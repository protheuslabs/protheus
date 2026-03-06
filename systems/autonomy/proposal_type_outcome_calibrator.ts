#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-028
 * Outcome calibration by proposal type.
 *
 * Usage:
 *   node systems/autonomy/proposal_type_outcome_calibrator.js calibrate --rows-json='[{"proposal_type":"external_intel","ok":true}]'
 *   node systems/autonomy/proposal_type_outcome_calibrator.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.PROPOSAL_TYPE_CALIBRATOR_ROOT
  ? path.resolve(process.env.PROPOSAL_TYPE_CALIBRATOR_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.PROPOSAL_TYPE_CALIBRATOR_POLICY_PATH
  ? path.resolve(process.env.PROPOSAL_TYPE_CALIBRATOR_POLICY_PATH)
  : path.join(ROOT, 'config', 'proposal_type_outcome_calibrator_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
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
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try { if (!fs.existsSync(filePath)) return fallback; const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return parsed == null ? fallback : parsed; } catch { return fallback; }
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
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseJsonArg(raw: unknown, fallback: any = null) {
  const txt = cleanText(raw, 120000);
  if (!txt) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    target_pass_rate: 0.6,
    max_offset_abs: 0.2,
    min_samples: 3,
    outputs: {
      state_path: 'state/adaptive/strategy/proposal_type_outcome_calibrator/state.json',
      latest_path: 'state/adaptive/strategy/proposal_type_outcome_calibrator/latest.json',
      history_path: 'state/adaptive/strategy/proposal_type_outcome_calibrator/history.jsonl',
      receipts_path: 'state/adaptive/strategy/receipts.jsonl'
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
    target_pass_rate: clampNumber(raw.target_pass_rate, 0, 1, base.target_pass_rate),
    max_offset_abs: clampNumber(raw.max_offset_abs, 0, 1, base.max_offset_abs),
    min_samples: clampNumber(raw.min_samples, 1, 100000, base.min_samples),
    outputs: {
      state_path: resolvePath(outputs.state_path, base.outputs.state_path),
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      receipts_path: resolvePath(outputs.receipts_path, base.outputs.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(statePath: string) {
  const raw = readJson(statePath, { version: 1, updated_at: null, by_type: {}, proposal_type_threshold_offsets: {} });
  return {
    version: 1,
    updated_at: cleanText(raw && raw.updated_at, 64) || null,
    by_type: raw && raw.by_type && typeof raw.by_type === 'object' ? raw.by_type : {},
    proposal_type_threshold_offsets: raw && raw.proposal_type_threshold_offsets && typeof raw.proposal_type_threshold_offsets === 'object'
      ? raw.proposal_type_threshold_offsets
      : {}
  };
}

function normalizeRows(rows: unknown) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: AnyObj) => ({
    proposal_type: cleanText(row && row.proposal_type, 120).toLowerCase(),
    ok: row && row.ok === true
  })).filter((row) => row.proposal_type);
}

function cmdCalibrate(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const rows = normalizeRows(parseJsonArg(args['rows-json'] || args.rows_json, []));
  if (!rows.length) return { ok: false, error: 'no_rows' };

  const state = loadState(policy.outputs.state_path);
  const changedTypes: AnyObj[] = [];

  for (const row of rows) {
    if (!state.by_type[row.proposal_type] || typeof state.by_type[row.proposal_type] !== 'object') {
      state.by_type[row.proposal_type] = { success: 0, failure: 0, total: 0, pass_rate: 0 };
    }
    const cell = state.by_type[row.proposal_type];
    if (row.ok) cell.success += 1;
    else cell.failure += 1;
    cell.total = Number(cell.success || 0) + Number(cell.failure || 0);
    cell.pass_rate = cell.total > 0 ? Number((cell.success / cell.total).toFixed(6)) : 0;

    if (cell.total >= Number(policy.min_samples || 1)) {
      const delta = Number((cell.pass_rate - Number(policy.target_pass_rate || 0)).toFixed(6));
      const offset = Math.max(-Number(policy.max_offset_abs || 0), Math.min(Number(policy.max_offset_abs || 0), delta));
      state.proposal_type_threshold_offsets[row.proposal_type] = Number(offset.toFixed(6));
      changedTypes.push({
        proposal_type: row.proposal_type,
        pass_rate: cell.pass_rate,
        offset: state.proposal_type_threshold_offsets[row.proposal_type],
        total: cell.total
      });
    }
  }

  state.updated_at = nowIso();
  writeJsonAtomic(policy.outputs.state_path, state);

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'proposal_type_outcome_calibrator',
    strict,
    ingested: rows.length,
    changed_types: changedTypes,
    proposal_type_threshold_offsets: state.proposal_type_threshold_offsets,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    ingested: out.ingested,
    changed_type_count: changedTypes.length,
    ok: true
  });
  appendJsonl(policy.outputs.receipts_path, {
    ts: out.ts,
    type: 'proposal_type_outcome_calibration_receipt',
    changed_types: changedTypes,
    proposal_type_threshold_offsets: state.proposal_type_threshold_offsets,
    policy_path: rel(policy.policy_path)
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const state = loadState(policy.outputs.state_path);
  return {
    ok: true,
    ts: nowIso(),
    type: 'proposal_type_outcome_calibrator_status',
    updated_at: state.updated_at,
    proposal_type_threshold_offsets: state.proposal_type_threshold_offsets,
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/proposal_type_outcome_calibrator.js calibrate --rows-json="[{\"proposal_type\":\"external_intel\",\"ok\":true}]"');
  console.log('  node systems/autonomy/proposal_type_outcome_calibrator.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }

  const payload = cmd === 'calibrate' ? cmdCalibrate(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'proposal_type_outcome_calibrator_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdCalibrate, cmdStatus };
