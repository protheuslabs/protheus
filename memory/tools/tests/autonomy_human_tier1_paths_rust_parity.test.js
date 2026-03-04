#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

delete require.cache[bridgePath];
const { runBacklogAutoscalePrimitive } = require(bridgePath);

function jsNowIso(input) {
  const raw = String((input && input.now_iso) || '').trim();
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return { value: new Date(ms).toISOString() };
  }
  return { value: new Date().toISOString() };
}

function jsTodayStr(input) {
  const raw = String((input && input.now_iso) || '').trim();
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return { value: new Date(ms).toISOString().slice(0, 10) };
  }
  return { value: new Date().toISOString().slice(0, 10) };
}

function jsApprovalPhrase(input) {
  const prefix = String((input && input.prefix) || 'I_APPROVE_ONE_SHOT_CANARY_OVERRIDE');
  const date = String((input && input.date_str) || '');
  const nonce = String((input && input.nonce) || '');
  return { phrase: `${prefix}:${date}:${nonce}` };
}

function jsParseState(input) {
  const o = input && input.record && typeof input.record === 'object' ? input.record : null;
  if (!o) {
    return {
      active: false,
      reason: 'missing',
      expired: null,
      remaining: null,
      expires_at: null,
      date: null,
      require_execution_mode: null,
      id: null,
      type: null
    };
  }
  const expMs = Date.parse(String(o.expires_at || ''));
  const nowMs = Number(input && input.now_ms);
  const remaining = Number(o.remaining_uses || 0);
  const expired = !Number.isFinite(expMs) || nowMs > expMs;
  if (remaining <= 0) {
    return {
      active: false,
      reason: 'depleted',
      expired,
      remaining,
      expires_at: null,
      date: null,
      require_execution_mode: null,
      id: null,
      type: null
    };
  }
  if (expired) {
    return {
      active: false,
      reason: 'expired',
      expired,
      remaining,
      expires_at: null,
      date: null,
      require_execution_mode: null,
      id: null,
      type: null
    };
  }
  return {
    active: true,
    reason: 'ok',
    expired: false,
    remaining,
    expires_at: String(o.expires_at || ''),
    date: String(o.date || ''),
    require_execution_mode: String(o.require_execution_mode || ''),
    id: String(o.id || ''),
    type: String(o.type || '')
  };
}

function jsDailyBudgetPath(input) {
  return { path: path.join(String(input.state_dir || ''), `${String(input.date_str || '')}.json`) };
}

function jsRunsPathFor(input) {
  return { path: path.join(String(input.runs_dir || ''), `${String(input.date_str || '')}.jsonl`) };
}

function jsEffectiveTier1Policy(input) {
  const mode = String((input && input.execution_mode) || '').trim().toLowerCase();
  const isCanary = mode === 'canary_execute';
  return {
    execution_mode: mode || null,
    canary_relaxed: isCanary,
    burn_rate_multiplier: isCanary
      ? Math.max(Number(input.tier1_burn_rate_multiplier), Number(input.tier1_canary_burn_rate_multiplier))
      : Number(input.tier1_burn_rate_multiplier),
    min_projected_tokens_for_burn_check: isCanary
      ? Math.max(Number(input.tier1_min_projected_tokens_for_burn_check), Number(input.tier1_canary_min_projected_tokens_for_burn_check))
      : Number(input.tier1_min_projected_tokens_for_burn_check),
    drift_min_samples: isCanary
      ? Math.max(Number(input.tier1_drift_min_samples), Number(input.tier1_canary_drift_min_samples))
      : Number(input.tier1_drift_min_samples),
    alignment_threshold: isCanary
      ? Math.min(Number(input.tier1_alignment_threshold), Number(input.tier1_canary_alignment_threshold))
      : Number(input.tier1_alignment_threshold),
    suppress_alignment_blocker: isCanary && input.tier1_canary_suppress_alignment_blocker === true
  };
}

function jsCompactTier1Exception(input) {
  if (!(input && input.tracked === true)) return { has_value: false, value: null };
  const recovery = input && input.recovery && typeof input.recovery === 'object' ? input.recovery : null;
  return {
    has_value: true,
    value: {
      novel: input.novel === true,
      stage: input.stage || null,
      error_code: input.error_code || null,
      signature: input.signature || null,
      count: Number(input.count || 0),
      recovery_action: recovery ? String(recovery.action || '') : null,
      recovery_cooldown_hours: recovery ? Number(recovery.cooldown_hours || 0) : null,
      recovery_playbook: recovery ? String(recovery.playbook || '') : null,
      recovery_reason: recovery ? String(recovery.reason || '') : null,
      recovery_should_escalate: recovery ? recovery.should_escalate === true : null
    }
  };
}

function jsNextHumanEscalationClearAt(input) {
  const rows = Array.isArray(input && input.rows) ? input.rows : [];
  const ms = rows
    .map((r) => Date.parse(String((r && r.expires_at) || '')))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!ms.length) return { value: null };
  return { value: new Date(Math.min(...ms)).toISOString() };
}

function jsModelCatalogCanaryThresholds(input) {
  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v)));
  return {
    min_samples: clamp(Math.round(Number(input.min_samples)), 1, 50),
    max_fail_rate: clamp(Number(input.max_fail_rate), 0, 1),
    max_route_block_rate: clamp(Number(input.max_route_block_rate), 0, 1)
  };
}

function runRust(mode, input) {
  const rust = runBacklogAutoscalePrimitive(mode, input, { allow_cli_fallback: true });
  assert(rust && rust.ok === true, `${mode}: rust bridge invocation failed`);
  assert(rust.payload && rust.payload.ok === true, `${mode}: rust payload failed`);
  return rust.payload.payload;
}

function assertDeep(mode, input, expected) {
  const got = runRust(mode, input);
  assert.deepStrictEqual(got, expected, `${mode} mismatch for input=${JSON.stringify(input)}`);
}

function run() {
  const fixedIso = '2026-03-04T18:19:20.123Z';
  assertDeep('now_iso', { now_iso: fixedIso }, jsNowIso({ now_iso: fixedIso }));
  assertDeep('today_str', { now_iso: fixedIso }, jsTodayStr({ now_iso: fixedIso }));

  assertDeep(
    'human_canary_override_approval_phrase',
    { prefix: 'I_APPROVE_ONE_SHOT_CANARY_OVERRIDE', date_str: '2026-03-04', nonce: 'abc12345' },
    jsApprovalPhrase({ prefix: 'I_APPROVE_ONE_SHOT_CANARY_OVERRIDE', date_str: '2026-03-04', nonce: 'abc12345' })
  );

  const nowMs = Date.parse('2026-03-04T12:00:00.000Z');
  const activeRec = {
    id: 'hco_1',
    type: 'daily_cap_once',
    date: '2026-03-04',
    require_execution_mode: 'canary_execute',
    remaining_uses: 1,
    expires_at: '2026-03-04T14:00:00.000Z'
  };
  assertDeep('parse_human_canary_override_state', { record: null, now_ms: nowMs }, jsParseState({ record: null, now_ms: nowMs }));
  assertDeep('parse_human_canary_override_state', { record: { ...activeRec, remaining_uses: 0 }, now_ms: nowMs }, jsParseState({ record: { ...activeRec, remaining_uses: 0 }, now_ms: nowMs }));
  assertDeep('parse_human_canary_override_state', { record: { ...activeRec, expires_at: '2026-03-04T10:00:00.000Z' }, now_ms: nowMs }, jsParseState({ record: { ...activeRec, expires_at: '2026-03-04T10:00:00.000Z' }, now_ms: nowMs }));
  assertDeep('parse_human_canary_override_state', { record: activeRec, now_ms: nowMs }, jsParseState({ record: activeRec, now_ms: nowMs }));

  assertDeep('daily_budget_path', { state_dir: '/tmp/budget', date_str: '2026-03-04' }, jsDailyBudgetPath({ state_dir: '/tmp/budget', date_str: '2026-03-04' }));
  assertDeep('runs_path_for', { runs_dir: '/tmp/runs', date_str: '2026-03-04' }, jsRunsPathFor({ runs_dir: '/tmp/runs', date_str: '2026-03-04' }));

  const tierInput = {
    execution_mode: 'canary_execute',
    tier1_burn_rate_multiplier: 1.2,
    tier1_canary_burn_rate_multiplier: 1.5,
    tier1_min_projected_tokens_for_burn_check: 300,
    tier1_canary_min_projected_tokens_for_burn_check: 500,
    tier1_drift_min_samples: 5,
    tier1_canary_drift_min_samples: 8,
    tier1_alignment_threshold: 0.9,
    tier1_canary_alignment_threshold: 0.82,
    tier1_canary_suppress_alignment_blocker: true
  };
  assertDeep('effective_tier1_policy', tierInput, jsEffectiveTier1Policy(tierInput));

  const compactTracked = {
    tracked: true,
    novel: true,
    stage: 'route_execute',
    error_code: 'E_RATE',
    signature: 'sig_1',
    count: 3,
    recovery: {
      action: 'cooldown',
      cooldown_hours: 6,
      playbook: 'tier1_recovery',
      reason: 'high drift',
      should_escalate: true
    }
  };
  assertDeep('compact_tier1_exception', compactTracked, jsCompactTier1Exception(compactTracked));
  assertDeep('compact_tier1_exception', { tracked: false }, jsCompactTier1Exception({ tracked: false }));

  const rows = [
    { escalation_id: 'e1', expires_at: '2026-03-04T16:00:00.000Z' },
    { escalation_id: 'e2', expires_at: '2026-03-04T13:00:00.000Z' },
    { escalation_id: 'e3', expires_at: 'invalid' }
  ];
  assertDeep('next_human_escalation_clear_at', { rows }, jsNextHumanEscalationClearAt({ rows }));

  const canaryInput = { min_samples: 84, max_fail_rate: 1.3, max_route_block_rate: -0.2 };
  assertDeep('model_catalog_canary_thresholds', canaryInput, jsModelCatalogCanaryThresholds(canaryInput));

  console.log('autonomy_human_tier1_paths_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_human_tier1_paths_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
