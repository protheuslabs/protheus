#!/usr/bin/env node
'use strict';
export {};

/** V1H-008 read-only recursive introspection baseline */
const fs = require('fs');
const path = require('path');
type AnyObj = Record<string, any>;
const ROOT = process.env.RECURSIVE_INTROSPECTION_BASELINE_ROOT ? path.resolve(process.env.RECURSIVE_INTROSPECTION_BASELINE_ROOT) : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.RECURSIVE_INTROSPECTION_BASELINE_POLICY_PATH ? path.resolve(process.env.RECURSIVE_INTROSPECTION_BASELINE_POLICY_PATH) : path.join(ROOT, 'config', 'recursive_introspection_baseline_readonly_policy.json');
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
function defaultPolicy() { return { version: '1.0', enabled: true, readonly: true, inputs: ['state/autonomy', 'state/sensory', 'state/routing'], outputs: { latest_path: 'state/autonomy/recursive_introspection_baseline_readonly/latest.json', history_path: 'state/autonomy/recursive_introspection_baseline_readonly/history.jsonl' } }; }
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) { const base = defaultPolicy(); const raw = readJson(policyPath, {}); const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {}; const inputs = Array.isArray(raw.inputs) ? raw.inputs.map((x: unknown) => cleanText(x, 520)).filter(Boolean) : base.inputs; return { version: cleanText(raw.version || base.version, 40) || base.version, enabled: raw.enabled !== false, readonly: raw.readonly !== false, inputs, outputs: { latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path), history_path: resolvePath(outputs.history_path, base.outputs.history_path) }, policy_path: path.resolve(policyPath) }; }
function scanPath(abs: string) {
  if (!fs.existsSync(abs)) return { path: abs, files: 0, bytes: 0 };
  const stack = [abs]; let files = 0; let bytes = 0;
  while (stack.length) {
    const cur = String(stack.pop() || '');
    let st = null; try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()) { try { for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name)); } catch {} continue; }
    if (st.isFile()) { files += 1; bytes += Number(st.size || 0); }
  }
  return { path: abs, files, bytes };
}
function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true); const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  const scans = policy.inputs.map((p: string) => { const abs = resolvePath(p, p); const s = scanPath(abs); return { path: rel(abs), files: s.files, bytes: s.bytes }; });
  const totalFiles = scans.reduce((s: number, r: AnyObj) => s + Number(r.files || 0), 0);
  const totalBytes = scans.reduce((s: number, r: AnyObj) => s + Number(r.bytes || 0), 0);
  const out = { ok: true, ts: nowIso(), type: 'recursive_introspection_baseline_readonly', strict, readonly: policy.readonly === true, summary: { scanned_paths: scans.length, total_files: totalFiles, total_bytes: totalBytes }, scans, policy_path: rel(policy.policy_path) };
  writeJsonAtomic(policy.outputs.latest_path, out); appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, total_files: totalFiles, total_bytes: totalBytes, ok: true }); return out;
}
function cmdStatus(args: AnyObj) { const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH); return { ok: true, ts: nowIso(), type: 'recursive_introspection_baseline_readonly_status', latest: readJson(policy.outputs.latest_path, null), policy_path: rel(policy.policy_path) }; }
function main() { const args = parseArgs(process.argv.slice(2)); const cmd = String(args._[0] || 'status').toLowerCase(); const payload = cmd === 'run' ? cmdRun(args) : cmd === 'status' ? cmdStatus(args) : { ok: false, error: `unknown_command:${cmd}` }; process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); if (payload.ok === false && toBool(args.strict, true)) process.exit(1); if (payload.ok === false) process.exit(1); }
if (require.main === module) { try { main(); } catch (err) { process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'recursive_introspection_baseline_readonly_failed', 260) })}\n`); process.exit(1); } }
module.exports = { loadPolicy, cmdRun, cmdStatus };
