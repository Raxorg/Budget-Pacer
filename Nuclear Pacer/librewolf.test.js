const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { findLibreWolf, openLibreWolf, run } = require('./pacer-librewolf');

test('LibreWolf detection prefers standard folders without consulting registry', () => {
  const executable = 'C:\\Program Files\\LibreWolf\\librewolf.exe';
  assert.equal(findLibreWolf({ env: { ProgramFiles: 'C:\\Program Files' },
    exists: file => file === executable, query() { throw new Error('Unexpected registry read'); },
  }), executable);
});
test('LibreWolf detection supports quoted registered App Paths and expanded variables', () => {
  const executable = 'D:\\Apps\\LibreWolf\\librewolf.exe';
  assert.equal(findLibreWolf({ env: { BrowserRoot: 'D:\\Apps' }, exists: file => file === executable,
    query: args => args.includes('/ve') ? '    (Default)    REG_EXPAND_SZ    "%BrowserRoot%\\LibreWolf\\librewolf.exe"\r\n' : '',
  }), executable);
});
test('LibreWolf detection supports registered uninstall location and rejects stale paths', () => {
  const executable = 'D:\\Other Apps\\LibreWolf\\librewolf.exe';
  assert.equal(findLibreWolf({ env: {}, exists: file => file === executable,
    query: args => args.includes('/k') ? 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LibreWolf\r\n' :
      args.includes('InstallLocation') ? '    InstallLocation    REG_SZ    D:\\Other Apps\\LibreWolf\\\r\n' : '',
  }), executable);
  assert.throws(() => findLibreWolf({ env: {}, exists: () => false, query: () => '' }), /No se encontro LibreWolf/);
});
test('secondary launcher verifies server before invoking only LibreWolf', async () => {
  const events = [];
  const executable = 'C:\\Program Files\\LibreWolf\\librewolf.exe';
  const url = 'http://localhost:8787';
  const result = await run({ find: () => executable,
    start: async options => { assert.equal(options.browser, false); events.push('server'); return { url, started: false }; },
    open: async (exe, address) => { assert.equal(exe, executable); assert.equal(address, url); events.push('LibreWolf'); },
  });
  assert.deepEqual(events, ['server', 'LibreWolf']);
  assert.equal(result.started, false);
  await assert.rejects(run({ find: () => { throw new Error('missing browser'); }, start: () => assert.fail('server must not start') }), /missing browser/);
  await assert.rejects(run({ find: () => executable, start: async () => { throw new Error('server conflict'); }, open: () => assert.fail('browser must not open') }), /server conflict/);
});
test('LibreWolf receives the URL as a separate argument without shell or profile flags', async () => {
  const executable = 'C:\\Program Files\\LibreWolf\\librewolf.exe';
  const url = 'http://localhost:8787';
  let unref = false;
  await openLibreWolf(executable, url, (exe, args, options) => {
    assert.equal(exe, executable);
    assert.deepEqual(args, ['-new-tab', url]);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.unref = () => { unref = true; };
    process.nextTick(() => child.emit('spawn'));
    return child;
  });
  assert.equal(unref, true);
  await assert.rejects(openLibreWolf(executable, url, () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('error', new Error('ENOENT')));
    return child;
  }), /No se pudo iniciar LibreWolf/);
});
