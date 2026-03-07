#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-029
 * Weekly strategy synthesis from executed outcomes.
 *
 * Usage:
 *   node systems/strategy/weekly_executed_outcomes_synthesis.js run [--rows-json='[{"strategy":"growth","ok":true}]']
 *   node systems/strategy/weekly_executed_outcomes_synthesis.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.WEEKLY_EXEC_OUTCOME_SYNTH_ROOT
  ? path.resolve(process.env.WEEKLY_EXEC_OUTCOME_SYNTH_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.WEEKLY_EXEC_OUTCOME_SYNTH_POLICY_PATH
  ? path.resolve(process.env.WEEKLY_EXEC_OUTCOME_SYNTH_POLICY_PATH)
  : path.join(ROOT, 'config', 'weekly_executed_outcomes_synthesis_policy.json');

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
    default_delta_step: 0.05,
    max_delta_abs: 0.25,
    inputs: {
      weekly_rows_path: 'state/autonomy/weekly_executed_outcomes/rows.json'
    },
    outputs: {
      latest_path: 'state/strategy/weekly_executed_outcomes_synthesis/latest.json',
      history_path: 'state/strategy/weekly_executed_outcomes_synthesis/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const inputs = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    default_delta_step: clampNumber(raw.default_delta_step, 0.001, 1, base.default_delta_step),
    max_delta_abs: clampNumber(raw.max_delta_abs, 0.01, 1, base.max_delta_abs),
    inputs: {
      weekly_rows_path: resolvePath(inputs.weekly_rows_path, base.inputs.weekly_rows_path)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function normalizeRows(rows: unknown) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: AnyObj) => ({
    strategy: cleanText(row && (row.strategy || row.bucket || row.tag), 120).toLowerCase(),
    ok: row && row.ok === true,
    revenue_delta: Number(row && row.revenue_delta || 0)
  })).filter((row) => row.strategy);
}

function rowsFromPolicyInput(policy: AnyObj) {
  const raw = readJson(policy.inputs.weekly_rows_path, []);
  if (Array.isArray(raw)) return normalizeRows(raw);
  if (raw && Array.isArray(raw.rows)) return normalizeRows(raw.rows);
  return [];
}

function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const explicitRows = normalizeRows(parseJsonArg(args['rows-json'] || args.rows_json, []));
  const rows = explicitRows.length ? explicitRows : rowsFromPolicyInput(policy);
  if (!rows.length) return { ok: false, error: 'no_rows' };

  const byStrategy: AnyObj = {};
  for (const row of rows) {
    if (!byStrategy[row.strategy]) byStrategy[row.strategy] = { success: 0, failure: 0, total: 0, revenue_delta: 0 };
    if (row.ok) byStrategy[row.strategy].success += 1;
    else byStrategy[row.strategy].failure += 1;
    byStrategy[row.strategy].total += 1;
    byStrategy[row.strategy].revenue_delta += Number.isFinite(row.revenue_delta) ? row.revenue_delta : 0;
  }

  const recommendations = Object.entries(byStrategy).map(([strategy, agg]: [string, AnyObj]) => {
    const passRate = agg.total > 0 ? agg.success / agg.total : 0;
    let delta = 0;
    if (passRate >= 0.7) delta += Number(policy.default_delta_step || 0.05);
    if (passRate <= 0.4) delta -= Number(policy.default_delta_step || 0.05);
    if (agg.revenue_delta > 0) delta += Number(policy.default_delta_step || 0.05) / 2;
    if (agg.revenue_delta < 0) delta -= Number(policy.default_delta_step || 0.05) / 2;
    const bounded = Math.max(-Number(policy.max_delta_abs || 0.25), Math.min(Number(policy.max_delta_abs || 0.25), delta));
    return {
      strategy,
      total: agg.total,
      pass_rate: Number(passRate.toFixed(6)),
      revenue_delta: Number(agg.revenue_delta.toFixed(6)),
      recommended_weight_delta: Number(bounded.toFixed(6))
    };
  }).sort((a, b) => Math.abs(b.recommended_weight_delta) - Math.abs(a.recommended_weight_delta));

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'weekly_executed_outcomes_synthesis',
    strict,
    week_key: cleanText(args.week, 80) || nowIso().slice(0, 10),
    rows_analyzed: rows.length,
    recommendations,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    week_key: out.week_key,
    rows_analyzed: out.rows_analyzed,
    recommendation_count: recommendations.length,
    ok: true
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'weekly_executed_outcomes_synthesis_status',
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/strategy/weekly_executed_outcomes_synthesis.js run [--rows-json="[{...}]"]');
  console.log('  node systems/strategy/weekly_executed_outcomes_synthesis.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }

  const payload = cmd === 'run' ? cmdRun(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'weekly_executed_outcomes_synthesis_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdRun, cmdStatus };
