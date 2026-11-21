const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { launch, request } = require('./pacer-launcher');

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}
test('launcher rejects foreign HTTP servers and missing project files', async t => {
  const server = http.createServer((req, res) => res.end('<title>Other app</title>'));
  const port = await listen(server);
  t.after(() => { server.close(); server.closeAllConnections(); });
  await assert.rejects(launch({ port, browser: false }), /Conflicto/);
  await assert.rejects(launch({ project: path.join(__dirname, 'nonexistent'), browser: false }), /Falta el archivo/);
});
test('launcher starts detached server safely, accepts no records and reuses it', async t => {
  const project = await fs.mkdtemp(path.join(__dirname, '.pacer-test-launcher-'));
  let pid;
  const oldHome = process.env.CODEX_HOME, oldResets = process.env.BUDGET_PACER_ENABLE_RESETS;
  t.after(async () => {
    if (pid) { process.kill(pid); await new Promise(resolve => setTimeout(resolve, 300)); }
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldResets === undefined) delete process.env.BUDGET_PACER_ENABLE_RESETS; else process.env.BUDGET_PACER_ENABLE_RESETS = oldResets;
    assert.ok(project.startsWith(path.join(__dirname, '.pacer-test-launcher-')));
    await fs.rm(project, { recursive: true, force: true });
  });
  for (const name of ['pacer-server.js', 'ai-budget-pacer.html']) await fs.copyFile(path.join(__dirname, name), path.join(project, name));
  process.env.CODEX_HOME = project; // Empty synthetic directory; never real credentials.
  process.env.BUDGET_PACER_ENABLE_RESETS = '1'; // Child MUST override inherited opt-in.
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const first = await launch({ project, port, browser: false });
  const health = JSON.parse((await request(port, '/api/health')).body);
  pid = health.pid;
  assert.equal(first.started, true);
  assert.equal(health.resets_enabled, false);
  assert.equal((await request(port, '/')).status, 200);
  assert.equal((await request(port, '/api/limits')).status, 404);
  const second = await launch({ project, port, browser: false });
  assert.equal(second.started, false);
  assert.equal(JSON.parse((await request(port, '/api/health')).body).pid, pid);
});
