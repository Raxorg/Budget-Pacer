const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { normalizeWindow } = require('./pacer-server');
const script = fs.readFileSync(require('node:path').join(__dirname, 'ai-budget-pacer.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const known = Date.parse('2026-11-17T12:34:56Z');
const formatted=(ms,zone)=>new Intl.DateTimeFormat('es-BO',{timeZone:zone,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(ms));
async function screen(zone, { now = known - 3661000, browserZone = 'UTC' } = {}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', className: '', style: {}, hidden: false, insertAdjacentHTML() {}});
    return elements.get(id);
  };
  let current = now, failTime = false;
  let payload = {primary: {used_percent: 25, window_minutes: 300, resets_at: known/1000, logged_at: now}};
  class Clock extends Date { static now() { return current; } }
  const context = vm.createContext({
    document: {getElementById: get}, Date: Clock, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval() {},
    Intl: { getCanonicalLocales:Intl.getCanonicalLocales, NumberFormat:Intl.NumberFormat, DateTimeFormat: function(locale, options) { return new Intl.DateTimeFormat(locale, options || {timeZone: browserZone}); } },
    fetch: async url => ({ok: url !== '/api/time' || !failTime, json: async () => url === '/api/time' ? {time_zone: zone,language:'es',locale:'es-BO'} : payload}),
  });
  vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return {get, context, setTime: t => {current = t;}, setPayload: p => {payload = p;}, failTime: () => {failTime = true;}};
}

test('seconds, milliseconds and relative reset durations retain the same absolute instant', () => {
  const absolute = normalizeWindow({used_percent:25,window_minutes:300,resets_at:known/1000}, known-10000);
  assert.equal(absolute.resets_at*1000, known);
  assert.equal(absolute.logged_at, known-10000);
  assert.equal(normalizeWindow({used_percent:25,window_minutes:300,resets_in_seconds:10}, known-10000).resets_at, absolute.resets_at);
  assert.equal(normalizeWindow({used_percent:25,window_minutes:300}, known).resets_at, null);
  assert.equal(Date.parse('2026-11-17T08:34:56-04:00'), known);
});
test('known timestamps use the supplied OS zone even when the browser reports UTC', async () => {
  for (const [zone, expected] of [
    ['America/La_Paz','17/11/2026 — 08:34:56'],
    ['UTC','17/11/2026 — 12:34:56'],
    ['Asia/Kathmandu','17/11/2026 — 18:19:56'],
  ]) {
    const s = await screen(zone);
    assert.equal(s.get('reset_h5').textContent, 'Próximo reinicio: '+formatted(known,zone));
    assert.equal(s.get('ql_h5').textContent, '75%');
    assert.match(s.get('countdown_h5').textContent, /^Cuenta regresiva: 1h 01min 01s/);
    assert.match(s.get('timezone').textContent, new RegExp(zone));
    if (zone!=='UTC') assert.match(s.get('timezone').textContent, /navegador detecta UTC; se usa Windows/);
  }
  const librewolf = await screen('America/La_Paz', {browserZone:'Atlantic/Reykjavik'});
  assert.equal(librewolf.get('reset_h5').textContent, 'Próximo reinicio: '+formatted(known,'America/La_Paz'));
  assert.match(librewolf.get('timezone').textContent, /navegador detecta Atlantic\/Reykjavik; se usa Windows/);
});
test('presentation follows daylight saving rules without changing the absolute countdown', async () => {
  const s = await screen('America/New_York');
  assert.equal(vm.runInContext(`localDate(${Date.parse('2026-07-17T12:34:56Z')})`,s.context), formatted(Date.parse('2026-07-17T12:34:56Z'),'America/New_York'));
  assert.equal(vm.runInContext(`localDate(${known})`,s.context), formatted(known,'America/New_York'));
});
test('countdown reaches expiry without inventing a new reset or changing usage', async () => {
  const s = await screen('UTC', {now:known-1000});
  assert.match(s.get('countdown_h5').textContent, /^Cuenta regresiva: 0h 00min 01s/);
  s.setTime(known);
  vm.runInContext('calc("h5")',s.context);
  assert.equal(s.get('p_h5').textContent, 'vencido');
  assert.equal(s.get('ql_h5').textContent, '\u2014');
  assert.match(s.get('reset_h5').textContent, /pendiente de confirmar.*registro vencido/);
  s.setPayload({primary:{used_percent:25,window_minutes:300,resets_at:null,logged_at:known}});
  await vm.runInContext('sync()',s.context);
  assert.equal(s.get('reset_h5').textContent, 'Próximo reinicio: desconocido');
  assert.equal(s.get('ql_h5').textContent, '\u2014');
});
test('unavailable system time metadata never silently substitutes the browser zone', async () => {
  const s = await screen('Not/A_Zone');
  assert.match(s.get('timezone').textContent, /no disponible/);
  assert.equal(s.get('reset_h5').textContent, 'Próximo reinicio: horario local pendiente');
  assert.equal(s.get('ql_h5').textContent, '75%');
  const good = await screen('America/La_Paz');
  good.failTime();
  await vm.runInContext('sync()',good.context);
  assert.match(good.get('timezone').textContent, /sin actualizar/);
});
test('known local timestamp matches Windows TimeZoneInfo independently', {skip:process.platform!=='win32'}, async () => {
  const expected = execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "[TimeZoneInfo]::ConvertTime([DateTimeOffset]::Parse('2026-11-17T12:34:56Z'),[TimeZoneInfo]::Local).ToString('yyyy-MM-ddTHH:mm:ss')"], {encoding:'utf8',windowsHide:true}).trim();
  const s = await screen(Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(s.get('reset_h5').textContent, 'Próximo reinicio: '+formatted(Date.parse(expected+'Z'),'UTC'));
});
