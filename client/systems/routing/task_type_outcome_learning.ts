#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-025
 * Outcome-linked routing learning by task type.
 *
 * Usage:
 *   node systems/routing/task_type_outcome_learning.js ingest --rows-json='[{"task_type":"research","model":"deepthinker","ok":true}]'
 *   node systems/routing/task_type_outcome_learning.js rank --task-type=research --candidates=deepthinker,smallthinker
 *   node systems/routing/task_type_outcome_learning.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.TASK_TYPE_OUTCOME_LEARNING_ROOT
  ? path.resolve(process.env.TASK_TYPE_OUTCOME_LEARNING_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.TASK_TYPE_OUTCOME_LEARNING_POLICY_PATH
  ? path.resolve(process.env.TASK_TYPE_OUTCOME_LEARNING_POLICY_PATH)
  : path.join(ROOT, 'config', 'task_type_outcome_learning_policy.json');

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
    smoothing: {
      beta_prior_success: 1,
      beta_prior_failure: 1,
      min_samples_for_strong_bias: 5
    },
    outputs: {
      matrix_path: 'state/routing/task_type_outcome_learning/matrix.json',
      latest_path: 'state/routing/task_type_outcome_learning/latest.json',
      history_path: 'state/routing/task_type_outcome_learning/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const smoothing = raw.smoothing && typeof raw.smoothing === 'object' ? raw.smoothing : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    smoothing: {
      beta_prior_success: clampNumber(smoothing.beta_prior_success, 0, 1000, base.smoothing.beta_prior_success),
      beta_prior_failure: clampNumber(smoothing.beta_prior_failure, 0, 1000, base.smoothing.beta_prior_failure),
      min_samples_for_strong_bias: clampNumber(smoothing.min_samples_for_strong_bias, 1, 100000, base.smoothing.min_samples_for_strong_bias)
    },
    outputs: {
      matrix_path: resolvePath(outputs.matrix_path, base.outputs.matrix_path),
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadMatrix(matrixPath: string) {
  const raw = readJson(matrixPath, { version: 1, updated_at: null, matrix: {} });
  return {
    version: 1,
    updated_at: cleanText(raw && raw.updated_at, 64) || null,
    matrix: raw && raw.matrix && typeof raw.matrix === 'object' ? raw.matrix : {}
  };
}

function normalizeRows(rows: unknown) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: AnyObj) => ({
    task_type: cleanText(row && row.task_type, 120).toLowerCase(),
    model: cleanText(row && row.model, 120),
    ok: row && row.ok === true
  })).filter((row) => row.task_type && row.model);
}

function ensureCell(matrix: AnyObj, taskType: string, model: string) {
  if (!matrix[taskType] || typeof matrix[taskType] !== 'object') matrix[taskType] = {};
  if (!matrix[taskType][model] || typeof matrix[taskType][model] !== 'object') {
    matrix[taskType][model] = { success: 0, failure: 0, total: 0, updated_at: null };
  }
  return matrix[taskType][model];
}

function posterior(cell: AnyObj, policy: AnyObj) {
  const s = Number(cell.success || 0);
  const f = Number(cell.failure || 0);
  const a = Number(policy.smoothing.beta_prior_success || 1);
  const b = Number(policy.smoothing.beta_prior_failure || 1);
  return Number(((s + a) / (s + f + a + b)).toFixed(6));
}

function cmdIngest(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const rows = normalizeRows(parseJsonArg(args['rows-json'] || args.rows_json, []));
  if (!rows.length) return { ok: false, error: 'no_rows' };

  const state = loadMatrix(policy.outputs.matrix_path);
  for (const row of rows) {
    const cell = ensureCell(state.matrix, row.task_type, row.model);
    if (row.ok) cell.success += 1;
    else cell.failure += 1;
    cell.total = Number(cell.success || 0) + Number(cell.failure || 0);
    cell.updated_at = nowIso();
  }

  state.updated_at = nowIso();
  writeJsonAtomic(policy.outputs.matrix_path, state);

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'task_type_outcome_learning_ingest',
    strict,
    ingested: rows.length,
    matrix_path: rel(policy.outputs.matrix_path),
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, ingested: out.ingested, ok: true });
  return out;
}

function cmdRank(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const state = loadMatrix(policy.outputs.matrix_path);

  const taskType = cleanText(args['task-type'] || args.task_type, 120).toLowerCase();
  const candidates = cleanText(args.candidates, 4000).split(',').map((x) => cleanText(x, 120)).filter(Boolean);
  if (!taskType) return { ok: false, error: 'missing_task_type' };
  if (!candidates.length) return { ok: false, error: 'missing_candidates' };

  const scored = candidates.map((model) => {
    const cell = state.matrix && state.matrix[taskType] && state.matrix[taskType][model]
      ? state.matrix[taskType][model]
      : { success: 0, failure: 0, total: 0 };
    const p = posterior(cell, policy);
    return {
      model,
      task_type: taskType,
      posterior_success_rate: p,
      total_samples: Number(cell.total || 0),
      bias_strength: Number(cell.total || 0) >= Number(policy.smoothing.min_samples_for_strong_bias || 0) ? 'strong' : 'weak'
    };
  }).sort((a, b) => (b.posterior_success_rate - a.posterior_success_rate) || String(a.model).localeCompare(String(b.model)));

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'task_type_outcome_learning_rank',
    strict,
    task_type: taskType,
    selected_model: scored.length ? scored[0].model : null,
    ranking: scored,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, task_type: taskType, selected_model: out.selected_model, ok: true });
  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const state = loadMatrix(policy.outputs.matrix_path);
  return {
    ok: true,
    ts: nowIso(),
    type: 'task_type_outcome_learning_status',
    updated_at: state.updated_at,
    matrix: state.matrix,
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/task_type_outcome_learning.js ingest --rows-json="[{\"task_type\":\"research\",\"model\":\"deepthinker\",\"ok\":true}]"');
  console.log('  node systems/routing/task_type_outcome_learning.js rank --task-type=research --candidates=deepthinker,smallthinker');
  console.log('  node systems/routing/task_type_outcome_learning.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  const payload = cmd === 'ingest' ? cmdIngest(args)
    : cmd === 'rank' ? cmdRank(args)
      : cmd === 'status' ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'task_type_outcome_learning_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdIngest, cmdRank, cmdStatus };
