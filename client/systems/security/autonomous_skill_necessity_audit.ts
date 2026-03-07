#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-017
 * Audit autonomous skill-install receipts for necessity gate compliance.
 *
 * Usage:
 *   node systems/security/autonomous_skill_necessity_audit.js run [--strict=1|0] [--days=30]
 *   node systems/security/autonomous_skill_necessity_audit.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.SKILL_NECESSITY_AUDIT_ROOT
  ? path.resolve(process.env.SKILL_NECESSITY_AUDIT_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SKILL_NECESSITY_AUDIT_POLICY_PATH
  ? path.resolve(process.env.SKILL_NECESSITY_AUDIT_POLICY_PATH)
  : path.join(ROOT, 'config', 'autonomous_skill_necessity_audit_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const lines = String(fs.readFileSync(filePath, 'utf8') || '').split(/\r?\n/).filter(Boolean);
  const out: AnyObj[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row);
    } catch {}
  }
  return out;
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    days: 30,
    required_fields: [
      'problem',
      'repeat_frequency',
      'expected_time_or_token_savings',
      'why_existing_habits_or_skills_insufficient',
      'risk_class'
    ],
    receipts_dir: 'state/security/skill_quarantine/install_receipts',
    outputs: {
      latest_path: 'state/security/autonomous_skill_necessity_audit/latest.json',
      history_path: 'state/security/autonomous_skill_necessity_audit/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    days: Math.max(1, Number(raw.days || base.days || 30)),
    required_fields: Array.isArray(raw.required_fields) ? raw.required_fields : base.required_fields,
    receipts_dir: resolvePath(raw.receipts_dir, base.receipts_dir),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function walkJsonlFiles(dirPath: string, out: string[] = []) {
  if (!fs.existsSync(dirPath)) return out;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkJsonlFiles(full, out);
    else if (ent.isFile() && full.toLowerCase().endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const maxDays = Math.max(1, Number(args.days || policy.days || 30));

  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const cutoffMs = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
  const files = walkJsonlFiles(policy.receipts_dir);
  const violations: AnyObj[] = [];
  let auditedRows = 0;
  let autonomousRows = 0;
  let noveltyBlocked = 0;

  for (const file of files) {
    const rows = readJsonl(file);
    for (const row of rows) {
      const tsMs = Date.parse(String(row.ts || ''));
      if (Number.isFinite(tsMs) && tsMs < cutoffMs) continue;
      if (String(row.type || '') !== 'skill_install_receipt') continue;
      auditedRows += 1;
      const autonomous = row.autonomous === true;
      if (!autonomous) continue;
      autonomousRows += 1;

      const decision = String(row.decision || '');
      const necessity = row.necessity && typeof row.necessity === 'object' ? row.necessity : null;
      if (decision === 'blocked_necessity') {
        const reasons = Array.isArray(necessity && necessity.reasons) ? necessity.reasons : [];
        if (reasons.includes('novelty_only_reasoning')) noveltyBlocked += 1;
      }

      if (decision !== 'installed_and_trusted') continue;
      if (!necessity || necessity.allowed !== true) {
        violations.push({
          file: rel(file),
          receipt_id: cleanText(row.receipt_id || '', 80),
          reason: 'installed_without_allowed_necessity'
        });
        continue;
      }
      const normalized = necessity.normalized && typeof necessity.normalized === 'object' ? necessity.normalized : {};
      const missing = (policy.required_fields || []).filter((field: string) => {
        const v = normalized[field];
        if (typeof v === 'number') return !Number.isFinite(v);
        return !cleanText(v, 400);
      });
      if (missing.length) {
        violations.push({
          file: rel(file),
          receipt_id: cleanText(row.receipt_id || '', 80),
          reason: 'installed_missing_required_necessity_fields',
          missing
        });
      }
    }
  }

  const out = {
    ok: violations.length === 0,
    ts: nowIso(),
    type: 'autonomous_skill_necessity_audit',
    strict,
    days: maxDays,
    files_scanned: files.length,
    audited_rows: auditedRows,
    autonomous_rows: autonomousRows,
    novelty_only_blocked_count: noveltyBlocked,
    violation_count: violations.length,
    violations,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    strict,
    days: out.days,
    violation_count: out.violation_count,
    autonomous_rows: out.autonomous_rows,
    novelty_only_blocked_count: out.novelty_only_blocked_count,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'autonomous_skill_necessity_audit_status',
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/autonomous_skill_necessity_audit.js run [--strict=1|0] [--days=30] [--policy=<path>]');
  console.log('  node systems/security/autonomous_skill_necessity_audit.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  try {
    const payload = cmd === 'run'
      ? cmdRun(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (cmd === 'run' && payload.ok === false && toBool(args.strict, true)) {
      process.exit(1);
    }
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'autonomous_skill_necessity_audit_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdRun,
  cmdStatus
};
