#!/usr/bin/env node
/**
 * Read-only system visualizer server.
 *
 * Serves:
 * - GET /api/graph?hours=24
 * - static UI from systems/ops/visualizer/
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const STATIC_DIR = path.join(__dirname, 'visualizer');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_HOURS = 24;
const MAX_EVENTS = 6000;
const MAX_PROPOSALS = 80;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const out = { host: DEFAULT_HOST, port: DEFAULT_PORT, hours: DEFAULT_HOURS };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (tok === '--host' && argv[i + 1]) {
      out.host = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (tok === '--port' && argv[i + 1]) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) out.port = Math.round(v);
      i += 1;
      continue;
    }
    if (tok === '--hours' && argv[i + 1]) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) out.hours = Math.round(v);
      i += 1;
      continue;
    }
  }
  return out;
}

function clampNumber(v, lo, hi, fallback = lo) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseTsMs(ts) {
  const ms = Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? ms : null;
}

function listRunFilesDesc() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .reverse();
}

function loadRecentTelemetry(hours = DEFAULT_HOURS, maxEvents = MAX_EVENTS) {
  const h = clampNumber(hours, 1, 24 * 30, DEFAULT_HOURS);
  const cap = clampNumber(maxEvents, 100, 20000, MAX_EVENTS);
  const cutoffMs = Date.now() - (h * 60 * 60 * 1000);
  const runs = [];
  const audits = [];

  const files = listRunFilesDesc();
  for (const file of files) {
    const fp = path.join(RUNS_DIR, file);
    if (!fs.existsSync(fp)) continue;
    const lines = String(fs.readFileSync(fp, 'utf8') || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = String(lines[i] || '').trim();
      if (!line) continue;
      const evt = safeJsonParse(line);
      if (!evt || typeof evt !== 'object') continue;
      const ms = parseTsMs(evt.ts);
      if (ms == null || ms < cutoffMs) continue;
      if (evt.type === 'autonomy_run') runs.push(evt);
      else if (evt.type === 'autonomy_candidate_audit') audits.push(evt);
      if (runs.length + audits.length >= cap) {
        return { runs, audits, window_hours: h };
      }
    }
  }
  return { runs, audits, window_hours: h };
}

function loadDirectiveSummary() {
  try {
    const { loadActiveDirectives } = require('../../lib/directive_resolver');
    const rows = loadActiveDirectives();
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const data = row && row.data && typeof row.data === 'object' ? row.data : {};
      const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
      const title = String(meta.title || data.title || row.id || '').trim();
      return {
        id: String(row.id || '').trim(),
        tier: Number(row.tier || meta.tier || 99),
        title: title || String(row.id || '').trim()
      };
    }).filter((d) => d.id);
  } catch {
    return [];
  }
}

function loadStrategySummary() {
  try {
    const { loadActiveStrategy } = require('../../lib/strategy_resolver');
    const s = loadActiveStrategy();
    const campaignsRaw = Array.isArray(s && s.campaigns) ? s.campaigns : [];
    const campaigns = campaignsRaw.map((c) => {
      const phases = Array.isArray(c && c.phases) ? c.phases : [];
      const phaseTypes = [];
      for (const ph of phases) {
        const pt = Array.isArray(ph && ph.proposal_types) ? ph.proposal_types : [];
        for (const t of pt) {
          const v = String(t || '').trim().toLowerCase();
          if (v) phaseTypes.push(v);
        }
      }
      return {
        id: String(c && c.id || '').trim(),
        name: String(c && c.name || c && c.id || '').trim(),
        status: String(c && c.status || 'active').trim().toLowerCase(),
        proposal_types: Array.from(new Set(phaseTypes))
      };
    }).filter((c) => c.id);
    return {
      id: String(s && s.id || '').trim() || 'default_general',
      name: String(s && s.name || s && s.id || '').trim() || 'default_general',
      mode: String(s && s.execution_policy && s.execution_policy.mode || '').trim().toLowerCase() || 'unknown',
      campaigns
    };
  } catch {
    return {
      id: 'default_general',
      name: 'default_general',
      mode: 'unknown',
      campaigns: []
    };
  }
}

function objectiveIdFromRun(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const pulse = evt.directive_pulse && typeof evt.directive_pulse === 'object'
    ? evt.directive_pulse
    : {};
  const binding = evt.objective_binding && typeof evt.objective_binding === 'object'
    ? evt.objective_binding
    : {};
  const raw = String(
    evt.objective_id
    || pulse.objective_id
    || binding.objective_id
    || ''
  ).trim();
  return raw;
}

function proposalTypeFromRun(evt) {
  const explicit = String(evt && evt.proposal_type || '').trim().toLowerCase();
  if (explicit) return explicit;
  const cap = String(evt && evt.capability_key || '').trim().toLowerCase();
  const m = cap.match(/^proposal:([a-z0-9:_-]+)$/);
  if (m && m[1]) return String(m[1]).replace(/_opportunity$/, '');
  return 'unknown';
}

function outcomeLabel(evt) {
  const result = String(evt && evt.result || '').trim();
  if (result === 'executed') {
    const o = String(evt && evt.outcome || 'unknown').trim().toLowerCase() || 'unknown';
    return `executed:${o}`;
  }
  return result || 'unknown';
}

function buildCampaignTypeIndex(campaigns) {
  const map = {};
  for (const c of campaigns || []) {
    const cid = String(c && c.id || '').trim();
    if (!cid) continue;
    const types = Array.isArray(c && c.proposal_types) ? c.proposal_types : [];
    for (const t of types) {
      const k = String(t || '').trim().toLowerCase();
      if (!k) continue;
      if (!map[k]) map[k] = new Set();
      map[k].add(cid);
    }
  }
  return map;
}

function edgeKey(from, to, label) {
  return `${String(from)}|${String(to)}|${String(label || '')}`;
}

function addNode(map, node) {
  const id = String(node && node.id || '').trim();
  if (!id) return;
  if (!map[id]) {
    map[id] = {
      id,
      label: String(node.label || id),
      type: String(node.type || 'unknown'),
      weight: Number(node.weight || 0),
      meta: node.meta && typeof node.meta === 'object' ? node.meta : {}
    };
    return;
  }
  map[id].weight = Number(map[id].weight || 0) + Number(node.weight || 0);
}

function addEdge(map, from, to, label, count = 1) {
  if (!from || !to) return;
  const k = edgeKey(from, to, label);
  if (!map[k]) {
    map[k] = {
      id: k,
      from,
      to,
      label: String(label || ''),
      count: Number(count || 1)
    };
    return;
  }
  map[k].count += Number(count || 1);
}

function topCounts(rows, limit = 10) {
  return Object.entries(rows || {})
    .map(([k, v]) => [k, Number(v || 0)])
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit);
}

function buildSummary(runs, audits, windowHours) {
  const resultCounts = {};
  const capabilityCounts = {};
  const proposalTypeCounts = {};
  const gateCounts = {};
  let executed = 0;
  let shipped = 0;
  let noChange = 0;
  let reverted = 0;
  let confidenceFallback = 0;
  let routeBlocked = 0;
  let policyHolds = 0;

  for (const evt of runs) {
    const result = String(evt && evt.result || 'unknown').trim() || 'unknown';
    resultCounts[result] = Number(resultCounts[result] || 0) + 1;
    if (evt && evt.policy_hold === true) policyHolds += 1;
    if (result === 'score_only_fallback_low_execution_confidence') confidenceFallback += 1;
    if (result === 'score_only_fallback_route_block' || result === 'init_gate_blocked_route') routeBlocked += 1;
    if (result === 'executed') {
      executed += 1;
      const outcome = String(evt && evt.outcome || '').trim().toLowerCase();
      if (outcome === 'shipped') shipped += 1;
      else if (outcome === 'no_change') noChange += 1;
      else if (outcome === 'reverted') reverted += 1;
    }
    const cap = String(evt && evt.capability_key || '').trim().toLowerCase();
    if (cap) capabilityCounts[cap] = Number(capabilityCounts[cap] || 0) + 1;
    const pType = proposalTypeFromRun(evt);
    if (pType) proposalTypeCounts[pType] = Number(proposalTypeCounts[pType] || 0) + 1;
  }

  for (const audit of audits) {
    const rej = audit && audit.rejected_by_gate && typeof audit.rejected_by_gate === 'object'
      ? audit.rejected_by_gate
      : {};
    for (const [gate, count] of Object.entries(rej)) {
      gateCounts[String(gate)] = Number(gateCounts[String(gate)] || 0) + Number(count || 0);
    }
  }

  const totalRuns = runs.length;
  return {
    generated_at: nowIso(),
    window_hours: windowHours,
    run_events: totalRuns,
    candidate_audits: audits.length,
    executed,
    shipped,
    no_change: noChange,
    reverted,
    policy_holds: policyHolds,
    confidence_fallback: confidenceFallback,
    route_blocked: routeBlocked,
    top_results: topCounts(resultCounts, 12),
    top_capabilities: topCounts(capabilityCounts, 10),
    top_proposal_types: topCounts(proposalTypeCounts, 10),
    top_rejected_gates: topCounts(gateCounts, 12)
  };
}

function buildGraph(runs, directives, strategy) {
  const nodeMap = {};
  const edgeMap = {};
  const latestByProposal = {};
  const objectiveSet = new Set();
  const strategyId = String(strategy && strategy.id || '').trim() || 'default_general';
  const campaignTypeIndex = buildCampaignTypeIndex(strategy && strategy.campaigns || []);

  for (const d of directives || []) {
    addNode(nodeMap, {
      id: `directive:${d.id}`,
      label: `${d.id}`,
      type: 'directive',
      weight: 1,
      meta: { tier: Number(d.tier || 99), title: String(d.title || d.id) }
    });
    objectiveSet.add(String(d.id));
  }

  addNode(nodeMap, {
    id: `strategy:${strategyId}`,
    label: strategyId,
    type: 'strategy',
    weight: 1,
    meta: { mode: String(strategy && strategy.mode || 'unknown') }
  });

  for (const c of strategy && strategy.campaigns || []) {
    const cid = String(c && c.id || '').trim();
    if (!cid) continue;
    addNode(nodeMap, {
      id: `campaign:${cid}`,
      label: cid,
      type: 'campaign',
      weight: 1,
      meta: { status: String(c.status || 'active') }
    });
    addEdge(edgeMap, `strategy:${strategyId}`, `campaign:${cid}`, 'contains', 1);
  }

  for (const evt of runs) {
    const pid = String(evt && evt.proposal_id || '').trim();
    if (!pid) continue;
    const ts = parseTsMs(evt.ts) || 0;
    if (!latestByProposal[pid] || ts > (latestByProposal[pid].ts || 0)) {
      latestByProposal[pid] = { evt, ts };
    }
  }

  const proposalIds = Object.entries(latestByProposal)
    .sort((a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0))
    .slice(0, MAX_PROPOSALS)
    .map(([pid]) => pid);
  const proposalIdSet = new Set(proposalIds);

  for (const pid of proposalIds) {
    const row = latestByProposal[pid];
    const evt = row && row.evt ? row.evt : {};
    const pType = proposalTypeFromRun(evt);
    addNode(nodeMap, {
      id: `proposal:${pid}`,
      label: pType === 'unknown' ? pid : `${pType}:${pid.slice(0, 8)}`,
      type: 'proposal',
      weight: 1,
      meta: {
        proposal_id: pid,
        proposal_type: pType,
        risk: String(evt && evt.risk || 'unknown')
      }
    });
    addEdge(edgeMap, `strategy:${strategyId}`, `proposal:${pid}`, 'selects', 1);

    const objectiveId = objectiveIdFromRun(evt);
    if (objectiveId) {
      objectiveSet.add(objectiveId);
      addNode(nodeMap, {
        id: `directive:${objectiveId}`,
        label: objectiveId,
        type: 'directive',
        weight: 1,
        meta: { tier: objectiveId.startsWith('T1_') ? 1 : null }
      });
      addEdge(edgeMap, `directive:${objectiveId}`, `proposal:${pid}`, 'targets', 1);
    }

    const campaignIds = campaignTypeIndex[pType] ? Array.from(campaignTypeIndex[pType]) : [];
    for (const cid of campaignIds) {
      addEdge(edgeMap, `campaign:${cid}`, `proposal:${pid}`, 'contains_type', 1);
    }
  }

  for (const evt of runs) {
    const pid = String(evt && evt.proposal_id || '').trim();
    if (!pid || !proposalIdSet.has(pid)) continue;
    const outLabel = outcomeLabel(evt);
    const outId = `outcome:${outLabel}`;
    addNode(nodeMap, {
      id: outId,
      label: outLabel,
      type: 'outcome',
      weight: 1,
      meta: {}
    });
    addEdge(edgeMap, `proposal:${pid}`, outId, 'produces', 1);
  }

  return {
    nodes: Object.values(nodeMap),
    edges: Object.values(edgeMap)
  };
}

function buildPayload(hours) {
  const telemetry = loadRecentTelemetry(hours, MAX_EVENTS);
  const directives = loadDirectiveSummary();
  const strategy = loadStrategySummary();
  const summary = buildSummary(telemetry.runs, telemetry.audits, telemetry.window_hours);
  const graph = buildGraph(telemetry.runs, directives, strategy);
  return {
    ok: true,
    generated_at: nowIso(),
    summary,
    graph
  };
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n';
  res.writeHead(code, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, code, text) {
  const body = String(text || '');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStatic(reqPath, res) {
  const rel = reqPath === '/' ? '/index.html' : reqPath;
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const fp = path.join(STATIC_DIR, normalized);
  if (!fp.startsWith(STATIC_DIR)) {
    sendText(res, 403, 'forbidden\n');
    return true;
  }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return false;
  const ext = path.extname(fp).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const data = fs.readFileSync(fp);
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    'Content-Length': data.length
  });
  res.end(data);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = args.host || DEFAULT_HOST;
  const port = Number(args.port || DEFAULT_PORT);
  const defaultHours = clampNumber(args.hours, 1, 24 * 30, DEFAULT_HOURS);

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    const pathname = parsed.pathname || '/';
    if (req.method !== 'GET') {
      sendText(res, 405, 'method_not_allowed\n');
      return;
    }
    if (pathname === '/api/graph') {
      const qHours = Number(parsed.searchParams.get('hours'));
      const hours = Number.isFinite(qHours) ? qHours : defaultHours;
      try {
        sendJson(res, 200, buildPayload(hours));
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: String(err && err.message || err || 'graph_build_failed'),
          ts: nowIso()
        });
      }
      return;
    }
    if (pathname === '/api/healthz') {
      sendJson(res, 200, { ok: true, ts: nowIso() });
      return;
    }
    if (!serveStatic(pathname, res)) {
      sendText(res, 404, 'not_found\n');
    }
  });

  server.listen(port, host, () => {
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'system_visualizer_server',
      host,
      port,
      url: `http://${host}:${port}`,
      default_hours: defaultHours,
      static_dir: STATIC_DIR,
      ts: nowIso()
    }) + '\n');
  });
}

if (require.main === module) {
  main();
}
