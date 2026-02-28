#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  loadSymbiosisCoherenceSignal,
  evaluateRecursionRequest
} = require('../../lib/symbiosis_coherence_signal');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SELF_CODE_EVOLUTION_POLICY_PATH
  ? path.resolve(process.env.SELF_CODE_EVOLUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'self_code_evolution_sandbox_policy.json');
const STATE_PATH = process.env.SELF_CODE_EVOLUTION_STATE_PATH
  ? path.resolve(process.env.SELF_CODE_EVOLUTION_STATE_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'self_code_evolution_sandbox', 'state.json');
const RECEIPTS_PATH = process.env.SELF_CODE_EVOLUTION_RECEIPTS_PATH
  ? path.resolve(process.env.SELF_CODE_EVOLUTION_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'self_code_evolution_sandbox', 'receipts.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
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

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function hash10(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
}

function parseRecursionRequest(args: AnyObj) {
  const depthRaw = args['recursion-depth'] != null
    ? args['recursion-depth']
    : (args.recursion_depth != null ? args.recursion_depth : null);
  const unboundedRaw = args['recursion-unbounded'] != null
    ? args['recursion-unbounded']
    : (args.recursion_unbounded != null ? args.recursion_unbounded : null);
  const depthToken = normalizeToken(depthRaw, 40);
  const unboundedByDepth = ['unbounded', 'infinite', 'max', 'none'].includes(depthToken);
  const depthNumber = Number(depthRaw);
  return {
    requested_depth: unboundedByDepth
      ? 'unbounded'
      : (Number.isFinite(depthNumber) ? clampInt(depthNumber, 1, 1_000_000_000, 1) : 1),
    requested_unbounded: unboundedByDepth || toBool(unboundedRaw, false)
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_active_sandboxes: 24,
    required_approvals: 2,
    require_tests_before_merge: true,
    sandbox_branch_prefix: 'codex/evo/',
    symbiosis_recursion_gate: {
      enabled: true,
      shadow_only: true,
      signal_policy_path: 'config/symbiosis_coherence_policy.json'
    },
    test_commands: [
      `node -e "process.exit(0)"`
    ]
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    max_active_sandboxes: clampInt(raw.max_active_sandboxes, 1, 256, base.max_active_sandboxes),
    required_approvals: clampInt(raw.required_approvals, 1, 8, base.required_approvals),
    require_tests_before_merge: raw.require_tests_before_merge !== false,
    sandbox_branch_prefix: cleanText(raw.sandbox_branch_prefix || base.sandbox_branch_prefix, 120) || base.sandbox_branch_prefix,
    symbiosis_recursion_gate: {
      enabled: !(raw.symbiosis_recursion_gate && raw.symbiosis_recursion_gate.enabled === false),
      shadow_only: raw.symbiosis_recursion_gate && raw.symbiosis_recursion_gate.shadow_only != null
        ? toBool(raw.symbiosis_recursion_gate.shadow_only, true)
        : base.symbiosis_recursion_gate.shadow_only === true,
      signal_policy_path: cleanText(
        raw.symbiosis_recursion_gate && raw.symbiosis_recursion_gate.signal_policy_path
          || base.symbiosis_recursion_gate.signal_policy_path,
        260
      ) || base.symbiosis_recursion_gate.signal_policy_path
    },
    test_commands: Array.from(
      new Set((Array.isArray(raw.test_commands) ? raw.test_commands : base.test_commands)
        .map((cmd: unknown) => cleanText(cmd, 500))
        .filter(Boolean))
    )
  };
}

function defaultState() {
  return {
    schema_id: 'self_code_evolution_sandbox_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    sandboxes: {}
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'self_code_evolution_sandbox_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    sandboxes: src.sandboxes && typeof src.sandboxes === 'object' ? src.sandboxes : {}
  };
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'self_code_evolution_sandbox_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    sandboxes: state && state.sandboxes && typeof state.sandboxes === 'object' ? state.sandboxes : {}
  });
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/self_code_evolution_sandbox.js propose --target-path=<file> [--summary=...] [--risk=low|medium|high]');
  console.log('  node systems/autonomy/self_code_evolution_sandbox.js test --sandbox-id=<id>');
  console.log('  node systems/autonomy/self_code_evolution_sandbox.js merge --sandbox-id=<id> --approval-a=<id> --approval-b=<id> [--apply=1]');
  console.log('  node systems/autonomy/self_code_evolution_sandbox.js rollback --sandbox-id=<id> [--reason=...]');
  console.log('  node systems/autonomy/self_code_evolution_sandbox.js status [--sandbox-id=<id>]');
}

function cmdPropose(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_code_evolution_propose', error: 'sandbox_disabled' })}\n`);
    process.exit(1);
  }
  const activeCount = Object.values(state.sandboxes || {}).filter((row: any) => row && row.status !== 'rolled_back').length;
  if (activeCount >= policy.max_active_sandboxes) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_code_evolution_propose', error: 'max_active_sandboxes_reached' })}\n`);
    process.exit(1);
  }
  const targetPath = cleanText(args.target_path || args['target-path'] || '', 260);
  if (!targetPath) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_code_evolution_propose', error: 'target_path_required' })}\n`);
    process.exit(1);
  }
  const recursionRequest = parseRecursionRequest(args);
  let symbiosisGate: AnyObj = {
    evaluated: false
  };
  if (policy.symbiosis_recursion_gate && policy.symbiosis_recursion_gate.enabled === true) {
    const signal = loadSymbiosisCoherenceSignal({
      policy_path: policy.symbiosis_recursion_gate.signal_policy_path,
      refresh: true,
      persist: true
    });
    const gate = evaluateRecursionRequest({
      signal,
      requested_depth: recursionRequest.requested_depth,
      require_unbounded: recursionRequest.requested_unbounded,
      shadow_only_override: policy.symbiosis_recursion_gate.shadow_only === true
    });
    symbiosisGate = {
      evaluated: true,
      request: recursionRequest,
      ...gate
    };
    if (gate.blocked_hard === true) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        type: 'self_code_evolution_propose',
        error: 'symbiosis_recursion_gate_blocked',
        target_path: targetPath,
        symbiosis_recursion_gate: symbiosisGate
      })}\n`);
      process.exit(1);
    }
  }
  const ts = nowIso();
  const sandboxId = normalizeToken(args.sandbox_id || args['sandbox-id'] || `sb_${hash10(`${targetPath}|${ts}`)}`, 120);
  const branchName = `${policy.sandbox_branch_prefix}${sandboxId}`;
  const record = {
    sandbox_id: sandboxId,
    created_at: ts,
    status: 'proposed',
    branch_name: branchName,
    target_path: targetPath,
    mutation_summary: cleanText(args.summary || 'self_code_mutation_candidate', 280),
    risk: normalizeToken(args.risk || 'medium', 40) || 'medium',
    recursion_depth_requested: recursionRequest.requested_depth,
    recursion_unbounded_requested: recursionRequest.requested_unbounded === true,
    symbiosis_recursion_gate: symbiosisGate,
    approvals: [],
    test_results: []
  };
  state.sandboxes[sandboxId] = record;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, {
    ts,
    type: 'self_code_evolution_propose',
    ok: true,
    sandbox_id: sandboxId,
    branch_name: branchName,
    target_path: targetPath,
    symbiosis_recursion_gate: symbiosisGate
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'self_code_evolution_propose', record, symbiosis_recursion_gate: symbiosisGate })}\n`);
}

function cmdTest(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const sandboxId = normalizeToken(args.sandbox_id || args['sandbox-id'] || '', 120);
  const row = sandboxId ? state.sandboxes[sandboxId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_code_evolution_test', error: 'sandbox_not_found' })}\n`);
    process.exit(1);
  }
  const results = [];
  let allOk = true;
  for (const command of policy.test_commands) {
    const proc = spawnSync(command, {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
      timeout: 120000
    });
    const ok = Number(proc.status) === 0;
    if (!ok) allOk = false;
    results.push({
      command,
      ok,
      status: Number(proc.status),
      stderr: cleanText(proc.stderr, 600),
      stdout: cleanText(proc.stdout, 600)
    });
  }
  row.status = allOk ? 'tested' : 'test_failed';
  row.test_results = results;
  row.last_tested_at = nowIso();
  state.sandboxes[sandboxId] = row;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts: nowIso(), type: 'self_code_evolution_test', ok: allOk, sandbox_id: sandboxId, tests: results.length });
  process.stdout.write(`${JSON.stringify({ ok: allOk, type: 'self_code_evolution_test', sandbox_id: sandboxId, results })}\n`);
  if (!allOk) process.exit(1);
}

function cmdMerge(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const sandboxId = normalizeToken(args.sandbox_id || args['sandbox-id'] || '', 120);
  const row = sandboxId ? state.sandboxes[sandboxId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_code_evolution_merge', error: 'sandbox_not_found' })}\n`);
    process.exit(1);
  }
  const approvals = [
    normalizeToken(args.approval_a || args['approval-a'] || '', 120),
    normalizeToken(args.approval_b || args['approval-b'] || '', 120),
    normalizeToken(args.approval_c || args['approval-c'] || '', 120)
  ].filter(Boolean);
  const uniqueApprovals = Array.from(new Set(approvals));
  const apply = ['1', 'true', 'yes', 'on'].includes(String(args.apply || '').toLowerCase());
  const blocked: string[] = [];
  if (policy.shadow_only === true) blocked.push('shadow_only_mode');
  if (apply !== true) blocked.push('apply_disabled');
  if (uniqueApprovals.length < policy.required_approvals) blocked.push('dual_approval_required');
  if (policy.require_tests_before_merge === true && row.status !== 'tested') blocked.push('tests_not_passed');
  if (row.status === 'rolled_back') blocked.push('sandbox_rolled_back');
  let symbiosisGate: AnyObj = {
    evaluated: false
  };
  if (policy.symbiosis_recursion_gate && policy.symbiosis_recursion_gate.enabled === true) {
    const signal = loadSymbiosisCoherenceSignal({
      policy_path: policy.symbiosis_recursion_gate.signal_policy_path,
      refresh: true,
      persist: true
    });
    const gate = evaluateRecursionRequest({
      signal,
      requested_depth: row.recursion_depth_requested != null ? row.recursion_depth_requested : 1,
      require_unbounded: row.recursion_unbounded_requested === true,
      shadow_only_override: policy.symbiosis_recursion_gate.shadow_only === true
    });
    symbiosisGate = {
      evaluated: true,
      request: {
        requested_depth: row.recursion_depth_requested != null ? row.recursion_depth_requested : 1,
        requested_unbounded: row.recursion_unbounded_requested === true
      },
      ...gate
    };
    if (gate.blocked_hard === true) blocked.push('symbiosis_recursion_gate_blocked');
  }

  const out = {
    ok: blocked.length === 0,
    type: 'self_code_evolution_merge',
    ts: nowIso(),
    sandbox_id: sandboxId,
    approvals: uniqueApprovals,
    blocked,
    symbiosis_recursion_gate: symbiosisGate
  };
  if (!blocked.length) {
    row.status = 'merged';
    row.approvals = uniqueApprovals;
    row.merged_at = nowIso();
    state.sandboxes[sandboxId] = row;
    saveState(state);
  }
  appendJsonl(RECEIPTS_PATH, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (blocked.length) process.exit(1);
}

function cmdRollback(args: AnyObj) {
  const state = loadState();
  const sandboxId = normalizeToken(args.sandbox_id || args['sandbox-id'] || '', 120);
  const row = sandboxId ? state.sandboxes[sandboxId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_code_evolution_rollback', error: 'sandbox_not_found' })}\n`);
    process.exit(1);
  }
  const reason = cleanText(args.reason || 'manual_rollback', 220) || 'manual_rollback';
  row.status = 'rolled_back';
  row.rollback = {
    ts: nowIso(),
    reason,
    rollback_receipt_id: `rb_${hash10(`${sandboxId}|${reason}|${Date.now()}`)}`
  };
  state.sandboxes[sandboxId] = row;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, {
    ts: nowIso(),
    type: 'self_code_evolution_rollback',
    ok: true,
    sandbox_id: sandboxId,
    reason,
    rollback_receipt_id: row.rollback.rollback_receipt_id
  });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'self_code_evolution_rollback', record: row })}\n`);
}

function cmdStatus(args: AnyObj) {
  const state = loadState();
  const sandboxId = normalizeToken(args.sandbox_id || args['sandbox-id'] || '', 120);
  if (sandboxId) {
    process.stdout.write(`${JSON.stringify({ ok: true, type: 'self_code_evolution_status', sandbox_id: sandboxId, record: state.sandboxes[sandboxId] || null })}\n`);
    return;
  }
  const rows = Object.values(state.sandboxes || {});
  const counts = {
    total: rows.length,
    proposed: rows.filter((row: any) => row && row.status === 'proposed').length,
    tested: rows.filter((row: any) => row && row.status === 'tested').length,
    merged: rows.filter((row: any) => row && row.status === 'merged').length,
    rolled_back: rows.filter((row: any) => row && row.status === 'rolled_back').length
  };
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'self_code_evolution_status', counts })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'propose') return cmdPropose(args);
  if (cmd === 'test') return cmdTest(args);
  if (cmd === 'merge') return cmdMerge(args);
  if (cmd === 'rollback') return cmdRollback(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
