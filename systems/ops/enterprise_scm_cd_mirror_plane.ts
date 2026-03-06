#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-219
 * Enterprise SCM/CD mirror plane (Azure DevOps <-> GitHub) with parity + rollback controls.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.SCM_CD_MIRROR_ROOT
  ? path.resolve(process.env.SCM_CD_MIRROR_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SCM_CD_MIRROR_POLICY_PATH
  ? path.resolve(process.env.SCM_CD_MIRROR_POLICY_PATH)
  : path.join(ROOT, 'config', 'enterprise_scm_cd_mirror_plane_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tokRaw of argv) {
    const tok = String(tokRaw || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[tok.slice(2)] = true;
    else out[tok.slice(2, idx)] = tok.slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableHash(v: unknown, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    auto_disable_on_divergence: true,
    required_branches: ['main'],
    required_gates: ['build', 'test', 'formal', 'chaos'],
    sources: {
      github_state_path: 'state/ops/scm_mirror/github_latest.json',
      azure_state_path: 'state/ops/scm_mirror/azure_latest.json'
    },
    paths: {
      state_path: 'state/ops/enterprise_scm_cd_mirror_plane/state.json',
      latest_path: 'state/ops/enterprise_scm_cd_mirror_plane/latest.json',
      history_path: 'state/ops/enterprise_scm_cd_mirror_plane/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, base);
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
      azure_state_path: resolvePath(sources.azure_state_path, base.sources.azure_state_path)
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
  const state = readJson(statePath, {});
  return {
    mirror_enabled: state.mirror_enabled !== false,
    disabled_reason: cleanText(state.disabled_reason, 240) || null,
    last_divergence_hash: cleanText(state.last_divergence_hash, 80) || null,
    last_updated_at: cleanText(state.last_updated_at, 80) || null
  };
}

function saveState(statePath: string, state: AnyObj) {
  writeJsonAtomic(statePath, {
    mirror_enabled: state.mirror_enabled !== false,
    disabled_reason: cleanText(state.disabled_reason, 240) || null,
    last_divergence_hash: cleanText(state.last_divergence_hash, 80) || null,
    last_updated_at: nowIso()
  });
}

function normalizeBranchPolicy(doc: AnyObj, branch: string) {
  const branches = doc && doc.branch_policies && typeof doc.branch_policies === 'object' ? doc.branch_policies : {};
  const row = branches[branch] && typeof branches[branch] === 'object' ? branches[branch] : {};
  const requiredChecks = Array.isArray(row.required_checks)
    ? row.required_checks.map((v: unknown) => cleanText(v, 120)).filter(Boolean).sort()
    : [];
  return {
    branch,
    required_checks: requiredChecks,
    protected: row.protected !== false
  };
}

function normalizeGateResult(doc: AnyObj, gate: string) {
  const gates = doc && doc.gates && typeof doc.gates === 'object' ? doc.gates : {};
  const row = gates[gate] && typeof gates[gate] === 'object' ? gates[gate] : {};
  return {
    gate,
    status: cleanText(row.status || 'unknown', 40).toLowerCase(),
    receipt_id: cleanText(row.receipt_id || '', 120) || null
  };
}

function compareParity(policy: AnyObj, githubDoc: AnyObj, azureDoc: AnyObj) {
  const divergences: AnyObj[] = [];

  for (const branch of policy.required_branches) {
    const gh = normalizeBranchPolicy(githubDoc, branch);
    const az = normalizeBranchPolicy(azureDoc, branch);
    if (gh.protected !== az.protected) {
      divergences.push({ kind: 'branch_protection_mismatch', branch, github: gh.protected, azure: az.protected });
    }
    if (JSON.stringify(gh.required_checks) !== JSON.stringify(az.required_checks)) {
      divergences.push({ kind: 'required_checks_mismatch', branch, github: gh.required_checks, azure: az.required_checks });
    }
  }

  for (const gate of policy.required_gates) {
    const gh = normalizeGateResult(githubDoc, gate);
    const az = normalizeGateResult(azureDoc, gate);
    const ok = gh.status === 'pass' && az.status === 'pass';
    if (!ok) {
      divergences.push({ kind: 'gate_parity_fail', gate, github: gh.status, azure: az.status });
    }
  }

  return divergences;
}

function runMirror(policy: AnyObj) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      ts: nowIso(),
      type: 'enterprise_scm_cd_mirror_plane',
      result: 'disabled_by_policy'
    };
  }

  const state = loadState(policy.paths.state_path);
  const githubDoc = readJson(policy.sources.github_state_path, {});
  const azureDoc = readJson(policy.sources.azure_state_path, {});
  const divergences = compareParity(policy, githubDoc, azureDoc);
  const divergenceHash = divergences.length ? stableHash(JSON.stringify(divergences), 20) : null;

  if (divergences.length && policy.auto_disable_on_divergence) {
    state.mirror_enabled = false;
    state.disabled_reason = 'divergence_detected';
    state.last_divergence_hash = divergenceHash;
    saveState(policy.paths.state_path, state);
  }

  const out = {
    ok: divergences.length === 0,
    ts: nowIso(),
    type: 'enterprise_scm_cd_mirror_plane',
    lane_id: 'V3-RACE-219',
    mirror_enabled: state.mirror_enabled,
    disabled_reason: state.disabled_reason,
    divergence_count: divergences.length,
    divergences,
    divergence_hash: divergenceHash,
    rollback_procedure: {
      disable: 'node systems/ops/enterprise_scm_cd_mirror_plane.js disable --reason=<text>',
      reseed: 'node systems/ops/enterprise_scm_cd_mirror_plane.js reseed --approve=1'
    },
    gate_parity_receipt_id: `scm_mirror_${stableHash(JSON.stringify({ divergences, state }), 14)}`
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

function cmdDisable(args: AnyObj, policy: AnyObj) {
  const state = loadState(policy.paths.state_path);
  state.mirror_enabled = false;
  state.disabled_reason = cleanText(args.reason, 240) || 'operator_disable';
  saveState(policy.paths.state_path, state);
  return {
    ok: true,
    ts: nowIso(),
    type: 'enterprise_scm_cd_mirror_plane_disable',
    mirror_enabled: false,
    disabled_reason: state.disabled_reason
  };
}

function cmdReseed(args: AnyObj, policy: AnyObj) {
  if (!toBool(args.approve, false)) {
    return {
      ok: false,
      ts: nowIso(),
      type: 'enterprise_scm_cd_mirror_plane_reseed',
      error: 'approval_required'
    };
  }
  const state = loadState(policy.paths.state_path);
  state.mirror_enabled = true;
  state.disabled_reason = null;
  state.last_divergence_hash = null;
  saveState(policy.paths.state_path, state);
  return {
    ok: true,
    ts: nowIso(),
    type: 'enterprise_scm_cd_mirror_plane_reseed',
    mirror_enabled: true,
    reseeded: true
  };
}

function cmdStatus(policy: AnyObj) {
  return {
    ok: true,
    ts: nowIso(),
    type: 'enterprise_scm_cd_mirror_plane_status',
    latest: readJson(policy.paths.latest_path, null),
    state: loadState(policy.paths.state_path),
    latest_path: rel(policy.paths.latest_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/enterprise_scm_cd_mirror_plane.js run [--strict=1] [--policy=<path>]');
  console.log('  node systems/ops/enterprise_scm_cd_mirror_plane.js disable --reason=<text> [--policy=<path>]');
  console.log('  node systems/ops/enterprise_scm_cd_mirror_plane.js reseed --approve=1 [--policy=<path>]');
  console.log('  node systems/ops/enterprise_scm_cd_mirror_plane.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 80).toLowerCase();
  if (args.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const out = cmd === 'run'
    ? runMirror(policy)
    : cmd === 'disable'
      ? cmdDisable(args, policy)
      : cmd === 'reseed'
        ? cmdReseed(args, policy)
        : cmd === 'status'
          ? cmdStatus(policy)
          : null;

  if (!out) {
    usage();
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify({ ...out, policy_path: rel(policy.policy_path) }, null, 2)}\n`);
  if (cmd === 'run' && toBool(args.strict, false) && out.ok !== true) process.exit(1);
  if ((cmd === 'disable' || cmd === 'reseed') && out.ok !== true) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  compareParity,
  runMirror,
  cmdDisable,
  cmdReseed,
  cmdStatus
};
