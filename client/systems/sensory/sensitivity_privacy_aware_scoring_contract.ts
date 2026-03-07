#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-103
 * Sensitivity/privacy-aware signal scoring contract.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SENSITIVITY_SCORING_POLICY_PATH
  ? path.resolve(process.env.SENSITIVITY_SCORING_POLICY_PATH)
  : path.join(ROOT, 'config', 'sensitivity_privacy_scoring_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    sensitive_classes: ['pii', 'health', 'financial_secret'],
    restricted_multiplier: 0.4,
    mask_fields: ['raw_text', 'source_payload'],
    require_explicit_approval: true,
    paths: {
      input_dir: 'state/sensory/analysis/scoring_input',
      output_dir: 'state/sensory/analysis/privacy_scoring',
      latest_path: 'state/sensory/analysis/privacy_scoring/latest.json',
      receipts_path: 'state/sensory/analysis/privacy_scoring/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    sensitive_classes: Array.isArray(raw.sensitive_classes)
      ? raw.sensitive_classes.map((row: any) => normalizeToken(row, 80)).filter(Boolean)
      : base.sensitive_classes,
    restricted_multiplier: clampNumber(raw.restricted_multiplier, 0, 1, base.restricted_multiplier),
    mask_fields: Array.isArray(raw.mask_fields)
      ? raw.mask_fields.map((row: any) => cleanText(row, 80)).filter(Boolean)
      : base.mask_fields,
    require_explicit_approval: raw.require_explicit_approval !== false,
    paths: {
      input_dir: resolvePath(paths.input_dir, base.paths.input_dir),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function maskRow(row: Record<string, any>, maskFields: string[]) {
  const out: Record<string, any> = { ...row };
  for (const field of maskFields || []) {
    if (field in out) out[field] = '[REDACTED]';
  }
  return out;
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const inputPath = path.join(policy.paths.input_dir, `${dateStr}.json`);
  const src = readJson(inputPath, { rows: [] });
  const rows = Array.isArray(src.rows) ? src.rows : [];

  const scored = [];
  const blocked = [];

  for (const row of rows) {
    const signalId = cleanText(row && row.signal_id || `sig_${stableHash(JSON.stringify(row), 10)}`, 120);
    const cls = normalizeToken(row && row.sensitivity_class || row && row.class || 'general', 80);
    const baseScore = clampNumber(row && row.base_score, 0, 1, 0);
    const sensitive = (policy.sensitive_classes || []).includes(cls);
    const approved = toBool(row && row.sensitive_use_approved, false);

    if (sensitive && policy.require_explicit_approval && !approved) {
      blocked.push({
        signal_id: signalId,
        sensitivity_class: cls,
        reason: 'sensitive_use_not_approved',
        masked_row: maskRow(row, policy.mask_fields)
      });
      continue;
    }

    const finalScore = sensitive
      ? baseScore * Number(policy.restricted_multiplier || 0.4)
      : baseScore;

    scored.push({
      signal_id: signalId,
      sensitivity_class: cls,
      sensitive,
      approved,
      base_score: Number(baseScore.toFixed(6)),
      final_score: Number(finalScore.toFixed(6)),
      masked_row: sensitive ? maskRow(row, policy.mask_fields) : row
    });
  }

  const out = {
    ok: blocked.length === 0,
    type: 'sensitivity_privacy_aware_scoring_contract',
    ts: nowIso(),
    date: dateStr,
    input_path: inputPath,
    scored_count: scored.length,
    blocked_count: blocked.length,
    scored,
    blocked
  };

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'sensitivity_privacy_scoring_receipt',
    date: dateStr,
    scored_count: scored.length,
    blocked_count: blocked.length,
    top_blocked_signal: blocked[0] ? blocked[0].signal_id : null
  });

  if (strict && blocked.length > 0) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'sensitivity_privacy_aware_scoring_contract_status',
    date: dateStr,
    scored_count: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/sensitivity_privacy_aware_scoring_contract.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/sensitivity_privacy_aware_scoring_contract.js status [YYYY-MM-DD] [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }
  if (cmd === 'run') return run(dateStr, policy, strict);
  if (cmd === 'status') return status(policy, dateStr);
  return usageAndExit(2);
}

module.exports = {
  run
};

if (require.main === module) {
  main();
}
