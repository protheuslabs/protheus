#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PLATFORM_ADAPTATION_CHANNEL_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.PLATFORM_ADAPTATION_CHANNEL_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'platform_adaptation_channel_runtime_policy.json');

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
    schema_id: 'platform_adaptation_channel_runtime_policy',
    schema_version: '1.0',
    enabled: true,
    oracle_state_path: 'state/ops/platform_oracle_hostprofile/latest.json',
    channels_registry_path: 'config/platform_adaptation_channels.json',
    state_path: 'state/ops/platform_adaptation_channel_runtime/latest.json',
    history_path: 'state/ops/platform_adaptation_channel_runtime/history.jsonl',
    signing_secret: 'platform_adaptation_channel_runtime_secret'
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
    schema_id: 'platform_adaptation_channel_runtime_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    oracle_state_path: resolvePath(raw.oracle_state_path || base.oracle_state_path, base.oracle_state_path),
    channels_registry_path: resolvePath(raw.channels_registry_path || base.channels_registry_path, base.channels_registry_path),
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

function matchesPredicate(predicate: AnyObj, profile: AnyObj): boolean {
  if (!predicate || typeof predicate !== 'object') return false;
  const keys = ['os_family', 'distro', 'variant', 'arch'];
  for (const key of keys) {
    const expected = cleanText(predicate[key], 120).toLowerCase();
    if (!expected || expected === '*' || expected === 'any') continue;
    const actual = cleanText(profile[key], 120).toLowerCase();
    if (actual !== expected) return false;
  }
  return true;
}

function validateChannel(row: AnyObj): AnyObj {
  const id = cleanText(row.id, 120).toLowerCase();
  const kind = cleanText(row.kind || '', 40).toLowerCase();
  const version = cleanText(row.version || '', 24);
  const modulePath = cleanText(row.module || '', 260);
  const predicate = row.predicate && typeof row.predicate === 'object' ? row.predicate : {};
  const attestation = row.attestation && typeof row.attestation === 'object' ? row.attestation : {};
  const signedBy = cleanText(attestation.signed_by || '', 120);
  const signature = cleanText(attestation.signature || '', 200);
  const problems: string[] = [];

  if (!id) problems.push('id_missing');
  if (!['generic', 'specific'].includes(kind)) problems.push('invalid_kind');
  if (!version) problems.push('version_missing');
  if (!modulePath) problems.push('module_missing');
  if (kind === 'specific' && Object.keys(predicate).length === 0) problems.push('predicate_missing');
  if (!signedBy) problems.push('attestation_signed_by_missing');
  if (!signature || signature.length < 12) problems.push('attestation_signature_missing');

  return {
    id,
    kind,
    version,
    module: modulePath,
    predicate,
    priority: Number(row.priority || 0),
    hooks: Array.isArray(row.hooks) ? row.hooks.map((x: unknown) => cleanText(x, 120)).filter(Boolean) : [],
    attestation: {
      signed_by: signedBy,
      signature
    },
    valid: problems.length === 0,
    problems
  };
}

function pickChannel(validChannels: AnyObj[], profile: AnyObj): AnyObj {
  const specific = validChannels
    .filter((c) => c.kind === 'specific' && matchesPredicate(c.predicate, profile))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  if (specific.length > 0) {
    return {
      selected: specific[0],
      fallback_to_generic: false,
      reason: 'specific_host_match'
    };
  }
  const generic = validChannels.find((c) => c.kind === 'generic');
  if (generic) {
    return {
      selected: generic,
      fallback_to_generic: true,
      reason: 'no_specific_match_fallback_generic'
    };
  }
  return {
    selected: null,
    fallback_to_generic: false,
    reason: 'no_channel_available_fail_closed'
  };
}

function loadProfile(policy: AnyObj): AnyObj {
  const profileReceipt = readJson(policy.oracle_state_path, {});
  const profile = profileReceipt && profileReceipt.host_profile && typeof profileReceipt.host_profile === 'object'
    ? profileReceipt.host_profile
    : {};
  return profile;
}

function activate(policyPath: string, dryRun: boolean): AnyObj {
  const policy = loadPolicy(policyPath);
  if (policy.enabled === false) {
    return {
      ok: true,
      skipped: true,
      reason: 'disabled',
      type: 'platform_adaptation_channel_runtime',
      ts: nowIso(),
      policy_path: rel(policyPath)
    };
  }

  const registry = readJson(policy.channels_registry_path, {});
  const rawChannels = Array.isArray(registry.channels) ? registry.channels : [];
  const channels = rawChannels.map((row: AnyObj) => validateChannel(row));
  const invalidChannels = channels.filter((row: AnyObj) => row.valid !== true);
  const validChannels = channels.filter((row: AnyObj) => row.valid === true);

  const profile = loadProfile(policy);
  const selected = pickChannel(validChannels, profile);
  const failClosed = !selected.selected;

  const core = {
    type: 'platform_adaptation_channel_runtime',
    ts: nowIso(),
    dry_run: dryRun,
    policy_path: rel(policyPath),
    registry_path: rel(policy.channels_registry_path),
    oracle_state_path: rel(policy.oracle_state_path),
    profile,
    valid_channel_count: validChannels.length,
    invalid_channel_count: invalidChannels.length,
    invalid_channels: invalidChannels.map((c: AnyObj) => ({ id: c.id || null, problems: c.problems || [] })),
    selected_channel: selected.selected
      ? {
        id: selected.selected.id,
        kind: selected.selected.kind,
        version: selected.selected.version,
        module: selected.selected.module,
        hooks: selected.selected.hooks,
        predicate: selected.selected.predicate,
        attestation: selected.selected.attestation
      }
      : null,
    fallback_to_generic: selected.fallback_to_generic,
    fail_closed: failClosed,
    reason: selected.reason,
    rollback_safe_disable_switch: true
  };

  const receipt = {
    schema_id: 'platform_adaptation_channel_runtime_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: failClosed ? false : true,
    ...core,
    signature: stableHash(core, policy.signing_secret)
  };

  if (!dryRun) {
    writeJsonAtomic(policy.state_path, receipt);
    appendJsonl(policy.history_path, receipt);
  }
  return receipt;
}

function cmdStatus(policyPath: string): void {
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.state_path, {
    ok: false,
    type: 'platform_adaptation_channel_runtime',
    reason: 'status_not_found',
    state_path: rel(policy.state_path)
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function cmdList(policyPath: string): void {
  const policy = loadPolicy(policyPath);
  const registry = readJson(policy.channels_registry_path, {});
  const rawChannels = Array.isArray(registry.channels) ? registry.channels : [];
  const channels = rawChannels.map((row: AnyObj) => validateChannel(row));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'platform_adaptation_channel_runtime',
    ts: nowIso(),
    registry_path: rel(policy.channels_registry_path),
    channels
  }, null, 2)}\n`);
}

function cmdTest(policyPath: string, strict: boolean): void {
  const out = activate(policyPath, true);
  const registry = readJson(loadPolicy(policyPath).channels_registry_path, {});
  const rawChannels = Array.isArray(registry.channels) ? registry.channels : [];
  const ids = new Set(rawChannels.map((row: AnyObj) => cleanText(row.id || '', 120).toLowerCase()).filter(Boolean));
  const required = ['generic', 'ubuntu', 'freebsd', 'nixos', 'raspios', 'alpine'];
  const missing = required.filter((id) => !ids.has(id));
  const payload = {
    ok: out.ok === true && missing.length === 0,
    type: 'platform_adaptation_channel_runtime_test',
    ts: nowIso(),
    missing_required_channels: missing,
    activation_preview: out
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/platform_adaptation_channel_runtime.js activate [--dry-run=1] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/platform_adaptation_channel_runtime.js status [--policy=<path>]');
  console.log('  node systems/ops/platform_adaptation_channel_runtime.js list [--policy=<path>]');
  console.log('  node systems/ops/platform_adaptation_channel_runtime.js test [--strict=1|0] [--policy=<path>]');
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
  if (cmd === 'list') {
    cmdList(policyPath);
    return;
  }
  if (cmd === 'test') {
    cmdTest(policyPath, toBool(args.strict, false));
    return;
  }
  if (cmd === 'activate' || cmd === 'run') {
    const out = activate(policyPath, toBool(args['dry-run'], false));
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) main();
