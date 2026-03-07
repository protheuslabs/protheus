#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-234
 * AWS CI/CD mirror plane (CodePipeline/Build/Deploy + FIS parity).
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  toBool,
  parseArgs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.AWS_CI_CD_MIRROR_POLICY_PATH
  ? path.resolve(process.env.AWS_CI_CD_MIRROR_POLICY_PATH)
  : path.join(ROOT, 'config', 'aws_ci_cd_mirror_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/aws_ci_cd_mirror_plane.js run [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/aws_ci_cd_mirror_plane.js disable --reason=<text> [--policy=<path>]');
  console.log('  node systems/ops/aws_ci_cd_mirror_plane.js reseed --approve=1 [--policy=<path>]');
  console.log('  node systems/ops/aws_ci_cd_mirror_plane.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    auto_disable_on_divergence: true,
    required_branches: ['main'],
    required_gates: ['build', 'test', 'formal', 'chaos', 'fis'],
    sources: {
      github_state_path: 'state/ops/aws_ci_cd_mirror/github_latest.json',
      aws_state_path: 'state/ops/aws_ci_cd_mirror/aws_latest.json'
    },
    paths: {
      state_path: 'state/ops/aws_ci_cd_mirror_plane/state.json',
      latest_path: 'state/ops/aws_ci_cd_mirror_plane/latest.json',
      history_path: 'state/ops/aws_ci_cd_mirror_plane/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const sources = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    auto_disable_on_divergence: raw.auto_disable_on_divergence !== false,
    required_branches: Array.isArray(raw.required_branches) && raw.required_branches.length
      ? raw.required_branches.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_branches,
    required_gates: Array.isArray(raw.required_gates) && raw.required_gates.length
      ? raw.required_gates.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_gates,
    sources: {
      github_state_path: resolvePath(sources.github_state_path, base.sources.github_state_path),
      aws_state_path: resolvePath(sources.aws_state_path, base.sources.aws_state_path)
    },
    paths: {
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(statePath: string) {
  const row = readJson(statePath, {});
  return {
    mirror_enabled: row.mirror_enabled !== false,
    disabled_reason: cleanText(row.disabled_reason, 200) || null,
    last_divergence_hash: cleanText(row.last_divergence_hash, 100) || null,
    last_updated_at: cleanText(row.last_updated_at, 80) || null
  };
}

function saveState(statePath: string, state: AnyObj) {
  writeJsonAtomic(statePath, {
    mirror_enabled: state.mirror_enabled !== false,
    disabled_reason: cleanText(state.disabled_reason, 200) || null,
    last_divergence_hash: cleanText(state.last_divergence_hash, 100) || null,
    last_updated_at: nowIso()
  });
}

function normalizeBranchPolicy(doc: AnyObj, branch: string) {
  const policies = doc && doc.branch_policies && typeof doc.branch_policies === 'object' ? doc.branch_policies : {};
  const row = policies[branch] && typeof policies[branch] === 'object' ? policies[branch] : {};
  return {
    branch,
    protected: row.protected !== false,
    required_checks: Array.isArray(row.required_checks)
      ? row.required_checks.map((v: unknown) => cleanText(v, 120)).filter(Boolean).sort()
      : []
  };
}

function normalizeGate(doc: AnyObj, gate: string) {
  const gates = doc && doc.gates && typeof doc.gates === 'object' ? doc.gates : {};
  const row = gates[gate] && typeof gates[gate] === 'object' ? gates[gate] : {};
  return {
    gate,
    status: cleanText(row.status || 'unknown', 40).toLowerCase(),
    receipt_id: cleanText(row.receipt_id || '', 120) || null
  };
}

function compare(policy: AnyObj, githubDoc: AnyObj, awsDoc: AnyObj) {
  const divergences: AnyObj[] = [];

  for (const branch of policy.required_branches) {
    const gh = normalizeBranchPolicy(githubDoc, branch);
    const aws = normalizeBranchPolicy(awsDoc, branch);

    if (gh.protected !== aws.protected) {
      divergences.push({ kind: 'branch_protection_mismatch', branch, github: gh.protected, aws: aws.protected });
    }
    if (JSON.stringify(gh.required_checks) !== JSON.stringify(aws.required_checks)) {
      divergences.push({ kind: 'required_checks_mismatch', branch, github: gh.required_checks, aws: aws.required_checks });
    }
  }

  for (const gate of policy.required_gates) {
    const gh = normalizeGate(githubDoc, gate);
    const aws = normalizeGate(awsDoc, gate);
    if (!(gh.status === 'pass' && aws.status === 'pass')) {
      divergences.push({ kind: 'gate_parity_fail', gate, github: gh.status, aws: aws.status });
    }
  }

  return divergences;
}

function runMirror(policy: AnyObj) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'aws_ci_cd_mirror_plane',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const state = loadState(policy.paths.state_path);
  const githubDoc = readJson(policy.sources.github_state_path, {});
  const awsDoc = readJson(policy.sources.aws_state_path, {});
  const divergences = compare(policy, githubDoc, awsDoc);
  const divergenceHash = divergences.length ? stableHash(JSON.stringify(divergences), 20) : null;

  if (divergences.length && policy.auto_disable_on_divergence) {
    state.mirror_enabled = false;
    state.disabled_reason = 'divergence_detected';
    state.last_divergence_hash = divergenceHash;
    saveState(policy.paths.state_path, state);
  }

  const out = {
    ok: divergences.length === 0,
    type: 'aws_ci_cd_mirror_plane',
    lane_id: 'V3-RACE-234',
    ts: nowIso(),
    mirror_enabled: state.mirror_enabled,
    disabled_reason: state.disabled_reason,
    divergence_count: divergences.length,
    divergences,
    divergence_hash: divergenceHash,
    gate_parity_receipt_id: `aws_mirror_${stableHash(JSON.stringify({ divergences, state }), 14)}`,
    rollback_procedure: {
      disable: 'node systems/ops/aws_ci_cd_mirror_plane.js disable --reason=<text>',
      reseed: 'node systems/ops/aws_ci_cd_mirror_plane.js reseed --approve=1'
    }
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    mirror_enabled: out.mirror_enabled,
    divergence_count: out.divergence_count,
    divergence_hash: out.divergence_hash
  });
  return out;
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const out = runMirror(policy);

  emit({
    ...out,
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path)
  }, out.ok || !strict ? 0 : 1);
}

function cmdDisable(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const reason = cleanText(args.reason || 'manual_disable', 200) || 'manual_disable';
  const state = loadState(policy.paths.state_path);
  state.mirror_enabled = false;
  state.disabled_reason = reason;
  saveState(policy.paths.state_path, state);
  emit({
    ok: true,
    type: 'aws_ci_cd_mirror_plane_disable',
    ts: nowIso(),
    mirror_enabled: false,
    disabled_reason: reason,
    state_path: rel(policy.paths.state_path)
  }, 0);
}

function cmdReseed(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const approved = toBool(args.approve, false);
  if (!approved) {
    emit({ ok: false, type: 'aws_ci_cd_mirror_plane_reseed', error: 'approval_required' }, 2);
  }

  saveState(policy.paths.state_path, {
    mirror_enabled: true,
    disabled_reason: null,
    last_divergence_hash: null
  });

  const out = runMirror(policy);
  emit({
    ...out,
    action: 'reseed',
    approved: true,
    policy_path: rel(policy.policy_path)
  }, out.ok ? 0 : 1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  emit({
    ok: true,
    type: 'aws_ci_cd_mirror_plane_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    state: loadState(policy.paths.state_path),
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path)
  }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 80).toLowerCase();
  if (args.help || ['help', '--help', '-h'].includes(cmd)) {
    usage();
    process.exit(0);
  }

  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'disable') return cmdDisable(args);
  if (cmd === 'reseed') return cmdReseed(args);
  if (cmd === 'status') return cmdStatus(args);

  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
