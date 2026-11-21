// Secondary entry point: reuse the original server logic without its browser opener.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { launch } = require('./pacer-launcher');

function registryQuery(args) {
  try {
    return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), args, {
      encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return ''; } // Absent/unsupported registry views are normal.
}
function registryValues(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/\sREG_(?:EXPAND_)?SZ\s+(.+)$/);
    return match ? [match[1].trim()] : [];
  });
}
function executablePath(value, env) {
  const expanded = value.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? env[key] : whole;
  });
  // Registry values may include quotes, browser arguments or an icon index.
  const match = expanded.match(/^"([^"]*\\librewolf\.exe)"(?:\s|,|$)/i) ||
    expanded.match(/^(.+\\librewolf\.exe)(?:\s|,|$)/i);
  return match && path.win32.isAbsolute(match[1]) ? match[1] : null;
}
function findLibreWolf({ env = process.env, exists = file => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}, query = registryQuery } = {}) {
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']];
  const usual = roots.filter(Boolean).map(root => path.join(root, 'LibreWolf', 'librewolf.exe'));
  if (env.LOCALAPPDATA) usual.push(
    path.join(env.LOCALAPPDATA, 'Programs', 'LibreWolf', 'librewolf.exe'),
    path.join(env.LOCALAPPDATA, 'LibreWolf', 'librewolf.exe'),
  );
  for (const file of new Set(usual)) if (exists(file)) return file;
  for (const hive of ['HKCU', 'HKLM']) for (const view of ['/reg:64', '/reg:32']) {
    const appPath = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\librewolf.exe`;
    for (const value of registryValues(query(['query', appPath, '/ve', view]))) {
      const file = executablePath(value, env);
      if (file && exists(file)) return file;
    }
  }
  // Installers may register an uninstall location instead of App Paths.
  for (const hive of ['HKCU', 'HKLM']) for (const view of ['/reg:64', '/reg:32']) {
    const root = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
    const keys = query(['query', root, '/s', '/f', 'LibreWolf', '/k', view])
      .split(/\r?\n/).map(s => s.trim()).filter(s => /^HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\.*\\Uninstall\\[^\\]*LibreWolf[^\\]*$/i.test(s));
    for (const key of keys) {
      for (const value of registryValues(query(['query', key, '/v', 'InstallLocation', view]))) {
        const folder = value.replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
        const file = executablePath(`${folder}\\librewolf.exe`, env);
        if (file && exists(file)) return file;
      }
      for (const value of registryValues(query(['query', key, '/v', 'DisplayIcon', view]))) {
        const file = executablePath(value, env);
        if (file && exists(file)) return file;
      }
    }
  }
  throw new Error('No se encontro LibreWolf en las carpetas habituales ni en sus rutas registradas en Windows. Comprueba su instalacion. No se abrira Brave ni otro navegador.');
}
async function openLibreWolf(executable, url, spawnBrowser = spawn) {
  await new Promise((resolve, reject) => {
    // -new-tab uses an existing instance when supported. No profile or -no-remote flags.
    const child = spawnBrowser(executable, ['-new-tab', url], {
      shell: false, detached: true, stdio: 'ignore',
    });
    child.once('error', e => reject(new Error(`No se pudo iniciar LibreWolf: ${e.message}. No se abrira otro navegador.`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function run({ browser = true, find = findLibreWolf, start = launch, open = openLibreWolf, ...options } = {}) {
  const executable = find(); // Fail before starting a server if LibreWolf is missing.
  console.log(`LibreWolf encontrado: ${executable}`);
  const result = await start({ ...options, browser: false });
  // launch() has already verified project identity, localhost, HTML and limits.
  if (browser) await open(executable, result.url);
  console.log(browser ? 'URL enviada directamente a LibreWolf.' : 'Diagnostico correcto; no se abrio ningun navegador.');
  return { ...result, executable };
}
if (require.main === module) run({ browser: !process.argv.includes('--no-browser') }).catch(e => {
  console.error(`ERROR: ${e.message}`);
  process.exitCode = 1;
});
module.exports = { findLibreWolf, registryValues, executablePath, openLibreWolf, run };
