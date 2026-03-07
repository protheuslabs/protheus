#!/usr/bin/env node
'use strict';
export {};

/** V1H-007 baseline objective value-currency propagation */
const fs = require('fs');
const path = require('path');
type AnyObj = Record<string, any>;
const ROOT = process.env.OBJ_CURRENCY_PROP_ROOT ? path.resolve(process.env.OBJ_CURRENCY_PROP_ROOT) : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.OBJ_CURRENCY_PROP_POLICY_PATH ? path.resolve(process.env.OBJ_CURRENCY_PROP_POLICY_PATH) : path.join(ROOT, 'config', 'objective_value_currency_propagation_baseline_policy.json');
function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) { const out: AnyObj = { _: [] }; for (let i = 0; i < argv.length; i += 1) { const t = String(argv[i] || ''); if (!t.startsWith('--')) { out._.push(t); continue; } const eq = t.indexOf('='); if (eq >= 0) { out[t.slice(2, eq)] = t.slice(eq + 1); continue; } const k = t.slice(2); const n = argv[i + 1]; if (n != null && !String(n).startsWith('--')) { out[k] = String(n); i += 1; continue; } out[k] = true; } return out; }
function toBool(v: unknown, fallback = false) { if (v == null) return fallback; const s = String(v).trim().toLowerCase(); if (['1', 'true', 'yes', 'on'].includes(s)) return true; if (['0', 'false', 'no', 'off'].includes(s)) return false; return fallback; }
function ensureDir(d: string) { fs.mkdirSync(d, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw, 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseJsonArg(raw: unknown, fallback: any = null) { const txt = cleanText(raw, 120000); if (!txt) return fallback; try { return JSON.parse(txt); } catch { return fallback; } }
function defaultPolicy() { return { version: '1.0', enabled: true, objective_currency_map: { T1: { revenue: 0.6, reliability: 0.2, velocity: 0.2 }, DEFAULT: { revenue: 0.4, reliability: 0.3, velocity: 0.3 } }, outputs: { latest_path: 'state/autonomy/objective_value_currency_propagation_baseline/latest.json', history_path: 'state/autonomy/objective_value_currency_propagation_baseline/history.jsonl' } }; }
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) { const base = defaultPolicy(); const raw = readJson(policyPath, {}); const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {}; const map = raw.objective_currency_map && typeof raw.objective_currency_map === 'object' ? raw.objective_currency_map : base.objective_currency_map; return { version: cleanText(raw.version || base.version, 40) || base.version, enabled: raw.enabled !== false, objective_currency_map: map, outputs: { latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path), history_path: resolvePath(outputs.history_path, base.outputs.history_path) }, policy_path: path.resolve(policyPath) }; }
function normalizeWeights(row: AnyObj) { const entries = Object.entries(row || {}).map(([k, v]) => [k, Math.max(0, Number(v || 0))]); const sum = entries.reduce((s, [, v]) => s + Number(v || 0), 0) || 1; const out: AnyObj = {}; for (const [k, v] of entries) out[k] = Number((Number(v) / sum).toFixed(6)); return out; }
function cmdPropagate(args: AnyObj) {
  const strict = toBool(args.strict, true); const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  const objectiveId = cleanText(args.objective_id || args.objective || '', 120); const prefix = objectiveId.split('_')[0] || '';
  const mapRow = policy.objective_currency_map[objectiveId] || policy.objective_currency_map[prefix] || policy.objective_currency_map.DEFAULT || {};
  const propagated = normalizeWeights(mapRow);
  const out = { ok: Object.keys(propagated).length > 0, ts: nowIso(), type: 'objective_value_currency_propagation_baseline', strict, objective_id: objectiveId || null, propagated, policy_path: rel(policy.policy_path) };
  writeJsonAtomic(policy.outputs.latest_path, out); appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, objective_id: out.objective_id, currency_count: Object.keys(propagated).length, ok: out.ok }); return out;
}
function cmdStatus(args: AnyObj) { const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); return { ok: true, ts: nowIso(), type: 'objective_value_currency_propagation_baseline_status', latest: readJson(policy.outputs.latest_path, null), policy_path: rel(policy.policy_path) }; }
function main() { const args = parseArgs(process.argv.slice(2)); const cmd = String(args._[0] || 'status').toLowerCase(); const payload = cmd === 'propagate' ? cmdPropagate(args) : cmd === 'status' ? cmdStatus(args) : { ok: false, error: `unknown_command:${cmd}` }; process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); if (payload.ok === false && toBool(args.strict, true)) process.exit(1); if (payload.ok === false) process.exit(1); }
if (require.main === module) { try { main(); } catch (err) { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'objective_value_currency_propagation_baseline_failed', 260) })}\n`); process.exit(1); } }
module.exports = { loadPolicy, cmdPropagate, cmdStatus };
