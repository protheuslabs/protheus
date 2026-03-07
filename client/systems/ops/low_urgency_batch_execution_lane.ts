#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-041
 * Batch execution lane for low-urgency LLM work.
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;
const ROOT = process.env.LOW_URGENCY_BATCH_ROOT ? path.resolve(process.env.LOW_URGENCY_BATCH_ROOT) : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.LOW_URGENCY_BATCH_POLICY_PATH ? path.resolve(process.env.LOW_URGENCY_BATCH_POLICY_PATH) : path.join(ROOT, 'config', 'low_urgency_batch_execution_lane_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) { const out: AnyObj = { _: [] }; for (let i = 0; i < argv.length; i += 1) { const t = String(argv[i] || ''); if (!t.startsWith('--')) { out._.push(t); continue; } const eq = t.indexOf('='); if (eq >= 0) { out[t.slice(2, eq)] = t.slice(eq + 1); continue; } const k = t.slice(2); const n = argv[i + 1]; if (n != null && !String(n).startsWith('--')) { out[k] = String(n); i += 1; continue; } out[k] = true; } return out; }
function toBool(v: unknown, fallback = false) { if (v == null) return fallback; const s = String(v).trim().toLowerCase(); if (['1', 'true', 'yes', 'on'].includes(s)) return true; if (['0', 'false', 'no', 'off'].includes(s)) return false; return fallback; }
function clampInt(v: unknown, lo: number, hi: number, fallback: number) { const n = Number(v); if (!Number.isFinite(n)) return fallback; const x = Math.trunc(n); if (x < lo) return lo; if (x > hi) return hi; return x; }
function ensureDir(d: string) { fs.mkdirSync(d, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw, 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseJsonArg(raw: unknown, fallback: any = null) { const txt = cleanText(raw, 120000); if (!txt) return fallback; try { return JSON.parse(txt); } catch { return fallback; } }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    batch: { max_tasks_per_batch: 5, max_tokens_per_batch: 1800 },
    outputs: { latest_path: 'state/ops/low_urgency_batch_execution_lane/latest.json', history_path: 'state/ops/low_urgency_batch_execution_lane/history.jsonl' }
  };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy(); const raw = readJson(policyPath, {}); const batch = raw.batch && typeof raw.batch === 'object' ? raw.batch : {}; const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    batch: {
      max_tasks_per_batch: clampInt(batch.max_tasks_per_batch, 1, 1000, base.batch.max_tasks_per_batch),
      max_tokens_per_batch: clampInt(batch.max_tokens_per_batch, 1, 10000000, base.batch.max_tokens_per_batch)
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
  return rows.map((r: AnyObj, i: number) => ({ id: cleanText(r && (r.id || `task_${i + 1}`), 120), urgency: cleanText(r && r.urgency, 40).toLowerCase() || 'low', tokens: clampInt(r && r.tokens, 1, 1000000, 200), prompt: cleanText(r && r.prompt, 1000) })).filter((r) => r.id);
}
function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true); const apply = toBool(args.apply, false);
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) return { ok: true, strict, apply, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  const rows = normalizeRows(parseJsonArg(args['tasks-json'] || args.tasks_json, []));
  const low = rows.filter((r: AnyObj) => r.urgency === 'low');
  const deferred = rows.filter((r: AnyObj) => r.urgency !== 'low').map((r: AnyObj) => ({ id: r.id, reason: 'not_low_urgency' }));

  const batches: AnyObj[] = [];
  let cur: AnyObj[] = []; let curTokens = 0;
  for (const task of low) {
    const wouldOverflowTasks = cur.length >= Number(policy.batch.max_tasks_per_batch || 1);
    const wouldOverflowTokens = (curTokens + Number(task.tokens || 0)) > Number(policy.batch.max_tokens_per_batch || 1);
    if ((wouldOverflowTasks || wouldOverflowTokens) && cur.length) {
      batches.push({ task_ids: cur.map((t) => t.id), task_count: cur.length, token_estimate: curTokens, apply_mode: apply ? 'execute' : 'dry_run' });
      cur = []; curTokens = 0;
    }
    cur.push(task); curTokens += Number(task.tokens || 0);
  }
  if (cur.length) batches.push({ task_ids: cur.map((t) => t.id), task_count: cur.length, token_estimate: curTokens, apply_mode: apply ? 'execute' : 'dry_run' });

  const out = { ok: true, ts: nowIso(), type: 'low_urgency_batch_execution_lane', strict, apply, task_count: rows.length, low_urgency_count: low.length, deferred_count: deferred.length, deferred, batches, policy_path: rel(policy.policy_path) };
  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, task_count: out.task_count, low_urgency_count: out.low_urgency_count, batch_count: batches.length, ok: true });
  return out;
}
function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  return { ok: true, ts: nowIso(), type: 'low_urgency_batch_execution_lane_status', latest: readJson(policy.outputs.latest_path, null), policy_path: rel(policy.policy_path) };
}
function main() { const args = parseArgs(process.argv.slice(2)); const cmd = String(args._[0] || 'status').toLowerCase(); const payload = cmd === 'run' ? cmdRun(args) : cmd === 'status' ? cmdStatus(args) : { ok: false, error: `unknown_command:${cmd}` }; process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); if (payload.ok === false && toBool(args.strict, true)) process.exit(1); if (payload.ok === false) process.exit(1); }
if (require.main === module) { try { main(); } catch (err) { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'low_urgency_batch_execution_lane_failed', 260) })}\n`); process.exit(1); } }
module.exports = { loadPolicy, cmdRun, cmdStatus };
