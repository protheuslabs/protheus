#!/usr/bin/env node
'use strict';
export {};

/** BL-043 parallel eyes execution with budget-aware concurrency */
const fs = require('fs');
const path = require('path');
type AnyObj = Record<string, any>;
const ROOT = process.env.PARALLEL_EYES_LANE_ROOT ? path.resolve(process.env.PARALLEL_EYES_LANE_ROOT) : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PARALLEL_EYES_LANE_POLICY_PATH ? path.resolve(process.env.PARALLEL_EYES_LANE_POLICY_PATH) : path.join(ROOT, 'config', 'parallel_eyes_budget_aware_lane_policy.json');
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
  return { version: '1.0', enabled: true, budget: { daily_cap_tokens: 8000, degrade_at_ratio: 0.85 }, concurrency: { max_parallel: 6, min_parallel: 1 }, outputs: { latest_path: 'state/sensory/parallel_eyes_budget_aware_lane/latest.json', history_path: 'state/sensory/parallel_eyes_budget_aware_lane/history.jsonl' } };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy(); const raw = readJson(policyPath, {}); const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {}; const concurrency = raw.concurrency && typeof raw.concurrency === 'object' ? raw.concurrency : {}; const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return { version: cleanText(raw.version || base.version, 40) || base.version, enabled: raw.enabled !== false, budget: { daily_cap_tokens: clampInt(budget.daily_cap_tokens, 1, 100000000, base.budget.daily_cap_tokens), degrade_at_ratio: Math.max(0, Math.min(1, Number(budget.degrade_at_ratio || base.budget.degrade_at_ratio))) }, concurrency: { max_parallel: clampInt(concurrency.max_parallel, 1, 1000, base.concurrency.max_parallel), min_parallel: clampInt(concurrency.min_parallel, 1, 1000, base.concurrency.min_parallel) }, outputs: { latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path), history_path: resolvePath(outputs.history_path, base.outputs.history_path) }, policy_path: path.resolve(policyPath) };
}
function normalizeEyes(rows: unknown) { if (!Array.isArray(rows)) return []; return rows.map((r: AnyObj, i: number) => ({ id: cleanText(r && (r.id || `eye_${i + 1}`), 120), token_estimate: clampInt(r && r.token_estimate, 1, 10000000, 100), priority: clampInt(r && r.priority, 0, 10, 5) })).filter((r) => r.id); }
function cmdPlan(args: AnyObj) {
  const strict = toBool(args.strict, true); const apply = toBool(args.apply, false); const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); if (!policy.enabled) return { ok: true, strict, apply, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  const eyes = normalizeEyes(parseJsonArg(args['eyes-json'] || args.eyes_json, []));
  const budgetUsed = clampInt(args['budget-used'] || args.budget_used, 0, 100000000, 0);
  const ratio = Number((budgetUsed / Math.max(1, Number(policy.budget.daily_cap_tokens || 1))).toFixed(6));
  let maxParallel = Number(policy.concurrency.max_parallel || 1);
  if (ratio >= Number(policy.budget.degrade_at_ratio || 0.85)) maxParallel = Math.max(Number(policy.concurrency.min_parallel || 1), Math.ceil(maxParallel / 2));
  const sorted = eyes.slice().sort((a, b) => b.priority - a.priority);
  const selected: AnyObj[] = []; const deferred: AnyObj[] = []; let used = 0;
  for (const eye of sorted) {
    const wouldExceed = (budgetUsed + used + Number(eye.token_estimate || 0)) > Number(policy.budget.daily_cap_tokens || 1);
    if (wouldExceed) { deferred.push({ id: eye.id, reason: 'budget_cap' }); continue; }
    if (selected.length >= maxParallel) { deferred.push({ id: eye.id, reason: 'concurrency_cap' }); continue; }
    selected.push(eye); used += Number(eye.token_estimate || 0);
  }
  const out = { ok: true, ts: nowIso(), type: 'parallel_eyes_budget_aware_lane', strict, apply, budget_ratio: ratio, max_parallel: maxParallel, selected_eyes: selected.map((e) => e.id), deferred, token_reserved: used, policy_path: rel(policy.policy_path) };
  writeJsonAtomic(policy.outputs.latest_path, out); appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, selected: out.selected_eyes.length, deferred: out.deferred.length, budget_ratio: out.budget_ratio, ok: true }); return out;
}
function cmdStatus(args: AnyObj) { const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); return { ok: true, ts: nowIso(), type: 'parallel_eyes_budget_aware_lane_status', latest: readJson(policy.outputs.latest_path, null), policy_path: rel(policy.policy_path) }; }
function main() { const args = parseArgs(process.argv.slice(2)); const cmd = String(args._[0] || 'status').toLowerCase(); const payload = cmd === 'plan' ? cmdPlan(args) : cmd === 'status' ? cmdStatus(args) : { ok: false, error: `unknown_command:${cmd}` }; process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); if (payload.ok === false && toBool(args.strict, true)) process.exit(1); if (payload.ok === false) process.exit(1); }
if (require.main === module) { try { main(); } catch (err) { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'parallel_eyes_budget_aware_lane_failed', 260) })}\n`); process.exit(1); } }
module.exports = { loadPolicy, cmdPlan, cmdStatus };
