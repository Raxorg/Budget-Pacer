const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { once } = require('node:events');
const { createServer, createLogReader, normalizeWindow, createResetReader } = require('./pacer-server');

const now = Date.now() - 1000;
const window = (minutes, used = 25) => ({ window_minutes: minutes, used_percent: used, resets_at: now / 1000 + minutes * 30 });
const record = (at, primary, secondary, extra = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), payload: { rate_limits: { primary, secondary, ...extra } } });
async function fixture(t) {
  const dir = await fs.promises.mkdtemp(path.join(__dirname, '.pacer-test-'));
  t.after(async () => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(__dirname) + path.sep + '.pacer-test-'));
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('window validation and relative resets preserve unknown resets', () => {
  assert.equal(normalizeWindow(window(123), now), null);
  for (const used of [null, '5', -1, 101, Infinity]) assert.equal(normalizeWindow(window(300, used), now), null);
  assert.equal(normalizeWindow({ window_minutes: 300, used_percent: 2 }, now).resets_at, null);
  assert.equal(normalizeWindow({ window_minutes: 300, used_percent: 2, resets_in_seconds: 60 }, now).resets_at, now / 1000 + 60);
});

test('select by event time across all files, independent windows, no tail limit, cache invalidation', async t => {
  const dir = await fixture(t);
  const a = path.join(dir, 'rollout-a.jsonl');
  await fs.promises.writeFile(a, record(now, window(10080, 42), window(300, 13)) + '\n' + ' '.repeat(1100000) + '\n{broken');
  await fs.promises.utimes(a, new Date(0), new Date(0));
  for (let i = 0; i < 12; i++) {
    await fs.promises.writeFile(path.join(dir, `rollout-${i}.jsonl`), record(now - 10000, window(300, 99)));
  }
  const latest = createLogReader(dir);
  let d = await latest();
  assert.equal(d.primary.used_percent, 13);
  assert.equal(d.secondary.used_percent, 42);
  await fs.promises.appendFile(a, '\n' + record(now + 100, window(300, 17)) + '\n' + record(now - 500, window(300, 80)) + '\n' + record(now + 200, window(300, 90), null, { limit_id: 'other' }));
  d = await latest();
  assert.equal(d.primary.used_percent, 17);
  assert.equal(d.secondary.used_percent, 42);
  await fs.promises.unlink(a);
  d = await latest();
  assert.equal(d.primary.used_percent, 99);
  assert.equal(d.secondary, null);
});

test('invalid dates and unsupported windows cannot masquerade as current usage', async t => {
  const dir = await fixture(t);
  await fs.promises.writeFile(path.join(dir, 'rollout-x.jsonl'), [
    JSON.stringify({ payload: { rate_limits: { primary: window(300) } } }),
    record(now + 3600000, window(300)), record(now, window(60)), 'null', '{partial',
  ].join('\n'));
  assert.equal(await createLogReader(dir)(), null);
});

test('disabled resets do not read credentials or access the network', async () => {
  const originalRead = fs.promises.readFile, originalFetch = global.fetch;
  let reads = 0, requests = 0;
  fs.promises.readFile = () => { reads++; throw new Error('Unexpected credential read'); };
  global.fetch = () => { requests++; throw new Error('Unexpected network request'); };
  try {
    assert.equal(await createResetReader(__dirname, false)(), null);
    assert.equal(reads, 0);
    assert.equal(requests, 0);
  }
  finally { fs.promises.readFile = originalRead; global.fetch = originalFetch; }
});

async function serve(t, options) {
  const server = createServer({ ...options, enableResets: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  assert.equal(server.address().address, '127.0.0.1');
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP routes, localhost Host restriction, no-data, successful refresh', async t => {
  const dir = await fixture(t), url = await serve(t, { dir });
  assert.equal((await fetch(url)).status, 200);
  const health = await (await fetch(url + '/api/health')).json();
  assert.equal(health.app, 'budget-pacer');
  assert.equal(health.resets_enabled, false);
  assert.equal(health.project, __dirname);
  assert.equal(health.auto_shutdown, true);
  assert.equal(health.idle_ms, 300000);
  const icon = await fetch(url + '/icon.png');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()).subarray(0,8), Buffer.from([137,80,78,71,13,10,26,10]));
  const time = await (await fetch(url + '/api/time')).json();
  assert.equal(time.time_zone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.ok(Math.abs(time.now - Date.now()) < 2000);
  assert.equal((await fetch(url + '/api/limits')).status, 404);
  assert.equal((await fetch(url + '/api/limits-other')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  const forbidden = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'untrusted.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(forbidden, 403);
  await fs.promises.writeFile(path.join(dir, 'rollout-x.jsonl'), record(now, window(300)));
  const r = await fetch(url + '/api/limits');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await r.json()).resets_available, null);
});

test('filesystem failures produce HTTP errors and the server stays alive', async t => {
  const dir = await fixture(t), file = path.join(dir, 'not-a-directory');
  await fs.promises.writeFile(file, '');
  const url = await serve(t, { dir: file });
  assert.equal((await fetch(url + '/api/limits')).status, 500);
  assert.equal((await fetch(url)).status, 200);
});

test('stream read errors are caught instead of crashing the server', async t => {
  const dir = await fixture(t);
  await fs.promises.writeFile(path.join(dir, 'rollout-x.jsonl'), record(now, window(300)));
  const url = await serve(t, { dir });
  const original = fs.createReadStream;
  fs.createReadStream = () => {
    const input = new (require('node:stream').Readable)({ read() {
      this.destroy(Object.assign(new Error('Read failure'), { code: 'EIO' }));
    } });
    return input;
  };
  try { assert.equal((await fetch(url + '/api/limits')).status, 500); }
  finally { fs.createReadStream = original; }
  assert.equal((await fetch(url + '/api/limits')).status, 200);
});

test('UI handles swapped, missing, unknown, expired, failed and recovered updates', async () => {
  const html = await fs.promises.readFile(path.join(__dirname, 'ai-budget-pacer.html'), 'utf8');
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '', style: {}, hidden: false, insertAdjacentHTML() {} });
    return elements.get(id);
  };
  let payload = { primary: { ...window(10080, 40), logged_at: now }, secondary: { ...window(300, 20), logged_at: now } };
  let fail = false, status = 200;
  const context = vm.createContext({ document: { getElementById: get }, Date, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval() {},
    location: { protocol: 'http:' },
    fetch: async url => { if (fail) throw new Error('offline'); return { status, ok: status === 200, json: async () => url === '/api/time' ? {time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone} : payload }; },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('ql_h5').textContent, '80%');
  assert.equal(get('ql_wk').textContent, '60%');
  assert.equal(get('p_h5').textContent, 'local');
  fail = true;
  await vm.runInContext('sync()', context);
  assert.equal(get('p_h5').textContent, 'offline');
  assert.equal(get('rs').hidden, true);
  assert.equal(get('err').hidden, false);
  assert.equal(get('ql_h5').textContent, '80%');
  fail = false;
  payload = { primary: { ...window(300), resets_at: null, logged_at: now } };
  await vm.runInContext('sync()', context);
  assert.equal(get('ql_h5').textContent, '\u2014');
  assert.equal(get('ql_wk').textContent, '\u2014');
  assert.equal(get('qf_h5').style.width, '0%');
  payload.primary.resets_at = now / 1000 - 1;
  await vm.runInContext('sync()', context);
  assert.equal(get('p_h5').textContent, 'expired');
  assert.equal(get('ql_h5').textContent, '\u2014');
  payload.primary = { ...window(300, 0), logged_at: now };
  await vm.runInContext('sync()', context);
  assert.equal(get('ql_h5').textContent, '100%');
  assert.equal(get('p_h5').textContent, 'local');
  assert.equal(get('err').hidden, true);
  status = 404;
  payload = { error: 'No valid local rate-limit records found.' };
  await vm.runInContext('sync()', context);
  assert.equal(get('p_h5').textContent, 'unknown');
  assert.equal(get('ql_h5').textContent, '\u2014');
  assert.match(get('err').textContent, /Server connected/);
  status = 200;
  payload = [];
  await vm.runInContext('sync()', context);
  assert.equal(get('p_h5').textContent, 'offline');
  vm.runInContext('location.protocol="file:"', context);
  await vm.runInContext('sync()', context);
  assert.match(get('err').textContent, /Iniciar Budget Pacer.cmd/);
});
