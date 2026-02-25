#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/fractal/morph_planner.js
 *
 * V2-025 Fractal morph planner.
 * Emits bounded `prune/spawn/rewire` proposals from objective + telemetry.
 * No direct self-mutation: proposal-only output with governance-required flag.
 *
 * Usage:
 *   node systems/fractal/morph_planner.js run [YYYY-MM-DD] [--objective-id=T1_x] [--max-actions=6]
 *   node systems/fractal/morph_planner.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  loadIdentityContext,
  evaluateMorphActions,
  writeIdentityReceipt
} = require('../identity/identity_anchor');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = process.env.FRACTAL_MORPH_PLAN_DIR
  ? path.resolve(process.env.FRACTAL_MORPH_PLAN_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'morph_plans');
const RECEIPTS_PATH = process.env.FRACTAL_MORPH_RECEIPTS_PATH
  ? path.resolve(process.env.FRACTAL_MORPH_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'receipts.jsonl');
const SIM_DIR = process.env.FRACTAL_MORPH_SIM_DIR
  ? path.resolve(process.env.FRACTAL_MORPH_SIM_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'simulations');
const SUGGESTION_LANE_DIR = process.env.FRACTAL_MORPH_SUGGESTION_LANE_DIR
  ? path.resolve(process.env.FRACTAL_MORPH_SUGGESTION_LANE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'suggestion_lane');
const QUEUE_PATH = process.env.FRACTAL_MORPH_QUEUE_PATH
  ? path.resolve(process.env.FRACTAL_MORPH_QUEUE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'sensory_queue.json');
const RUNS_DIR = process.env.FRACTAL_MORPH_RUNS_DIR
  ? path.resolve(process.env.FRACTAL_MORPH_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');

const DEFAULT_MAX_ACTIONS = clampInt(process.env.FRACTAL_MORPH_MAX_ACTIONS || 6, 1, 20, 6);

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/morph_planner.js run [YYYY-MM-DD] [--objective-id=T1_x] [--max-actions=6]');
  console.log('  node systems/fractal/morph_planner.js status [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
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

function clampInt(value, lo, hi, fallback = lo) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
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
        // ignore malformed lines
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

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function compact(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function stableId(seed, prefix = 'morph') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function simulationForDate(dateStr) {
  const fp = path.join(SIM_DIR, `${dateStr}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') return { drift: null, yieldRate: null };
  const eff = payload.checks_effective && typeof payload.checks_effective === 'object'
    ? payload.checks_effective
    : {};
  const raw = payload.checks && typeof payload.checks === 'object'
    ? payload.checks
    : {};
  const drift = Number(eff.drift_rate && eff.drift_rate.value);
  const yieldRate = Number(eff.yield_rate && eff.yield_rate.value);
  return {
    drift: Number.isFinite(drift) ? drift : Number(raw.drift_rate && raw.drift_rate.value),
    yieldRate: Number.isFinite(yieldRate) ? yieldRate : Number(raw.yield_rate && raw.yield_rate.value)
  };
}

function queuePressure() {
  const q = readJson(QUEUE_PATH, {});
  const pending = safeNumber(q && q.pending, 0);
  const total = Math.max(pending, safeNumber(q && q.total, pending));
  const ratio = total > 0 ? pending / total : 0;
  let pressure = 'normal';
  if (ratio >= 0.7 || pending >= 80) pressure = 'critical';
  else if (ratio >= 0.45 || pending >= 45) pressure = 'high';
  else if (ratio >= 0.25 || pending >= 20) pressure = 'elevated';
  return { pending, total, ratio: Number(ratio.toFixed(4)), pressure };
}

function laneStats(dateStr) {
  const lane = readJson(path.join(SUGGESTION_LANE_DIR, `${dateStr}.json`), null);
  if (!lane || typeof lane !== 'object') return { merged: 0, candidates: 0, capped: false };
  return {
    merged: safeNumber(lane.merged_count, 0),
    candidates: safeNumber(lane.total_candidates, 0),
    capped: lane.capped === true
  };
}

function objectiveFromRuns(dateStr) {
  const fp = path.join(RUNS_DIR, `${dateStr}.jsonl`);
  const rows = readJsonl(fp);
  const counts = {};
  for (const row of rows) {
    if (String(row && row.type || '') !== 'autonomy_run') continue;
    const objective = String(
      row.objective_id
      || (row.directive_pulse && row.directive_pulse.objective_id)
      || (row.objective_binding && row.objective_binding.objective_id)
      || ''
    ).trim();
    if (!objective) continue;
    counts[objective] = Number(counts[objective] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a: any, b: any) => Number(b[1]) - Number(a[1]));
  if (!ranked.length) return null;
  return String(ranked[0][0]);
}

function buildActions(ctx, maxActions) {
  const out = [];
  const drift = Number(ctx.sim && ctx.sim.drift);
  const yieldRate = Number(ctx.sim && ctx.sim.yieldRate);
  const q = ctx.queue || {};
  const lane = ctx.lane || {};

  if (Number.isFinite(drift) && drift >= 0.03) {
    out.push({
      kind: 'prune',
      target: 'lane:explore',
      reason: `effective drift ${drift.toFixed(4)} is above target`,
      risk: 'low',
      ttl_hours: 24
    });
  }
  if (Number.isFinite(yieldRate) && yieldRate < 0.7) {
    out.push({
      kind: 'spawn',
      target: 'module:objective_binding_assistant',
      reason: `effective yield ${yieldRate.toFixed(4)} indicates directive fit pressure`,
      risk: 'medium',
      ttl_hours: 48
    });
  }
  if (String(q.pressure || '') === 'critical' || String(q.pressure || '') === 'high') {
    out.push({
      kind: 'rewire',
      target: 'queue->spawn_broker',
      reason: `queue pressure ${String(q.pressure)} pending=${safeNumber(q.pending, 0)}`,
      risk: 'medium',
      ttl_hours: 24
    });
  }
  if (lane.capped === true || safeNumber(lane.candidates, 0) > safeNumber(lane.merged, 0) + 8) {
    out.push({
      kind: 'spawn',
      target: 'module:suggestion_lane_compactor',
      reason: `suggestion lane saturation candidates=${safeNumber(lane.candidates, 0)} merged=${safeNumber(lane.merged, 0)}`,
      risk: 'low',
      ttl_hours: 24
    });
  }
  if (!out.length) {
    out.push({
      kind: 'rewire',
      target: 'strategy->autonomy_selector',
      reason: 'steady-state maintenance and periodic topology health refresh',
      risk: 'low',
      ttl_hours: 24
    });
  }
  return out.slice(0, maxActions).map((row, idx) => ({
    id: stableId(`${ctx.date}|${ctx.objective_id}|${idx}|${row.kind}|${row.target}`, 'mpa'),
    ...row
  }));
}

function planPath(dateStr) {
  return path.join(OUTPUT_DIR, `${dateStr}.json`);
}

function cmdRun(dateStr, objectiveIdRaw, maxActionsRaw) {
  const maxActions = clampInt(maxActionsRaw == null ? DEFAULT_MAX_ACTIONS : maxActionsRaw, 1, 20, DEFAULT_MAX_ACTIONS);
  const inferredObjective = objectiveFromRuns(dateStr);
  const objectiveId = String(objectiveIdRaw || inferredObjective || '').trim() || null;
  const ctx = {
    ts: nowIso(),
    date: dateStr,
    objective_id: objectiveId,
    sim: simulationForDate(dateStr),
    queue: queuePressure(),
    lane: laneStats(dateStr)
  };
  const actions = buildActions(ctx, maxActions);
  const identityContext = loadIdentityContext({
    date: dateStr
  });
  const identity = evaluateMorphActions(actions, {
    context: identityContext,
    source: 'fractal_morph_planner',
    objective_id: objectiveId || null
  });
  const blockedActions = new Set(Array.isArray(identity.blocked_actions) ? identity.blocked_actions : []);
  const filteredActions = actions.filter((row) => !blockedActions.has(String(row && row.id || '')));
  const identityReceipt = writeIdentityReceipt({
    context: identityContext,
    scope: 'morph',
    source: 'fractal_morph_planner',
    evaluations: identity.evaluations,
    summary: identity.summary
  });
  const plan = {
    ok: true,
    type: 'fractal_morph_plan',
    ts: nowIso(),
    date: dateStr,
    plan_id: stableId(`${dateStr}|${objectiveId}|${filteredActions.map((a) => a.id).join(',')}`, 'morph'),
    objective_id: objectiveId,
    max_actions: maxActions,
    governance_required: true,
    execution_mode: 'proposal_only',
    actions: filteredActions,
    identity: {
      checked: Number(identity.summary && identity.summary.checked || 0),
      blocked: Number(identity.summary && identity.summary.blocked || 0),
      identity_drift_score: Number(identity.summary && identity.summary.identity_drift_score || 0),
      max_identity_drift_score: Number(identity.summary && identity.summary.max_identity_drift_score || 0),
      blocking_code_counts: identity.summary && identity.summary.blocking_code_counts
        ? identity.summary.blocking_code_counts
        : {},
      blocked_action_ids: Array.isArray(identity.blocked_actions) ? identity.blocked_actions : [],
      receipt_path: identityReceipt && identityReceipt.receipt_path ? identityReceipt.receipt_path : null
    },
    context: ctx,
    summary: compact(
      `${filteredActions.length} bounded morph action(s); governance-required, no direct self-mutation.`,
      220
    )
  };
  writeJson(planPath(dateStr), plan);
  appendJsonl(RECEIPTS_PATH, {
    ts: nowIso(),
    type: 'fractal_morph_plan_generated',
    date: dateStr,
    plan_id: plan.plan_id,
    objective_id: objectiveId,
    action_count: filteredActions.length,
    governance_required: true,
    identity_drift_score: Number(identity.summary && identity.summary.identity_drift_score || 0),
    identity_blocked: Number(identity.summary && identity.summary.blocked || 0),
    identity_receipt_path: identityReceipt && identityReceipt.receipt_path ? identityReceipt.receipt_path : null
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: plan.type,
    date: dateStr,
    plan_id: plan.plan_id,
    objective_id: objectiveId,
    action_count: filteredActions.length,
    identity_checked: Number(identity.summary && identity.summary.checked || 0),
    identity_blocked: Number(identity.summary && identity.summary.blocked || 0),
    identity_drift_score: Number(identity.summary && identity.summary.identity_drift_score || 0),
    identity_max_drift_score: Number(identity.summary && identity.summary.max_identity_drift_score || 0),
    identity_receipt_path: identityReceipt && identityReceipt.receipt_path ? identityReceipt.receipt_path : null,
    output_path: path.relative(ROOT, planPath(dateStr)).replace(/\\/g, '/')
  })}\n`);
}

function cmdStatus(dateStr) {
  const fp = planPath(dateStr);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'fractal_morph_plan_status',
      date: dateStr,
      error: 'plan_not_found'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_morph_plan_status',
    date: dateStr,
    plan_id: payload.plan_id || null,
    objective_id: payload.objective_id || null,
    action_count: Array.isArray(payload.actions) ? payload.actions.length : 0,
    governance_required: payload.governance_required === true,
    output_path: path.relative(ROOT, fp).replace(/\\/g, '/')
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || args.help === true) {
    usage();
    return;
  }
  const dateStr = dateArgOrToday(args._[1]);
  if (cmd === 'run') {
    cmdRun(dateStr, args['objective-id'], args['max-actions']);
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

module.exports = {
  buildActions
};
