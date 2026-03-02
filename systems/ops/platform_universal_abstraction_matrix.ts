#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PLATFORM_UNIVERSAL_ABSTRACTION_MATRIX_POLICY_PATH
  ? path.resolve(process.env.PLATFORM_UNIVERSAL_ABSTRACTION_MATRIX_POLICY_PATH)
  : path.join(ROOT, 'config', 'platform_universal_abstraction_matrix_policy.json');

const REQUIRED_CONTROLS = [
  'atomic_transactional_rollout',
  'capability_security_defaults',
  'lts_posture_hooks',
  'offline_cryptographic_verification',
  'declarative_config_contracts',
  'lightweight_profile_tiers',
  'observability_sla_hooks',
  'hardened_default_baseline',
  'rootless_container_minimization',
  'signed_delta_updates',
  'power_thermal_scheduling',
  'reproducible_distribution',
  'orchestration_abstractions',
  'rollback_recovery_contracts',
  'policy_attestation_logging',
  'host_profile_compatibility',
  'promotion_gate_enforcement',
  'governed_override_toggle'
];

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
    schema_id: 'platform_universal_abstraction_matrix_policy',
    schema_version: '1.0',
    enabled: true,
    matrix_path: 'config/platform_universal_abstraction_matrix.json',
    state_path: 'state/ops/platform_universal_abstraction_matrix/latest.json',
    history_path: 'state/ops/platform_universal_abstraction_matrix/history.jsonl',
    signing_secret: 'platform_universal_abstraction_matrix_secret'
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
    schema_id: 'platform_universal_abstraction_matrix_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    matrix_path: resolvePath(raw.matrix_path || base.matrix_path, base.matrix_path),
    state_path: resolvePath(raw.state_path || base.state_path, base.state_path),
    history_path: resolvePath(raw.history_path || base.history_path, base.history_path),
    signing_secret: cleanText(raw.signing_secret || base.signing_secret, 200) || base.signing_secret
  };
}

function stableHash(payload: AnyObj, secret: string): string {
  const h = crypto.createHmac('sha256', String(secret || ''));
  h.update(JSON.stringify(payload));
  return h.digest('hex');
}

function runMatrix(policyPath: string): AnyObj {
  const policy = loadPolicy(policyPath);
  if (policy.enabled === false) {
    return {
      ok: true,
      skipped: true,
      reason: 'disabled',
      type: 'platform_universal_abstraction_matrix',
      ts: nowIso(),
      policy_path: rel(policyPath)
    };
  }

  const matrix = readJson(policy.matrix_path, {});
  const controls = matrix.controls && typeof matrix.controls === 'object' ? matrix.controls : {};
  const missing = REQUIRED_CONTROLS.filter((id) => !controls[id]);
  const invalid: AnyObj[] = [];

  for (const id of REQUIRED_CONTROLS) {
    const row = controls[id];
    if (!row || typeof row !== 'object') continue;
    const mode = cleanText(row.enforcement_mode || '', 40).toLowerCase();
    const owner = cleanText(row.owner || '', 120);
    const rollback = cleanText(row.rollback_toggle || '', 120);
    if (!['core', 'delegated'].includes(mode)) invalid.push({ control: id, reason: 'invalid_enforcement_mode' });
    if (!owner) invalid.push({ control: id, reason: 'owner_missing' });
    if (!rollback) invalid.push({ control: id, reason: 'rollback_toggle_missing' });
  }

  const revision = cleanText(matrix.revision || '', 80) || 'unknown';
  const fallbackRevision = cleanText(matrix.fallback_revision || '', 80) || null;
  const hasFallback = !!fallbackRevision;

  const core = {
    type: 'platform_universal_abstraction_matrix',
    ts: nowIso(),
    policy_path: rel(policyPath),
    matrix_path: rel(policy.matrix_path),
    revision,
    fallback_revision: fallbackRevision,
    has_fallback_revision: hasFallback,
    required_control_count: REQUIRED_CONTROLS.length,
    present_control_count: REQUIRED_CONTROLS.length - missing.length,
    missing_controls: missing,
    invalid_controls: invalid,
    rollback_safe_policy_toggle: hasFallback
  };

  const receipt = {
    schema_id: 'platform_universal_abstraction_matrix_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: missing.length === 0 && invalid.length === 0 && hasFallback,
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
    type: 'platform_universal_abstraction_matrix',
    reason: 'status_not_found',
    state_path: rel(policy.state_path)
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/platform_universal_abstraction_matrix.js run [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/platform_universal_abstraction_matrix.js status [--policy=<path>]');
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

  if (cmd === 'run') {
    const out = runMatrix(policyPath);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) main();
