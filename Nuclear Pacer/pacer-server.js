#!/usr/bin/env node
// Local Codex log monitor. Usage: node pacer-server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const DEFAULT_IDLE_MS = 300000;
let regionalSettings;
function detectRegionalSettings({ platform = process.platform, query = () => execFileSync(
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-Command', '[pscustomobject]@{ui=(Get-UICulture).Name;region=(Get-Culture).Name}|ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
) } = {}) {
  try {
    if (platform !== 'win32') throw new Error('Windows unavailable');
    const data = JSON.parse(query());
    const ui = Intl.getCanonicalLocales(data.ui)[0];
    const locale = Intl.getCanonicalLocales(data.region || ui)[0];
    if (!ui || !locale) throw new Error('Missing culture');
    return { language: ui.split('-')[0] === 'es' ? 'es' : 'en', locale, ui_culture: ui, locale_source: 'windows' };
  } catch {
    return { language: 'en', locale: 'en-US', ui_culture: null, locale_source: 'fallback' };
  }
}
function getRegionalSettings() { return regionalSettings ||= detectRegionalSettings(); }
const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DIR = path.join(HOME, 'sessions');

async function rollouts(dir, out = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    // Never follow symlinks outside the sessions directory.
    if (entry.isDirectory()) await rollouts(p, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(p);
  }
  return out;
}

function normalizeWindow(w, at) {
  if (!w || !Number.isFinite(w.used_percent) || w.used_percent < 0 || w.used_percent > 100 ||
      ![300, 10080].includes(w.window_minutes)) return null;
  // Codex resets_at is Unix seconds; Date.parse(event timestamp) gives milliseconds.
  // Keep the API in seconds, with no local-zone arithmetic.
  let reset = w.resets_at;
  if (reset == null && Number.isFinite(w.resets_in_seconds) && w.resets_in_seconds >= 0) {
    reset = at / 1000 + w.resets_in_seconds;
  }
  return {
    used_percent: w.used_percent,
    window_minutes: w.window_minutes,
    resets_at: Number.isFinite(reset) && reset > 0 ? reset : null,
    logged_at: at,
  };
}

function createLogReader(dir) {
  const cache = new Map();
  let pending;
  async function scan() {
    const files = (await rollouts(dir)).sort();
    const present = new Set(files);
    for (const p of cache.keys()) if (!present.has(p)) cache.delete(p);
    const best = {};
    let plan = null, planAt = -Infinity;
    for (const p of files) {
      try {
        const stat = await fs.promises.stat(p);
        let item = cache.get(p);
        if (!item || item.size !== stat.size || item.mtime !== stat.mtimeMs) {
          item = { size: stat.size, mtime: stat.mtimeMs, windows: {}, plan: null, planAt: -Infinity };
          const input = fs.createReadStream(p, { encoding: 'utf8' });
          const lines = readline.createInterface({ input, crlfDelay: Infinity });
          try {
            for await (const line of lines) {
              if (!line.includes('"rate_limits"')) continue;
              let o;
              try { o = JSON.parse(line); } catch { continue; }
              const rl = o?.payload?.rate_limits;
              const at = typeof o?.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
              // mtime does not describe when usage was measured.
              if (!rl || !Number.isFinite(at) || at > Date.now() + 60000) continue;
              if (rl.limit_id != null && rl.limit_id !== 'codex') continue;
              for (const raw of [rl.primary, rl.secondary]) {
                const w = normalizeWindow(raw, at);
                if (!w) continue;
                if (!item.windows[w.window_minutes] || at >= item.windows[w.window_minutes].logged_at) {
                  item.windows[w.window_minutes] = w;
                }
                if (at >= item.planAt) {
                  item.plan = typeof rl.plan_type === 'string' ? rl.plan_type : null;
                  item.planAt = at;
                }
              }
            }
          } finally { lines.close(); input.destroy(); }
          cache.set(p, item);
        }
        for (const w of Object.values(item.windows)) {
          if (!best[w.window_minutes] || w.logged_at >= best[w.window_minutes].logged_at) best[w.window_minutes] = w;
        }
        if (item.planAt >= planAt) { plan = item.plan; planAt = item.planAt; }
      } catch (e) {
        cache.delete(p);
        // A concurrently removed log is harmless; inaccessible logs make freshness uncertain.
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (!Object.keys(best).length) return null;
    return {
      plan,
      logged_at: Math.max(...Object.values(best).map(w => w.logged_at)),
      primary: best[300] || null,
      secondary: best[10080] || null,
    };
  }
  return function latest() {
    if (!pending) pending = scan().finally(() => { pending = null; });
    return pending;
  };
}

// Explicit opt-in only. Disabled mode never reads auth.json or makes external requests.
function createResetReader(home, enabled) {
  let cache = { t: 0, v: null };
  return async function resets() {
    if (!enabled) return null;
    if (Date.now() - cache.t < 300000) return cache.v;
    cache.t = Date.now();
    try {
      const a = JSON.parse(await fs.promises.readFile(path.join(home, 'auth.json'), 'utf8')).tokens || {};
      if (typeof a.access_token !== 'string' || !a.access_token.trim()) return null;
      const headers = { Authorization: 'Bearer ' + a.access_token };
      if (typeof a.account_id === 'string') headers['ChatGPT-Account-ID'] = a.account_id;
      const r = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers, signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!r.ok) throw new Error('Reset lookup failed');
      const n = (await r.json()).rate_limit_reset_credits?.available_count;
      cache.v = Number.isInteger(n) && n >= 0 ? n : null;
    } catch { cache.v = null; }
    return cache.v;
  };
}

function createServer({ dir = DIR, home = HOME, enableResets = process.env.BUDGET_PACER_ENABLE_RESETS === '1', regional = getRegionalSettings(), idleMs = DEFAULT_IDLE_MS, shutdownGraceMs = 10000 } = {}) {
  if (!Number.isInteger(idleMs) || idleMs < 100) throw new Error('Idle timeout must be an integer of at least 100 milliseconds.');
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 100) throw new Error('Shutdown grace must be at least 100 milliseconds.');
  // The default Windows culture query is cached per process, never per poll.
  const latest = createLogReader(dir);
  const resets = createResetReader(home, enableResets);
  // Ephemeral local capability, unrelated to Codex credentials. Shared by tabs;
  // never returned in health/limits or put in a URL, cookie, log or disk file.
  const monitorKey = randomBytes(32).toString('hex');
  let lastActivity = performance.now(), closing = false, idleTimer, graceTimer;
  function armIdle() {
    clearTimeout(idleTimer);
    if (closing || !server.listening) return;
    const remaining = idleMs - (performance.now() - lastActivity);
    if (remaining > 0) {
      idleTimer = setTimeout(armIdle, Math.ceil(remaining));
      idleTimer.unref();
      return;
    }
    closing = true;
    // Stop accepting requests, let in-flight work finish, then bound stuck sockets.
    server.close();
    server.closeIdleConnections?.();
    graceTimer = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
    graceTimer.unref();
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      // Restrict Host as well as the listening interface (including DNS rebinding).
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host || '')) return json(403, { error: 'Localhost only' });
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return json(403, { error: 'Same origin only' });
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return json(403, { error: 'Same origin only' });
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/heartbeat') {
        if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) return json(400, { error: 'Heartbeat must have no body' });
        if (req.headers.origin !== origin || req.headers['x-budget-pacer-monitor'] !== monitorKey) return json(403, { error: 'Invalid monitor activity' });
        if (closing) return json(503, { error: 'Server shutting down' });
        lastActivity = performance.now();
        armIdle();
        return json(200, { ok: true });
      }
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
      // Node/Intl obtains the local OS zone; send it explicitly because a browser
      // may expose a different zone. No UTC offsets or remote clock lookup.
      if (pathname === '/api/time') return json(200, {
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: Date.now(),
        ...regional,
      });
      // This route never scans sessions or invokes the optional credential reader.
      if (pathname === '/api/health') return json(200, {
        app: 'budget-pacer', protocol: 1, project: __dirname,
        pid: process.pid, resets_enabled: enableResets,
        idle_ms: idleMs, auto_shutdown: true,
      });
      if (pathname === '/icon.png') {
        const icon = await fs.promises.readFile(path.join(__dirname, 'icon.png'));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
        return res.end(icon);
      }
      if (pathname === '/api/limits') {
        const d = await latest();
        if (!d) return json(404, { error: 'No valid local rate-limit records found.' });
        d.resets_available = await resets();
        return json(200, d);
      }
      if (pathname !== '/' && pathname !== '/ai-budget-pacer.html') return json(404, { error: 'Not found' });
      const html = await fs.promises.readFile(path.join(__dirname, 'ai-budget-pacer.html'));
      const source = html.toString('utf8');
      const dictionaries = JSON.parse(source.match(/\/\*TRANSLATIONS\*\/([\s\S]*?)\/\*END_TRANSLATIONS\*\//)[1]);
      const rendered = source.replace('/*PACER_LOCALE*/null', JSON.stringify(regional))
        .replace('/*PACER_MONITOR*/null', JSON.stringify(monitorKey))
        .replace('<html lang="en">', `<html lang="${regional.language}">`)
        .replace(/<noscript>[\s\S]*?<\/noscript>/, `<noscript>${dictionaries[regional.language].noscript}</noscript>`);
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(rendered);
    } catch {
      if (!res.headersSent) json(500, { error: 'Unable to read local monitor data. Try refreshing.' });
      else res.end();
    }
  });
  server.on('listening', () => { lastActivity = performance.now(); armIdle(); });
  server.on('close', () => { clearTimeout(idleTimer); clearTimeout(graceTimer); });
  return server;
}

if (require.main === module) {
  const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createServer();
    server.on('error', e => {
      console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : 'Unable to start the localhost server.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`Budget Pacer: http://localhost:${port}`));
  }
}
module.exports = { createServer, createLogReader, normalizeWindow, createResetReader, detectRegionalSettings, DEFAULT_IDLE_MS };
