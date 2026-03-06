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
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.CONTINUOUS_PARITY_MAINTAINER_POLICY_PATH
  ? path.resolve(process.env.CONTINUOUS_PARITY_MAINTAINER_POLICY_PATH)
  : path.join(ROOT, 'config', 'continuous_parity_maintainer_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/continuous_parity_maintainer.js run [--strict=1|0] [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/continuous_parity_maintainer.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: true,
    remediation_threshold: 0.95,
    remediation_limit: 4,
    parity_cmd: ['node', 'systems/ops/narrow_agent_parity_harness.js', 'run', '--strict=1'],
    paths: {
      latest_path: 'state/ops/continuous_parity_maintainer/latest.json',
      receipts_path: 'state/ops/continuous_parity_maintainer/receipts.jsonl',
      remediation_queue_path: 'state/ops/continuous_parity_maintainer/remediation_queue.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const parityCmd = Array.isArray(raw.parity_cmd) && raw.parity_cmd.length >= 2 ? raw.parity_cmd : base.parity_cmd;
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    strict_default: toBool(raw.strict_default, true),
    remediation_threshold: Number.isFinite(Number(raw.remediation_threshold)) ? Number(raw.remediation_threshold) : base.remediation_threshold,
    remediation_limit: clampInt(raw.remediation_limit, 1, 64, base.remediation_limit),
    parity_cmd: parityCmd.map((row) => cleanText(row, 220)).filter(Boolean),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      remediation_queue_path: resolvePath(paths.remediation_queue_path, base.paths.remediation_queue_path)
    }
  };
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, policy) {
  const apply = toBool(args.apply, false);
  const strict = toBool(args.strict, policy.strict_default);
  const [bin, ...cmdArgs] = policy.parity_cmd;
  const proc = spawnSync(bin, cmdArgs, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const payload = parseJsonLoose(proc.stdout);
  const status = Number(proc.status == null ? -1 : proc.status);

  const score = Number(payload && payload.scorecard && payload.scorecard.composite_score);
  const scoreOrZero = Number.isFinite(score) ? score : 0;
  const needsRemediation = status !== 0 || scoreOrZero < policy.remediation_threshold;
  const queue = readJson(policy.paths.remediation_queue_path, { generated_at: nowIso(), items: [] });
  const items = Array.isArray(queue.items) ? queue.items : [];

  const newItem = needsRemediation ? {
    id: `rem_${Date.now()}`,
    ts: nowIso(),
    reason: status !== 0 ? 'parity_harness_failed' : 'score_below_threshold',
    score: scoreOrZero,
    threshold: policy.remediation_threshold,
    command: policy.parity_cmd.join(' ')
  } : null;

  const nextItems = newItem ? [newItem, ...items].slice(0, policy.remediation_limit) : items.slice(0, policy.remediation_limit);
  if (apply) {
    writeJsonAtomic(policy.paths.remediation_queue_path, {
      generated_at: nowIso(),
      items: nextItems
    });
  }

  const checks = {
    parity_cmd_ok: status === 0,
    score_above_threshold: scoreOrZero >= policy.remediation_threshold,
    remediation_queue_updated: !needsRemediation || (nextItems.length >= 1)
  };

  const ok = strict ? Object.values(checks).every(Boolean) : true;

  return writeReceipt(policy, {
    type: 'continuous_parity_maintainer_run',
    apply,
    strict,
    ok,
    checks,
    parity_status: status,
    score: Number(scoreOrZero.toFixed(6)),
    remediation_count: nextItems.length,
    remediation_added: Boolean(newItem)
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'continuous_parity_maintainer_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    remediation_queue: readJson(policy.paths.remediation_queue_path, { items: [] })
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
  if (!policy.enabled) emit({ ok: false, error: 'continuous_parity_maintainer_disabled' }, 1);

  if (cmd === 'run') emit(run(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
