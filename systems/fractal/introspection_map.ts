#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/fractal/introspection_map.js
 *
 * V2-030 recursive organism introspection map.
 * Produces branch health graph + anomaly-triggered restructuring candidates.
 *
 * Usage:
 *   node systems/fractal/introspection_map.js run [YYYY-MM-DD]
 *   node systems/fractal/introspection_map.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = process.env.FRACTAL_INTROSPECTION_DIR
  ? path.resolve(process.env.FRACTAL_INTROSPECTION_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'introspection');
const QUEUE_PATH = process.env.FRACTAL_INTROSPECTION_QUEUE_PATH
  ? path.resolve(process.env.FRACTAL_INTROSPECTION_QUEUE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'sensory_queue.json');
const RUNS_DIR = process.env.FRACTAL_INTROSPECTION_RUNS_DIR
  ? path.resolve(process.env.FRACTAL_INTROSPECTION_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const COOLDOWNS_PATH = process.env.FRACTAL_INTROSPECTION_COOLDOWNS_PATH
  ? path.resolve(process.env.FRACTAL_INTROSPECTION_COOLDOWNS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'capability_cooldowns.json');
const AUTOPAUSE_PATH = process.env.FRACTAL_INTROSPECTION_AUTOPAUSE_PATH
  ? path.resolve(process.env.FRACTAL_INTROSPECTION_AUTOPAUSE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'budget_autopause.json');
const CONTINUITY_LEASE_PATH = process.env.FRACTAL_INTROSPECTION_LEASE_PATH
  ? path.resolve(process.env.FRACTAL_INTROSPECTION_LEASE_PATH)
  : path.join(ROOT, 'state', 'continuity', 'active_lease.json');
const MORPH_PLAN_DIR = process.env.FRACTAL_MORPH_PLAN_DIR
  ? path.resolve(process.env.FRACTAL_MORPH_PLAN_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'morph_plans');

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/introspection_map.js run [YYYY-MM-DD]');
  console.log('  node systems/fractal/introspection_map.js status [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const tok of argv) out._.push(String(tok || ''));
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // ignore malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stableId(seed, prefix = 'node') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function queueSnapshot() {
  const q = readJson(QUEUE_PATH, {});
  const pending = safeNumber(q && q.pending, 0);
  const total = Math.max(pending, safeNumber(q && q.total, pending));
  const accepted = safeNumber(q && q.accepted, 0);
  const rejected = safeNumber(q && q.rejected, 0);
  const ratio = total > 0 ? pending / total : 0;
  let pressure = 'normal';
  if (ratio >= 0.7 || pending >= 80) pressure = 'critical';
  else if (ratio >= 0.45 || pending >= 45) pressure = 'high';
  else if (ratio >= 0.25 || pending >= 20) pressure = 'elevated';
  return {
    pending,
    total,
    accepted,
    rejected,
    pending_ratio: Number(ratio.toFixed(4)),
    pressure
  };
}

function runMetrics(dateStr) {
  const fp = path.join(RUNS_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(fp);
  let runs = 0;
  let executed = 0;
  let policyHolds = 0;
  let noProgress = 0;
  for (const row of rows) {
    if (String(row && row.type || '') !== 'autonomy_run') continue;
    runs += 1;
    const result = String(row && row.result || '').trim().toLowerCase();
    const outcome = String(row && row.outcome || '').trim().toLowerCase();
    if (result === 'executed') executed += 1;
    if (result === 'policy_hold' || result.startsWith('no_candidates_policy_')) policyHolds += 1;
    if (outcome === 'no_change') noProgress += 1;
  }
  return {
    runs,
    executed,
    policy_holds: policyHolds,
    no_progress: noProgress
  };
}

function cooldownSnapshot() {
  const payload = readJson(COOLDOWNS_PATH, {});
  const rows = payload && typeof payload === 'object'
    ? Object.values(payload).filter((v: any) => v && typeof v === 'object')
    : [];
  const active = rows.filter((row: any) => String(row.until || '').trim()).length;
  return {
    active_cooldowns: active,
    cooldown_keys: rows.length
  };
}

function leaseSnapshot() {
  const lease = readJson(CONTINUITY_LEASE_PATH, {});
  const holder = String(lease && lease.holder || lease && lease.instance_id || '').trim() || null;
  const expiresAt = String(lease && lease.expires_at || '').trim() || null;
  return {
    holder,
    expires_at: expiresAt,
    active: !!holder && !!expiresAt
  };
}

function autopauseSnapshot() {
  const row = readJson(AUTOPAUSE_PATH, {});
  return {
    active: row && row.active === true,
    source: String(row && row.source || '').trim() || null,
    reason: String(row && row.reason || '').trim() || null
  };
}

function anomalyCandidates(dateStr, snap) {
  const out = [];
  const queue = snap.queue || {};
  const runs = snap.runs || {};
  const cooldown = snap.cooldowns || {};
  const autopause = snap.autopause || {};
  const morphPlanPath = path.join(MORPH_PLAN_DIR, `${dateStr}.json`);
  const reversibleRef = fs.existsSync(morphPlanPath)
    ? path.relative(ROOT, morphPlanPath).replace(/\\/g, '/')
    : null;

  if (String(queue.pressure || '') === 'critical') {
    out.push({
      id: stableId(`${dateStr}|critical_queue`, 'cand'),
      type: 'queue_pressure',
      severity: 'high',
      reason: `critical queue pressure pending=${safeNumber(queue.pending, 0)} total=${safeNumber(queue.total, 0)}`,
      suggested_plan: 'spawn_queue_relief_worker',
      reversible_plan_ref: reversibleRef
    });
  }
  if (safeNumber(runs.policy_holds, 0) >= 20) {
    out.push({
      id: stableId(`${dateStr}|policy_holds`, 'cand'),
      type: 'policy_hold_churn',
      severity: 'medium',
      reason: `policy holds elevated (${safeNumber(runs.policy_holds, 0)})`,
      suggested_plan: 'tighten_admission_and_retry_backoff',
      reversible_plan_ref: reversibleRef
    });
  }
  if (safeNumber(cooldown.active_cooldowns, 0) >= 10) {
    out.push({
      id: stableId(`${dateStr}|cooldown_load`, 'cand'),
      type: 'cooldown_load',
      severity: 'medium',
      reason: `cooldown pressure active=${safeNumber(cooldown.active_cooldowns, 0)}`,
      suggested_plan: 'capability_lane_rewire',
      reversible_plan_ref: reversibleRef
    });
  }
  if (autopause.active === true) {
    out.push({
      id: stableId(`${dateStr}|autopause_active`, 'cand'),
      type: 'autopause_active',
      severity: 'high',
      reason: `budget autopause active source=${String(autopause.source || 'unknown')}`,
      suggested_plan: 'budget_first_mode_and_low_cost_routes',
      reversible_plan_ref: reversibleRef
    });
  }
  return out.slice(0, 12);
}

function graphModel(snap) {
  const nodes = [
    { id: 'root', label: 'root', type: 'root', health: 'ok' },
    { id: 'autonomy', label: 'autonomy', type: 'module', health: safeNumber(snap.runs.policy_holds, 0) > 20 ? 'warn' : 'ok' },
    { id: 'queue', label: 'queue', type: 'module', health: String(snap.queue.pressure || '') === 'critical' ? 'error' : (String(snap.queue.pressure || '') === 'high' ? 'warn' : 'ok') },
    { id: 'spawn', label: 'spawn', type: 'module', health: 'ok' },
    { id: 'budget', label: 'budget', type: 'module', health: snap.autopause.active === true ? 'warn' : 'ok' },
    { id: 'continuity', label: 'continuity', type: 'module', health: snap.lease.active ? 'ok' : 'warn' }
  ];
  const edges = [
    { from: 'root', to: 'autonomy', relation: 'controls' },
    { from: 'autonomy', to: 'queue', relation: 'consumes' },
    { from: 'autonomy', to: 'spawn', relation: 'scales' },
    { from: 'autonomy', to: 'budget', relation: 'bounded_by' },
    { from: 'autonomy', to: 'continuity', relation: 'leases' }
  ];
  return { nodes, edges };
}

function outputPath(dateStr) {
  return path.join(OUTPUT_DIR, `${dateStr}.json`);
}

function cmdRun(dateStr) {
  const snap = {
    ts: nowIso(),
    date: dateStr,
    queue: queueSnapshot(),
    runs: runMetrics(dateStr),
    cooldowns: cooldownSnapshot(),
    autopause: autopauseSnapshot(),
    lease: leaseSnapshot()
  };
  const candidates = anomalyCandidates(dateStr, snap);
  const graph = graphModel(snap);
  const payload = {
    ok: true,
    type: 'fractal_introspection_map',
    ts: nowIso(),
    date: dateStr,
    snapshot: snap,
    graph,
    restructure_candidates: candidates
  };
  const fp = outputPath(dateStr);
  writeJson(fp, payload);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    date: dateStr,
    nodes: payload.graph.nodes.length,
    edges: payload.graph.edges.length,
    restructure_candidates: payload.restructure_candidates.length,
    output_path: path.relative(ROOT, fp).replace(/\\/g, '/')
  })}\n`);
}

function cmdStatus(dateStr) {
  const fp = outputPath(dateStr);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'fractal_introspection_status',
      date: dateStr,
      error: 'snapshot_not_found'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_introspection_status',
    date: dateStr,
    nodes: payload.graph && Array.isArray(payload.graph.nodes) ? payload.graph.nodes.length : 0,
    edges: payload.graph && Array.isArray(payload.graph.edges) ? payload.graph.edges.length : 0,
    restructure_candidates: Array.isArray(payload.restructure_candidates) ? payload.restructure_candidates.length : 0,
    output_path: path.relative(ROOT, fp).replace(/\\/g, '/')
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const dateStr = dateArgOrToday(args._[1]);
  if (cmd === 'run') {
    cmdRun(dateStr);
    return;
  }
  if (cmd === 'status') {
    cmdStatus(dateStr);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}
