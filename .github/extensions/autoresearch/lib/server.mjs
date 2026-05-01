/**
 * DashboardServer — a zero-dependency localhost HTTP server that serves:
 *   GET  /               → live dashboard SPA (SSE-powered)
 *   GET  /api/state      → current state as JSON
 *   GET  /api/events     → SSE stream: state changes + named Copilot CLI session events
 *   GET  /api/activity   → recent Copilot CLI session events as JSON array
 *   POST /api/pause      → pause the session (safe, non-destructive)
 *   POST /api/resume     → resume the session (safe, non-destructive)
 *   GET  /api/export     → static HTML snapshot (no live features)
 *
 * Transport choice — SSE over WebSocket:
 *   Node.js has no built-in WebSocket *server* (only a client since v21).
 *   Implementing one from scratch requires manual SHA-1 handshake + frame
 *   codec — ~150 lines of fiddly code — and introduces the 'ws' package if
 *   we want reliability. SSE is a first-class HTTP feature, works over plain
 *   http.createServer(), supports named events and auto-reconnect natively,
 *   and is sufficient here because all dashboard control actions (pause/resume)
 *   use regular fetch() POSTs. Zero extra dependencies needed.
 */
import { createServer } from 'node:http';

export const DEFAULT_PORT = 7432;

/** Maximum number of Copilot CLI session events to keep in memory for replay. */
const MAX_ACTIVITY = 100;

export class DashboardServer {
  /** @param {import('./state.mjs').StateManager} sm */
  constructor(sm, port = DEFAULT_PORT) {
    this.sm = sm;
    this.port = port;
    this.clients = new Set();
    /** Ring buffer of Copilot CLI session events, replayed to new SSE connections. */
    this.copilotEvents = [];
    this.server = null;
    this._onChange = (state) => this._broadcast(state);
  }

  /** Number of currently connected SSE clients. */
  get activeClients() { return this.clients.size; }

  /** Starts the server. Returns the URL string. */
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        try { this._route(req, res); }
        catch (err) { this._error(res, 500, err.message); }
      });
      this.server.listen(this.port, '127.0.0.1', () => {
        this.sm.on('change', this._onChange);
        // Also catch external file writes (parallel processes)
        this.sm.startWatching((state) => this._broadcast(state));
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  /** Gracefully stops the server. */
  stop() {
    return new Promise((resolve) => {
      this.sm.removeListener('change', this._onChange);
      this.sm.stopWatching();
      for (const res of this.clients) {
        try { res.end(); } catch { /* already closed */ }
      }
      this.clients.clear();
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }

  /** Pushes a state update to all connected SSE clients. */
  _broadcast(state) {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); }
      catch { this.clients.delete(res); }
    }
  }

  /**
   * Push a named Copilot CLI session event to all connected SSE clients and
   * buffer it so it is replayed to clients that connect later.
   *
   * Called by extension.mjs to bridge session.on() listeners and hook return
   * values to the dashboard without any additional transport layer.
   *
   * Browsers receive this as: es.addEventListener('copilot', handler)
   *
   * @param {string} name   Logical event type, e.g. 'tool.start', 'assistant.message'
   * @param {object} [data] Arbitrary serialisable payload
   */
  broadcastEvent(name, data = {}) {
    const entry = { ts: new Date().toISOString(), type: name, ...data };
    this.copilotEvents.push(entry);
    if (this.copilotEvents.length > MAX_ACTIVITY) this.copilotEvents.shift();
    const payload = `event: copilot\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); }
      catch { this.clients.delete(res); }
    }
  }

  _route(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const p = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buildDashboardHTML(this.port));

    } else if (req.method === 'GET' && p === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.sm.getState(), null, 2));

    } else if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n');
      res.write('retry: 2000\n\n');
      // Send current state immediately so page renders without waiting for a change
      res.write(`data: ${JSON.stringify(this.sm.getState())}\n\n`);
      // Replay buffered Copilot CLI session events so a freshly opened tab
      // can reconstruct the agent activity feed without missing history.
      for (const ev of this.copilotEvents) {
        res.write(`event: copilot\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));

    } else if (req.method === 'GET' && p === '/api/activity') {
      // Recent Copilot CLI session events as JSON — useful for scripting/polling.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.copilotEvents));

    } else if (req.method === 'POST' && p === '/api/pause') {
      this.sm.pause();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'paused' }));

    } else if (req.method === 'POST' && p === '/api/resume') {
      this.sm.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'running' }));

    } else if (req.method === 'GET' && p === '/api/export') {
      const state = this.sm.getState();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="autoresearch-snapshot.html"',
      });
      res.end(buildExportHTML(state));

    } else {
      this._error(res, 404, 'Not Found');
    }
  }

  _error(res, code, msg) {
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end(msg);
  }
}

// ── HTML Templates ────────────────────────────────────────────────────────────
//
// Style direction: ultra-minimal, ASCII-inspired, automatic light/dark via
// color-scheme. Single accent: #8eca9d (sage green). No framework, no
// hardcoded backgrounds — browser defaults handle contrast in both modes.
// Reference: Tiberriver256.GitHub.io/assets/css/main.css

function buildDashboardHTML(port) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>[ autoresearch ]</title>
<style>
:root{--a:#8eca9d}
*{box-sizing:border-box;color-scheme:light dark}
body{font:100%/1.6 system-ui;max-width:960px;margin:0 auto;padding:1rem 1.25rem}
header{display:flex;align-items:baseline;gap:.75rem;flex-wrap:wrap;border-bottom:2px solid var(--a);padding-bottom:.4rem;margin-bottom:1.25rem}
header h1{font:.9rem/1 monospace;font-weight:700;margin:0}
h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;border-bottom:1px solid var(--a);padding-bottom:.15rem;margin:1.4rem 0 .5rem}
.st{font-family:monospace;font-size:.82rem}
.st-running{color:var(--a)}
.st-paused{opacity:.6}
.st-stopped{opacity:.35}
.dot{display:inline-block;width:.5rem;height:.5rem;border:1px solid currentColor;border-radius:50%;vertical-align:middle}
.dot.live{background:var(--a);border-color:var(--a)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:.6rem;margin-bottom:1rem}
.card{border:1px solid color-mix(in srgb,var(--a) 30%,transparent);padding:.55rem .7rem}
.lbl{font-size:.65rem;text-transform:uppercase;letter-spacing:.09em;opacity:.5;margin-bottom:.1rem}
.big{font:1.25rem/1.2 monospace;font-weight:600}
.sub{font-size:.7rem;opacity:.5;margin-top:.1rem}
.row{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1.1rem}
button{font:inherit;font-size:.82rem;border:1px solid var(--a);background:none;padding:.15rem .65rem;cursor:pointer}
button:hover{background:color-mix(in srgb,var(--a) 12%,transparent)}
button:disabled{opacity:.28;cursor:not-allowed}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;text-align:left;padding:.25rem .35rem;border-bottom:1px solid var(--a)}
td{padding:.22rem .35rem;border-bottom:1px solid color-mix(in srgb,var(--a) 20%,transparent);vertical-align:top}
svg.ch{width:100%;height:4rem;display:block}
.log{font:.77rem/1.55 'SFMono-Regular',Consolas,monospace;height:11rem;overflow-y:auto;
  border:1px solid color-mix(in srgb,var(--a) 35%,transparent);padding:.4rem .5rem;white-space:pre-wrap}
.dim{opacity:.4;font-size:.85em}
.lv-warn{opacity:.65}
.lv-error{text-decoration:underline wavy}
.none{opacity:.4;font-style:italic}
</style>
</head>
<body>
<header>
  <h1>[ autoresearch ]</h1>
  <span class="st" id="st">[idle]</span>
  <span class="dot" id="dot" title="SSE live"></span>
  <span class="dim" style="margin-left:auto;font-size:.75rem">:${port}</span>
</header>

<div class="cards">
  <div class="card"><div class="lbl">Goal</div><div id="goal">—</div></div>
  <div class="card"><div class="lbl">Benchmark</div><code id="bench" style="font-size:.82rem">—</code></div>
  <div class="card"><div class="lbl">Best Metric ★</div><div class="big" id="bv">—</div><div class="sub" id="bs"></div></div>
  <div class="card"><div class="lbl">Session</div><div id="sid" style="font-family:monospace;font-size:.78rem">—</div><div class="sub" id="sdt"></div></div>
</div>

<div class="row">
  <button id="bp" onclick="act('pause')">⏸ pause</button>
  <button id="br" onclick="act('resume')">▶ resume</button>
  <button onclick="window.open('/api/export')">↓ export</button>
</div>

<h2>Metric Trend <span id="mc" class="dim"></span></h2>
<svg id="ch" class="ch" viewBox="0 0 400 64" preserveAspectRatio="none"></svg>

<h2>Experiments <span id="ec" class="dim"></span></h2>
<table>
  <thead><tr><th>#</th><th>Name</th><th>Status</th><th>Metric</th><th>Started</th><th>Finished</th></tr></thead>
  <tbody id="et"></tbody>
</table>

<h2>Recent Metrics <span id="mtc" class="dim"></span></h2>
<table>
  <thead><tr><th>#</th><th>Experiment</th><th>Value</th><th>At</th><th>Params</th></tr></thead>
  <tbody id="mt"></tbody>
</table>

<h2>Logs <span id="lc" class="dim"></span></h2>
<div id="lb" class="log"></div>

<h2>Agent Activity <span id="ac" class="dim"></span></h2>
<div id="ab" class="log"></div>

<script>
let state = null;
const activity = [];

function ts(iso){ return iso ? new Date(iso).toLocaleTimeString() : '—'; }
function dt(iso){ return iso ? new Date(iso).toLocaleString() : '—'; }
function x(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function sc(s){ return s==='running'?'st-running':s==='paused'?'st-paused':s==='stopped'?'st-stopped':''; }

function render(s) {
  if (!s) return;

  const el = document.getElementById('st');
  el.textContent = '[' + (s.status || 'idle') + ']';
  el.className = 'st ' + sc(s.status);

  document.getElementById('goal').textContent = s.goal || '—';
  document.getElementById('bench').textContent = s.benchmarkCommand || '—';

  if (s.bestMetric) {
    document.getElementById('bv').textContent = Number(s.bestMetric.value).toFixed(6);
    document.getElementById('bs').textContent = (s.bestMetric.experiment||'') + '  ' + ts(s.bestMetric.at);
  } else {
    document.getElementById('bv').textContent = '—';
    document.getElementById('bs').textContent = '';
  }

  document.getElementById('sid').textContent = s.sessionId ? s.sessionId.slice(0,8)+'…' : '—';
  document.getElementById('sdt').textContent = s.startedAt ? 'started '+ts(s.startedAt)+' · updated '+ts(s.updatedAt) : '';

  const paused = s.paused || s.status === 'paused';
  const active = s.status === 'running' || s.status === 'paused';
  document.getElementById('bp').disabled = !active || paused;
  document.getElementById('br').disabled = !paused;

  chart(s.metrics || []);
  document.getElementById('mc').textContent = (s.metrics||[]).length;

  const exps = (s.experiments||[]).slice().reverse();
  document.getElementById('ec').textContent = exps.length;
  document.getElementById('et').innerHTML = exps.length
    ? exps.slice(0,50).map((e,i) =>
        '<tr><td class="dim">'+(exps.length-i)+'</td>'+
        '<td>'+x(e.name)+'</td>'+
        '<td class="'+sc(e.status)+'">'+x(e.status)+'</td>'+
        '<td style="font-family:monospace">'+(e.metric!=null?Number(e.metric).toFixed(6):'—')+'</td>'+
        '<td class="dim">'+ts(e.startedAt)+'</td>'+
        '<td class="dim">'+ts(e.finishedAt)+'</td></tr>').join('')
    : '<tr><td colspan="6" class="none">no experiments yet</td></tr>';

  const ms = (s.metrics||[]).slice(-20).reverse();
  document.getElementById('mtc').textContent = (s.metrics||[]).length;
  document.getElementById('mt').innerHTML = ms.length
    ? ms.map((m,i) =>
        '<tr><td class="dim">'+(ms.length-i)+'</td>'+
        '<td>'+x(m.experiment)+'</td>'+
        '<td style="font-family:monospace">'+Number(m.value).toFixed(6)+'</td>'+
        '<td class="dim">'+ts(m.at)+'</td>'+
        '<td class="dim">'+x(JSON.stringify(m.params||{}))+'</td></tr>').join('')
    : '<tr><td colspan="5" class="none">no metrics yet</td></tr>';

  const logs = (s.logs||[]).slice(-100);
  document.getElementById('lc').textContent = (s.logs||[]).length;
  const lb = document.getElementById('lb');
  const lb_bot = lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 8;
  lb.innerHTML = logs.map(l =>
    '<span class="dim">'+ts(l.at)+'</span> <span class="lv-'+x(l.level)+'">'+x(l.msg)+'</span>\n'
  ).join('');
  if (lb_bot) lb.scrollTop = lb.scrollHeight;
}

function chart(metrics) {
  const svg = document.getElementById('ch');
  const pts = metrics.slice(-30);
  if (pts.length < 2) {
    svg.innerHTML = '<text x="50%" y="50%" fill="currentColor" opacity=".3" font-size="10" text-anchor="middle" dominant-baseline="middle">waiting for metrics…</text>';
    return;
  }
  const vals = pts.map(m => m.value);
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
  const W = 400, H = 64, P = 4;
  const poly = pts.map((m,i) => {
    const cx = P + i*(W-P*2)/(pts.length-1);
    const cy = P + (1-(m.value-mn)/rng)*(H-P*2);
    return cx.toFixed(1)+','+cy.toFixed(1);
  }).join(' ');
  svg.innerHTML =
    '<polyline points="'+poly+'" fill="none" stroke="#8eca9d" stroke-width="1.5" stroke-linejoin="round"/>'+
    pts.map((m,i) => {
      const cx = P+i*(W-P*2)/(pts.length-1);
      const cy = P+(1-(m.value-mn)/rng)*(H-P*2);
      return '<circle cx="'+cx.toFixed(1)+'" cy="'+cy.toFixed(1)+'" r="2" fill="#8eca9d"/>';
    }).join('');
}

function renderActivity(evs) {
  const box = document.getElementById('ab');
  document.getElementById('ac').textContent = evs.length;
  const was_bot = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.innerHTML = evs.slice(0, 80).map(ev => {
    let body = ev.content ? x(ev.content.slice(0,200))
             : ev.toolName ? x(ev.toolName + (ev.command ? ' '+ev.command.slice(0,80) : ''))
             : ev.error ? x(String(ev.error).slice(0,200))
             : '';
    return '<span class="dim">'+ts(ev.ts)+'</span> ['+x(ev.type)+'] '+body+'\n';
  }).join('') || '<span class="none">no agent activity yet</span>';
  if (was_bot) box.scrollTop = box.scrollHeight;
}

async function act(a) { try { await fetch('/api/'+a, {method:'POST'}); } catch {} }

function connect() {
  const es = new EventSource('/api/events');
  document.getElementById('dot').className = 'dot';
  es.onopen   = () => document.getElementById('dot').className = 'dot live';
  es.onmessage = e => { state = JSON.parse(e.data); render(state); };
  es.onerror   = () => document.getElementById('dot').className = 'dot';
  // Named 'copilot' events bridged from session.on() by extension.mjs.
  // New connections receive a buffer replay from the server.
  es.addEventListener('copilot', e => {
    activity.unshift(JSON.parse(e.data));
    if (activity.length > 100) activity.pop();
    renderActivity(activity);
  });
}

connect();
</script>
</body>
</html>`;
}

// ── Static export snapshot ────────────────────────────────────────────────────
// Same style direction as the live dashboard — minimal, auto light/dark.

export function buildExportHTML(state) {
  const now = new Date().toISOString();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>[ autoresearch snapshot ]</title>
<style>
:root{--a:#8eca9d}
*{box-sizing:border-box;color-scheme:light dark}
body{font:100%/1.6 system-ui;max-width:900px;margin:0 auto;padding:1rem 1.25rem}
header{display:flex;align-items:baseline;gap:.75rem;flex-wrap:wrap;border-bottom:2px solid var(--a);padding-bottom:.4rem;margin-bottom:1.1rem}
header h1{font:.9rem/1 monospace;font-weight:700;margin:0}
.st{font-family:monospace;font-size:.82rem}
h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;border-bottom:1px solid var(--a);padding-bottom:.15rem;margin:1.3rem 0 .5rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:.6rem;margin-bottom:1rem}
.card{border:1px solid color-mix(in srgb,var(--a) 30%,transparent);padding:.55rem .7rem}
.lbl{font-size:.65rem;text-transform:uppercase;letter-spacing:.09em;opacity:.5;margin-bottom:.1rem}
.big{font:1.25rem/1.2 monospace;font-weight:600}
.sub{font-size:.7rem;opacity:.5;margin-top:.1rem}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;text-align:left;padding:.25rem .35rem;border-bottom:1px solid var(--a)}
td{padding:.22rem .35rem;border-bottom:1px solid color-mix(in srgb,var(--a) 20%,transparent);vertical-align:top}
.log{font:.77rem/1.55 'SFMono-Regular',Consolas,monospace;max-height:14rem;overflow-y:auto;
  border:1px solid color-mix(in srgb,var(--a) 35%,transparent);padding:.4rem .5rem;white-space:pre-wrap}
.dim{opacity:.4;font-size:.85em}
.none{opacity:.4;font-style:italic}
.note{font-size:.72rem;opacity:.45;margin-bottom:1.1rem}
</style>
</head>
<body>
<header>
  <h1>[ autoresearch snapshot ]</h1>
  <span class="st">[${e(state.status||'idle')}]</span>
</header>
<p class="note">Exported ${now} · Read-only snapshot. Open the live dashboard for real-time data.</p>

<div class="cards">
  <div class="card"><div class="lbl">Goal</div><div>${e(state.goal)}</div></div>
  <div class="card"><div class="lbl">Benchmark</div><code style="font-size:.82rem">${e(state.benchmarkCommand)}</code></div>
  <div class="card">
    <div class="lbl">Best Metric ★</div>
    <div class="big">${state.bestMetric ? Number(state.bestMetric.value).toFixed(6) : '—'}</div>
    <div class="sub">${state.bestMetric ? e(state.bestMetric.experiment)+' · '+new Date(state.bestMetric.at).toLocaleTimeString() : ''}</div>
  </div>
  <div class="card">
    <div class="lbl">Session</div>
    <div style="font-family:monospace;font-size:.78rem">${e(state.sessionId?.slice(0,8))}…</div>
    <div class="sub">${state.startedAt ? 'started '+new Date(state.startedAt).toLocaleTimeString() : ''}</div>
  </div>
</div>

<h2>Experiments (${(state.experiments||[]).length})</h2>
<table>
  <thead><tr><th>#</th><th>Name</th><th>Status</th><th>Metric</th><th>Started</th><th>Finished</th></tr></thead>
  <tbody>
    ${(state.experiments||[]).slice().reverse().map((ex,i,arr) =>
      '<tr><td class="dim">'+(arr.length-i)+'</td><td>'+e(ex.name)+'</td><td>'+e(ex.status)+'</td>'+
      '<td style="font-family:monospace">'+(ex.metric!=null?Number(ex.metric).toFixed(6):'—')+'</td>'+
      '<td class="dim">'+(ex.startedAt?new Date(ex.startedAt).toLocaleTimeString():'—')+'</td>'+
      '<td class="dim">'+(ex.finishedAt?new Date(ex.finishedAt).toLocaleTimeString():'—')+'</td></tr>'
    ).join('') || '<tr><td colspan="6" class="none">no experiments</td></tr>'}
  </tbody>
</table>

<h2>Metrics (last 50 of ${(state.metrics||[]).length})</h2>
<table>
  <thead><tr><th>#</th><th>Experiment</th><th>Value</th><th>At</th><th>Params</th></tr></thead>
  <tbody>
    ${(state.metrics||[]).slice(-50).reverse().map((m,i,arr) =>
      '<tr><td class="dim">'+(arr.length-i)+'</td><td>'+e(m.experiment)+'</td>'+
      '<td style="font-family:monospace">'+Number(m.value).toFixed(6)+'</td>'+
      '<td class="dim">'+(m.at?new Date(m.at).toLocaleTimeString():'—')+'</td>'+
      '<td class="dim">'+e(JSON.stringify(m.params||{}))+'</td></tr>'
    ).join('') || '<tr><td colspan="5" class="none">no metrics</td></tr>'}
  </tbody>
</table>

<h2>Logs (${(state.logs||[]).length})</h2>
<div class="log">${
  (state.logs||[]).map(l =>
    '<span class="dim">'+(l.at?new Date(l.at).toLocaleTimeString():'')+' </span>'+e(l.msg)
  ).join('\n') || '<span class="none">no logs</span>'
}</div>

<script>window.__AUTORESEARCH_STATE__ = ${JSON.stringify(state)};</script>
</body>
</html>`;
}

function e(s) {
  return String(s ?? '—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
