#!/usr/bin/env node
// Serves ai-budget-pacer.html and /api/limits (latest Codex rate limits from your local logs).
// Usage: node pacer-server.js   ->   open http://localhost:8787
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");

const PORT = +process.env.PORT || 8787;
const HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CHOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const DIR = path.join(HOME, "sessions");

function rollouts(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rollouts(p, out);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push({ p, t: fs.statSync(p).mtimeMs });
  }
  return out;
}

function tail(p, bytes = 1 << 20) {
  const fd = fs.openSync(p, "r");
  const { size } = fs.fstatSync(fd);
  const n = Math.min(size, bytes);
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, size - n);
  fs.closeSync(fd);
  return buf.toString("utf8");
}

function latest() {
  const files = rollouts(DIR).sort((a, b) => b.t - a.t).slice(0, 10);
  for (const f of files) {
    for (const line of tail(f.p).split("\n").reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const rl = o.payload && o.payload.rate_limits;
      if (!rl || (!rl.primary && !rl.secondary)) continue;
      const at = Date.parse(o.timestamp) || f.t;
      const fix = w => w && {
        used_percent: w.used_percent,
        window_minutes: w.window_minutes,
        resets_at: w.resets_at ?? (w.resets_in_seconds != null ? Math.round(at / 1000 + w.resets_in_seconds) : null),
      };
      return { plan: rl.plan_type || null, logged_at: at, primary: fix(rl.primary), secondary: fix(rl.secondary) };
    }
  }
  return null;
}

// Banked reset count is not in the local logs; it comes from the same usage endpoint Codex itself uses.
// Uses the token in ~/.codex/auth.json, sends it only to chatgpt.com, cached 5 min. Any failure -> null (badge hidden).
let rc = { t: 0, v: null };
async function resets() {
  if (Date.now() - rc.t < 300000) return rc.v;
  rc.t = Date.now();
  try {
    const a = JSON.parse(fs.readFileSync(path.join(HOME, "auth.json"), "utf8")).tokens || {};
    const headers = { Authorization: "Bearer " + a.access_token };
    if (a.account_id) headers["ChatGPT-Account-ID"] = a.account_id;
    const r = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw 0;
    const n = (await r.json()).rate_limit_reset_credits?.available_count;
    rc.v = Number.isInteger(n) && n >= 0 ? n : null;
  } catch { rc.v = null; }
  return rc.v;
}

// Claude (Pro/Max) usage: same endpoint Claude Code's /usage uses. Reads the OAuth token Claude Code already saved
// (~/.claude/.credentials.json, or the macOS keychain), sends it only to api.anthropic.com, cached 2 min.
// Never refreshes the token (that could log Claude Code out): if it's expired, just use Claude Code once and it renews.
function claudeToken() {
  let raw;
  try { raw = fs.readFileSync(path.join(CHOME, ".credentials.json"), "utf8"); }
  catch {
    if (process.platform !== "darwin") return null;
    raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  }
  const o = JSON.parse(raw).claudeAiOauth;
  return o && o.accessToken && (!o.expiresAt || o.expiresAt > Date.now()) ? o.accessToken : null;
}

let cc = { t: 0, v: null };
async function claude() {
  if (Date.now() - cc.t < 120000) return cc.v;
  cc.t = Date.now();
  try {
    const token = claudeToken();
    if (!token) throw 0;
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw 0;
    const j = await r.json();
    const fix = (w, m) => w && w.utilization != null
      ? { used_percent: w.utilization, window_minutes: m, resets_at: w.resets_at ? Math.round(Date.parse(w.resets_at) / 1000) : null }
      : null;
    const primary = fix(j.five_hour, 300), secondary = fix(j.seven_day, 10080);
    cc.v = primary || secondary ? { plan: "claude", logged_at: Date.now(), primary, secondary } : null;
  } catch { cc.v = null; }
  return cc.v;
}

// Auto-exit: the page polls every 30s. If nothing has hit the server for IDLE_MS (tab closed), quit.
// 90s rather than ~35s because browsers throttle timers in background tabs to about once a minute.
const IDLE_MS = 90000;
const ICON = path.join(__dirname, "icon.png");
let seen = Date.now(), lastCheck = Date.now();
setInterval(() => {
  const n = Date.now();
  if (n - lastCheck > 15000) seen = n;   // this process was suspended (PC sleep): give the page time to tick again
  lastCheck = n;
  if (n - seen > IDLE_MS) process.exit(0);
}, 5000);

http.createServer(async (req, res) => {
  seen = Date.now();
  if (req.url.split("?")[0] === "/icon.png") {
    return fs.readFile(ICON, (e, b) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
      res.end(b);
    });
  }
  if (req.url.startsWith("/api/claude")) {
    const d = await claude();
    res.writeHead(d ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(d || { error: "no Claude usage found; log in with Claude Code (~/.claude)" }));
  }
  if (req.url.startsWith("/api/limits")) {
    const d = latest();
    if (d) d.resets_available = await resets();
    res.writeHead(d ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(d || { error: "no rate_limits found in " + DIR }));
  }
  fs.readFile(path.join(__dirname, "ai-budget-pacer.html"), (e, b) => {
    if (e) { res.writeHead(500); return res.end("ai-budget-pacer.html must sit next to this file"); }
    let html = b.toString();
    if (fs.existsSync(ICON)) html = html.replace("</head>", '<link rel="icon" type="image/png" href="/icon.png">\n</head>');
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
}).listen(PORT, "127.0.0.1", () => console.log("Budget Pacer: http://localhost:" + PORT));
