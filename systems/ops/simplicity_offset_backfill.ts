#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { loadPolicy, runGate } = require('./simplicity_budget_gate.js');

type AnyObj = Record<string, any>;

const ROOT = process.env.SIMPLICITY_OFFSET_BACKFILL_ROOT
  ? path.resolve(process.env.SIMPLICITY_OFFSET_BACKFILL_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SIMPLICITY_OFFSET_BACKFILL_POLICY_PATH
  ? path.resolve(process.env.SIMPLICITY_OFFSET_BACKFILL_POLICY_PATH)
  : path.join(ROOT, 'config', 'simplicity_offset_backfill_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 320) {
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
  console.log('  node systems/ops/simplicity_offset_backfill.js run [--apply=1|0] [--policy=<path>] [--approver=<id>] [--reason="..."] [--strict=1|0]');
  console.log('  node systems/ops/simplicity_offset_backfill.js status [--policy=<path>]');
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
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
function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 600);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(absPath: string) { return path.relative(ROOT, absPath).replace(/\\/g, '/'); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    simplicity_policy_path: 'config/simplicity_budget_policy.json',
    latest_path: 'state/ops/simplicity_offset_backfill/latest.json',
    receipts_path: 'state/ops/simplicity_offset_backfill/receipts.jsonl'
  };
}

function loadBackfillPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    simplicity_policy_path: resolvePath(raw.simplicity_policy_path || base.simplicity_policy_path, base.simplicity_policy_path),
    latest_path: resolvePath(raw.latest_path || base.latest_path, base.latest_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function missingOffsetOrgans(gateOut: AnyObj) {
  const checks = Array.isArray(gateOut && gateOut.checks) ? gateOut.checks : [];
  const row = checks.find((item: AnyObj) => String(item && item.id || '') === 'new_organs_offset_receipts');
  const detail = cleanText(row && row.detail || '', 1000);
  if (!detail || !detail.startsWith('missing_offsets=')) return [];
  return detail
    .slice('missing_offsets='.length)
    .split(',')
    .map((token) => normalizeToken(token, 80))
    .filter(Boolean);
}

function cmdRun(args: AnyObj) {
  const backfillPolicy = loadBackfillPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const simplicityPolicy = loadPolicy(backfillPolicy.simplicity_policy_path);
  const apply = toBool(args.apply, true);
  const strict = toBool(args.strict, false);
  const gateOut = runGate(simplicityPolicy);
  const missing = missingOffsetOrgans(gateOut);
  const existing = new Set(
    readJsonl(simplicityPolicy.offset_receipts_path)
      .filter((row: AnyObj) => row && row.approved === true)
      .map((row: AnyObj) => normalizeToken(row.organ_id || '', 80))
      .filter(Boolean)
  );
  const approver = normalizeToken(args.approver || process.env.USER || 'codex', 80) || 'codex';
  const reasonBase = cleanText(args.reason || 'retroactive_offset_receipt_for_baseline_alignment', 240)
    || 'retroactive_offset_receipt_for_baseline_alignment';

  const created = [] as AnyObj[];
  for (const organId of missing) {
    if (existing.has(organId)) continue;
    const row = {
      ts: nowIso(),
      type: 'complexity_offset',
      approved: true,
      organ_id: organId,
      approver,
      reason: reasonBase,
      source: 'simplicity_offset_backfill',
      policy_path: rel(backfillPolicy.policy_path)
    };
    if (apply) appendJsonl(simplicityPolicy.offset_receipts_path, row);
    created.push(row);
    existing.add(organId);
  }

  const verifyOut = runGate(simplicityPolicy);
  const out = {
    ok: verifyOut.ok === true,
    type: 'simplicity_offset_backfill',
    ts: nowIso(),
    apply,
    strict,
    missing_before: missing,
    created_count: created.length,
    created,
    gate_after: {
      ok: verifyOut.ok === true,
      failed_checks: verifyOut.failed_checks,
      checks: verifyOut.checks
    },
    paths: {
      simplicity_policy_path: rel(backfillPolicy.simplicity_policy_path),
      offset_receipts_path: rel(simplicityPolicy.offset_receipts_path),
      latest_path: rel(backfillPolicy.latest_path),
      receipts_path: rel(backfillPolicy.receipts_path)
    }
  };

  writeJsonAtomic(backfillPolicy.latest_path, out);
  appendJsonl(backfillPolicy.receipts_path, out);
  if (strict && out.ok !== true) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }
  return out;
}

function cmdStatus(args: AnyObj) {
  const policy = loadBackfillPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return {
      ok: false,
      type: 'simplicity_offset_backfill_status',
      reason: 'status_not_found',
      latest_path: rel(policy.latest_path)
    };
  }
  return {
    ok: true,
    type: 'simplicity_offset_backfill_status',
    ts: nowIso(),
    latest,
    latest_path: rel(policy.latest_path),
    receipts_path: rel(policy.receipts_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const out = cmdRun(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (cmd === 'status') {
    const out = cmdStatus(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!out.ok) process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadBackfillPolicy,
  cmdRun,
  cmdStatus
};
