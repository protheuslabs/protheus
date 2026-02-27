#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.SELF_HOST_BOOTSTRAP_ROOT
  ? path.resolve(process.env.SELF_HOST_BOOTSTRAP_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SELF_HOST_BOOTSTRAP_POLICY_PATH
  ? path.resolve(process.env.SELF_HOST_BOOTSTRAP_POLICY_PATH)
  : path.join(ROOT, 'config', 'self_hosted_bootstrap_policy.json');

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

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/self_hosted_bootstrap_compiler.js compile [--source-root=<path>] [--apply=1|0]');
  console.log('  node systems/ops/self_hosted_bootstrap_compiler.js verify --build-id=<id> [--strict=1|0]');
  console.log('  node systems/ops/self_hosted_bootstrap_compiler.js promote --build-id=<id> --approved-by=<id> --approval-note="<text>" [--apply=1|0]');
  console.log('  node systems/ops/self_hosted_bootstrap_compiler.js rollback [--apply=1|0] [--reason=<text>]');
  console.log('  node systems/ops/self_hosted_bootstrap_compiler.js status');
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown) {
  const token = cleanText(raw || '', 500);
  if (!token) return ROOT;
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function shaHex(value: unknown) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    schema_id: 'self_hosted_bootstrap_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    min_approval_note_chars: 12,
    source_root: '.',
    build_command: [
      'node',
      'systems/ops/build_systems.js'
    ],
    smoke_command: [
      'node',
      'systems/ops/build_smoke.js'
    ],
    verify_commands: [
      ['node', 'systems/security/formal_invariant_engine.js', 'run', '--strict=1'],
      ['node', 'systems/security/supply_chain_trust_plane.js', 'run', '--strict=1', '--verify-only=1']
    ],
    outputs: {
      state_path: 'state/ops/self_hosted_bootstrap/state.json',
      latest_path: 'state/ops/self_hosted_bootstrap/latest.json',
      receipts_path: 'state/ops/self_hosted_bootstrap/receipts.jsonl'
    }
  };
}

function normalizeCommand(src: unknown, fallback: string[]) {
  const arr = Array.isArray(src) ? src : fallback;
  const out = arr.map((row) => cleanText(row, 300)).filter(Boolean);
  return out.length ? out : fallback;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const outputsRaw = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const verifyRaw = Array.isArray(raw.verify_commands) ? raw.verify_commands : base.verify_commands;
  const verifyCommands = verifyRaw
    .map((cmd: unknown) => normalizeCommand(cmd, []))
    .filter((cmd: string[]) => cmd.length > 0);
  return {
    schema_id: 'self_hosted_bootstrap_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    min_approval_note_chars: clampInt(raw.min_approval_note_chars, 4, 400, base.min_approval_note_chars),
    source_root: resolvePath(raw.source_root || base.source_root),
    build_command: normalizeCommand(raw.build_command, base.build_command),
    smoke_command: normalizeCommand(raw.smoke_command, base.smoke_command),
    verify_commands: verifyCommands.length ? verifyCommands : base.verify_commands,
    outputs: {
      state_path: resolvePath(outputsRaw.state_path || base.outputs.state_path),
      latest_path: resolvePath(outputsRaw.latest_path || base.outputs.latest_path),
      receipts_path: resolvePath(outputsRaw.receipts_path || base.outputs.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function initState() {
  return {
    schema_id: 'self_hosted_bootstrap_state',
    schema_version: '1.0',
    created_at: nowIso(),
    updated_at: nowIso(),
    active_build_id: null,
    previous_active_build_id: null,
    builds: {}
  };
}

function loadState(policy: AnyObj) {
  const raw = readJson(policy.outputs.state_path, null);
  if (!raw || typeof raw !== 'object') return initState();
  return {
    schema_id: 'self_hosted_bootstrap_state',
    schema_version: '1.0',
    created_at: cleanText(raw.created_at || nowIso(), 40) || nowIso(),
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    active_build_id: cleanText(raw.active_build_id || '', 120) || null,
    previous_active_build_id: cleanText(raw.previous_active_build_id || '', 120) || null,
    builds: raw.builds && typeof raw.builds === 'object' ? raw.builds : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.outputs.state_path, {
    ...state,
    updated_at: nowIso()
  });
}

function runCommand(cmd: string[], cwd: string) {
  if (!Array.isArray(cmd) || !cmd.length) {
    return { ok: false, status: 1, command: null, stdout: '', stderr: 'empty_command' };
  }
  const started = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8'
  });
  return {
    ok: r.status === 0,
    status: Number(r.status || 0),
    command: cmd.join(' '),
    stdout: cleanText(r.stdout || '', 4000),
    stderr: cleanText(r.stderr || '', 4000),
    duration_ms: Date.now() - started
  };
}

function buildFingerprint(policy: AnyObj) {
  const parts = [
    policy.build_command.join(' '),
    policy.smoke_command.join(' '),
    ...policy.verify_commands.map((cmd: string[]) => cmd.join(' '))
  ];
  return shaHex(parts.join('|')).slice(0, 16);
}

function resolveBuild(state: AnyObj, buildIdRaw: unknown) {
  const buildId = normalizeToken(buildIdRaw || '', 120);
  if (!buildId) return null;
  return state.builds && typeof state.builds === 'object' ? state.builds[buildId] || null : null;
}

function emitReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.outputs.receipts_path, {
    ts: nowIso(),
    ...row
  });
}

function cmdCompile(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_compile', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }

  const apply = toBool(args.apply, true);
  const sourceRoot = args['source-root'] ? resolvePath(args['source-root']) : policy.source_root;
  const state = loadState(policy);

  const buildId = normalizeToken(args['build-id'] || '', 120)
    || `shb_${shaHex(`${nowIso()}|${sourceRoot}|${Math.random()}`).slice(0, 12)}`;
  if (resolveBuild(state, buildId)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_compile', error: 'build_id_exists', build_id: buildId })}\n`);
    process.exit(1);
  }

  const build = runCommand(policy.build_command, sourceRoot);
  const smoke = runCommand(policy.smoke_command, sourceRoot);
  const ok = build.ok === true && smoke.ok === true;

  const buildRecord = {
    build_id: buildId,
    ts: nowIso(),
    source_root: rel(sourceRoot),
    fingerprint: buildFingerprint(policy),
    compile_ok: build.ok === true,
    smoke_ok: smoke.ok === true,
    ok,
    verification_ok: false,
    promoted: false,
    commands: {
      build,
      smoke
    },
    verify_results: [],
    promotion: null
  };

  if (apply && policy.shadow_only !== true) {
    state.builds[buildId] = buildRecord;
    saveState(policy, state);
  }

  const out = {
    ok,
    type: 'self_hosted_bootstrap_compile',
    build_id: buildId,
    source_root: rel(sourceRoot),
    compile_ok: build.ok === true,
    smoke_ok: smoke.ok === true,
    apply,
    shadow_only: policy.shadow_only === true,
    policy_path: rel(policy.policy_path)
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdVerify(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, false);
  const state = loadState(policy);
  const buildId = normalizeToken(args['build-id'] || args.build_id || '', 120);
  if (!buildId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_verify', error: 'build_id_required' })}\n`);
    process.exit(1);
  }
  const build = resolveBuild(state, buildId);
  if (!build) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_verify', error: 'build_not_found', build_id: buildId })}\n`);
    process.exit(1);
  }

  const results = policy.verify_commands.map((cmd: string[]) => runCommand(cmd, policy.source_root));
  const ok = results.every((row: AnyObj) => row.ok === true);

  if (policy.shadow_only !== true) {
    build.verify_results = results;
    build.verification_ok = ok;
    build.verified_at = nowIso();
    saveState(policy, state);
  }

  const out = {
    ok,
    type: 'self_hosted_bootstrap_verify',
    strict,
    build_id: buildId,
    verification_ok: ok,
    verify_count: results.length,
    policy_path: rel(policy.policy_path)
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (strict && !ok) process.exit(1);
}

function cmdPromote(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const apply = toBool(args.apply, true);
  const buildId = normalizeToken(args['build-id'] || args.build_id || '', 120);
  const approvedBy = normalizeToken(args['approved-by'] || args.approved_by || '', 120);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 500);
  if (!buildId || !approvedBy || approvalNote.length < policy.min_approval_note_chars) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_promote', error: 'build_id_approval_required', min_approval_note_chars: policy.min_approval_note_chars })}\n`);
    process.exit(1);
  }

  const state = loadState(policy);
  const build = resolveBuild(state, buildId);
  if (!build) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_promote', error: 'build_not_found', build_id: buildId })}\n`);
    process.exit(1);
  }
  if (build.compile_ok !== true || build.smoke_ok !== true || build.verification_ok !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_promote', error: 'build_not_verified', build_id: buildId, compile_ok: build.compile_ok === true, smoke_ok: build.smoke_ok === true, verification_ok: build.verification_ok === true })}\n`);
    process.exit(1);
  }

  if (apply && policy.shadow_only !== true) {
    state.previous_active_build_id = state.active_build_id || null;
    state.active_build_id = buildId;
    build.promoted = true;
    build.promotion = {
      promoted_at: nowIso(),
      approved_by: approvedBy,
      approval_note: approvalNote,
      previous_active_build_id: state.previous_active_build_id || null
    };
    saveState(policy, state);
  }

  const out = {
    ok: true,
    type: 'self_hosted_bootstrap_promote',
    build_id: buildId,
    approved_by: approvedBy,
    previous_active_build_id: state.previous_active_build_id || null,
    apply,
    shadow_only: policy.shadow_only === true,
    policy_path: rel(policy.policy_path)
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdRollback(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const apply = toBool(args.apply, true);
  const reason = cleanText(args.reason || 'manual_rollback', 260) || 'manual_rollback';
  const state = loadState(policy);
  const target = cleanText(state.previous_active_build_id || '', 120) || null;
  if (!target) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'self_hosted_bootstrap_rollback', error: 'no_previous_active_build' })}\n`);
    process.exit(1);
  }

  if (apply && policy.shadow_only !== true) {
    const current = state.active_build_id || null;
    state.active_build_id = target;
    state.previous_active_build_id = current;
    const build = resolveBuild(state, target);
    if (build) {
      build.rollback = {
        rolled_back_at: nowIso(),
        reason,
        from_build_id: current
      };
    }
    saveState(policy, state);
  }

  const out = {
    ok: true,
    type: 'self_hosted_bootstrap_rollback',
    target_build_id: target,
    reason,
    apply,
    shadow_only: policy.shadow_only === true,
    policy_path: rel(policy.policy_path)
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const latest = readJson(policy.outputs.latest_path, null);
  const receipts = readJsonl(policy.outputs.receipts_path).slice(-50);
  const out = {
    ok: true,
    type: 'self_hosted_bootstrap_status',
    ts: nowIso(),
    policy: {
      path: rel(policy.policy_path),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      source_root: rel(policy.source_root),
      verify_command_count: policy.verify_commands.length
    },
    state: {
      active_build_id: state.active_build_id,
      previous_active_build_id: state.previous_active_build_id,
      build_count: Object.keys(state.builds || {}).length
    },
    latest,
    receipt_count_50: receipts.length,
    paths: {
      state_path: rel(policy.outputs.state_path),
      receipts_path: rel(policy.outputs.receipts_path)
    }
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 80);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'compile') return cmdCompile(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'promote') return cmdPromote(args);
  if (cmd === 'rollback') return cmdRollback(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  cmdCompile,
  cmdVerify,
  cmdPromote,
  cmdRollback,
  cmdStatus
};
