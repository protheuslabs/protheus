#!/usr/bin/env node
'use strict';
export {};

const {
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  loadPolicy,
  emit
} = require('./_shared');
const { synthesizeProfile } = require('./profile_synthesizer');
const { selectCountermeasure } = require('./countermeasure_selector');
const { persistProfile, loadState } = require('./temporal_profile_store');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/psycheforge/psycheforge_organ.js evaluate --actor=<id> [--telemetry_json={}] [--apply=0|1] [--two_gate_approved=0|1]');
  console.log('  node systems/security/psycheforge/psycheforge_organ.js promote --decision_id=<id> [--two_gate_approved=0|1] [--apply=0|1]');
  console.log('  node systems/security/psycheforge/psycheforge_organ.js status');
}

function parseJson(raw: unknown) {
  const txt = String(raw || '').trim();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { return {}; }
}

function loadShadowQueue(policy: Record<string, any>) {
  const src = readJson(policy.paths.shadow_queue_path, {});
  const rows = Array.isArray(src.decisions) ? src.decisions : [];
  return {
    schema_id: 'psycheforge_shadow_queue',
    schema_version: '1.0',
    updated_at: src.updated_at || nowIso(),
    decisions: rows
  };
}

function saveShadowQueue(policy: Record<string, any>, queue: Record<string, any>) {
  writeJsonAtomic(policy.paths.shadow_queue_path, {
    schema_id: 'psycheforge_shadow_queue',
    schema_version: '1.0',
    updated_at: nowIso(),
    decisions: Array.isArray(queue.decisions) ? queue.decisions.slice(-500) : []
  });
}

function writeIntegrationHints(policy: Record<string, any>, payload: Record<string, any>) {
  const row = {
    ts: nowIso(),
    type: 'psycheforge_integration_hint',
    actor_id: payload.actor_id,
    profile_id: payload.profile_id,
    decision_id: payload.decision_id,
    risk_tier: payload.risk_tier,
    stage: payload.stage,
    behavior_class: payload.behavior_class,
    selected_countermeasures: payload.selected_countermeasures
  };
  writeJsonAtomic(policy.paths.guard_hint_path, { ...row, target: 'guard' });
  writeJsonAtomic(policy.paths.redteam_hint_path, { ...row, target: 'redteam' });
  writeJsonAtomic(policy.paths.venom_hint_path, { ...row, target: 'venom' });
  writeJsonAtomic(policy.paths.fractal_hint_path, { ...row, target: 'fractal' });
}

function appendReceipt(policy: Record<string, any>, row: Record<string, any>) {
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
}

function cmdEvaluate(args: Record<string, any>, policy: Record<string, any>) {
  const actorId = cleanText(args.actor || args.instance || 'unknown_actor', 120) || 'unknown_actor';
  const apply = toBool(args.apply, false);
  const twoGateApproved = toBool(args.two_gate_approved, false);
  const telemetry = parseJson(args.telemetry_json || args.telemetry || '{}');

  const state = loadState(policy);
  const previousRows = Array.isArray(state.profiles[actorId]) ? state.profiles[actorId] : [];
  const previousMeta = previousRows.length > 0 ? previousRows[previousRows.length - 1] : null;
  const previous = previousMeta && previousMeta.behavior_class
    ? { behavior_class: previousMeta.behavior_class }
    : null;

  const profile = synthesizeProfile(actorId, telemetry, previous);
  const decision = selectCountermeasure(profile, policy, {
    apply,
    two_gate_approved: twoGateApproved
  });

  const baseReceipt = {
    ts: nowIso(),
    type: 'psycheforge_evaluate',
    ok: true,
    shadow_only: policy.shadow_only === true,
    apply,
    actor_id: actorId,
    profile_id: profile.profile_id,
    behavior_class: profile.behavior_class,
    behavior_confidence: profile.behavior_confidence,
    decision_id: decision.decision_id,
    risk_tier: decision.risk_tier,
    requires_two_gate: decision.requires_two_gate,
    two_gate_approved: decision.two_gate_approved,
    stage: decision.stage,
    selected_countermeasures: decision.selected_countermeasures,
    integration_targets: decision.integration_targets
  };

  let persistence = null;
  if (apply) {
    persistence = persistProfile(policy, profile);
    writeIntegrationHints(policy, {
      ...baseReceipt,
      selected_countermeasures: decision.selected_countermeasures
    });
  }

  const shadowQueue = loadShadowQueue(policy);
  if (decision.stage === 'shadow' && apply) {
    shadowQueue.decisions.push({
      decision_id: decision.decision_id,
      actor_id: actorId,
      profile_id: profile.profile_id,
      behavior_class: profile.behavior_class,
      risk_tier: decision.risk_tier,
      selected_countermeasures: decision.selected_countermeasures,
      created_at: nowIso()
    });
    saveShadowQueue(policy, shadowQueue);
  }

  const out = {
    ...baseReceipt,
    persistence,
    shadow_queue_size: Array.isArray(shadowQueue.decisions) ? shadowQueue.decisions.length : 0
  };
  appendReceipt(policy, out);
  emit(out, 0);
}

function cmdPromote(args: Record<string, any>, policy: Record<string, any>) {
  const decisionId = cleanText(args.decision_id || args['decision-id'] || '', 120);
  if (!decisionId) emit({ ok: false, error: 'decision_id_required' }, 2);

  const apply = toBool(args.apply, false);
  const twoGateApproved = toBool(args.two_gate_approved, false);
  if (!twoGateApproved) {
    emit({
      ok: false,
      error: 'two_gate_approval_required',
      decision_id: decisionId
    }, 2);
  }

  const queue = loadShadowQueue(policy);
  const rows = Array.isArray(queue.decisions) ? queue.decisions : [];
  const idx = rows.findIndex((row) => String(row.decision_id || '') === decisionId);
  if (idx < 0) emit({ ok: false, error: 'shadow_decision_not_found', decision_id: decisionId }, 2);
  const decision = rows[idx];

  const promotion = {
    ts: nowIso(),
    type: 'psycheforge_shadow_to_live_promotion',
    ok: true,
    apply,
    decision_id: decisionId,
    actor_id: decision.actor_id,
    profile_id: decision.profile_id,
    from_stage: 'shadow',
    to_stage: 'live',
    risk_tier: decision.risk_tier,
    selected_countermeasures: decision.selected_countermeasures,
    two_gate_approved: true
  };

  if (apply) {
    rows.splice(idx, 1);
    saveShadowQueue(policy, { decisions: rows });
    appendJsonl(policy.paths.promotion_path, promotion);
    writeIntegrationHints(policy, {
      ...promotion,
      stage: 'live',
      behavior_class: decision.behavior_class
    });
  }

  appendReceipt(policy, promotion);
  emit({
    ...promotion,
    shadow_queue_size: rows.length
  }, 0);
}

function cmdStatus(policy: Record<string, any>) {
  const profiles = loadState(policy);
  const queue = loadShadowQueue(policy);
  const actorCount = Object.keys(profiles.profiles || {}).length;
  const historyCount = Object.values(profiles.profiles || {}).reduce((acc, row) => acc + (Array.isArray(row) ? row.length : 0), 0);
  emit({
    ok: true,
    type: 'psycheforge_status',
    actor_count: actorCount,
    profile_history_rows: historyCount,
    shadow_queue_size: Array.isArray(queue.decisions) ? queue.decisions.length : 0,
    latest_path: policy.paths.latest_path
  }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').trim().toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) emit({ ok: false, error: 'policy_disabled' }, 2);
  if (cmd === 'evaluate') return cmdEvaluate(args, policy);
  if (cmd === 'promote') return cmdPromote(args, policy);
  if (cmd === 'status') return cmdStatus(policy);
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

module.exports = {
  cmdEvaluate,
  cmdPromote
};

if (require.main === module) {
  main();
}
