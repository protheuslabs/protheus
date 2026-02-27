#!/usr/bin/env node
'use strict';
export {};

/**
 * secret_rotation_migration_auditor.js
 *
 * SEC-M03: secret rotation + secret-manager migration governance lane.
 *
 * Usage:
 *   node systems/security/secret_rotation_migration_auditor.js status [--strict=1|0] [--scan=1|0]
 *   node systems/security/secret_rotation_migration_auditor.js scan
 *   node systems/security/secret_rotation_migration_auditor.js attest --operator-id=<id> --approval-note="..." [--apply=1|0]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SECRET_ROTATION_MIGRATION_POLICY_PATH
  ? path.resolve(String(process.env.SECRET_ROTATION_MIGRATION_POLICY_PATH))
  : path.join(ROOT, 'config', 'secret_rotation_migration_policy.json');
const DEFAULT_SECRETS_DIR = process.env.SECRET_BROKER_SECRETS_DIR
  ? path.resolve(String(process.env.SECRET_BROKER_SECRETS_DIR))
  : path.join(os.homedir(), '.config', 'protheus', 'secrets');

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

function normalizeRel(p: unknown) {
  return String(p == null ? '' : p).trim().replace(/\\/g, '/');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(absDir: string) {
  fs.mkdirSync(absDir, { recursive: true });
}

function readJson(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(absPath: string, payload: AnyObj) {
  ensureDir(path.dirname(absPath));
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, absPath);
}

function appendJsonl(absPath: string, row: AnyObj) {
  ensureDir(path.dirname(absPath));
  fs.appendFileSync(absPath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const token = cleanText(raw || fallbackRel, 400);
  return path.isAbsolute(token) ? path.resolve(token) : path.join(ROOT, token);
}

function rel(absPath: string) {
  return normalizeRel(path.relative(ROOT, absPath));
}

function defaultPolicy() {
  return {
    schema_id: 'secret_rotation_migration_policy',
    schema_version: '1.0',
    enabled: true,
    broker_policy_path: 'config/secret_broker_policy.json',
    required_secret_ids: ['moltbook_api_key', 'moltstack_api_key'],
    attestation: {
      max_age_days: 90,
      required_flags: ['active_keys_rotated', 'history_scrub_verified', 'secret_manager_migrated'],
      state_path: 'config/secret_rotation_attestation.json',
      receipts_path: 'state/security/secret_rotation_migration/receipts.jsonl'
    },
    scan: {
      enabled: true,
      fail_on_hits: true,
      max_hits: 25,
      max_file_bytes: 1024 * 1024,
      exclude_paths: [
        'node_modules/',
        'dist/',
        'state/',
        'memory/',
        'memory/tools/tests/',
        'drafts/',
        'research/'
      ],
      patterns: [
        { id: 'aws_access_key', regex: 'AKIA[0-9A-Z]{16}' },
        { id: 'github_pat', regex: 'github_pat_[A-Za-z0-9_]{60,}' },
        { id: 'github_classic', regex: 'ghp_[A-Za-z0-9]{36}' },
        { id: 'slack_token', regex: 'xox[baprs]-[A-Za-z0-9-]{20,}' },
        { id: 'google_api_key', regex: 'AIza[0-9A-Za-z-_]{35}' },
        { id: 'private_key_block', regex: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |)?PRIVATE KEY-----' },
        { id: 'openai_project_key', regex: 'sk-proj-[A-Za-z0-9_-]{20,}' }
      ]
    },
    runbook_path: 'docs/SECRET_ROTATION_MIGRATION.md'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const attRaw = raw.attestation && typeof raw.attestation === 'object' ? raw.attestation : {};
  const scanRaw = raw.scan && typeof raw.scan === 'object' ? raw.scan : {};
  const patternRows = Array.isArray(scanRaw.patterns) ? scanRaw.patterns : base.scan.patterns;
  return {
    schema_id: 'secret_rotation_migration_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    broker_policy_path: resolvePath(raw.broker_policy_path, base.broker_policy_path),
    required_secret_ids: Array.isArray(raw.required_secret_ids)
      ? raw.required_secret_ids.map((row: unknown) => normalizeToken(row, 120)).filter(Boolean).slice(0, 64)
      : base.required_secret_ids.slice(0),
    attestation: {
      max_age_days: clampInt(attRaw.max_age_days, 1, 3650, base.attestation.max_age_days),
      required_flags: Array.isArray(attRaw.required_flags)
        ? attRaw.required_flags.map((row: unknown) => normalizeToken(row, 120)).filter(Boolean).slice(0, 64)
        : base.attestation.required_flags.slice(0),
      state_path: resolvePath(attRaw.state_path, base.attestation.state_path),
      receipts_path: resolvePath(attRaw.receipts_path, base.attestation.receipts_path)
    },
    scan: {
      enabled: scanRaw.enabled !== false,
      fail_on_hits: scanRaw.fail_on_hits !== false,
      max_hits: clampInt(scanRaw.max_hits, 1, 500, base.scan.max_hits),
      max_file_bytes: clampInt(scanRaw.max_file_bytes, 1024, 10 * 1024 * 1024, base.scan.max_file_bytes),
      exclude_paths: Array.isArray(scanRaw.exclude_paths)
        ? scanRaw.exclude_paths.map((row: unknown) => normalizeRel(row)).filter(Boolean).slice(0, 256)
        : base.scan.exclude_paths.slice(0),
      patterns: patternRows
        .map((row: AnyObj) => ({
          id: normalizeToken(row && row.id || '', 80),
          regex: cleanText(row && row.regex || '', 400)
        }))
        .filter((row: AnyObj) => row.id && row.regex)
    },
    runbook_path: resolvePath(raw.runbook_path, base.runbook_path),
    policy_path: path.resolve(policyPath)
  };
}

function gitTrackedFiles() {
  const proc = spawnSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (proc.status !== 0) return [];
  return String(proc.stdout || '')
    .split(/\r?\n/)
    .map((row) => normalizeRel(row))
    .filter(Boolean);
}

function isExcludedPath(relPath: string, excludes: string[]) {
  const low = normalizeRel(relPath).toLowerCase();
  for (const row of excludes) {
    const token = normalizeRel(row).toLowerCase();
    if (!token) continue;
    if (token.endsWith('/')) {
      if (low.startsWith(token)) return true;
    } else if (low === token || low.startsWith(`${token}/`)) {
      return true;
    }
  }
  return false;
}

function compilePatterns(patterns: AnyObj[]) {
  const out: AnyObj[] = [];
  for (const row of patterns) {
    try {
      out.push({
        id: normalizeToken(row.id, 80),
        re: new RegExp(String(row.regex || ''), 'm')
      });
    } catch {}
  }
  return out;
}

function scanTrackedFiles(policy: AnyObj) {
  if (policy.scan.enabled !== true) {
    return { enabled: false, hit_count: 0, hits: [] };
  }
  const tracked = gitTrackedFiles();
  const compiled = compilePatterns(policy.scan.patterns || []);
  const hits: AnyObj[] = [];
  for (const relPath of tracked) {
    if (isExcludedPath(relPath, policy.scan.exclude_paths || [])) continue;
    const absPath = path.join(ROOT, relPath);
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!stat || !stat.isFile()) continue;
    if (Number(stat.size || 0) > Number(policy.scan.max_file_bytes || 1024 * 1024)) continue;
    let text = '';
    try {
      text = String(fs.readFileSync(absPath, 'utf8') || '');
    } catch {
      continue;
    }
    for (const pattern of compiled) {
      if (!pattern || !pattern.re) continue;
      const m = text.match(pattern.re);
      if (!m) continue;
      hits.push({
        path: relPath,
        pattern_id: pattern.id,
        sample: cleanText(m[0], 120)
      });
      if (hits.length >= Number(policy.scan.max_hits || 25)) {
        return { enabled: true, hit_count: hits.length, hits };
      }
    }
  }
  return { enabled: true, hit_count: hits.length, hits };
}

function resolveTemplate(rawPath: unknown) {
  let out = String(rawPath == null ? '' : rawPath).trim();
  if (!out) return '';
  out = out
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$\{REPO_ROOT\}/g, ROOT)
    .replace(/\$\{DEFAULT_SECRETS_DIR\}/g, DEFAULT_SECRETS_DIR);
  if (path.isAbsolute(out)) return path.resolve(out);
  return path.resolve(ROOT, out);
}

function isWithinRoot(absPath: string) {
  const rootToken = `${path.resolve(ROOT)}${path.sep}`;
  const full = path.resolve(absPath);
  return full === path.resolve(ROOT) || full.startsWith(rootToken);
}

function evaluateBrokerPolicy(policy: AnyObj) {
  const broker = readJson(policy.broker_policy_path, {});
  const checks: AnyObj[] = [];
  const secrets = broker.secrets && typeof broker.secrets === 'object' ? broker.secrets : {};
  const required = Array.isArray(policy.required_secret_ids) ? policy.required_secret_ids : [];
  const missingSecrets = required.filter((id: string) => !Object.prototype.hasOwnProperty.call(secrets, id));
  checks.push({
    id: 'broker:required_secret_ids_present',
    ok: missingSecrets.length === 0,
    detail: missingSecrets.length === 0 ? `required=${required.length}` : `missing=${missingSecrets.join(',')}`
  });
  const globalRotation = broker.rotation_policy && typeof broker.rotation_policy === 'object' ? broker.rotation_policy : {};
  const warnDays = Math.max(0, Number(globalRotation.warn_after_days || 0) || 0);
  const maxDays = Math.max(0, Number(globalRotation.max_after_days || 0) || 0);
  checks.push({
    id: 'broker:rotation_window_enforced',
    ok: warnDays > 0 && warnDays <= 45 && maxDays > 0 && maxDays <= 90,
    detail: `warn_after_days=${warnDays} max_after_days=${maxDays}`
  });

  const repoLocalPaths: string[] = [];
  for (const [secretId, secretCfg] of Object.entries(secrets)) {
    const secretObj = secretCfg && typeof secretCfg === 'object' ? secretCfg as AnyObj : {};
    const providers = Array.isArray(secretObj.providers) ? secretObj.providers : [];
    for (const providerRaw of providers) {
      const provider = providerRaw && typeof providerRaw === 'object' ? providerRaw : {};
      const type = normalizeToken(provider.type || '', 40);
      if (type !== 'json_file') continue;
      const paths = Array.isArray(provider.paths)
        ? provider.paths.map((row: unknown) => resolveTemplate(row)).filter(Boolean)
        : resolveTemplate(provider.path) ? [resolveTemplate(provider.path)] : [];
      for (const absCandidate of paths) {
        if (!isWithinRoot(absCandidate)) continue;
        repoLocalPaths.push(`${normalizeToken(secretId, 120)}:${rel(absCandidate)}`);
      }
    }
  }
  checks.push({
    id: 'broker:no_repo_local_secret_paths',
    ok: repoLocalPaths.length === 0,
    detail: repoLocalPaths.length === 0 ? 'none' : repoLocalPaths.join(',')
  });
  return checks;
}

function loadAttestation(policy: AnyObj) {
  const raw = readJson(policy.attestation.state_path, {});
  return {
    schema_id: 'secret_rotation_migration_state',
    schema_version: '1.0',
    ts: cleanText(raw.ts || '', 64) || null,
    operator_id: normalizeToken(raw.operator_id || '', 120) || null,
    approval_note: cleanText(raw.approval_note || '', 240) || null,
    flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {}
  };
}

function evaluateAttestation(policy: AnyObj) {
  const state = loadAttestation(policy);
  const checks: AnyObj[] = [];
  const tsMs = state.ts ? Date.parse(state.ts) : NaN;
  const ageDays = Number.isFinite(tsMs)
    ? Math.floor((Date.now() - tsMs) / (24 * 3600 * 1000))
    : null;
  checks.push({
    id: 'attestation:present',
    ok: !!state.ts && !!state.operator_id,
    detail: state.ts ? `ts=${state.ts} operator=${state.operator_id || 'missing'}` : 'missing'
  });
  checks.push({
    id: 'attestation:fresh',
    ok: ageDays != null && ageDays <= Number(policy.attestation.max_age_days || 90),
    detail: ageDays == null ? 'age_days=missing' : `age_days=${ageDays} max_age_days=${Number(policy.attestation.max_age_days || 0)}`
  });
  const requiredFlags = Array.isArray(policy.attestation.required_flags) ? policy.attestation.required_flags : [];
  const missingFlags = requiredFlags.filter((id: string) => state.flags[id] !== true);
  checks.push({
    id: 'attestation:required_flags',
    ok: missingFlags.length === 0,
    detail: missingFlags.length === 0 ? `flags=${requiredFlags.join(',')}` : `missing=${missingFlags.join(',')}`
  });
  return { checks, state };
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const strict = toBool(args.strict, false);
  const scanEnabled = toBool(args.scan, policy.scan.enabled !== false);
  const checks: AnyObj[] = [];
  const pushCheck = (row: AnyObj) => checks.push({ id: row.id, ok: row.ok === true, detail: cleanText(row.detail || '', 320) });

  pushCheck({
    id: 'policy:enabled',
    ok: policy.enabled === true,
    detail: `enabled=${policy.enabled ? '1' : '0'}`
  });

  for (const row of evaluateBrokerPolicy(policy)) pushCheck(row);

  const attestationEval = evaluateAttestation(policy);
  for (const row of attestationEval.checks) pushCheck(row);

  const runbookPresent = fs.existsSync(policy.runbook_path) && fs.statSync(policy.runbook_path).isFile();
  const runbookText = runbookPresent ? String(fs.readFileSync(policy.runbook_path, 'utf8') || '') : '';
  pushCheck({
    id: 'runbook:present',
    ok: runbookPresent && runbookText.includes('secret_broker.js rotation-check') && runbookText.includes('attest'),
    detail: runbookPresent ? `path=${rel(policy.runbook_path)}` : 'missing'
  });

  const scanResult = scanEnabled ? scanTrackedFiles(policy) : { enabled: false, hit_count: 0, hits: [] };
  pushCheck({
    id: 'scan:plaintext_secret_hits',
    ok: scanResult.enabled !== true || Number(scanResult.hit_count || 0) === 0 || policy.scan.fail_on_hits !== true,
    detail: `enabled=${scanResult.enabled ? '1' : '0'} hit_count=${Number(scanResult.hit_count || 0)} fail_on_hits=${policy.scan.fail_on_hits ? '1' : '0'}`
  });

  const ok = checks.every((row) => row.ok === true);
  const out = {
    ok,
    type: 'secret_rotation_migration_status',
    ts: nowIso(),
    policy: {
      path: rel(policy.policy_path),
      broker_policy_path: rel(policy.broker_policy_path),
      runbook_path: rel(policy.runbook_path)
    },
    checks,
    scan_hits: Array.isArray(scanResult.hits) ? scanResult.hits.slice(0, 25) : []
  };
  if (strict && !ok) process.exitCode = 1;
  return out;
}

function cmdScan(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const scanResult = scanTrackedFiles(policy);
  const out = {
    ok: Number(scanResult.hit_count || 0) === 0,
    type: 'secret_rotation_migration_scan',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    enabled: scanResult.enabled === true,
    hit_count: Number(scanResult.hit_count || 0),
    hits: Array.isArray(scanResult.hits) ? scanResult.hits : []
  };
  return out;
}

function cmdAttest(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const apply = toBool(args.apply, false);
  const operatorId = normalizeToken(args['operator-id'] || args.operator_id || process.env.USER || '', 120);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 240);
  if (!operatorId) {
    return {
      ok: false,
      type: 'secret_rotation_migration_attest',
      ts: nowIso(),
      error: 'operator_id_required'
    };
  }
  if (approvalNote.length < 10) {
    return {
      ok: false,
      type: 'secret_rotation_migration_attest',
      ts: nowIso(),
      error: 'approval_note_too_short',
      min_len: 10
    };
  }
  const flags = {
    active_keys_rotated: toBool(args['active-keys-rotated'], true),
    history_scrub_verified: toBool(args['history-scrub-verified'], true),
    secret_manager_migrated: toBool(args['secret-manager-migrated'], true)
  };
  const payload = {
    schema_id: 'secret_rotation_migration_state',
    schema_version: '1.0',
    ts: nowIso(),
    operator_id: operatorId,
    approval_note: approvalNote,
    flags,
    policy_path: rel(policy.policy_path)
  };
  if (apply) {
    writeJsonAtomic(policy.attestation.state_path, payload);
    appendJsonl(policy.attestation.receipts_path, {
      ...payload,
      type: 'secret_rotation_migration_attestation'
    });
  }
  return {
    ok: true,
    type: 'secret_rotation_migration_attest',
    ts: nowIso(),
    applied: apply,
    attestation_state_path: rel(policy.attestation.state_path),
    attestation_receipts_path: rel(policy.attestation.receipts_path),
    payload
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/secret_rotation_migration_auditor.js status [--strict=1|0] [--scan=1|0] [--policy=/abs/path.json]');
  console.log('  node systems/security/secret_rotation_migration_auditor.js scan [--policy=/abs/path.json]');
  console.log('  node systems/security/secret_rotation_migration_auditor.js attest --operator-id=<id> --approval-note="..." [--active-keys-rotated=1|0] [--history-scrub-verified=1|0] [--secret-manager-migrated=1|0] [--apply=1|0] [--policy=/abs/path.json]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'status') out = cmdStatus(args);
  else if (cmd === 'scan') out = cmdScan(args);
  else if (cmd === 'attest') out = cmdAttest(args);
  else out = { ok: false, type: 'secret_rotation_migration_auditor', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  const strictStatus = cmd === 'status' && toBool(args.strict, false);
  if (out && out.ok === false && (cmd !== 'status' || strictStatus)) process.exitCode = 1;
  if (cmd === 'status' && strictStatus && out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'secret_rotation_migration_auditor',
      error: cleanText((err as AnyObj)?.message || err || 'secret_rotation_migration_auditor_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  cmdStatus,
  cmdScan,
  cmdAttest
};
