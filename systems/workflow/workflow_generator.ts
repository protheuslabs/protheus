#!/usr/bin/env node
'use strict';
export {};

/**
 * workflow_generator.js
 *
 * Adaptive workflow draft generator from repeated autonomy run patterns.
 * Outputs proposal-only workflow drafts (no direct execution).
 *
 * Usage:
 *   node systems/workflow/workflow_generator.js run [YYYY-MM-DD] [--days=N] [--max=N] [--policy=path]
 *   node systems/workflow/workflow_generator.js status [YYYY-MM-DD|latest]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadActiveStrategy } = require('../../lib/strategy_resolver');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.WORKFLOW_GENERATOR_RUNS_DIR
  ? path.resolve(process.env.WORKFLOW_GENERATOR_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const PRINCIPLES_LATEST_PATH = process.env.WORKFLOW_GENERATOR_PRINCIPLES_PATH
  ? path.resolve(process.env.WORKFLOW_GENERATOR_PRINCIPLES_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'principles', 'latest.json');
const OUT_DIR = process.env.WORKFLOW_GENERATOR_OUT_DIR
  ? path.resolve(process.env.WORKFLOW_GENERATOR_OUT_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'drafts');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'workflow_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/workflow_generator.js run [YYYY-MM-DD] [--days=N] [--max=N] [--policy=path]');
  console.log('  node systems/workflow/workflow_generator.js status [YYYY-MM-DD|latest]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeToken(v, maxLen = 120) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanText(v, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function shiftDate(dateStr, deltaDays) {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dateStr;
  base.setUTCDate(base.getUTCDate() + Number(deltaDays || 0));
  return base.toISOString().slice(0, 10);
}

function windowDates(dateStr, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(shiftDate(dateStr, -i));
  return out;
}

function stableId(seed, prefix = 'wf') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    window_days: 14,
    min_pattern_occurrences: 3,
    min_shipped_rate: 0.28,
    max_drafts_per_run: 8,
    apply_threshold: 0.62,
    max_registry_workflows: 128,
    promotion_gate: {
      enabled: true,
      require_contract_fields: true,
      require_non_regression: true,
      require_approval_receipt: true,
      require_gate_step: true,
      require_receipt_step: true,
      require_approver_id: true,
      require_approval_note: true,
      max_predicted_drift_delta: 0,
      min_predicted_yield_delta: 0,
      min_safety_score: 0.5,
      max_regression_risk: 0.56,
      max_red_team_critical_fail_cases: 0
    }
  };
}

function loadPolicy(policyPath) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const promotionRaw = raw.promotion_gate && typeof raw.promotion_gate === 'object'
    ? raw.promotion_gate
    : {};
  return {
    version: String(raw.version || base.version),
    enabled: raw.enabled !== false,
    window_days: clampInt(raw.window_days, 1, 90, base.window_days),
    min_pattern_occurrences: clampInt(raw.min_pattern_occurrences, 1, 10000, base.min_pattern_occurrences),
    min_shipped_rate: clampNumber(raw.min_shipped_rate, 0, 1, base.min_shipped_rate),
    max_drafts_per_run: clampInt(raw.max_drafts_per_run, 1, 64, base.max_drafts_per_run),
    apply_threshold: clampNumber(raw.apply_threshold, 0, 1, base.apply_threshold),
    max_registry_workflows: clampInt(raw.max_registry_workflows, 8, 10000, base.max_registry_workflows),
    promotion_gate: {
      enabled: promotionRaw.enabled !== false,
      require_contract_fields: promotionRaw.require_contract_fields !== false,
      require_non_regression: promotionRaw.require_non_regression !== false,
      require_approval_receipt: promotionRaw.require_approval_receipt !== false,
      require_gate_step: promotionRaw.require_gate_step !== false,
      require_receipt_step: promotionRaw.require_receipt_step !== false,
      require_approver_id: promotionRaw.require_approver_id !== false,
      require_approval_note: promotionRaw.require_approval_note !== false,
      max_predicted_drift_delta: clampNumber(
        promotionRaw.max_predicted_drift_delta,
        -1,
        1,
        base.promotion_gate.max_predicted_drift_delta
      ),
      min_predicted_yield_delta: clampNumber(
        promotionRaw.min_predicted_yield_delta,
        -1,
        1,
        base.promotion_gate.min_predicted_yield_delta
      ),
      min_safety_score: clampNumber(
        promotionRaw.min_safety_score,
        0,
        1,
        base.promotion_gate.min_safety_score
      ),
      max_regression_risk: clampNumber(
        promotionRaw.max_regression_risk,
        0,
        1,
        base.promotion_gate.max_regression_risk
      ),
      max_red_team_critical_fail_cases: clampInt(
        promotionRaw.max_red_team_critical_fail_cases,
        0,
        64,
        base.promotion_gate.max_red_team_critical_fail_cases
      )
    }
  };
}

function principlesSnapshot() {
  const payload = readJson(PRINCIPLES_LATEST_PATH, null);
  const summary = payload && payload.summary && typeof payload.summary === 'object'
    ? payload.summary
    : {};
  const score = clampNumber(summary.score, 0, 1, 0.5);
  const ids = Array.isArray(payload && payload.principles)
    ? payload.principles.filter((p) => p && p.pass === true).map((p) => String(p.id || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    available: !!payload,
    score,
    band: String(summary.band || 'unknown'),
    ids
  };
}

function defaultStats(scopeValue) {
  return {
    proposal_type: scopeValue,
    attempts: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    holds: 0,
    stops: 0,
    recent_objective_id: null
  };
}

function isPolicyHold(result) {
  const r = String(result || '').trim().toLowerCase();
  if (!r) return false;
  return r === 'policy_hold'
    || r.startsWith('no_candidates_policy_')
    || r.startsWith('stop_init_gate_')
    || r.startsWith('stop_repeat_gate_');
}

function collectPatternStats(dateStr, days) {
  const byType = {};
  let runRows = 0;
  for (const day of windowDates(dateStr, days)) {
    for (const row of readJsonl(path.join(RUNS_DIR, `${day}.jsonl`))) {
      if (String(row && row.type || '') !== 'autonomy_run') continue;
      runRows += 1;
      const proposalType = normalizeToken(row.proposal_type || 'unknown', 100) || 'unknown';
      if (!byType[proposalType]) byType[proposalType] = defaultStats(proposalType);
      const bucket = byType[proposalType];
      bucket.attempts += 1;
      const result = String(row.result || '').trim().toLowerCase();
      const outcome = String(row.outcome || '').trim().toLowerCase();
      if (result === 'executed') bucket.executed += 1;
      if (outcome === 'shipped') bucket.shipped += 1;
      if (outcome === 'no_change') bucket.no_change += 1;
      if (isPolicyHold(result)) bucket.holds += 1;
      if (result.startsWith('stop_')) bucket.stops += 1;
      if (row.objective_id) bucket.recent_objective_id = String(row.objective_id);
    }
  }
  return {
    run_rows: runRows,
    rows: Object.values(byType)
  };
}

function workflowStepsForProposalType(proposalType) {
  const p = String(proposalType || '').trim().toLowerCase();
  if (p.includes('collector')) {
    return [
      { id: 'collect', type: 'command', command: 'node habits/scripts/external_eyes.js run --eye=<eye_id>', purpose: 'collect source signal' },
      { id: 'ingest', type: 'command', command: 'node habits/scripts/sensory_queue.js ingest <date>', purpose: 'normalize and queue proposals' },
      { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'enforce execution safety gates' },
      { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', purpose: 'record verifiable outcome' }
    ];
  }
  if (p.includes('actuation') || p.includes('publish')) {
    return [
      { id: 'bridge', type: 'command', command: 'node systems/actuation/bridge_from_proposals.js run <date>', purpose: 'map proposal -> actuation contract' },
      { id: 'execute', type: 'command', command: 'node systems/actuation/actuation_executor.js run --kind=<adapter> --dry-run', purpose: 'execute safely via adapter lane' },
      { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'confirm postconditions and rollbackability' },
      { id: 'receipt', type: 'receipt', command: 'state/actuation/receipts/<date>.jsonl', purpose: 'record actuation receipt' }
    ];
  }
  return [
    { id: 'enrich', type: 'command', command: 'node systems/autonomy/proposal_enricher.js run <date>', purpose: 'normalize actionable proposal shape' },
    { id: 'rank', type: 'command', command: 'node systems/autonomy/autonomy_controller.js run <date>', purpose: 'rank and execute/preview according to strategy' },
    { id: 'verify', type: 'gate', command: 'node systems/autonomy/strategy_execute_guard.js run <date>', purpose: 'enforce safety and evidence checks' },
    { id: 'receipt', type: 'receipt', command: 'state/autonomy/receipts/<date>.jsonl', purpose: 'record final receipt evidence' }
  ];
}

function generateDrafts(dateStr, opts = {}) {
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : defaultPolicy();
  const days = clampInt(opts.days, 1, 90, policy.window_days);
  const maxDrafts = clampInt(opts.maxDrafts, 1, 64, policy.max_drafts_per_run);
  const strategy = loadActiveStrategy({ allowMissing: true });
  const objectivePrimary = cleanText(
    strategy && strategy.objective && strategy.objective.primary
      ? strategy.objective.primary
      : 'maximize verified progress under active directives',
    220
  );
  const strategyId = String(strategy && strategy.id || 'unknown');
  const principleSnapshot = principlesSnapshot();
  const patterns = collectPatternStats(dateStr, days);

  const candidates = [];
  for (const row of patterns.rows) {
    const stats = row && typeof row === 'object' ? row : {};
    const attempts = Number(stats.attempts || 0);
    if (attempts < Number(policy.min_pattern_occurrences || 1)) continue;
    const shippedRate = attempts > 0 ? Number(stats.shipped || 0) / attempts : 0;
    const failureRate = attempts > 0
      ? (Number(stats.no_change || 0) + Number(stats.holds || 0) + Number(stats.stops || 0)) / attempts
      : 1;
    const proposalType = normalizeToken(stats.proposal_type || 'unknown', 100) || 'unknown';
    const intrinsic = (shippedRate * 0.65) + ((1 - failureRate) * 0.35);
    const principleBlend = (Number(principleSnapshot.score || 0.5) * 0.2);
    const score = Number(clampNumber(intrinsic + principleBlend, 0, 1, 0).toFixed(4));
    if (shippedRate < Number(policy.min_shipped_rate || 0)) continue;
    const workflowId = stableId(`${strategyId}|${proposalType}|${stats.recent_objective_id || ''}`, 'wf');
    candidates.push({
      id: workflowId,
      name: `Adaptive workflow for ${proposalType}`,
      status: 'draft',
      source: 'adaptive_workflow_generator',
      strategy_id: strategyId,
      objective_id: stats.recent_objective_id || null,
      objective_primary: objectivePrimary,
      trigger: {
        proposal_type: proposalType,
        min_occurrences: Number(policy.min_pattern_occurrences || 1),
        suggested_when: {
          min_shipped_rate: Number(policy.min_shipped_rate || 0)
        }
      },
      principles: {
        score: Number(principleSnapshot.score || 0),
        band: principleSnapshot.band || 'unknown',
        ids: Array.isArray(principleSnapshot.ids) ? principleSnapshot.ids.slice(0, 8) : []
      },
      metrics: {
        attempts,
        shipped_rate: Number(shippedRate.toFixed(4)),
        failure_rate: Number(failureRate.toFixed(4)),
        score
      },
      risk_policy: {
        max_risk_per_action: strategy && strategy.risk_policy ? Number(strategy.risk_policy.max_risk_per_action || 35) : 35,
        allowed_risks: strategy && strategy.risk_policy && Array.isArray(strategy.risk_policy.allowed_risks)
          ? strategy.risk_policy.allowed_risks.slice(0, 4)
          : ['low']
      },
      steps: workflowStepsForProposalType(proposalType),
      generated_at: nowIso()
    });
  }

  candidates.sort((a, b) => Number(b.metrics.score || 0) - Number(a.metrics.score || 0));
  const drafts = candidates.slice(0, maxDrafts);
  return {
    date: dateStr,
    policy,
    window_days: days,
    run_rows: Number(patterns.run_rows || 0),
    strategy_id: strategyId,
    principle_snapshot: principleSnapshot,
    drafts
  };
}

function runCmd(dateStr, args) {
  const policyPath = path.resolve(String(args.policy || process.env.WORKFLOW_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled === false) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'workflow_generator_run',
      date: dateStr,
      skipped: true,
      reason: 'policy_disabled',
      policy_path: relPath(policyPath)
    })}\n`);
    return;
  }
  const generated = generateDrafts(dateStr, {
    policy,
    days: args.days,
    maxDrafts: args.max
  });
  const payload = {
    ok: true,
    type: 'workflow_generator_run',
    ts: nowIso(),
    date: dateStr,
    policy_version: policy.version,
    policy_path: relPath(policyPath),
    window_days: generated.window_days,
    run_rows: generated.run_rows,
    strategy_id: generated.strategy_id,
    principle_snapshot: generated.principle_snapshot,
    drafts: generated.drafts
  };

  const fp = path.join(OUT_DIR, `${dateStr}.json`);
  writeJsonAtomic(fp, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    date: payload.date,
    strategy_id: payload.strategy_id,
    run_rows: payload.run_rows,
    drafts: Array.isArray(payload.drafts) ? payload.drafts.length : 0
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    date: payload.date,
    strategy_id: payload.strategy_id,
    run_rows: payload.run_rows,
    drafts: Array.isArray(payload.drafts) ? payload.drafts.length : 0,
    output_path: relPath(fp)
  })}\n`);
}

function statusCmd(dateArg) {
  const useLatest = String(dateArg || '').trim().toLowerCase() === 'latest';
  const fp = useLatest ? LATEST_PATH : path.join(OUT_DIR, `${dateArgOrToday(dateArg)}.json`);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'workflow_generator_status',
      error: 'workflow_generator_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'workflow_generator_status',
    date: payload.date || null,
    ts: payload.ts || null,
    strategy_id: payload.strategy_id || null,
    run_rows: Number(payload.run_rows || 0),
    drafts: Array.isArray(payload.drafts) ? payload.drafts.length : 0
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') return runCmd(dateArgOrToday(args._[1]), args);
  if (cmd === 'status') return statusCmd(args._[1] || 'latest');
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'workflow_generator',
      error: String(err && err.message ? err.message : err || 'workflow_generator_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  generateDrafts
};
