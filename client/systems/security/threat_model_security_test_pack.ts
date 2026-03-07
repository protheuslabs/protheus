#!/usr/bin/env node
'use strict';
export {};

/** V1H-004 threat-model-driven security test pack */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
type AnyObj = Record<string, any>;
const ROOT = process.env.THREAT_MODEL_PACK_ROOT ? path.resolve(process.env.THREAT_MODEL_PACK_ROOT) : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.THREAT_MODEL_PACK_POLICY_PATH ? path.resolve(process.env.THREAT_MODEL_PACK_POLICY_PATH) : path.join(ROOT, 'config', 'threat_model_security_test_pack_policy.json');
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
function defaultPolicy() { return { version: '1.0', enabled: true, checks: [{ id: 'startup_attestation_boot_gate', script: 'systems/security/startup_attestation_boot_gate.js', args: ['boot-check', '--strict=1'] }, { id: 'required_checks_policy_guard', script: 'systems/security/required_checks_policy_guard.js', args: ['check', '--strict=1'] }], outputs: { latest_path: 'state/security/threat_model_security_test_pack/latest.json', history_path: 'state/security/threat_model_security_test_pack/history.jsonl' } }; }
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy(); const raw = readJson(policyPath, {}); const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {}; const checksRaw = Array.isArray(raw.checks) ? raw.checks : base.checks;
  const checks = checksRaw.map((c: AnyObj, i: number) => ({ id: cleanText(c && c.id, 120) || `check_${i + 1}`, script: path.isAbsolute(cleanText(c && c.script, 520)) ? cleanText(c && c.script, 520) : path.join(ROOT, cleanText(c && c.script, 520)), args: Array.isArray(c && c.args) ? c.args.map((a: unknown) => cleanText(a, 120)).filter(Boolean) : [] })).filter((c: AnyObj) => c.id && c.script);
  return { version: cleanText(raw.version || base.version, 40) || base.version, enabled: raw.enabled !== false, checks, outputs: { latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path), history_path: resolvePath(outputs.history_path, base.outputs.history_path) }, policy_path: path.resolve(policyPath) };
}
function runOne(check: AnyObj) {
  const proc = spawnSync(process.execPath, [check.script, ...(Array.isArray(check.args) ? check.args : [])], { cwd: ROOT, encoding: 'utf8' });
  return { id: check.id, ok: proc.status === 0, status: Number(proc.status || 0), stderr: cleanText(proc.stderr, 600) || null };
}
function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true); const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  const results = policy.checks.map((c: AnyObj) => runOne(c)); const failed = results.filter((r: AnyObj) => r.ok !== true);
  const out = { ok: failed.length === 0, ts: nowIso(), type: 'threat_model_security_test_pack', strict, checks_run: results.length, failed_checks: failed.map((r: AnyObj) => r.id), results, policy_path: rel(policy.policy_path) };
  writeJsonAtomic(policy.outputs.latest_path, out); appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, checks_run: out.checks_run, failed_checks: out.failed_checks, ok: out.ok }); return out;
}
function cmdStatus(args: AnyObj) { const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); return { ok: true, ts: nowIso(), type: 'threat_model_security_test_pack_status', latest: readJson(policy.outputs.latest_path, null), policy_path: rel(policy.policy_path) }; }
function main() { const args = parseArgs(process.argv.slice(2)); const cmd = String(args._[0] || 'status').toLowerCase(); const payload = cmd === 'run' ? cmdRun(args) : cmd === 'status' ? cmdStatus(args) : { ok: false, error: `unknown_command:${cmd}` }; process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); if (payload.ok === false && toBool(args.strict, true)) process.exit(1); if (payload.ok === false) process.exit(1); }
if (require.main === module) { try { main(); } catch (err) { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'threat_model_security_test_pack_failed', 260) })}\n`); process.exit(1); } }
module.exports = { loadPolicy, cmdRun, cmdStatus };
