#!/usr/bin/env node
'use strict';
export {};

/** V1H-003 observability + SLO + runbook completion pass */
const fs = require('fs');
const path = require('path');
type AnyObj = Record<string, any>;
const ROOT = process.env.OBS_SLO_RUNBOOK_CLOSURE_ROOT ? path.resolve(process.env.OBS_SLO_RUNBOOK_CLOSURE_ROOT) : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.OBS_SLO_RUNBOOK_CLOSURE_POLICY_PATH ? path.resolve(process.env.OBS_SLO_RUNBOOK_CLOSURE_POLICY_PATH) : path.join(ROOT, 'config', 'observability_slo_runbook_closure_policy.json');
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
function defaultPolicy() { return { version: '1.0', enabled: true, inputs: { slo_map_path: 'config/autonomy_slo_runbook_map.json', runbook_path: 'docs/OPERATOR_RUNBOOK.md' }, outputs: { latest_path: 'state/ops/observability_slo_runbook_closure/latest.json', history_path: 'state/ops/observability_slo_runbook_closure/history.jsonl' } }; }
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) { const base = defaultPolicy(); const raw = readJson(policyPath, {}); const inputs = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {}; const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {}; return { version: cleanText(raw.version || base.version, 40) || base.version, enabled: raw.enabled !== false, inputs: { slo_map_path: resolvePath(inputs.slo_map_path, base.inputs.slo_map_path), runbook_path: resolvePath(inputs.runbook_path, base.inputs.runbook_path) }, outputs: { latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path), history_path: resolvePath(outputs.history_path, base.outputs.history_path) }, policy_path: path.resolve(policyPath) }; }
function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true); const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  const map = readJson(policy.inputs.slo_map_path, {}); const runbook = fs.existsSync(policy.inputs.runbook_path) ? fs.readFileSync(policy.inputs.runbook_path, 'utf8') : '';
  const entries = map && typeof map === 'object' ? Object.entries(map) : [];
  const blockers: AnyObj[] = [];
  for (const [slo, runbookHint] of entries) {
    if (!cleanText(runbookHint, 240)) { blockers.push({ gate: 'slo_map', slo, reason: 'missing_runbook_hint' }); continue; }
    if (!runbook.includes(String(runbookHint))) blockers.push({ gate: 'runbook_coverage', slo, reason: 'hint_missing_in_runbook', hint: runbookHint });
  }
  const out = { ok: blockers.length === 0, ts: nowIso(), type: 'observability_slo_runbook_closure_pass', strict, checked_entries: entries.length, blockers, policy_path: rel(policy.policy_path) };
  writeJsonAtomic(policy.outputs.latest_path, out); appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, checked_entries: out.checked_entries, blocker_count: blockers.length, ok: out.ok }); return out;
}
function cmdStatus(args: AnyObj) { const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); return { ok: true, ts: nowIso(), type: 'observability_slo_runbook_closure_pass_status', latest: readJson(policy.outputs.latest_path, null), policy_path: rel(policy.policy_path) }; }
function main() { const args = parseArgs(process.argv.slice(2)); const cmd = String(args._[0] || 'status').toLowerCase(); const payload = cmd === 'run' ? cmdRun(args) : cmd === 'status' ? cmdStatus(args) : { ok: false, error: `unknown_command:${cmd}` }; process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); if (payload.ok === false && toBool(args.strict, true)) process.exit(1); if (payload.ok === false) process.exit(1); }
if (require.main === module) { try { main(); } catch (err) { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'observability_slo_runbook_closure_pass_failed', 260) })}\n`); process.exit(1); } }
module.exports = { loadPolicy, cmdRun, cmdStatus };
