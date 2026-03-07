#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  rollingAverage,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.CROSS_INSTANCE_FEDERATED_LEARNING_POLICY_PATH
  ? path.resolve(process.env.CROSS_INSTANCE_FEDERATED_LEARNING_POLICY_PATH)
  : path.join(ROOT, 'config', 'cross_instance_federated_learning_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/cross_instance_federated_learning.js ingest --node-id=<id> --lift=<num> [--privacy=standard|high] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/cross_instance_federated_learning.js aggregate [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/cross_instance_federated_learning.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    min_participants: 2,
    max_recent_contributions: 200,
    paths: {
      latest_path: 'state/ops/cross_instance_federated_learning/latest.json',
      receipts_path: 'state/ops/cross_instance_federated_learning/receipts.jsonl',
      state_path: 'state/ops/cross_instance_federated_learning/state.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    min_participants: clampInt(raw.min_participants, 2, 128, base.min_participants),
    max_recent_contributions: clampInt(raw.max_recent_contributions, 10, 10000, base.max_recent_contributions),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path)
    }
  };
}

function loadState(policy) {
  const raw = readJson(policy.paths.state_path, {});
  return {
    schema_id: 'cross_instance_federated_learning_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    contributions: Array.isArray(raw.contributions) ? raw.contributions : [],
    aggregates: raw.aggregates && typeof raw.aggregates === 'object' ? raw.aggregates : {}
  };
}

function saveState(policy, state) {
  const next = { ...state, updated_at: nowIso() };
  writeJsonAtomic(policy.paths.state_path, next);
  return next;
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function ingest(args, policy) {
  const apply = toBool(args.apply, false);
  const nodeId = normalizeToken(args['node-id'] || args.node_id || '', 120);
  if (!nodeId) return { ok: false, type: 'cross_instance_federated_learning_ingest', error: 'node_id_required' };
  const lift = clampNumber(args.lift, -1, 2, 0);
  const privacy = cleanText(args.privacy || 'standard', 20);
  const state = loadState(policy);
  const row = {
    ts: nowIso(),
    node_id: nodeId,
    lift,
    privacy,
    sample_count: clampInt(args.samples, 1, 1000000, 200)
  };
  const contributions = [row, ...state.contributions].slice(0, policy.max_recent_contributions);
  if (apply) saveState(policy, { ...state, contributions });
  return writeReceipt(policy, {
    type: 'cross_instance_federated_learning_ingest',
    apply,
    node_id: nodeId,
    lift,
    privacy,
    contribution_count: contributions.length
  });
}

function aggregate(args, policy) {
  const apply = toBool(args.apply, false);
  const state = loadState(policy);
  const rows = Array.isArray(state.contributions) ? state.contributions : [];
  const participants = Array.from(new Set(rows.map((row) => String(row.node_id || '')).filter(Boolean)));
  const avgLift = rollingAverage(rows.map((row) => Number(row.lift || 0)));
  const aggregate = {
    ts: nowIso(),
    participant_count: participants.length,
    min_participants_required: policy.min_participants,
    privacy_controls: ['no_raw_data_pooling', 'summary_only', 'retention_bound'],
    lift_avg: avgLift == null ? 0 : Number(avgLift),
    aggregation_ok: participants.length >= policy.min_participants
  };
  if (apply) saveState(policy, { ...state, aggregates: aggregate });
  return writeReceipt(policy, {
    type: 'cross_instance_federated_learning_aggregate',
    apply,
    ...aggregate
  });
}

function status(policy) {
  const state = loadState(policy);
  const latestAggregate = state.aggregates && typeof state.aggregates === 'object' ? state.aggregates : {};
  return {
    ok: true,
    type: 'cross_instance_federated_learning_status',
    shadow_only: policy.shadow_only,
    contribution_count: Array.isArray(state.contributions) ? state.contributions.length : 0,
    participant_count: Number(latestAggregate.participant_count || 0),
    lift_avg: Number(latestAggregate.lift_avg || 0),
    latest: readJson(policy.paths.latest_path, {})
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'cross_instance_federated_learning_disabled' }, 1);

  if (cmd === 'ingest') emit(ingest(args, policy));
  if (cmd === 'aggregate') emit(aggregate(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
