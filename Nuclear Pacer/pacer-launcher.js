// Windows entry point. No dependencies, credentials, or external HTTP calls.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function request(port, route, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: route, timeout }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error('Respuesta local demasiado grande.'));
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('El servidor local no responde.')));
    req.on('error', reject);
  });
}
function matches(reply, project) {
  try {
    const d = JSON.parse(reply.body);
    return reply.status === 200 && d.app === 'budget-pacer' && d.protocol === 1 &&
      typeof d.project === 'string' && path.resolve(d.project).toLowerCase() === path.resolve(project).toLowerCase() &&
      d.resets_enabled === false;
  } catch { return false; }
}
async function probe(port, project) {
  try {
    if (matches(await request(port, '/api/health'), project)) return true;
  } catch (e) {
    if (e.code === 'ECONNREFUSED') return false;
    throw new Error(`No se pudo comprobar el puerto ${port}: ${e.message}`);
  }
  throw new Error(`Conflicto: el puerto ${port} pertenece a otra aplicacion, otra carpeta o una version incompatible de Budget Pacer. Cierra ese servidor y vuelve a intentarlo.`);
}
async function checkFree(port, host) {
  // Check IPv6 too: the browser resolves localhost, while Node listens on IPv4 only.
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); reject(new Error(`Conflicto: ${host}:${port} ya esta ocupado por otra aplicacion.`)); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('No se pudo comprobar el puerto local.')); });
    socket.on('error', e => {
      if (['ECONNREFUSED', 'EAFNOSUPPORT', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(e.code)) resolve();
      else reject(e);
    });
  });
}
async function openBrowser(url) {
  // Windows Shell resolves the default browser. Do not wait for that browser to exit.
  await new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [url], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolve(); });
  });
}
async function launch({ port = 8787, project = __dirname, browser = true } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Se requiere Node.js 18 o posterior.');
  for (const name of ['pacer-server.js', 'ai-budget-pacer.html']) {
    if (!fs.statSync(path.join(project, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Falta el archivo ${name} en ${project}.`);
  }
  let child;
  let ready = await probe(port, project);
  await checkFree(port, '::1');
  if (!ready) {
    console.log('Iniciando Budget Pacer...');
    child = spawn(process.execPath, [path.join(project, 'pacer-server.js')], {
      cwd: project, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PORT: String(port), BUDGET_PACER_ENABLE_RESETS: '0' },
    });
    let spawnError;
    child.on('error', e => { spawnError = e; });
    child.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`No se pudo iniciar Node.js: ${spawnError.message}`);
      if (await probe(port, project)) { ready = true; break; }
      if (child.exitCode !== null) break;
      await delay(250);
    }
    if (!ready) throw new Error('El servidor no arranco en 15 segundos. Ejecuta node pacer-server.js para ver el diagnostico.');
  } else console.log('Budget Pacer ya esta ejecutandose; se reutiliza el servidor.');
  // Verify localhost resolves to this same application before opening the browser.
  if (!matches(await request(port, '/api/health', 'localhost'), project)) throw new Error('localhost no apunta a este Budget Pacer.');
  const page = await request(port, '/');
  if (page.status !== 200 || !page.body.includes('<title>Budget Pacer</title>')) throw new Error('El servidor no puede servir la interfaz HTML.');
  const limits = await request(port, '/api/limits', '127.0.0.1', 10000);
  const data = JSON.parse(limits.body);
  if (!(limits.status === 200 && ('primary' in data || 'secondary' in data)) &&
      !(limits.status === 404 && data.error === 'No valid local rate-limit records found.')) {
    throw new Error('No se pudieron leer los registros locales. Revisa permisos y vuelve a intentarlo.');
  }
  const url = `http://localhost:${port}`;
  if (browser) await openBrowser(url);
  console.log(`Budget Pacer listo: ${url}`);
  console.log('El servidor sigue activo con el monitor abierto y se apaga por inactividad (5 minutos por defecto).');
  return { url, started: !!child };
}
if (require.main === module) launch({ browser: !process.argv.includes('--no-browser') }).catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exitCode = 1;
});
module.exports = { launch, request, matches };
