#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PLATFORM_SOCKET_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.PLATFORM_SOCKET_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'platform_socket_runtime_policy.json');

function nowIso(): string {
  return new Date().toISOString();
}

function rel(filePath: string): string {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function cleanText(v: unknown, maxLen = 240): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = String(tok).indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false): boolean {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}): AnyObj {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy(): AnyObj {
  return {
    schema_id: 'platform_socket_runtime_policy',
    schema_version: '1.0',
    enabled: true,
    oracle_state_path: 'state/ops/platform_oracle_hostprofile/latest.json',
    socket_registry_path: 'config/platform_socket_registry.json',
    admission_policy_path: 'config/platform_socket_admission_policy.json',
    state_path: 'state/ops/platform_socket_runtime/latest.json',
    history_path: 'state/ops/platform_socket_runtime/history.jsonl',
    install_state_path: 'state/ops/platform_socket_runtime/installed.json',
    signing_secret: 'platform_socket_runtime_secret'
  };
}

function resolvePath(raw: unknown, fallbackRel: string): string {
  const txt = cleanText(raw, 320);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function loadPolicy(policyPath: string): AnyObj {
  const base = defaultPolicy();
  const raw = readJson(policyPath, base);
  return {
    schema_id: 'platform_socket_runtime_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    oracle_state_path: resolvePath(raw.oracle_state_path || base.oracle_state_path, base.oracle_state_path),
    socket_registry_path: resolvePath(raw.socket_registry_path || base.socket_registry_path, base.socket_registry_path),
    admission_policy_path: resolvePath(raw.admission_policy_path || base.admission_policy_path, base.admission_policy_path),
    state_path: resolvePath(raw.state_path || base.state_path, base.state_path),
    history_path: resolvePath(raw.history_path || base.history_path, base.history_path),
    install_state_path: resolvePath(raw.install_state_path || base.install_state_path, base.install_state_path),
    signing_secret: cleanText(raw.signing_secret || base.signing_secret, 200) || base.signing_secret
  };
}

function stableHash(payload: AnyObj, secret: string): string {
  const h = crypto.createHmac('sha256', String(secret || ''));
  h.update(JSON.stringify(payload));
  return h.digest('hex');
}

function loadProfile(policy: AnyObj): AnyObj {
  const oracle = readJson(policy.oracle_state_path, {});
  return oracle.host_profile && typeof oracle.host_profile === 'object' ? oracle.host_profile : {};
}

function normalizePredicate(predicate: AnyObj): AnyObj {
  return {
    os_family: cleanText(predicate.os_family || '', 120).toLowerCase(),
    distro: cleanText(predicate.distro || '', 120).toLowerCase(),
    variant: cleanText(predicate.variant || '', 120).toLowerCase(),
    arch: cleanText(predicate.arch || '', 120).toLowerCase()
  };
}

function matchesPredicate(predicateRaw: AnyObj, profile: AnyObj): boolean {
  const predicate = normalizePredicate(predicateRaw || {});
  const keys = ['os_family', 'distro', 'variant', 'arch'];
  for (const key of keys) {
    const expected = cleanText(predicate[key], 120).toLowerCase();
    if (!expected || expected === 'any' || expected === '*') continue;
    const actual = cleanText(profile[key], 120).toLowerCase();
    if (actual !== expected) return false;
  }
  return true;
}

function validateSocket(row: AnyObj): AnyObj {
  const id = cleanText(row.id || '', 120).toLowerCase();
  const kind = cleanText(row.kind || '', 40).toLowerCase();
  const moduleType = cleanText(row.module_type || '', 40).toLowerCase();
  const version = cleanText(row.version || '', 24);
  const modulePath = cleanText(row.module || '', 260);
  const predicate = row.predicate && typeof row.predicate === 'object' ? row.predicate : {};
  const attestation = row.attestation && typeof row.attestation === 'object' ? row.attestation : {};
  const capabilityClaims = Array.isArray(row.capability_claims)
    ? row.capability_claims.map((x: unknown) => cleanText(x, 120)).filter(Boolean)
    : [];
  const proofStub = cleanText(row.proof_stub || '', 320);

  const problems: string[] = [];
  if (!id) problems.push('id_missing');
  if (!['generic', 'specific'].includes(kind)) problems.push('invalid_kind');
  if (!['wasm', 'native'].includes(moduleType)) problems.push('invalid_module_type');
  if (!version) problems.push('version_missing');
  if (!modulePath) problems.push('module_missing');
  if (kind === 'specific' && Object.keys(predicate).length === 0) problems.push('predicate_missing');
  if (!cleanText(attestation.signed_by || '', 120)) problems.push('attestation_signed_by_missing');
  if (!cleanText(attestation.signature || '', 200)) problems.push('attestation_signature_missing');

  return {
    id,
    kind,
    module_type: moduleType,
    version,
    module: modulePath,
    predicate,
    capability_claims: capabilityClaims,
    hot_swap_safe: row.hot_swap_safe === true,
    priority: Number(row.priority || 0),
    proof_stub: proofStub || null,
    attestation: {
      signed_by: cleanText(attestation.signed_by || '', 120) || null,
      signature: cleanText(attestation.signature || '', 200) || null
    },
    valid: problems.length === 0,
    problems
  };
}

function loadSockets(policy: AnyObj): AnyObj[] {
  const registry = readJson(policy.socket_registry_path, {});
  const rows = Array.isArray(registry.sockets) ? registry.sockets : [];
  return rows.map((row: AnyObj) => validateSocket(row));
}

function pickSocket(validSockets: AnyObj[], profile: AnyObj): AnyObj {
  const specific = validSockets
    .filter((s) => s.kind === 'specific' && matchesPredicate(s.predicate, profile))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  if (specific.length > 0) {
    return { selected: specific[0], fallback_to_generic: false, reason: 'specific_socket_match' };
  }
  const generic = validSockets.find((s) => s.kind === 'generic');
  if (generic) return { selected: generic, fallback_to_generic: true, reason: 'fallback_generic_socket' };
  return { selected: null, fallback_to_generic: false, reason: 'no_socket_fail_closed' };
}

function activate(policyPath: string, dryRun: boolean): AnyObj {
  const policy = loadPolicy(policyPath);
  const profile = loadProfile(policy);
  const sockets = loadSockets(policy);
  const valid = sockets.filter((s) => s.valid === true);
  const invalid = sockets.filter((s) => s.valid !== true);
  const selected = pickSocket(valid, profile);

  const core = {
    type: 'platform_socket_runtime',
    ts: nowIso(),
    action: 'activate',
    dry_run: dryRun,
    policy_path: rel(policyPath),
    socket_registry_path: rel(policy.socket_registry_path),
    oracle_state_path: rel(policy.oracle_state_path),
    host_profile: profile,
    valid_socket_count: valid.length,
    invalid_socket_count: invalid.length,
    invalid_sockets: invalid.map((s) => ({ id: s.id || null, problems: s.problems || [] })),
    selected_socket: selected.selected
      ? {
        id: selected.selected.id,
        kind: selected.selected.kind,
        module_type: selected.selected.module_type,
        version: selected.selected.version,
        module: selected.selected.module,
        capability_claims: selected.selected.capability_claims,
        hot_swap_safe: selected.selected.hot_swap_safe,
        predicate: selected.selected.predicate
      }
      : null,
    fallback_to_generic: selected.fallback_to_generic,
    fail_closed: !selected.selected,
    reason: selected.reason,
    rollback_safe_disable_switch: true
  };

  const receipt = {
    schema_id: 'platform_socket_runtime_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: !core.fail_closed,
    ...core,
    signature: stableHash(core, policy.signing_secret)
  };

  if (!dryRun) {
    writeJsonAtomic(policy.state_path, receipt);
    appendJsonl(policy.history_path, receipt);
  }
  return receipt;
}

function lifecycle(policyPath: string, command: string, socketId: string): AnyObj {
  const policy = loadPolicy(policyPath);
  const sockets = loadSockets(policy);
  const installed = readJson(policy.install_state_path, { installed: {} });
  const installedMap = installed && installed.installed && typeof installed.installed === 'object' ? installed.installed : {};

  const id = cleanText(socketId, 120).toLowerCase();
  const socketRow = sockets.find((s) => s.id === id);

  if (command === 'list') {
    return {
      ok: true,
      type: 'platform_socket_runtime',
      action: 'lifecycle_list',
      ts: nowIso(),
      sockets,
      installed: installedMap,
      socket_registry_path: rel(policy.socket_registry_path),
      install_state_path: rel(policy.install_state_path)
    };
  }

  if (!id) {
    return {
      ok: false,
      type: 'platform_socket_runtime',
      action: `lifecycle_${command}`,
      ts: nowIso(),
      error: 'socket_id_required'
    };
  }
  if (!socketRow) {
    return {
      ok: false,
      type: 'platform_socket_runtime',
      action: `lifecycle_${command}`,
      ts: nowIso(),
      error: 'socket_not_found',
      socket_id: id
    };
  }

  const nextInstalled = { ...installedMap };
  if (command === 'install') {
    nextInstalled[id] = {
      installed_at: nowIso(),
      version: socketRow.version,
      source: 'registry',
      status: 'installed'
    };
  } else if (command === 'update') {
    const prev = nextInstalled[id] || {};
    nextInstalled[id] = {
      ...prev,
      updated_at: nowIso(),
      version: socketRow.version,
      status: 'updated'
    };
  } else if (command === 'test') {
    const prev = nextInstalled[id] || {};
    nextInstalled[id] = {
      ...prev,
      tested_at: nowIso(),
      status: 'tested'
    };
  }

  const lifecycleOut = {
    ok: true,
    type: 'platform_socket_runtime',
    action: `lifecycle_${command}`,
    ts: nowIso(),
    socket_id: id,
    socket: socketRow,
    installed_before: installedMap[id] || null,
    installed_after: nextInstalled[id] || null,
    audit_log_path: rel(policy.history_path)
  };

  writeJsonAtomic(policy.install_state_path, {
    schema_id: 'platform_socket_install_state',
    schema_version: '1.0',
    ts: nowIso(),
    installed: nextInstalled
  });
  appendJsonl(policy.history_path, lifecycleOut);
  return lifecycleOut;
}

function admission(policyPath: string): AnyObj {
  const policy = loadPolicy(policyPath);
  const sockets = loadSockets(policy);
  const admissionPolicy = readJson(policy.admission_policy_path, {});
  const requiredChaos = admissionPolicy.required_chaos_checks === true;

  const failures: AnyObj[] = [];
  const rows: AnyObj[] = [];

  for (const socket of sockets) {
    const proofStub = cleanText(socket.proof_stub || '', 320);
    const proofPath = proofStub
      ? (path.isAbsolute(proofStub) ? proofStub : path.join(ROOT, proofStub))
      : '';
    const proofExists = proofPath ? fs.existsSync(proofPath) : false;

    const rowFailures: string[] = [];
    if (!socket.valid) rowFailures.push('manifest_invalid');
    if (!proofExists) rowFailures.push('proof_stub_missing');
    if (!cleanText(socket.attestation && socket.attestation.signature || '', 200)) rowFailures.push('signature_missing');
    if (requiredChaos && socket.hot_swap_safe !== true && socket.kind === 'specific') rowFailures.push('chaos_eligibility_missing');

    if (rowFailures.length > 0) {
      failures.push({ socket_id: socket.id || null, reasons: rowFailures });
    }
    rows.push({
      socket_id: socket.id || null,
      kind: socket.kind || null,
      manifest_valid: socket.valid === true,
      proof_stub: proofStub || null,
      proof_exists: proofExists,
      chaos_eligible: socket.hot_swap_safe === true || socket.kind === 'generic',
      failures: rowFailures
    });
  }

  const core = {
    type: 'platform_socket_runtime',
    action: 'admission',
    ts: nowIso(),
    policy_path: rel(policyPath),
    socket_registry_path: rel(policy.socket_registry_path),
    admission_policy_path: rel(policy.admission_policy_path),
    row_count: rows.length,
    rows,
    failures,
    required_chaos_checks: requiredChaos
  };

  const receipt = {
    schema_id: 'platform_socket_admission_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: failures.length === 0,
    ...core,
    signature: stableHash(core, policy.signing_secret)
  };

  writeJsonAtomic(policy.state_path, receipt);
  appendJsonl(policy.history_path, receipt);
  return receipt;
}

function cmdStatus(policyPath: string): void {
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.state_path, {
    ok: false,
    type: 'platform_socket_runtime',
    reason: 'status_not_found',
    state_path: rel(policy.state_path)
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/platform_socket_runtime.js activate [--dry-run=1] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/platform_socket_runtime.js discover [--policy=<path>]');
  console.log('  node systems/ops/platform_socket_runtime.js status [--policy=<path>]');
  console.log('  node systems/ops/platform_socket_runtime.js lifecycle <list|install|update|test> [--socket-id=<id>] [--policy=<path>]');
  console.log('  node systems/ops/platform_socket_runtime.js admission [--strict=1|0] [--policy=<path>]');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase();
  if (args.help || cmd === 'help') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy
    ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
    : DEFAULT_POLICY_PATH;

  if (cmd === 'status') {
    cmdStatus(policyPath);
    return;
  }

  if (cmd === 'discover') {
    const policy = loadPolicy(policyPath);
    const sockets = loadSockets(policy);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'platform_socket_runtime',
      action: 'discover',
      ts: nowIso(),
      socket_registry_path: rel(policy.socket_registry_path),
      sockets
    }, null, 2)}\n`);
    return;
  }

  if (cmd === 'activate' || cmd === 'abi') {
    const out = activate(policyPath, toBool(args['dry-run'], false));
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }

  if (cmd === 'lifecycle') {
    const sub = cleanText(args._[1] || 'list', 20).toLowerCase();
    const socketId = cleanText(args['socket-id'] || args._[2] || '', 120);
    const out = lifecycle(policyPath, sub, socketId);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }

  if (cmd === 'admission') {
    const out = admission(policyPath);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) main();
