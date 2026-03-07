#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-011 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, normalizeToken, toBool, clampNumber,
  readJson, writeJsonAtomic, appendJsonl, resolvePath, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.HABIT_ADAPTER_FINETUNE_POLICY_PATH
  ? path.resolve(process.env.HABIT_ADAPTER_FINETUNE_POLICY_PATH)
  : path.join(ROOT, 'config', 'habit_adapter_finetune_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/habit_adapter_finetune_lane.js train --habit=<id> --objective=<id> --uplift=<n>');
  console.log('  node systems/assimilation/habit_adapter_finetune_lane.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    paths: {
      latest_path: 'state/assimilation/habit_adapter_finetune/latest.json',
      receipts_path: 'state/assimilation/habit_adapter_finetune/receipts.jsonl',
      adapters_path: 'state/assimilation/habit_adapter_finetune/adapters.json'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      adapters_path: resolvePath(paths.adapters_path, base.paths.adapters_path)
    }
  };
}

function train(args: any, p: any) {
  const habit = normalizeToken(args.habit || 'default_habit', 120) || 'default_habit';
  const objective = normalizeToken(args.objective || 'global', 80) || 'global';
  const uplift = clampNumber(args.uplift || 0.05, -1, 1, 0.05);
  const adapters = readJson(p.paths.adapters_path, { schema_version: '1.0', rows: {} });
  adapters.rows = adapters.rows && typeof adapters.rows === 'object' ? adapters.rows : {};
  const key = `${habit}:${objective}`;
  const row = {
    habit,
    objective,
    updated_at: nowIso(),
    uplift,
    status: uplift >= 0 ? 'promote_candidate' : 'rollback_candidate'
  };
  adapters.rows[key] = row;
  writeJsonAtomic(p.paths.adapters_path, adapters);
  const out = { ts: nowIso(), type: 'habit_adapter_finetune_train', ok: true, shadow_only: p.shadow_only, key, ...row };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'habit_adapter_finetune_disabled' }, 1);
  if (cmd === 'train') emit(train(args, p));
  if (cmd === 'status') emit({ ok: true, type: 'habit_adapter_finetune_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
