#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

type GraphEdge = {
  source_event_id: string,
  target_event_id: string,
  relation: string,
  weight: number
};

const ROOT = process.env.CAUSAL_TEMPORAL_GRAPH_ROOT
  ? path.resolve(process.env.CAUSAL_TEMPORAL_GRAPH_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.CAUSAL_TEMPORAL_GRAPH_POLICY_PATH
  ? path.resolve(process.env.CAUSAL_TEMPORAL_GRAPH_POLICY_PATH)
  : path.join(ROOT, 'config', 'causal_temporal_memory_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/causal_temporal_graph.js build [--date=YYYY-MM-DD] [--strict=1|0] [--policy=<path>] [--source=<dir|file>]');
  console.log('  node systems/memory/causal_temporal_graph.js query --mode=why|what-if --event-id=<id> [--depth=N] [--counterfactual=<json>] [--policy=<path>]');
  console.log('  node systems/memory/causal_temporal_graph.js status [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(rawPath: unknown) {
  const text = cleanText(rawPath || '', 400);
  if (!text) return ROOT;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'causal_temporal_memory_policy',
    schema_version: '1.0',
    enabled: true,
    strict_requires_events: false,
    allow_counterfactual_query: true,
    max_events: 20000,
    default_query_depth: 4,
    max_query_depth: 8,
    canonical_events_path: 'state/runtime/canonical_events',
    state_path: 'state/memory/causal_temporal_graph/state.json',
    latest_query_path: 'state/memory/causal_temporal_graph/latest_query.json',
    receipts_path: 'state/memory/causal_temporal_graph/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    schema_id: 'causal_temporal_memory_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 32) || base.schema_version,
    enabled: raw.enabled !== false,
    strict_requires_events: raw.strict_requires_events === true,
    allow_counterfactual_query: raw.allow_counterfactual_query !== false,
    max_events: clampInt(raw.max_events, 1, 1_000_000, base.max_events),
    default_query_depth: clampInt(raw.default_query_depth, 1, 64, base.default_query_depth),
    max_query_depth: clampInt(raw.max_query_depth, 1, 128, base.max_query_depth),
    canonical_events_path: resolvePath(raw.canonical_events_path || base.canonical_events_path),
    state_path: resolvePath(raw.state_path || base.state_path),
    latest_query_path: resolvePath(raw.latest_query_path || base.latest_query_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function collectCanonicalEventFiles(sourcePath: string, date: string) {
  const files: string[] = [];
  if (!fs.existsSync(sourcePath)) return files;
  const st = fs.statSync(sourcePath);
  if (st.isFile() && sourcePath.endsWith('.jsonl')) return [sourcePath];
  if (!st.isDirectory()) return files;

  if (date) {
    const datedPath = path.join(sourcePath, `${date}.jsonl`);
    if (fs.existsSync(datedPath) && fs.statSync(datedPath).isFile()) return [datedPath];
  }

  const rows = fs.readdirSync(sourcePath)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(sourcePath, name))
    .filter((absPath) => fs.statSync(absPath).isFile())
    .sort((a, b) => a.localeCompare(b));
  return rows;
}

function loadCanonicalEvents(policy: AnyObj, args: AnyObj) {
  const sourcePath = args.source ? resolvePath(args.source) : policy.canonical_events_path;
  const date = cleanText(args.date || '', 10);
  const files = collectCanonicalEventFiles(sourcePath, date);
  const rows: AnyObj[] = [];
  for (const filePath of files) {
    const parsed = readJsonl(filePath);
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const eventId = cleanText(row.event_id || '', 120);
      if (!eventId) continue;
      rows.push({ ...row, __source_path: rel(filePath) });
    }
  }
  rows.sort((a, b) => {
    const ta = cleanText(a.ts || '', 40);
    const tb = cleanText(b.ts || '', 40);
    if (ta !== tb) return ta.localeCompare(tb);
    return Number(a.seq || 0) - Number(b.seq || 0);
  });
  if (rows.length > policy.max_events) {
    return {
      rows: rows.slice(rows.length - policy.max_events),
      files,
      trimmed: rows.length - policy.max_events
    };
  }
  return { rows, files, trimmed: 0 };
}

function extractDeclaredParents(payload: AnyObj) {
  const parentIds: string[] = [];
  if (!payload || typeof payload !== 'object') return parentIds;
  const scalarKeys = [
    'parent_event_id',
    'cause_event_id',
    'depends_on_event_id',
    'source_event_id'
  ];
  const listKeys = [
    'parent_event_ids',
    'cause_event_ids',
    'depends_on_event_ids',
    'source_event_ids',
    'causal_parent_event_ids'
  ];
  for (const key of scalarKeys) {
    const token = cleanText(payload[key], 120);
    if (token) parentIds.push(token);
  }
  for (const key of listKeys) {
    const rows = Array.isArray(payload[key]) ? payload[key] : [];
    for (const row of rows) {
      const token = cleanText(row, 120);
      if (token) parentIds.push(token);
    }
  }
  return Array.from(new Set(parentIds));
}

function makeEdgeKey(sourceEventId: string, targetEventId: string, relation: string) {
  return `${sourceEventId}|${targetEventId}|${relation}`;
}

function stableHash(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildGraph(rows: AnyObj[]) {
  const nodesByEvent: AnyObj = {};
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const lastByRun: Record<string, string> = {};
  const lastByWorkflow: Record<string, string> = {};

  const addEdge = (sourceEventId: string, targetEventId: string, relation: string, weight = 1) => {
    const source = cleanText(sourceEventId, 120);
    const target = cleanText(targetEventId, 120);
    const relType = normalizeToken(relation, 64);
    if (!source || !target || !relType) return;
    if (!nodesByEvent[source] || !nodesByEvent[target]) return;
    const key = makeEdgeKey(source, target, relType);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source_event_id: source, target_event_id: target, relation: relType, weight });
  };

  for (const row of rows) {
    const eventId = cleanText(row.event_id || '', 120);
    if (!eventId) continue;
    nodesByEvent[eventId] = {
      event_id: eventId,
      ts: cleanText(row.ts || '', 40) || null,
      date: cleanText(row.date || '', 10) || null,
      seq: Number(row.seq || 0) || null,
      type: cleanText(row.type || '', 80) || null,
      run_id: cleanText(row.run_id || '', 120) || null,
      workflow_id: cleanText(row.workflow_id || '', 120) || null,
      step_id: cleanText(row.step_id || '', 120) || null,
      opcode: cleanText(row.opcode || '', 80) || null,
      effect: cleanText(row.effect || '', 80) || null,
      ok: row && typeof row.ok === 'boolean' ? row.ok : null,
      source_path: cleanText(row.__source_path || '', 260) || null
    };
  }

  let prevEventId = '';
  for (const row of rows) {
    const eventId = cleanText(row.event_id || '', 120);
    if (!eventId || !nodesByEvent[eventId]) continue;

    if (prevEventId && nodesByEvent[prevEventId]) {
      addEdge(prevEventId, eventId, 'temporal_prev', 1);
    }
    prevEventId = eventId;

    const runId = cleanText(row.run_id || '', 120);
    if (runId && lastByRun[runId] && lastByRun[runId] !== eventId) {
      addEdge(lastByRun[runId], eventId, 'run_context', 0.9);
    }
    if (runId) lastByRun[runId] = eventId;

    const workflowId = cleanText(row.workflow_id || '', 120);
    if (workflowId && lastByWorkflow[workflowId] && lastByWorkflow[workflowId] !== eventId) {
      addEdge(lastByWorkflow[workflowId], eventId, 'workflow_context', 0.85);
    }
    if (workflowId) lastByWorkflow[workflowId] = eventId;

    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const declaredParents = extractDeclaredParents(payload);
    for (const parentId of declaredParents) {
      addEdge(parentId, eventId, 'declared_cause', 1);
    }
  }

  const incoming: Record<string, GraphEdge[]> = {};
  const outgoing: Record<string, GraphEdge[]> = {};
  for (const edge of edges) {
    if (!incoming[edge.target_event_id]) incoming[edge.target_event_id] = [];
    if (!outgoing[edge.source_event_id]) outgoing[edge.source_event_id] = [];
    incoming[edge.target_event_id].push(edge);
    outgoing[edge.source_event_id].push(edge);
  }

  const eventIds = Object.keys(nodesByEvent).sort((a, b) => a.localeCompare(b));
  const graphHash = stableHash({ eventIds, edges });

  return {
    schema_id: 'causal_temporal_memory_graph',
    schema_version: '1.0',
    built_at: nowIso(),
    event_count: eventIds.length,
    edge_count: edges.length,
    graph_hash: graphHash,
    nodes_by_event_id: nodesByEvent,
    edges,
    incoming,
    outgoing
  };
}

function buildWhyPayload(graph: AnyObj, eventIdRaw: unknown, maxDepth: number) {
  const eventId = cleanText(eventIdRaw || '', 120);
  const targetNode = graph.nodes_by_event_id && graph.nodes_by_event_id[eventId] ? graph.nodes_by_event_id[eventId] : null;
  if (!targetNode) {
    return {
      ok: false,
      reason: 'event_not_found',
      event_id: eventId,
      explanation: `No canonical event found for ${eventId || 'unknown_event'}.`
    };
  }

  const incoming = graph.incoming && graph.incoming[eventId] ? graph.incoming[eventId] : [];
  const queue = incoming.map((edge: GraphEdge) => ({ edge, depth: 1 }));
  const visited = new Set<string>();
  const causes: AnyObj[] = [];

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const edge = current.edge;
    const depth = current.depth;
    const key = makeEdgeKey(edge.source_event_id, edge.target_event_id, edge.relation);
    if (visited.has(key)) continue;
    visited.add(key);

    causes.push({
      source_event_id: edge.source_event_id,
      relation: edge.relation,
      weight: edge.weight,
      depth,
      source_node: graph.nodes_by_event_id[edge.source_event_id] || null
    });

    if (depth >= maxDepth) continue;
    const parentIncoming = graph.incoming && graph.incoming[edge.source_event_id] ? graph.incoming[edge.source_event_id] : [];
    for (const parentEdge of parentIncoming) {
      queue.push({ edge: parentEdge, depth: depth + 1 });
    }
  }

  const primary = causes.slice(0, 5).map((row) => `${row.source_event_id} (${row.relation})`);
  return {
    ok: true,
    mode: 'why',
    event_id: eventId,
    explanation: primary.length
      ? `Event ${eventId} is linked to ${primary.join(', ')}.`
      : `Event ${eventId} has no causal parents in the current canonical window.`,
    causes,
    canonical_event_ids: Array.from(new Set([eventId, ...causes.map((row) => row.source_event_id)])).slice(0, 200)
  };
}

function buildWhatIfPayload(graph: AnyObj, eventIdRaw: unknown, maxDepth: number, counterfactual: AnyObj) {
  const eventId = cleanText(eventIdRaw || '', 120);
  const targetNode = graph.nodes_by_event_id && graph.nodes_by_event_id[eventId] ? graph.nodes_by_event_id[eventId] : null;
  if (!targetNode) {
    return {
      ok: false,
      reason: 'event_not_found',
      event_id: eventId,
      explanation: `No canonical event found for ${eventId || 'unknown_event'}.`
    };
  }

  const impacted: AnyObj[] = [];
  const queue: AnyObj[] = [{ event_id: eventId, depth: 0 }];
  const visited = new Set<string>([eventId]);

  while (queue.length) {
    const row = queue.shift();
    if (!row) break;
    const currentEventId = row.event_id;
    const depth = Number(row.depth || 0);
    if (depth >= maxDepth) continue;
    const outs = graph.outgoing && graph.outgoing[currentEventId] ? graph.outgoing[currentEventId] : [];
    for (const edge of outs) {
      if (visited.has(edge.target_event_id)) continue;
      visited.add(edge.target_event_id);
      impacted.push({
        event_id: edge.target_event_id,
        relation: edge.relation,
        via_event_id: currentEventId,
        depth: depth + 1,
        node: graph.nodes_by_event_id[edge.target_event_id] || null
      });
      queue.push({ event_id: edge.target_event_id, depth: depth + 1 });
    }
  }

  const assumeOk = counterfactual && typeof counterfactual.assume_ok === 'boolean'
    ? counterfactual.assume_ok
    : null;
  const summary = assumeOk == null
    ? `Counterfactual ripple from ${eventId} reaches ${impacted.length} downstream events.`
    : `If ${eventId} were forced to ok=${assumeOk ? 'true' : 'false'}, ${impacted.length} downstream events would require re-evaluation.`;

  return {
    ok: true,
    mode: 'what-if',
    event_id: eventId,
    counterfactual,
    explanation: summary,
    impacted,
    canonical_event_ids: Array.from(new Set([eventId, ...impacted.map((row) => row.event_id)])).slice(0, 400)
  };
}

function writeReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    type: cleanText(row.type || 'causal_temporal_graph_event', 80),
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    ...row
  });
}

function cmdBuild(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = boolFlag(args.strict, false);
  if (policy.enabled !== true) {
    const disabledPayload = {
      ok: false,
      reason: 'policy_disabled',
      policy_path: rel(policy.policy_path)
    };
    process.stdout.write(`${JSON.stringify(disabledPayload, null, 2)}\n`);
    if (strict) process.exit(1);
    return;
  }

  const loaded = loadCanonicalEvents(policy, args);
  const rows = loaded.rows;
  if (strict && policy.strict_requires_events === true && rows.length === 0) {
    const emptyPayload = {
      ok: false,
      reason: 'canonical_events_missing',
      source_path: args.source ? cleanText(args.source, 320) : rel(policy.canonical_events_path)
    };
    process.stdout.write(`${JSON.stringify(emptyPayload, null, 2)}\n`);
    process.exit(1);
  }

  const graph = buildGraph(rows);
  const payload = {
    ok: true,
    type: 'causal_temporal_graph_build',
    ts: nowIso(),
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    source_files: loaded.files.map((fp: string) => rel(fp)),
    trimmed_events: loaded.trimmed,
    event_count: graph.event_count,
    edge_count: graph.edge_count,
    graph_hash: graph.graph_hash,
    canonical_event_ids_sample: Object.keys(graph.nodes_by_event_id || {}).slice(0, 20)
  };

  writeJsonAtomic(policy.state_path, {
    ...graph,
    source_files: loaded.files.map((fp: string) => rel(fp))
  });
  writeReceipt(policy, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cmdQuery(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const mode = normalizeToken(args.mode || policy.default_mode || 'why', 40);
  const eventId = cleanText(args['event-id'] || args.event_id || '', 120);
  const depth = clampInt(args.depth, 1, policy.max_query_depth, policy.default_query_depth);

  if (!eventId) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'event_id_required' }, null, 2)}\n`);
    process.exit(2);
  }
  if (mode === 'what-if' && policy.allow_counterfactual_query !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'counterfactual_query_disabled' }, null, 2)}\n`);
    process.exit(1);
  }

  const graph = readJson(policy.state_path, {});
  if (!graph || graph.schema_id !== 'causal_temporal_memory_graph') {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'graph_state_missing', state_path: rel(policy.state_path) }, null, 2)}\n`);
    process.exit(1);
  }

  let counterfactual: AnyObj = {};
  if (args.counterfactual) {
    try {
      const parsed = JSON.parse(String(args.counterfactual));
      counterfactual = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      counterfactual = { raw: cleanText(args.counterfactual, 200) };
    }
  }
  if (args['assume-ok'] != null) {
    counterfactual.assume_ok = boolFlag(args['assume-ok'], false);
  }

  const queryResult = mode === 'what-if'
    ? buildWhatIfPayload(graph, eventId, depth, counterfactual)
    : buildWhyPayload(graph, eventId, depth);

  const payload = {
    ...queryResult,
    type: 'causal_temporal_graph_query',
    ts: nowIso(),
    query_depth: depth,
    graph_hash: cleanText(graph.graph_hash || '', 80) || null,
    policy_path: rel(policy.policy_path),
    policy_version: policy.schema_version,
    source_state_path: rel(policy.state_path)
  };

  writeJsonAtomic(policy.latest_query_path, payload);
  writeReceipt(policy, {
    type: 'causal_temporal_graph_query',
    mode,
    ok: payload.ok === true,
    event_id: eventId,
    query_depth: depth,
    graph_hash: payload.graph_hash,
    canonical_event_ids: Array.isArray(payload.canonical_event_ids)
      ? payload.canonical_event_ids.slice(0, 120)
      : []
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const graph = readJson(policy.state_path, null);
  const latestQuery = readJson(policy.latest_query_path, null);
  const payload = {
    ok: !!graph,
    type: 'causal_temporal_graph_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    state_path: rel(policy.state_path),
    receipts_path: rel(policy.receipts_path),
    latest_query_path: rel(policy.latest_query_path),
    graph_summary: graph ? {
      built_at: graph.built_at || null,
      event_count: Number(graph.event_count || 0),
      edge_count: Number(graph.edge_count || 0),
      graph_hash: graph.graph_hash || null,
      source_files: Array.isArray(graph.source_files) ? graph.source_files : []
    } : null,
    latest_query: latestQuery || null
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!graph) process.exit(1);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'build') return cmdBuild(args);
  if (cmd === 'query') return cmdQuery(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  loadCanonicalEvents,
  buildGraph,
  buildWhyPayload,
  buildWhatIfPayload
};
