#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-032
 * Signed startup attestation + integrity check at run boot.
 *
 * Usage:
 *   node systems/security/startup_attestation_boot_gate.js boot-check [--strict=1|0]
 *   node systems/security/startup_attestation_boot_gate.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.STARTUP_ATTEST_BOOT_GATE_ROOT
  ? path.resolve(process.env.STARTUP_ATTEST_BOOT_GATE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.STARTUP_ATTEST_BOOT_GATE_POLICY_PATH
  ? path.resolve(process.env.STARTUP_ATTEST_BOOT_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'startup_attestation_boot_gate_policy.json');

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
function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.trunc(n);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_attestation_age_hours: 24,
    scripts: {
      startup_attestation: 'systems/security/startup_attestation.js',
      integrity_kernel: 'systems/security/integrity_kernel.js'
    },
    outputs: {
      latest_path: 'state/security/startup_attestation_boot_gate/latest.json',
      history_path: 'state/security/startup_attestation_boot_gate/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const scripts = raw.scripts && typeof raw.scripts === 'object' ? raw.scripts : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const startupScript = cleanText(scripts.startup_attestation || base.scripts.startup_attestation, 520) || base.scripts.startup_attestation;
  const integrityScript = cleanText(scripts.integrity_kernel || base.scripts.integrity_kernel, 520) || base.scripts.integrity_kernel;

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    max_attestation_age_hours: clampInt(raw.max_attestation_age_hours, 1, 24 * 365, base.max_attestation_age_hours),
    scripts: {
      startup_attestation: path.isAbsolute(startupScript) ? startupScript : path.join(ROOT, startupScript),
      integrity_kernel: path.isAbsolute(integrityScript) ? integrityScript : path.join(ROOT, integrityScript)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runScript(scriptPath: string, args: string[] = []) {
  const proc = spawnSync(process.execPath, [scriptPath, ...args], { cwd: ROOT, encoding: 'utf8' });
  const stdout = String(proc.stdout || '').trim();
  const stderr = cleanText(proc.stderr, 600);
  let payload = null;
  try { payload = JSON.parse(stdout); } catch {
    const lines = stdout.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { payload = JSON.parse(lines[i]); break; } catch {}
    }
  }
  return {
    ok: proc.status === 0,
    status: Number(proc.status || 0),
    payload,
    stderr
  };
}

function attestationAgeHours(payload: AnyObj) {
  const ts = cleanText(payload && (payload.ts || payload.generated_at || payload.updated_at || payload.attested_at), 64);
  if (!ts) return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return Number(((Date.now() - ms) / (1000 * 60 * 60)).toFixed(6));
}

function cmdBootCheck(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const attestation = runScript(policy.scripts.startup_attestation, ['check', '--strict=1']);
  const integrity = runScript(policy.scripts.integrity_kernel, ['check', '--strict=1']);

  const ageHours = attestationAgeHours(attestation.payload || {});
  const stale = ageHours != null && ageHours > Number(policy.max_attestation_age_hours || 24);

  const blockers: AnyObj[] = [];
  if (!attestation.ok) blockers.push({ gate: 'startup_attestation', reason: 'attestation_check_failed' });
  if (!integrity.ok) blockers.push({ gate: 'integrity_kernel', reason: 'integrity_check_failed' });
  if (stale) blockers.push({ gate: 'attestation_freshness', reason: 'attestation_stale', age_hours: ageHours });

  const out = {
    ok: blockers.length === 0,
    ts: nowIso(),
    type: 'startup_attestation_boot_gate',
    strict,
    ready_for_execute: blockers.length === 0,
    blockers,
    attestation: {
      ok: attestation.ok,
      age_hours: ageHours,
      status: attestation.status,
      stderr: attestation.stderr || null
    },
    integrity: {
      ok: integrity.ok,
      status: integrity.status,
      stderr: integrity.stderr || null
    },
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    ready_for_execute: out.ready_for_execute,
    blocker_count: out.blockers.length,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'startup_attestation_boot_gate_status',
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/startup_attestation_boot_gate.js boot-check [--strict=1|0]');
  console.log('  node systems/security/startup_attestation_boot_gate.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  const payload = cmd === 'boot-check' ? cmdBootCheck(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'startup_attestation_boot_gate_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdBootCheck, cmdStatus };
