#!/usr/bin/env node
'use strict';
export {};

/**
 * zero_permission_conversational_layer.js
 *
 * V3-AGT-001:
 * Risk-tier conversational execution contract.
 *
 * Commands:
 *   node systems/autonomy/zero_permission_conversational_layer.js decide --action-id=<id> [--risk-tier=<low|medium|high>] [--estimated-cost-usd=<n>] [--liability-score=<0..1>] [--approval-note="..."] [--apply=0|1]
 *   node systems/autonomy/zero_permission_conversational_layer.js status
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ZERO_PERMISSION_CONVERSATIONAL_LAYER_POLICY_PATH
  ? path.resolve(process.env.ZERO_PERMISSION_CONVERSATIONAL_LAYER_POLICY_PATH)
  : path.join(ROOT, 'config', 'zero_permission_conversational_layer_policy.json');

type AnyObj = Record<string, any>;

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

function toBool(v: unknown, fallback = false) {
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    high_risk_min_approval_note_chars: 12,
    medium_veto_window_minutes: 10,
    low_to_medium_promote_usd: 50,
    default_risk_tier: 'medium',
    default_cost_usd: 8,
    default_liability_score: 0.35,
    threshold_usd: {
      low: 100,
      medium: 1000
    },
    liability_threshold: {
      low: 0.2,
      medium: 0.55
    },
    state: {
      state_path: 'state/autonomy/zero_permission_layer/state.json',
      latest_path: 'state/autonomy/zero_permission_layer/latest.json',
      receipts_path: 'state/autonomy/zero_permission_layer/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const thresholdUsd = raw.threshold_usd && typeof raw.threshold_usd === 'object' ? raw.threshold_usd : {};
  const liabilityThreshold = raw.liability_threshold && typeof raw.liability_threshold === 'object'
    ? raw.liability_threshold
    : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    high_risk_min_approval_note_chars: clampInt(
      raw.high_risk_min_approval_note_chars,
      1,
      200,
      base.high_risk_min_approval_note_chars
    ),
    medium_veto_window_minutes: clampInt(
      raw.medium_veto_window_minutes,
      0,
      24 * 60,
      base.medium_veto_window_minutes
    ),
    low_to_medium_promote_usd: clampNumber(
      raw.low_to_medium_promote_usd,
      0,
      1000000,
      base.low_to_medium_promote_usd
    ),
    default_risk_tier: normalizeToken(raw.default_risk_tier || base.default_risk_tier, 20) || base.default_risk_tier,
    default_cost_usd: clampNumber(raw.default_cost_usd, 0, 1000000, base.default_cost_usd),
    default_liability_score: clampNumber(raw.default_liability_score, 0, 1, base.default_liability_score),
    threshold_usd: {
      low: clampNumber(thresholdUsd.low, 0, 1000000, base.threshold_usd.low),
      medium: clampNumber(thresholdUsd.medium, 0, 10000000, base.threshold_usd.medium)
    },
    liability_threshold: {
      low: clampNumber(liabilityThreshold.low, 0, 1, base.liability_threshold.low),
      medium: clampNumber(liabilityThreshold.medium, 0, 1, base.liability_threshold.medium)
    },
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'zero_permission_layer_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    decisions_total: 0,
    decisions_by_tier: {
      low: 0,
      medium: 0,
      high: 0
    }
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'zero_permission_layer_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    decisions_total: clampInt(src.decisions_total, 0, 1_000_000_000, 0),
    decisions_by_tier: {
      low: clampInt(src.decisions_by_tier && src.decisions_by_tier.low, 0, 1_000_000_000, 0),
      medium: clampInt(src.decisions_by_tier && src.decisions_by_tier.medium, 0, 1_000_000_000, 0),
      high: clampInt(src.decisions_by_tier && src.decisions_by_tier.high, 0, 1_000_000_000, 0)
    }
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'zero_permission_layer_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    decisions_total: clampInt(state.decisions_total, 0, 1_000_000_000, 0),
    decisions_by_tier: {
      low: clampInt(state.decisions_by_tier && state.decisions_by_tier.low, 0, 1_000_000_000, 0),
      medium: clampInt(state.decisions_by_tier && state.decisions_by_tier.medium, 0, 1_000_000_000, 0),
      high: clampInt(state.decisions_by_tier && state.decisions_by_tier.high, 0, 1_000_000_000, 0)
    }
  });
}

function persistLatest(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, row);
  appendJsonl(policy.state.receipts_path, row);
}

function inferRiskTier(policy: AnyObj, args: AnyObj) {
  const override = normalizeToken(args['risk-tier'] || args.risk_tier || args.risk || '', 20);
  const estimatedCostUsd = clampNumber(
    args['estimated-cost-usd'] || args.estimated_cost_usd,
    0,
    1_000_000_000,
    policy.default_cost_usd
  );
  const liabilityScore = clampNumber(
    args['liability-score'] || args.liability_score,
    0,
    1,
    policy.default_liability_score
  );
  let tier = ['low', 'medium', 'high'].includes(override) ? override : '';
  if (!tier) {
    if (estimatedCostUsd <= Number(policy.threshold_usd.low || 100) && liabilityScore <= Number(policy.liability_threshold.low || 0.2)) {
      tier = 'low';
    } else if (estimatedCostUsd <= Number(policy.threshold_usd.medium || 1000) && liabilityScore <= Number(policy.liability_threshold.medium || 0.55)) {
      tier = 'medium';
    } else {
      tier = 'high';
    }
  }
  return {
    risk_tier: tier || policy.default_risk_tier || 'medium',
    estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
    liability_score: Number(liabilityScore.toFixed(6))
  };
}

function decide(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const actionId = normalizeToken(args['action-id'] || args.action_id || '', 200) || 'action_unknown';
  const profile = inferRiskTier(policy, args);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 1000);
  const applyRequested = toBool(args.apply, false);
  const now = nowIso();
  const reasonCodes: string[] = [];

  let executionMode = 'execute_and_report';
  let operatorPromptRequired = false;
  let executeNow = true;
  let vetoDeadlineAt = null;
  let approvalSatisfied = true;

  if (profile.risk_tier === 'medium') {
    executionMode = 'shadow_then_auto_execute_unless_vetoed';
    const deadlineMs = Date.now() + (Number(policy.medium_veto_window_minutes || 0) * 60 * 1000);
    vetoDeadlineAt = new Date(deadlineMs).toISOString();
  } else if (profile.risk_tier === 'high') {
    executionMode = 'explicit_approval_required';
    operatorPromptRequired = true;
    executeNow = false;
    approvalSatisfied = applyRequested
      && approvalNote.length >= Number(policy.high_risk_min_approval_note_chars || 12);
    if (!applyRequested) reasonCodes.push('high_risk_apply_required');
    if (approvalNote.length < Number(policy.high_risk_min_approval_note_chars || 12)) {
      reasonCodes.push('high_risk_approval_note_required');
    }
    if (policy.shadow_only === true) {
      reasonCodes.push('shadow_only_mode');
      approvalSatisfied = false;
    }
    if (approvalSatisfied) executeNow = true;
  } else if (policy.shadow_only === true) {
    reasonCodes.push('autonomous_tier_override_shadow');
  }

  state.decisions_total = clampInt(Number(state.decisions_total || 0) + 1, 0, 1_000_000_000, 0);
  state.decisions_by_tier[profile.risk_tier] = clampInt(
    Number(state.decisions_by_tier && state.decisions_by_tier[profile.risk_tier] || 0) + 1,
    0,
    1_000_000_000,
    0
  );
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'zero_permission_decision',
    ts: now,
    action_id: actionId,
    risk_tier: profile.risk_tier,
    estimated_cost_usd: profile.estimated_cost_usd,
    liability_score: profile.liability_score,
    execution_mode: executionMode,
    operator_prompt_required: operatorPromptRequired,
    execute_now: executeNow,
    veto_deadline_at: vetoDeadlineAt,
    apply_requested: applyRequested,
    approval_satisfied: approvalSatisfied,
    reason_codes: reasonCodes,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path)
    }
  };
  persistLatest(policy, out);
  return out;
}

function status(policy: AnyObj) {
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  return {
    ok: true,
    type: 'zero_permission_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      medium_veto_window_minutes: policy.medium_veto_window_minutes
    },
    state,
    latest: latest && typeof latest === 'object'
      ? {
        type: cleanText(latest.type || '', 80) || null,
        ts: cleanText(latest.ts || '', 60) || null,
        risk_tier: cleanText(latest.risk_tier || '', 20) || null,
        execution_mode: cleanText(latest.execution_mode || '', 80) || null
      }
      : null,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path),
      receipts_path: rel(policy.state.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/zero_permission_conversational_layer.js decide --action-id=<id> [--risk-tier=<low|medium|high>] [--estimated-cost-usd=<n>] [--liability-score=<0..1>] [--approval-note="..."] [--apply=0|1]');
  console.log('  node systems/autonomy/zero_permission_conversational_layer.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  let out: AnyObj;
  if (!policy.enabled) {
    out = { ok: false, type: 'zero_permission_layer', ts: nowIso(), error: 'policy_disabled' };
  } else if (cmd === 'decide') {
    out = decide(policy, args);
  } else if (cmd === 'status') {
    out = status(policy);
  } else if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  } else {
    out = { ok: false, type: 'zero_permission_layer', ts: nowIso(), error: `unknown_command:${cmd}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  decide,
  status
};
