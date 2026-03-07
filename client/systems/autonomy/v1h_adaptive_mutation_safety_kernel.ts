#!/usr/bin/env node
'use strict';
export {};

/** V1H-006 baseline adaptive-mutation safety kernel */
const fs = require('fs');
const path = require('path');
type AnyObj = Record<string, any>;
const ROOT = process.env.V1H_MUTATION_KERNEL_ROOT ? path.resolve(process.env.V1H_MUTATION_KERNEL_ROOT) : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.V1H_MUTATION_KERNEL_POLICY_PATH ? path.resolve(process.env.V1H_MUTATION_KERNEL_POLICY_PATH) : path.join(ROOT, 'config', 'v1h_adaptive_mutation_safety_kernel_policy.json');
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
function defaultPolicy() { return { version: '1.0', enabled: true, allowed_risks: ['low', 'medium'], max_mutations_per_day: 5, outputs: { state_path: 'state/autonomy/v1h_adaptive_mutation_safety_kernel/state.json', latest_path: 'state/autonomy/v1h_adaptive_mutation_safety_kernel/latest.json', history_path: 'state/autonomy/v1h_adaptive_mutation_safety_kernel/history.jsonl' } }; }
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) { const base = defaultPolicy(); const raw = readJson(policyPath, {}); const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {}; const allowed = Array.isArray(raw.allowed_risks) ? raw.allowed_risks.map((x: unknown) => cleanText(x, 40).toLowerCase()).filter(Boolean) : base.allowed_risks; return { version: cleanText(raw.version || base.version, 40) || base.version, enabled: raw.enabled !== false, allowed_risks: Array.from(new Set(allowed)), max_mutations_per_day: clampInt(raw.max_mutations_per_day, 1, 100000, base.max_mutations_per_day), outputs: { state_path: resolvePath(outputs.state_path, base.outputs.state_path), latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path), history_path: resolvePath(outputs.history_path, base.outputs.history_path) }, policy_path: path.resolve(policyPath) }; }
function loadState(statePath: string) { const raw = readJson(statePath, { by_day: {} }); return { by_day: raw && raw.by_day && typeof raw.by_day === 'object' ? raw.by_day : {} }; }
function cmdGate(args: AnyObj) {
  const strict = toBool(args.strict, true); const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  const risk = cleanText(args.risk || 'low', 40).toLowerCase(); const date = cleanText(args.date, 20) || nowIso().slice(0, 10); const state = loadState(policy.outputs.state_path);
  const used = clampInt(state.by_day[date], 0, 1000000, 0); const blockers: AnyObj[] = [];
  if (!policy.allowed_risks.includes(risk)) blockers.push({ gate: 'risk', reason: 'risk_not_allowed', risk });
  if (used >= Number(policy.max_mutations_per_day || 0)) blockers.push({ gate: 'daily_cap', reason: 'max_mutations_exceeded', used, cap: policy.max_mutations_per_day });
  if (blockers.length === 0) { state.by_day[date] = used + 1; writeJsonAtomic(policy.outputs.state_path, state); }
  const out = { ok: blockers.length === 0, ts: nowIso(), type: 'v1h_adaptive_mutation_safety_kernel', strict, risk, date, used_before: used, used_after: blockers.length === 0 ? used + 1 : used, blockers, policy_path: rel(policy.policy_path) };
  writeJsonAtomic(policy.outputs.latest_path, out); appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, date, risk, blockers: blockers.map((b: AnyObj) => b.gate), ok: out.ok }); return out;
}
function cmdStatus(args: AnyObj) { const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); return { ok: true, ts: nowIso(), type: 'v1h_adaptive_mutation_safety_kernel_status', latest: readJson(policy.outputs.latest_path, null), policy_path: rel(policy.policy_path) }; }
function main() { const args = parseArgs(process.argv.slice(2)); const cmd = String(args._[0] || 'status').toLowerCase(); const payload = cmd === 'gate' ? cmdGate(args) : cmd === 'status' ? cmdStatus(args) : { ok: false, error: `unknown_command:${cmd}` }; process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); if (payload.ok === false && toBool(args.strict, true)) process.exit(1); if (payload.ok === false) process.exit(1); }
if (require.main === module) { try { main(); } catch (err) { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'v1h_adaptive_mutation_safety_kernel_failed', 260) })}\n`); process.exit(1); } }
module.exports = { loadPolicy, cmdGate, cmdStatus };
