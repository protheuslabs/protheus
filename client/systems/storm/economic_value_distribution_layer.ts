#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.ECONOMIC_VALUE_DISTRIBUTION_LAYER_POLICY_PATH
  ? path.resolve(process.env.ECONOMIC_VALUE_DISTRIBUTION_LAYER_POLICY_PATH)
  : path.join(ROOT, 'config', 'economic_value_distribution_layer_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/storm/economic_value_distribution_layer.js distribute --amount=<n> [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/storm/economic_value_distribution_layer.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    treasury_split: {
      sovereign_root: 0.10,
      generator_lane: 0.65,
      reserve_lane: 0.25
    },
    require_policy_bound_payout_routing: true,
    storm_plan_cmd: ['node', 'systems/storm/storm_value_distribution.js', 'plan'],
    paths: {
      latest_path: 'state/storm/economic_value_distribution_layer/latest.json',
      receipts_path: 'state/storm/economic_value_distribution_layer/receipts.jsonl',
      ledger_path: 'state/storm/economic_value_distribution_layer/ledger.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const split = raw.treasury_split && typeof raw.treasury_split === 'object' ? raw.treasury_split : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const stormCmd = Array.isArray(raw.storm_plan_cmd) && raw.storm_plan_cmd.length >= 2 ? raw.storm_plan_cmd : base.storm_plan_cmd;
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    require_policy_bound_payout_routing: toBool(raw.require_policy_bound_payout_routing, true),
    treasury_split: {
      sovereign_root: clampNumber(split.sovereign_root, 0, 1, base.treasury_split.sovereign_root),
      generator_lane: clampNumber(split.generator_lane, 0, 1, base.treasury_split.generator_lane),
      reserve_lane: clampNumber(split.reserve_lane, 0, 1, base.treasury_split.reserve_lane)
    },
    storm_plan_cmd: stormCmd.map((row) => cleanText(row, 220)).filter(Boolean),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      ledger_path: resolvePath(paths.ledger_path, base.paths.ledger_path)
    }
  };
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function distribute(args, policy) {
  const apply = toBool(args.apply, false);
  const amount = clampNumber(args.amount, 0, 1e12, 0);
  const split = policy.treasury_split;
  const rootAmount = Number((amount * split.sovereign_root).toFixed(6));
  const generatorAmount = Number((amount * split.generator_lane).toFixed(6));
  const reserveAmount = Number((amount * split.reserve_lane).toFixed(6));

  const [bin, ...cmdArgs] = policy.storm_plan_cmd;
  const stormProc = spawnSync(bin, cmdArgs, { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  const stormOk = Number(stormProc.status || 0) === 0;

  const ledgerRow = {
    ts: nowIso(),
    amount,
    split: {
      sovereign_root: rootAmount,
      generator_lane: generatorAmount,
      reserve_lane: reserveAmount
    },
    policy_bound_routing: policy.require_policy_bound_payout_routing,
    storm_plan_ok: stormOk
  };
  if (apply) appendJsonl(policy.paths.ledger_path, ledgerRow);

  return writeReceipt(policy, {
    type: 'economic_value_distribution_layer_distribute',
    apply,
    amount,
    split: ledgerRow.split,
    policy_bound_routing: ledgerRow.policy_bound_routing,
    storm_plan_ok: stormOk
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'economic_value_distribution_layer_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    split: policy.treasury_split
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
  if (!policy.enabled) emit({ ok: false, error: 'economic_value_distribution_layer_disabled' }, 1);

  if (cmd === 'distribute') emit(distribute(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
