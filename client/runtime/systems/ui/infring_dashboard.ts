#!/usr/bin/env tsx
// Unified dashboard lane: TypeScript-first client UI over Rust-core authority.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { WebSocketServer } = require('ws');
const { ROOT, resolveBinary } = require('../ops/run_protheus_ops.js');

const DASHBOARD_DIR = __dirname;
const CLIENT_TS_PATH = path.resolve(DASHBOARD_DIR, 'infring_dashboard_client.tsx');
const FALLBACK_TS_PATH = path.resolve(DASHBOARD_DIR, 'infring_dashboard_fallback.ts');
const CSS_PATH = path.resolve(DASHBOARD_DIR, 'infring_dashboard.css');
const STATE_DIR = path.resolve(ROOT, 'client/runtime/local/state/ui/infring_dashboard');
const ACTION_DIR = path.resolve(STATE_DIR, 'actions');
const ACTION_LATEST_PATH = path.resolve(ACTION_DIR, 'latest.json');
const ACTION_HISTORY_PATH = path.resolve(ACTION_DIR, 'history.jsonl');
const SNAPSHOT_LATEST_PATH = path.resolve(STATE_DIR, 'latest_snapshot.json');
const SNAPSHOT_HISTORY_PATH = path.resolve(STATE_DIR, 'snapshot_history.jsonl');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const DEFAULT_TEAM = 'ops';
const DEFAULT_REFRESH_MS = 2000;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLen = 120) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function parsePositiveInt(value, fallback, min = 1, max = 65535) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function parseJsonLoose(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function parseFlags(argv = []) {
  const out = {
    mode: 'serve',
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    team: DEFAULT_TEAM,
    refreshMs: DEFAULT_REFRESH_MS,
    pretty: true,
  };

  let modeSet = false;
  for (const token of argv) {
    const value = String(token || '').trim();
    if (!value) continue;

    if (!modeSet && !value.startsWith('--')) {
      out.mode = value;
      modeSet = true;
      continue;
    }
    if (value.startsWith('--host=')) {
      out.host = cleanText(value.split('=').slice(1).join('='), 100) || DEFAULT_HOST;
      continue;
    }
    if (value.startsWith('--port=')) {
      out.port = parsePositiveInt(value.split('=').slice(1).join('='), DEFAULT_PORT, 1, 65535);
      continue;
    }
    if (value.startsWith('--team=')) {
      out.team = cleanText(value.split('=').slice(1).join('='), 80) || DEFAULT_TEAM;
      continue;
    }
    if (value.startsWith('--refresh-ms=')) {
      out.refreshMs = parsePositiveInt(value.split('=').slice(1).join('='), DEFAULT_REFRESH_MS, 800, 60000);
      continue;
    }
    if (value === '--pretty=0' || value === '--pretty=false') {
      out.pretty = false;
      continue;
    }
  }
  return out;
}

function runLane(argv) {
  const env = { ...process.env, PROTHEUS_ROOT: ROOT };
  const opts = {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env,
    maxBuffer: 12 * 1024 * 1024,
  };
  const bin = resolveBinary();
  const proc = bin
    ? spawnSync(bin, argv, opts)
    : spawnSync(
        'cargo',
        ['run', '--quiet', '-p', 'protheus-ops-core', '--bin', 'protheus-ops', '--', ...argv],
        opts
      );

  const status = typeof proc.status === 'number' ? proc.status : 1;
  const stdout = typeof proc.stdout === 'string' ? proc.stdout : '';
  const stderr = typeof proc.stderr === 'string' ? proc.stderr : '';
  const payload = parseJsonLoose(stdout);
  return {
    ok: status === 0 && !!payload,
    status,
    stdout,
    stderr,
    payload,
    argv,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function recentFiles(rootDir, { limit = 25, maxDepth = 4, include }) {
  const out = [];
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (typeof include === 'function' && !include(fullPath)) continue;
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        stat = null;
      }
      if (!stat) continue;
      out.push({
        path: path.relative(ROOT, fullPath),
        full_path: fullPath,
        mtime_ms: stat.mtimeMs || 0,
        mtime: stat.mtime.toISOString(),
        size_bytes: stat.size,
      });
    }
  }

  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out.slice(0, limit);
}

function readTailLines(filePath, maxBytes = 48 * 1024, maxLines = 8) {
  let data = '';
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const size = stat.size - start;
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, start);
    fs.closeSync(fd);
    data = buffer.toString('utf8');
  } catch {
    return [];
  }
  return data
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines);
}

function collectLogEvents() {
  const logRoots = [
    path.resolve(ROOT, 'core/local/state/ops'),
    path.resolve(ROOT, 'client/runtime/local/state'),
  ];
  const rows = [];
  for (const rootDir of logRoots) {
    const files = recentFiles(rootDir, {
      limit: 8,
      maxDepth: 4,
      include: (fullPath) => fullPath.endsWith('history.jsonl') || fullPath.endsWith('.jsonl'),
    });
    for (const file of files) {
      const lines = readTailLines(file.full_path);
      for (const line of lines) {
        const payload = parseJsonLoose(line);
        rows.push({
          ts: payload && payload.ts ? payload.ts : file.mtime,
          source: file.path,
          message: payload && payload.type ? payload.type : line.slice(0, 220),
        });
      }
    }
  }
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return rows.slice(0, 40);
}

function collectReceipts() {
  const roots = [
    path.resolve(ROOT, 'core/local/state/ops'),
    path.resolve(ROOT, 'client/runtime/local/state'),
  ];
  const files = [];
  for (const rootDir of roots) {
    files.push(
      ...recentFiles(rootDir, {
        limit: 30,
        maxDepth: 4,
        include: (fullPath) =>
          fullPath.endsWith('latest.json') ||
          fullPath.endsWith('history.jsonl') ||
          fullPath.endsWith('.receipt.json'),
      })
    );
  }
  files.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return files.slice(0, 32).map((file) => ({
    kind: file.path.endsWith('.jsonl') ? 'timeline' : 'receipt',
    path: file.path,
    mtime: file.mtime,
    size_bytes: file.size_bytes,
  }));
}

function collectMemoryArtifacts() {
  const roots = [
    path.resolve(ROOT, 'client/runtime/local/state'),
    path.resolve(ROOT, 'core/local/state/ops'),
  ];
  const rows = [];
  for (const rootDir of roots) {
    rows.push(
      ...recentFiles(rootDir, {
        limit: 20,
        maxDepth: 3,
        include: (fullPath) =>
          fullPath.endsWith('latest.json') ||
          fullPath.endsWith('.jsonl') ||
          fullPath.endsWith('queue.json'),
      }).map((row) => ({
        scope: row.path.includes('memory') ? 'memory' : 'state',
        kind: row.path.endsWith('.jsonl') ? 'timeline' : 'snapshot',
        path: row.path,
        mtime: row.mtime,
      }))
    );
  }
  rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return rows.slice(0, 30);
}

function asMetricRows(healthPayload) {
  const metrics = healthPayload && healthPayload.dashboard_metrics && typeof healthPayload.dashboard_metrics === 'object'
    ? healthPayload.dashboard_metrics
    : {};
  return Object.entries(metrics).map(([name, value]) => {
    const row = value && typeof value === 'object' ? value : {};
    const target = row.target_max != null ? `<= ${row.target_max}` : row.target_min != null ? `>= ${row.target_min}` : 'n/a';
    return {
      name,
      status: row.status || 'unknown',
      value: row.value,
      target,
    };
  });
}

function buildSnapshot(opts = {}) {
  const team = cleanText(opts.team || DEFAULT_TEAM, 80) || DEFAULT_TEAM;
  const healthLane = runLane(['health-status', 'dashboard']);
  const appLane = runLane(['app-plane', 'history', '--app=chat-ui']);
  const collabLane = runLane(['collab-plane', 'dashboard', `--team=${team}`]);
  const skillsLane = runLane(['skills-plane', 'dashboard']);

  const health = healthLane.payload || {};
  const app = appLane.payload || {};
  const collab = collabLane.payload || {};
  const skills = skillsLane.payload || {};

  const snapshot = {
    ok: !!(healthLane.ok && appLane.ok && collabLane.ok && skillsLane.ok),
    type: 'infring_dashboard_snapshot',
    ts: nowIso(),
    metadata: {
      root: ROOT,
      team,
      refresh_ms: opts.refreshMs || DEFAULT_REFRESH_MS,
      authority: 'rust_core_lanes',
      lanes: {
        health: healthLane.argv.join(' '),
        app: appLane.argv.join(' '),
        collab: collabLane.argv.join(' '),
        skills: skillsLane.argv.join(' '),
      },
    },
    health,
    app,
    collab,
    skills,
    memory: {
      entries: collectMemoryArtifacts(),
    },
    receipts: {
      recent: collectReceipts(),
      action_history_path: path.relative(ROOT, ACTION_HISTORY_PATH),
    },
    logs: {
      recent: collectLogEvents(),
    },
    apm: {
      metrics: asMetricRows(health),
      checks: health.checks || {},
      alerts: health.alerts || {},
    },
  };
  const receiptHash = sha256(JSON.stringify(snapshot));
  return { ...snapshot, receipt_hash: receiptHash };
}

function writeSnapshotReceipt(snapshot) {
  writeJson(SNAPSHOT_LATEST_PATH, snapshot);
  appendJsonl(SNAPSHOT_HISTORY_PATH, snapshot);
}

function writeActionReceipt(action, payload, laneResult) {
  const record = {
    ok: laneResult && laneResult.ok === true,
    type: 'infring_dashboard_action_receipt',
    ts: nowIso(),
    action: cleanText(action, 120),
    payload: payload && typeof payload === 'object' ? payload : {},
    lane_status: laneResult ? laneResult.status : 1,
    lane_argv: laneResult ? laneResult.argv : [],
    lane_receipt_hash:
      laneResult &&
      laneResult.payload &&
      typeof laneResult.payload === 'object' &&
      laneResult.payload.receipt_hash
        ? String(laneResult.payload.receipt_hash)
        : null,
  };
  const withHash = { ...record, receipt_hash: sha256(JSON.stringify(record)) };
  writeJson(ACTION_LATEST_PATH, withHash);
  appendJsonl(ACTION_HISTORY_PATH, withHash);
  return withHash;
}

function runAction(action, payload) {
  const normalizedAction = cleanText(action, 80);
  const data = payload && typeof payload === 'object' ? payload : {};
  if (normalizedAction === 'dashboard.ui.toggleControls') {
    const open = !!(data && data.open);
    const ts = nowIso();
    const eventPayload = { event: 'toggle_controls', open, ts };
    return {
      ok: true,
      status: 0,
      argv: ['dashboard.ui.toggleControls'],
      payload: {
        ok: true,
        type: 'infring_dashboard_ui_event',
        event: eventPayload.event,
        open: eventPayload.open,
        ts: eventPayload.ts,
        receipt_hash: sha256(JSON.stringify(eventPayload)),
      },
    };
  }
  if (normalizedAction === 'dashboard.ui.toggleSection') {
    const section = cleanText(data.section || 'unknown', 80) || 'unknown';
    const open = !!(data && data.open);
    const ts = nowIso();
    const eventPayload = { event: 'toggle_section', section, open, ts };
    return {
      ok: true,
      status: 0,
      argv: ['dashboard.ui.toggleSection'],
      payload: {
        ok: true,
        type: 'infring_dashboard_ui_event',
        event: eventPayload.event,
        section: eventPayload.section,
        open: eventPayload.open,
        ts: eventPayload.ts,
        receipt_hash: sha256(JSON.stringify(eventPayload)),
      },
    };
  }
  if (normalizedAction === 'app.switchProvider') {
    const provider = cleanText(data.provider || 'openai', 60) || 'openai';
    const model = cleanText(data.model || 'gpt-5', 100) || 'gpt-5';
    return runLane(['app-plane', 'switch-provider', '--app=chat-ui', `--provider=${provider}`, `--model=${model}`]);
  }
  if (normalizedAction === 'app.chat') {
    const input = cleanText(data.input || data.message || '', 2000);
    if (!input) {
      return {
        ok: false,
        status: 2,
        argv: ['app-plane', 'run', '--app=chat-ui'],
        payload: {
          ok: false,
          type: 'infring_dashboard_action_error',
          error: 'chat_input_required',
        },
      };
    }
    return runLane(['app-plane', 'run', '--app=chat-ui', `--input=${input}`]);
  }
  if (normalizedAction === 'collab.launchRole') {
    const team = cleanText(data.team || DEFAULT_TEAM, 60) || DEFAULT_TEAM;
    const role = cleanText(data.role || 'analyst', 60) || 'analyst';
    const shadow =
      cleanText(data.shadow || `${team}-${role}-shadow`, 80) || `${team}-${role}-shadow`;
    return runLane([
      'collab-plane',
      'launch-role',
      `--team=${team}`,
      `--role=${role}`,
      `--shadow=${shadow}`,
    ]);
  }
  if (normalizedAction === 'skills.run') {
    const skill = cleanText(data.skill || '', 80);
    const input = cleanText(data.input || '', 600);
    if (!skill) {
      return {
        ok: false,
        status: 2,
        argv: ['skills-plane', 'run'],
        payload: {
          ok: false,
          type: 'infring_dashboard_action_error',
          error: 'skill_required',
        },
      };
    }
    const args = ['skills-plane', 'run', `--skill=${skill}`];
    if (input) args.push(`--input=${input}`);
    return runLane(args);
  }
  if (normalizedAction === 'dashboard.assimilate') {
    const target = cleanText(data.target || 'codex', 120) || 'codex';
    return runLane([
      'app-plane',
      'run',
      '--app=chat-ui',
      `--input=assimilate target ${target} with receipt-first safety`,
    ]);
  }
  if (normalizedAction === 'dashboard.benchmark') {
    return runLane(['health-status', 'dashboard']);
  }
  return {
    ok: false,
    status: 2,
    argv: [],
    payload: {
      ok: false,
      type: 'infring_dashboard_action_error',
      error: `unsupported_action:${normalizedAction}`,
    },
  };
}

function htmlShell() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>InfRing Unified Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://unpkg.com/reactflow@11.11.4/dist/style.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Manrope:wght@500;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/infring_dashboard.css">
</head>
<body>
  <div id="root">
    <main style="max-width:980px;margin:32px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">
      <h1 style="margin:0 0 8px 0">InfRing Dashboard</h1>
      <p style="margin:0 0 8px 0;color:#bfd3f5">Loading dashboard UI...</p>
      <p style="margin:0;color:#9eb9e4;font-size:12px">If this view remains blank, the compatibility renderer will auto-activate.</p>
    </main>
  </div>
  <script type="module" src="/assets/infring_dashboard_client.js"></script>
  <script defer src="/assets/infring_dashboard_fallback.js"></script>
  <script>
    (function () {
      function esc(v) {
        var s = String(v == null ? '' : v);
        return s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }
      function short(v, n) {
        var t = String(v == null ? '' : v).trim();
        if (!t) return 'n/a';
        if (t.length <= n) return t;
        return t.slice(0, n) + '...';
      }
      function bootInlineFallback() {
        var root = document.getElementById('root');
        if (!root) return;
        if (root.getAttribute('data-dashboard-hydrated')) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/dashboard/snapshot', true);
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          if (root.getAttribute('data-dashboard-hydrated')) return;
          if (xhr.status < 200 || xhr.status >= 300) {
            root.innerHTML =
              '<main style="max-width:980px;margin:32px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">' +
              '<h1 style="margin:0 0 8px 0">InfRing Dashboard</h1>' +
              '<p style="margin:0;color:#bfd3f5">UI compatibility fallback active.</p>' +
              '<p style="margin:8px 0 0 0;color:#9eb9e4;font-size:12px">Snapshot endpoint temporarily unavailable.</p>' +
              '</main>';
            root.setAttribute('data-dashboard-hydrated', 'inline-fallback');
            return;
          }
          var snap = null;
          try { snap = JSON.parse(xhr.responseText || '{}'); } catch (e) { snap = null; }
          if (!snap || typeof snap !== 'object') return;
          var provider = snap && snap.app && snap.app.settings ? snap.app.settings.provider : 'n/a';
          var model = snap && snap.app && snap.app.settings ? snap.app.settings.model : 'n/a';
          var alerts = snap && snap.health && snap.health.alerts ? snap.health.alerts.count : 0;
          root.innerHTML =
            '<main style="max-width:1200px;margin:20px auto;padding:16px;color:#e8f0ff;background:rgba(9,16,30,.72);border:1px solid rgba(122,163,255,.28);border-radius:14px">' +
            '<h1 style="margin:0 0 6px 0">InfRing Dashboard</h1>' +
            '<p style="margin:0;color:#bfd3f5">Compatibility UI active (core data live).</p>' +
            '<div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Provider</div><div style="font-size:18px;font-weight:700">' + esc(provider) + '</div></article>' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Model</div><div style="font-size:18px;font-weight:700">' + esc(model) + '</div></article>' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Open Alerts</div><div style="font-size:18px;font-weight:700">' + esc(alerts) + '</div></article>' +
            '<article style="padding:10px;border:1px solid rgba(122,163,255,.22);border-radius:10px;background:rgba(20,32,58,.8)"><div style="font-size:12px;color:#b9ceef">Receipt</div><div style="font-size:12px;font-family:ui-monospace,Menlo,monospace">' + esc(short(snap.receipt_hash, 28)) + '</div></article>' +
            '</div>' +
            '</main>';
          root.setAttribute('data-dashboard-hydrated', 'inline-fallback');
        };
        xhr.send(null);
      }
      window.setTimeout(bootInlineFallback, 1400);
    })();
  </script>
</body>
</html>`;
}

function transpileClientTs() {
  const source = readText(CLIENT_TS_PATH, '');
  if (!source) {
    throw new Error(`missing_client_source:${path.relative(ROOT, CLIENT_TS_PATH)}`);
  }
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      sourceMap: false,
      removeComments: false,
    },
    fileName: CLIENT_TS_PATH,
    reportDiagnostics: false,
  }).outputText;
}

function transpileFallbackTs() {
  const source = readText(FALLBACK_TS_PATH, '');
  if (!source) {
    throw new Error(`missing_fallback_source:${path.relative(ROOT, FALLBACK_TS_PATH)}`);
  }
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2018,
      sourceMap: false,
      removeComments: false,
    },
    fileName: FALLBACK_TS_PATH,
    reportDiagnostics: false,
  }).outputText;
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 1_500_000) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function runServe(flags) {
  const html = htmlShell();
  const css = readText(CSS_PATH, '');
  const clientJs = transpileClientTs();
  const fallbackJs = transpileFallbackTs();
  let latestSnapshot = buildSnapshot(flags);
  writeSnapshotReceipt(latestSnapshot);
  let updating = false;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${flags.host}:${flags.port}`);
    const pathname = reqUrl.pathname;

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
        sendText(res, 200, html, 'text/html; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard.css') {
        sendText(res, 200, css, 'text/css; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard_client.js') {
        sendText(res, 200, clientJs, 'text/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && pathname === '/assets/infring_dashboard_fallback.js') {
        sendText(res, 200, fallbackJs, 'text/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && pathname === '/api/dashboard/snapshot') {
        latestSnapshot = buildSnapshot(flags);
        writeSnapshotReceipt(latestSnapshot);
        sendJson(res, 200, latestSnapshot);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/dashboard/action') {
        const payload = await bodyJson(req);
        const action = cleanText(payload && payload.action ? payload.action : '', 80);
        const actionPayload = payload && payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
        const laneResult = runAction(action, actionPayload);
        const actionReceipt = writeActionReceipt(action, actionPayload, laneResult);
        latestSnapshot = buildSnapshot(flags);
        writeSnapshotReceipt(latestSnapshot);
        const ok = !!laneResult.ok;
        sendJson(res, ok ? 200 : 400, {
          ok,
          type: 'infring_dashboard_action_response',
          action,
          action_receipt: actionReceipt,
          lane: laneResult.payload || null,
          snapshot: latestSnapshot,
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          type: 'infring_dashboard_healthz',
          ts: nowIso(),
          receipt_hash: latestSnapshot.receipt_hash,
        });
        return;
      }
      sendJson(res, 404, {
        ok: false,
        type: 'infring_dashboard_not_found',
        path: pathname,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        type: 'infring_dashboard_request_error',
        error: cleanText(error && error.message ? error.message : String(error), 260),
      });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const wsClients = new Set();
  wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.send(JSON.stringify({ type: 'snapshot', snapshot: latestSnapshot }));
    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', `http://${flags.host}:${flags.port}`);
    if (reqUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const interval = setInterval(() => {
    if (updating) return;
    updating = true;
    try {
      latestSnapshot = buildSnapshot(flags);
      writeSnapshotReceipt(latestSnapshot);
      const envelope = JSON.stringify({ type: 'snapshot', snapshot: latestSnapshot });
      for (const client of wsClients) {
        if (client.readyState === 1) {
          client.send(envelope);
        }
      }
    } catch (error) {
      const envelope = JSON.stringify({
        type: 'snapshot_error',
        ts: nowIso(),
        error: cleanText(error && error.message ? error.message : String(error), 240),
      });
      for (const client of wsClients) {
        if (client.readyState === 1) {
          client.send(envelope);
        }
      }
    } finally {
      updating = false;
    }
  }, flags.refreshMs);

  server.listen(flags.port, flags.host, () => {
    const url = `http://${flags.host}:${flags.port}/dashboard`;
    const status = {
      ok: true,
      type: 'infring_dashboard_server',
      ts: nowIso(),
      url,
      host: flags.host,
      port: flags.port,
      refresh_ms: flags.refreshMs,
      team: flags.team,
      receipt_hash: latestSnapshot.receipt_hash,
      snapshot_path: path.relative(ROOT, SNAPSHOT_LATEST_PATH),
      action_path: path.relative(ROOT, ACTION_LATEST_PATH),
    };
    writeJson(path.resolve(STATE_DIR, 'server_status.json'), status);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.stdout.write(`Dashboard listening at ${url}\n`);
  });

  const shutdown = () => {
    clearInterval(interval);
    for (const client of wsClients) {
      try {
        client.close();
      } catch {}
    }
    try {
      server.close();
    } catch {}
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return null;
}

function run(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  if (flags.mode === 'snapshot' || flags.mode === 'status') {
    const snapshot = buildSnapshot(flags);
    writeSnapshotReceipt(snapshot);
    const body = `${JSON.stringify(snapshot, null, flags.pretty ? 2 : 0)}${flags.pretty ? '\n' : ''}`;
    // Sync write avoids truncation when parent captures stdout via spawnSync.
    fs.writeFileSync(1, body, 'utf8');
    return 0;
  }
  if (flags.mode === 'serve' || flags.mode === 'web') {
    runServe(flags);
    return null;
  }
  process.stderr.write(
    `infring_dashboard: unsupported mode ${flags.mode}. expected serve|snapshot|status\n`
  );
  return 2;
}

module.exports = {
  run,
  parseFlags,
  buildSnapshot,
  runAction,
};

if (require.main === module) {
  const exitCode = run(process.argv.slice(2));
  if (typeof exitCode === 'number') {
    process.exitCode = exitCode;
  }
}
