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

function buildDashboardHTML(port) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoResearch Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;padding:0;min-height:100vh}
a{color:#58a6ff}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10}
.topbar h1{font-size:16px;font-weight:600;flex:1}
.badge{padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.badge-idle{background:#21262d;color:#8b949e}
.badge-running{background:#1a4a1a;color:#56d364}
.badge-paused{background:#3d2b00;color:#e3b341}
.badge-stopped{background:#2d1010;color:#f85149}
.sse-dot{width:8px;height:8px;border-radius:50%;background:#30363d;flex-shrink:0}
.sse-dot.live{background:#56d364;box-shadow:0 0 4px #56d364}
.container{max-width:1200px;margin:0 auto;padding:20px;display:grid;gap:16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
@media(max-width:700px){.grid2,.grid3{grid-template-columns:1fr}}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card h2{font-size:12px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
.card .value{font-size:20px;font-weight:600;word-break:break-all}
.card .sub{font-size:12px;color:#8b949e;margin-top:4px}
.best-card{border-color:#1c6b2f;background:#0d2518}
.best-card .value{color:#56d364}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#8b949e;font-weight:600;font-size:11px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #21262d;text-align:left}
td{padding:7px 8px;border-bottom:1px solid #161b22;vertical-align:top}
tr:hover td{background:#1c2128}
.status-running{color:#56d364}
.status-done{color:#58a6ff}
.status-failed{color:#f85149}
.log-box{background:#010409;border:1px solid #21262d;border-radius:6px;height:240px;overflow-y:auto;padding:10px;font-family:'SFMono-Regular',Consolas,monospace;font-size:12px;line-height:1.6}
.log-box .log-info{color:#8b949e}
.log-box .log-warn{color:#e3b341}
.log-box .log-error{color:#f85149}
.log-time{color:#484f58;margin-right:6px}
.btn-group{display:flex;gap:8px;margin-top:10px}
button{padding:7px 16px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#e6edf3;font-size:13px;cursor:pointer;font-weight:500}
button:hover{background:#30363d}
button:disabled{opacity:.4;cursor:not-allowed}
.btn-pause{border-color:#e3b341;color:#e3b341}
.btn-resume{border-color:#56d364;color:#56d364}
.metric-chart{height:80px;width:100%}
.empty{color:#484f58;font-style:italic;font-size:13px;padding:10px 0}
</style>
</head>
<body>
<div class="topbar">
  <h1>🔬 AutoResearch Dashboard</h1>
  <span id="status-badge" class="badge badge-idle">idle</span>
  <div id="sse-dot" class="sse-dot" title="SSE stream"></div>
</div>
<div class="container">
  <div class="grid3">
    <div class="card">
      <h2>Goal</h2>
      <div id="goal" class="value" style="font-size:14px;color:#e6edf3">—</div>
    </div>
    <div class="card">
      <h2>Benchmark Command</h2>
      <div id="benchmark" class="value" style="font-size:13px;font-family:monospace;color:#79c0ff">—</div>
    </div>
    <div class="card best-card">
      <h2>⭐ Best Metric</h2>
      <div id="best-value" class="value">—</div>
      <div id="best-sub" class="sub"></div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2>Session Info</h2>
      <table>
        <tr><td style="color:#8b949e;width:130px">Session ID</td><td id="session-id">—</td></tr>
        <tr><td style="color:#8b949e">Started</td><td id="started-at">—</td></tr>
        <tr><td style="color:#8b949e">Last Updated</td><td id="updated-at">—</td></tr>
        <tr><td style="color:#8b949e">Current Exp.</td><td id="current-exp">—</td></tr>
      </table>
      <div class="btn-group">
        <button id="btn-pause" class="btn-pause" onclick="doAction('pause')">⏸ Pause</button>
        <button id="btn-resume" class="btn-resume" onclick="doAction('resume')">▶ Resume</button>
        <button onclick="window.open('/api/export')">📥 Export</button>
      </div>
    </div>
    <div class="card">
      <h2>Metric Trend (last 30)</h2>
      <svg id="metric-chart" class="metric-chart" viewBox="0 0 400 80" preserveAspectRatio="none"></svg>
      <div id="metric-count" class="sub" style="margin-top:6px"></div>
    </div>
  </div>

  <div class="card">
    <h2>Experiments</h2>
    <div id="experiments-wrap">
      <table>
        <thead><tr><th>#</th><th>ID</th><th>Name</th><th>Status</th><th>Metric</th><th>Started</th><th>Finished</th></tr></thead>
        <tbody id="experiments-tbody"></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Recent Metrics (last 20)</h2>
    <table>
      <thead><tr><th>#</th><th>Experiment</th><th>Value</th><th>At</th><th>Params</th></tr></thead>
      <tbody id="metrics-tbody"></tbody>
    </table>
  </div>

  <div class="card">
    <h2>Logs <span id="log-count" style="font-weight:400;color:#484f58"></span></h2>
    <div id="log-box" class="log-box"></div>
  </div>

  <div class="card">
    <h2>Agent Activity <span id="activity-count" style="font-weight:400;color:#484f58"></span></h2>
    <div id="activity-box" class="log-box"></div>
  </div>
</div>

<script>
const PORT = ${port};
let state = null;
let autoScroll = true;

// SSE connection
function connect() {
  const es = new EventSource('/api/events');
  document.getElementById('sse-dot').className = 'sse-dot';
  es.onopen = () => document.getElementById('sse-dot').className = 'sse-dot live';
  es.onmessage = (e) => { state = JSON.parse(e.data); render(state); };
  es.onerror = () => { document.getElementById('sse-dot').className = 'sse-dot'; };
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}
function fmtShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function statusClass(s) {
  if (s === 'running') return 'status-running';
  if (s === 'done') return 'status-done';
  if (s === 'failed') return 'status-failed';
  return '';
}

function render(s) {
  if (!s) return;

  // Status badge
  const badge = document.getElementById('status-badge');
  badge.textContent = s.status || 'idle';
  badge.className = 'badge badge-' + (s.status || 'idle');

  // Cards
  document.getElementById('goal').textContent = s.goal || '—';
  document.getElementById('benchmark').textContent = s.benchmarkCommand || '—';

  if (s.bestMetric) {
    document.getElementById('best-value').textContent = 
      typeof s.bestMetric.value === 'number' ? s.bestMetric.value.toFixed(6) : s.bestMetric.value;
    document.getElementById('best-sub').textContent =
      (s.bestMetric.experiment || '') + '  ' + fmtShort(s.bestMetric.at);
  } else {
    document.getElementById('best-value').textContent = '—';
    document.getElementById('best-sub').textContent = '';
  }

  // Session info
  document.getElementById('session-id').textContent = s.sessionId ? s.sessionId.slice(0,8) + '…' : '—';
  document.getElementById('started-at').textContent = fmt(s.startedAt);
  document.getElementById('updated-at').textContent = fmt(s.updatedAt);
  document.getElementById('current-exp').textContent = s.currentExperiment || '—';

  // Buttons
  const paused = s.paused || s.status === 'paused';
  const running = s.status === 'running' || s.status === 'paused';
  document.getElementById('btn-pause').disabled = !running || paused;
  document.getElementById('btn-resume').disabled = !paused;

  // Metric chart
  renderChart(s.metrics || []);
  document.getElementById('metric-count').textContent =
    (s.metrics || []).length + ' metric(s) recorded';

  // Experiments
  const exps = (s.experiments || []).slice().reverse();
  const eTbody = document.getElementById('experiments-tbody');
  if (exps.length === 0) {
    eTbody.innerHTML = '<tr><td colspan="7" class="empty">No experiments yet</td></tr>';
  } else {
    eTbody.innerHTML = exps.slice(0, 50).map((e, i) =>
      '<tr>' +
      '<td style="color:#484f58">' + (exps.length - i) + '</td>' +
      '<td style="font-family:monospace;font-size:11px">' + esc(e.id?.slice(0,8)) + '…</td>' +
      '<td>' + esc(e.name) + '</td>' +
      '<td class="' + statusClass(e.status) + '">' + esc(e.status) + '</td>' +
      '<td>' + (e.metric != null ? Number(e.metric).toFixed(6) : '—') + '</td>' +
      '<td style="color:#8b949e;font-size:11px">' + fmtShort(e.startedAt) + '</td>' +
      '<td style="color:#8b949e;font-size:11px">' + fmtShort(e.finishedAt) + '</td>' +
      '</tr>'
    ).join('');
  }

  // Recent metrics
  const metrics = (s.metrics || []).slice(-20).reverse();
  const mTbody = document.getElementById('metrics-tbody');
  if (metrics.length === 0) {
    mTbody.innerHTML = '<tr><td colspan="5" class="empty">No metrics yet</td></tr>';
  } else {
    mTbody.innerHTML = metrics.map((m, i) =>
      '<tr>' +
      '<td style="color:#484f58">' + (metrics.length - i) + '</td>' +
      '<td>' + esc(m.experiment) + '</td>' +
      '<td style="color:#79c0ff;font-family:monospace">' + Number(m.value).toFixed(6) + '</td>' +
      '<td style="color:#8b949e;font-size:11px">' + fmtShort(m.at) + '</td>' +
      '<td style="font-size:11px;color:#8b949e">' + esc(JSON.stringify(m.params || {})) + '</td>' +
      '</tr>'
    ).join('');
  }

  // Logs
  const logs = (s.logs || []).slice(-100);
  document.getElementById('log-count').textContent = '(' + (s.logs || []).length + ')';
  const box = document.getElementById('log-box');
  const wasBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.innerHTML = logs.map(l =>
    '<div><span class="log-time">' + fmtShort(l.at) + '</span>' +
    '<span class="log-' + esc(l.level) + '">' + esc(l.msg) + '</span></div>'
  ).join('');
  if (wasBottom || autoScroll) box.scrollTop = box.scrollHeight;
}

function renderChart(metrics) {
  const svg = document.getElementById('metric-chart');
  const pts = metrics.slice(-30);
  if (pts.length < 2) { svg.innerHTML = '<text x="50%" y="50%" fill="#484f58" font-size="11" text-anchor="middle" dominant-baseline="middle">Waiting for metrics…</text>'; return; }
  const vals = pts.map(m => m.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const W = 400, H = 80, PAD = 6;
  const xStep = (W - PAD * 2) / (pts.length - 1);
  const points = pts.map((m, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - (m.value - min) / range) * (H - PAD * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  svg.innerHTML =
    '<polyline points="' + points + '" fill="none" stroke="#58a6ff" stroke-width="1.5" stroke-linejoin="round"/>' +
    pts.map((m, i) => {
      const x = PAD + i * xStep;
      const y = PAD + (1 - (m.value - min) / range) * (H - PAD * 2);
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2" fill="#58a6ff"/>';
    }).join('');
}

async function doAction(action) {
  try {
    await fetch('/api/' + action, { method: 'POST' });
  } catch (e) {
    console.error(e);
  }
}

// ── Agent Activity feed (Copilot CLI session events via SSE named events) ────────

const activityLog = [];

/**
 * Colour map for Copilot CLI session event types.
 * The extension bridges session.on() and hook callbacks to this SSE channel.
 */
const ACTIVITY_COLORS = {
  'tool.start':           '#79c0ff',
  'tool.end':             '#56d364',
  'tool.denied':          '#f85149',
  'tool.metrics':         '#e3b341',
  'assistant.message':    '#e6edf3',
  'session.start':        '#56d364',
  'session.end':          '#8b949e',
  'session.shutdown':     '#8b949e',
  'error':                '#f85149',
};

function renderActivity(events) {
  const box = document.getElementById('activity-box');
  document.getElementById('activity-count').textContent = '(' + events.length + ')';
  const wasBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
  box.innerHTML = events.slice(0, 80).map(ev => {
    const col = ACTIVITY_COLORS[ev.type] || '#8b949e';
    let body;
    if (ev.content)   body = esc(ev.content.slice(0, 300));
    else if (ev.toolName) body = esc(ev.toolName) + (ev.command ? ': ' + esc(String(ev.command).slice(0, 100)) : '');
    else if (ev.error)    body = esc(String(ev.error).slice(0, 200));
    else                  body = esc(JSON.stringify(ev).slice(0, 200));
    return '<div style="margin-bottom:3px">' +
      '<span class="log-time">' + fmtShort(ev.ts) + '</span>' +
      '<span style="color:' + col + '">[' + esc(ev.type) + ']</span> ' +
      '<span style="color:#8b949e">' + body + '</span></div>';
  }).join('') || '<div class="empty">No agent activity yet</div>';
  if (wasBottom) box.scrollTop = box.scrollHeight;
}

// SSE connection — receives both default state messages and named 'copilot' events.
function connect() {
  const es = new EventSource('/api/events');
  document.getElementById('sse-dot').className = 'sse-dot';
  es.onopen  = () => document.getElementById('sse-dot').className = 'sse-dot live';
  es.onmessage = (e) => { state = JSON.parse(e.data); render(state); };
  es.onerror  = () => { document.getElementById('sse-dot').className = 'sse-dot'; };

  // Named 'copilot' events: Copilot CLI session.on() + hook callbacks bridged
  // by the extension process. New connections receive a replay of the buffer.
  es.addEventListener('copilot', (e) => {
    const ev = JSON.parse(e.data);
    activityLog.unshift(ev);
    if (activityLog.length > 100) activityLog.pop();
    renderActivity(activityLog);
  });
}

connect();
</script>
</body>
</html>`;
}

// ── Static export snapshot ────────────────────────────────────────────────────

export function buildExportHTML(state) {
  const ts = new Date().toISOString();
  const safeState = JSON.stringify(state);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoResearch Snapshot — ${ts}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;padding:20px}
.topbar{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:10px;margin-bottom:16px}
.topbar h1{font-size:15px;font-weight:600;flex:1}
.badge{padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase}
.badge-idle{background:#21262d;color:#8b949e}.badge-running{background:#1a4a1a;color:#56d364}
.badge-paused{background:#3d2b00;color:#e3b341}.badge-stopped{background:#2d1010;color:#f85149}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:14px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card h2{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.val{font-size:18px;font-weight:600}.sub{font-size:12px;color:#8b949e;margin-top:4px}
.best{border-color:#1c6b2f;background:#0d2518}.best .val{color:#56d364}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}
th{color:#8b949e;font-size:10px;text-transform:uppercase;padding:5px 6px;border-bottom:1px solid #21262d;text-align:left}
td{padding:5px 6px;border-bottom:1px solid #161b22}
.log-box{background:#010409;border:1px solid #21262d;border-radius:6px;max-height:300px;overflow-y:auto;padding:8px;font-family:monospace;font-size:11px;line-height:1.6;margin-top:6px}
.log-info{color:#8b949e}.log-warn{color:#e3b341}.log-error{color:#f85149}
.log-time{color:#484f58;margin-right:6px}
.snap-note{color:#484f58;font-size:11px;margin-bottom:14px}
</style>
</head>
<body>
<div class="topbar">
  <h1>🔬 AutoResearch — Static Snapshot</h1>
  <span class="badge badge-${state.status || 'idle'}">${state.status || 'idle'}</span>
</div>
<p class="snap-note">Exported at ${ts} · This is a read-only snapshot. Open the live dashboard for real-time data.</p>
<div class="grid">
  <div class="card">
    <h2>Goal</h2>
    <div class="val" style="font-size:14px">${esc(state.goal)}</div>
  </div>
  <div class="card">
    <h2>Benchmark Command</h2>
    <div class="val" style="font-size:13px;font-family:monospace;color:#79c0ff">${esc(state.benchmarkCommand)}</div>
  </div>
  <div class="card best">
    <h2>⭐ Best Metric</h2>
    <div class="val">${state.bestMetric ? Number(state.bestMetric.value).toFixed(6) : '—'}</div>
    <div class="sub">${state.bestMetric ? esc(state.bestMetric.experiment) + ' at ' + new Date(state.bestMetric.at).toLocaleString() : ''}</div>
  </div>
  <div class="card">
    <h2>Session Info</h2>
    <div style="font-size:12px;line-height:1.8;color:#8b949e">
      ID: <span style="color:#e6edf3">${esc(state.sessionId?.slice(0,8))}…</span><br>
      Started: <span style="color:#e6edf3">${state.startedAt ? new Date(state.startedAt).toLocaleString() : '—'}</span><br>
      Updated: <span style="color:#e6edf3">${state.updatedAt ? new Date(state.updatedAt).toLocaleString() : '—'}</span>
    </div>
  </div>
</div>

<div class="card" style="margin-bottom:14px">
  <h2>Experiments (${(state.experiments || []).length})</h2>
  <table>
    <thead><tr><th>#</th><th>Name</th><th>Status</th><th>Metric</th><th>Started</th><th>Finished</th></tr></thead>
    <tbody>
      ${(state.experiments || []).slice().reverse().map((e, i) =>
        `<tr><td style="color:#484f58">${(state.experiments.length - i)}</td><td>${esc(e.name)}</td><td>${esc(e.status)}</td><td>${e.metric != null ? Number(e.metric).toFixed(6) : '—'}</td><td style="color:#8b949e">${e.startedAt ? new Date(e.startedAt).toLocaleTimeString() : '—'}</td><td style="color:#8b949e">${e.finishedAt ? new Date(e.finishedAt).toLocaleTimeString() : '—'}</td></tr>`
      ).join('') || '<tr><td colspan="6" style="color:#484f58;font-style:italic;padding:8px">No experiments</td></tr>'}
    </tbody>
  </table>
</div>

<div class="card" style="margin-bottom:14px">
  <h2>Metrics (last 50 of ${(state.metrics || []).length})</h2>
  <table>
    <thead><tr><th>#</th><th>Experiment</th><th>Value</th><th>At</th><th>Params</th></tr></thead>
    <tbody>
      ${(state.metrics || []).slice(-50).reverse().map((m, i) =>
        `<tr><td style="color:#484f58">${(Math.min(state.metrics.length, 50) - i)}</td><td>${esc(m.experiment)}</td><td style="font-family:monospace;color:#79c0ff">${Number(m.value).toFixed(6)}</td><td style="color:#8b949e">${m.at ? new Date(m.at).toLocaleTimeString() : '—'}</td><td style="font-size:11px;color:#8b949e">${esc(JSON.stringify(m.params || {}))}</td></tr>`
      ).join('') || '<tr><td colspan="5" style="color:#484f58;font-style:italic;padding:8px">No metrics</td></tr>'}
    </tbody>
  </table>
</div>

<div class="card">
  <h2>Logs (${(state.logs || []).length})</h2>
  <div class="log-box">
    ${(state.logs || []).map(l =>
      `<div><span class="log-time">${l.at ? new Date(l.at).toLocaleTimeString() : ''}</span><span class="log-${esc(l.level)}">${esc(l.msg)}</span></div>`
    ).join('') || '<span style="color:#484f58;font-style:italic">No logs</span>'}
  </div>
</div>

<script>
// Embed raw state for programmatic access
window.__AUTORESEARCH_STATE__ = ${safeState};
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s ?? '—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
