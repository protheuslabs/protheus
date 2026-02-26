#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/workflow/high_value_play_detector.js
 *
 * Safe high-value play scoring and outcome tracking.
 * BRG-005 implementation.
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'high_value_play_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'adaptive', 'workflows', 'high_value_play');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'history.jsonl');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');

function nowIso() {
  return new Date().toISOString();
}

function parseIsoMs(value: unknown) {
  const ts = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ts) ? ts : null;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePaths(opts: AnyObj = {}) {
  const stateDir = path.resolve(String(opts.stateDir || opts.state_dir || process.env.HIGH_VALUE_PLAY_STATE_DIR || DEFAULT_STATE_DIR));
  return {
    policy_path: path.resolve(String(opts.policyPath || opts.policy_path || process.env.HIGH_VALUE_PLAY_POLICY_PATH || DEFAULT_POLICY_PATH)),
    state_dir: stateDir,
    history_path: path.resolve(String(opts.historyPath || opts.history_path || process.env.HIGH_VALUE_PLAY_HISTORY_PATH || path.join(stateDir, 'history.jsonl'))),
    latest_path: path.resolve(String(opts.latestPath || opts.latest_path || process.env.HIGH_VALUE_PLAY_LATEST_PATH || path.join(stateDir, 'latest.json')))
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    apply_annotations: true,
    thresholds: {
      min_reward_potential: 0.62,
      max_drift_risk: 0.35,
      min_reversibility: 0.5,
      min_confidence: 0.58
    },
    weights: {
      score: 0.38,
      yield_delta: 0.27,
      value_priority: 0.22,
      objective_bonus: 0.13
    },
    false_positive: {
      enabled: true,
      lookback_days: 45,
      max_rate: 0.33,
      min_outcomes_for_enforcement: 6,
      confidence_penalty: 0.08,
      reward_penalty: 0.08
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const weights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const fp = raw.false_positive && typeof raw.false_positive === 'object' ? raw.false_positive : {};
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: raw.enabled !== false,
    apply_annotations: raw.apply_annotations !== false,
    thresholds: {
      min_reward_potential: clampNumber(thresholds.min_reward_potential, 0, 1, base.thresholds.min_reward_potential),
      max_drift_risk: clampNumber(thresholds.max_drift_risk, 0, 1, base.thresholds.max_drift_risk),
      min_reversibility: clampNumber(thresholds.min_reversibility, 0, 1, base.thresholds.min_reversibility),
      min_confidence: clampNumber(thresholds.min_confidence, 0, 1, base.thresholds.min_confidence)
    },
    weights: {
      score: clampNumber(weights.score, 0, 1, base.weights.score),
      yield_delta: clampNumber(weights.yield_delta, 0, 1, base.weights.yield_delta),
      value_priority: clampNumber(weights.value_priority, 0, 1, base.weights.value_priority),
      objective_bonus: clampNumber(weights.objective_bonus, 0, 1, base.weights.objective_bonus)
    },
    false_positive: {
      enabled: fp.enabled !== false,
      lookback_days: clampInt(fp.lookback_days, 1, 365, base.false_positive.lookback_days),
      max_rate: clampNumber(fp.max_rate, 0, 1, base.false_positive.max_rate),
      min_outcomes_for_enforcement: clampInt(
        fp.min_outcomes_for_enforcement,
        1,
        1000,
        base.false_positive.min_outcomes_for_enforcement
      ),
      confidence_penalty: clampNumber(fp.confidence_penalty, 0, 0.5, base.false_positive.confidence_penalty),
      reward_penalty: clampNumber(fp.reward_penalty, 0, 0.5, base.false_positive.reward_penalty)
    }
  };
}

function objectiveBonus(objectiveText: string) {
  const text = String(objectiveText || '').toLowerCase();
  let bonus = 0;
  if (/(revenue|profit|income|sales|contract|client|pipeline)/.test(text)) bonus += 0.08;
  if (/(ship|deliver|execution|throughput|automation)/.test(text)) bonus += 0.05;
  if (/(low.?risk|safe|guarded|reversible|rollback)/.test(text)) bonus += 0.04;
  return clampNumber(bonus, 0, 0.18, 0);
}

function reversibilityScore(draft: AnyObj) {
  const steps = Array.isArray(draft && draft.steps) ? draft.steps : [];
  if (!steps.length) return 0.2;
  let score = 0.15;
  const hasRollback = steps.some((row) => /rollback/i.test(String(row && row.id || '')) || /rollback/i.test(String(row && row.command || '')));
  const hasGate = steps.some((row) => String(row && row.type || '').toLowerCase() === 'gate');
  const hasReceipt = steps.some((row) => String(row && row.type || '').toLowerCase() === 'receipt');
  if (hasRollback) score += 0.45;
  if (hasGate) score += 0.2;
  if (hasReceipt) score += 0.2;
  return clampNumber(score, 0, 1, 0.2);
}

function computeFalsePositiveRate(rows: AnyObj[], lookbackDays: number) {
  const sinceMs = Date.now() - (clampInt(lookbackDays, 1, 3650, 45) * 24 * 60 * 60 * 1000);
  const outcomeRows = rows.filter((row) => {
    if (!row || row.type !== 'high_value_play_outcome') return false;
    const ts = parseIsoMs(row.ts);
    return ts != null && ts >= sinceMs;
  });
  const total = outcomeRows.length;
  if (!total) return { rate: 0, total: 0, false_positive: 0 };
  const falsePositive = outcomeRows.filter((row) => {
    const out = normalizeToken(row.outcome || '', 32);
    return out === 'failed' || out === 'blocked';
  }).length;
  return {
    rate: Number((falsePositive / total).toFixed(6)),
    total,
    false_positive: falsePositive
  };
}

function evaluateDraft(draft: AnyObj, policy: AnyObj, fpRate: number, enforceFp: boolean) {
  const metrics = draft && draft.metrics && typeof draft.metrics === 'object' ? draft.metrics : {};
  const score = clampNumber(metrics.score, 0, 1, 0);
  const valuePriority = clampNumber(metrics.value_priority_score, 0, 1, 0.5);
  const yieldDelta = clampNumber(metrics.predicted_yield_delta, -1, 1, 0);
  const yieldSignal = clampNumber((yieldDelta + 0.02) / 0.08, 0, 1, 0);
  const bonus = objectiveBonus(cleanText(draft && draft.objective_primary || '', 260));

  const w = policy.weights;
  let rewardPotential = (
    (score * Number(w.score || 0.38))
    + (yieldSignal * Number(w.yield_delta || 0.27))
    + (valuePriority * Number(w.value_priority || 0.22))
    + (bonus * Number(w.objective_bonus || 0.13) * 5)
  );
  rewardPotential = clampNumber(rewardPotential, 0, 1, 0);

  const driftDelta = clampNumber(metrics.predicted_drift_delta, -1, 1, 0);
  const driftComponent = clampNumber(driftDelta / 0.06, 0, 1, 0);
  const regressionRisk = clampNumber(metrics.regression_risk, 0, 1, 0.5);
  const driftRisk = clampNumber((driftComponent * 0.52) + (regressionRisk * 0.48), 0, 1, 0.5);

  const reversibility = reversibilityScore(draft);
  const safety = clampNumber(metrics.safety_score, 0, 1, 0.5);
  const tritAlignment = clampNumber((Number(metrics.trit_alignment || 0) + 1) / 2, 0, 1, 0.5);
  let confidence = clampNumber(
    (score * 0.38) + ((1 - driftRisk) * 0.24) + (reversibility * 0.18) + (safety * 0.12) + (tritAlignment * 0.08),
    0,
    1,
    0
  );

  if (enforceFp) {
    rewardPotential = clampNumber(rewardPotential - Number(policy.false_positive.reward_penalty || 0.08), 0, 1, 0);
    confidence = clampNumber(confidence - Number(policy.false_positive.confidence_penalty || 0.08), 0, 1, 0);
  }

  const th = policy.thresholds;
  const safe = rewardPotential >= Number(th.min_reward_potential || 0.62)
    && driftRisk <= Number(th.max_drift_risk || 0.35)
    && reversibility >= Number(th.min_reversibility || 0.5)
    && confidence >= Number(th.min_confidence || 0.58);

  const reasonCodes = [];
  if (rewardPotential >= Number(th.min_reward_potential || 0.62)) reasonCodes.push('reward_threshold_pass');
  if (driftRisk <= Number(th.max_drift_risk || 0.35)) reasonCodes.push('drift_threshold_pass');
  if (reversibility >= Number(th.min_reversibility || 0.5)) reasonCodes.push('reversibility_threshold_pass');
  if (confidence >= Number(th.min_confidence || 0.58)) reasonCodes.push('confidence_threshold_pass');
  if (enforceFp) reasonCodes.push('false_positive_penalty_applied');

  return {
    flagged: rewardPotential >= Number(th.min_reward_potential || 0.62),
    safe,
    reward_potential: Number(rewardPotential.toFixed(4)),
    drift_risk: Number(driftRisk.toFixed(4)),
    reversibility: Number(reversibility.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    false_positive_rate: Number(fpRate.toFixed(4)),
    reason_codes: reasonCodes,
    evidence: {
      source: 'orchestron_nursery',
      score: Number(score.toFixed(4)),
      predicted_yield_delta: Number(yieldDelta.toFixed(4)),
      predicted_drift_delta: Number(driftDelta.toFixed(4)),
      regression_risk: Number(regressionRisk.toFixed(4)),
      safety_score: Number(safety.toFixed(4))
    }
  };
}

function deepAnnotateDraft(draft: AnyObj, policy: AnyObj, fpRate: number, enforceFp: boolean) {
  const src = draft && typeof draft === 'object' ? draft : {};
  const annotation = evaluateDraft(src, policy, fpRate, enforceFp);
  const children = Array.isArray(src.children) ? src.children : [];
  const nextChildren = children.map((child) => deepAnnotateDraft(child, policy, fpRate, enforceFp));
  const out = {
    ...src,
    high_value_play: {
      ...(src.high_value_play && typeof src.high_value_play === 'object' ? src.high_value_play : {}),
      ...annotation,
      policy_version: policy.version,
      evaluated_at: nowIso()
    },
    children: nextChildren
  };
  if (annotation.safe === true) {
    if (!out.priority || String(out.priority).toLowerCase() === 'medium') out.priority = 'high';
    const tags = Array.isArray(out.tags) ? out.tags.slice(0) : [];
    if (!tags.includes('high_value_play')) tags.push('high_value_play');
    out.tags = tags;
  }
  return out;
}

function detectHighValuePlays(input: AnyObj = {}, opts: AnyObj = {}) {
  const paths = resolvePaths(opts);
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(paths.policy_path);
  const dateStr = cleanText(input.date || nowIso().slice(0, 10), 16) || nowIso().slice(0, 10);
  const runId = cleanText(input.run_id || `hvp_${Date.now().toString(36)}`, 80) || `hvp_${Date.now().toString(36)}`;
  const dryRun = input.dry_run === true;

  if (policy.enabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: 'high_value_policy_disabled',
      drafts: Array.isArray(input.drafts) ? input.drafts : [],
      promotable_drafts: Array.isArray(input.promotable_drafts) ? input.promotable_drafts : []
    };
  }

  const historyRows = readJsonl(paths.history_path);
  const fp = computeFalsePositiveRate(historyRows, Number(policy.false_positive.lookback_days || 45));
  const enforceFp = policy.false_positive.enabled === true
    && fp.total >= Number(policy.false_positive.min_outcomes_for_enforcement || 6)
    && fp.rate >= Number(policy.false_positive.max_rate || 0.33);

  const draftsRaw = Array.isArray(input.drafts) ? input.drafts : [];
  const promotableRaw = Array.isArray(input.promotable_drafts) ? input.promotable_drafts : [];
  const drafts = draftsRaw.map((row) => deepAnnotateDraft(row, policy, fp.rate, enforceFp));
  const byId = new Map(drafts.map((row) => [String(row && row.id || ''), row]));
  const promotable = promotableRaw.map((row) => {
    const id = String(row && row.id || '');
    if (id && byId.has(id)) return byId.get(id);
    return deepAnnotateDraft(row, policy, fp.rate, enforceFp);
  });

  const topRows = drafts.filter((row) => row && row.high_value_play && typeof row.high_value_play === 'object');
  const flagged = topRows.filter((row) => row.high_value_play.flagged === true).length;
  const safe = topRows.filter((row) => row.high_value_play.safe === true).length;
  const safePromotable = promotable.filter((row) => row && row.high_value_play && row.high_value_play.safe === true);

  if (policy.apply_annotations === true && dryRun !== true) {
    for (const row of topRows) {
      const hv = row.high_value_play || {};
      appendJsonl(paths.history_path, {
        ts: nowIso(),
        type: 'high_value_play_candidate',
        run_id: runId,
        date: dateStr,
        workflow_id: String(row && row.id || ''),
        objective_id: cleanText(row && row.objective_id || '', 120) || null,
        flagged: hv.flagged === true,
        safe: hv.safe === true,
        reward_potential: Number(hv.reward_potential || 0),
        drift_risk: Number(hv.drift_risk || 0),
        reversibility: Number(hv.reversibility || 0),
        confidence: Number(hv.confidence || 0),
        false_positive_rate: Number(hv.false_positive_rate || 0)
      });
    }
  }

  const summary = {
    enabled: true,
    policy_version: policy.version,
    false_positive_rate: Number(fp.rate.toFixed(4)),
    false_positive_samples: Number(fp.total || 0),
    false_positive_count: Number(fp.false_positive || 0),
    false_positive_penalty_active: enforceFp,
    flagged_count: flagged,
    safe_count: safe,
    safe_promotable_count: safePromotable.length
  };

  writeJsonAtomic(paths.latest_path, {
    ts: nowIso(),
    type: 'high_value_play_snapshot',
    run_id: runId,
    date: dateStr,
    summary,
    policy_path: relPath(paths.policy_path),
    history_path: relPath(paths.history_path)
  });

  return {
    ok: true,
    type: 'high_value_play_detection',
    ts: nowIso(),
    run_id: runId,
    date: dateStr,
    policy,
    policy_path: relPath(paths.policy_path),
    history_path: relPath(paths.history_path),
    latest_path: relPath(paths.latest_path),
    summary,
    drafts,
    promotable_drafts: promotable,
    safe_promotable_drafts: safePromotable,
    auto_proposals: safePromotable.map((row) => ({
      workflow_id: String(row && row.id || ''),
      objective_id: cleanText(row && row.objective_id || '', 120) || null,
      confidence: Number(row && row.high_value_play && row.high_value_play.confidence || 0),
      reward_potential: Number(row && row.high_value_play && row.high_value_play.reward_potential || 0),
      drift_risk: Number(row && row.high_value_play && row.high_value_play.drift_risk || 0),
      reversibility: Number(row && row.high_value_play && row.high_value_play.reversibility || 0),
      simulation_evidence: row && row.high_value_play && row.high_value_play.evidence
        ? row.high_value_play.evidence
        : null
    }))
  };
}

function recordExecutionOutcomes(input: AnyObj = {}, opts: AnyObj = {}) {
  const paths = resolvePaths(opts);
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(paths.policy_path);
  const dryRun = input.dry_run === true;
  if (policy.enabled !== true || dryRun) {
    return {
      ok: true,
      skipped: true,
      reason: policy.enabled !== true ? 'high_value_policy_disabled' : 'dry_run',
      outcomes_recorded: 0
    };
  }

  const results = Array.isArray(input.results) ? input.results : [];
  const workflows = Array.isArray(input.workflows) ? input.workflows : [];
  const wfMap = new Map(workflows.map((row) => [String(row && row.id || ''), row]));
  let recorded = 0;

  for (const result of results) {
    const workflowId = String(result && result.workflow_id || '');
    if (!workflowId) continue;
    const workflow = wfMap.get(workflowId) || {};
    const hv = (result && result.high_value_play && typeof result.high_value_play === 'object')
      ? result.high_value_play
      : (workflow && workflow.high_value_play && typeof workflow.high_value_play === 'object' ? workflow.high_value_play : null);
    if (!hv || hv.flagged !== true) continue;

    const outcome = result && result.ok === true
      ? 'success'
      : (result && result.blocked_by_gate === true ? 'blocked' : 'failed');
    appendJsonl(paths.history_path, {
      ts: nowIso(),
      type: 'high_value_play_outcome',
      date: cleanText(input.date || '', 16) || nowIso().slice(0, 10),
      run_id: cleanText(input.run_id || '', 80) || null,
      workflow_id: workflowId,
      outcome,
      blocked_by_gate: result && result.blocked_by_gate === true,
      reward_potential: Number(hv.reward_potential || 0),
      drift_risk: Number(hv.drift_risk || 0),
      confidence: Number(hv.confidence || 0),
      safe: hv.safe === true
    });
    recorded += 1;
  }

  const fp = computeFalsePositiveRate(readJsonl(paths.history_path), Number(policy.false_positive.lookback_days || 45));
  return {
    ok: true,
    outcomes_recorded: recorded,
    false_positive_rate: Number(fp.rate.toFixed(4)),
    false_positive_samples: Number(fp.total || 0),
    false_positive_count: Number(fp.false_positive || 0)
  };
}

module.exports = {
  loadPolicy,
  detectHighValuePlays,
  recordExecutionOutcomes
};
