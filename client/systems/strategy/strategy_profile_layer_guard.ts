#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-012
 * Strategy profile loader + architecture genericity guard.
 *
 * Usage:
 *   node systems/strategy/strategy_profile_layer_guard.js check [--strict=1|0] [--audit=1|0]
 *   node systems/strategy/strategy_profile_layer_guard.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.STRATEGY_PROFILE_LAYER_ROOT
  ? path.resolve(process.env.STRATEGY_PROFILE_LAYER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.STRATEGY_PROFILE_LAYER_POLICY_PATH
  ? path.resolve(process.env.STRATEGY_PROFILE_LAYER_POLICY_PATH)
  : path.join(ROOT, 'config', 'strategy_profile_layer_policy.json');

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
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try { if (!fs.existsSync(filePath)) return fallback; const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return parsed == null ? fallback : parsed; } catch { return fallback; }
}
function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw, 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) { const s = cleanText(item, 120).toLowerCase(); if (!s) continue; if (!out.includes(s)) out.push(s); }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    active_profile_path: 'config/strategies/active_profile.json',
    profiles_dir: 'config/strategies',
    guard: {
      enabled: true,
      scan_root: 'systems',
      file_extensions: ['.ts', '.js'],
      skip_tokens: ['/tests/'],
      forbidden_profile_tokens: ['drop-shipping', 'ecommerce_only', 'affiliate_only']
    },
    outputs: {
      latest_path: 'state/strategy/profile_layer/latest.json',
      history_path: 'state/strategy/profile_layer/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const guard = raw.guard && typeof raw.guard === 'object' ? raw.guard : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    active_profile_path: resolvePath(raw.active_profile_path, base.active_profile_path),
    profiles_dir: resolvePath(raw.profiles_dir, base.profiles_dir),
    guard: {
      enabled: guard.enabled !== false,
      scan_root: resolvePath(guard.scan_root, base.guard.scan_root),
      file_extensions: asStringArray(guard.file_extensions || base.guard.file_extensions),
      skip_tokens: asStringArray(guard.skip_tokens || base.guard.skip_tokens),
      forbidden_profile_tokens: asStringArray(guard.forbidden_profile_tokens || base.guard.forbidden_profile_tokens)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadActiveProfile(policy: AnyObj) {
  const marker = readJson(policy.active_profile_path, { active_profile: 'default', execution_policy: { mode: 'score_only' } });
  const profileId = cleanText(marker && marker.active_profile, 80) || 'default';
  const profilePath = path.join(policy.profiles_dir, `${profileId}.json`);
  const profile = readJson(profilePath, { id: profileId, execution_policy: { mode: 'score_only' } });
  const mode = cleanText(profile && profile.execution_policy && profile.execution_policy.mode, 60).toLowerCase() || 'score_only';
  return {
    id: profileId,
    path: profilePath,
    profile,
    execution_mode: mode || 'score_only'
  };
}

function walkFiles(absRoot: string, out: string[] = []) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(absRoot, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const full = path.join(absRoot, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function checkGenericity(policy: AnyObj) {
  if (!policy.guard.enabled) return { ok: true, violations: [], scanned_count: 0 };
  const files = walkFiles(policy.guard.scan_root)
    .filter((f) => policy.guard.file_extensions.includes(path.extname(f).toLowerCase()))
    .filter((f) => {
      const r = rel(f).toLowerCase();
      return !(policy.guard.skip_tokens || []).some((tok: string) => r.includes(tok));
    });

  const violations: AnyObj[] = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8').toLowerCase(); } catch { continue; }
    for (const tok of policy.guard.forbidden_profile_tokens || []) {
      if (!tok) continue;
      if (text.includes(tok)) {
        violations.push({ file: rel(file), token: tok });
      }
    }
  }
  return {
    ok: violations.length === 0,
    scanned_count: files.length,
    violations
  };
}

function cmdCheck(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const audit = toBool(args.audit, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, audit, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const active = loadActiveProfile(policy);
  const genericity = checkGenericity(policy);
  const blockers: AnyObj[] = [];
  if (!genericity.ok) blockers.push({ gate: 'architecture_genericity_guard', reason: 'forbidden_strategy_tokens_in_systems', violations: genericity.violations.slice(0, 20) });

  const out = {
    ok: blockers.length === 0,
    ts: nowIso(),
    type: 'strategy_profile_layer_guard',
    strict,
    audit,
    active_profile: {
      id: active.id,
      path: rel(active.path),
      execution_mode: active.execution_mode
    },
    genericity,
    blockers,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    active_profile_id: out.active_profile.id,
    execution_mode: out.active_profile.execution_mode,
    violation_count: genericity.violations.length,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const active = loadActiveProfile(policy);
  return {
    ok: true,
    ts: nowIso(),
    type: 'strategy_profile_layer_guard_status',
    active_profile: {
      id: active.id,
      path: rel(active.path),
      execution_mode: active.execution_mode
    },
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/strategy/strategy_profile_layer_guard.js check [--strict=1|0] [--audit=1|0]');
  console.log('  node systems/strategy/strategy_profile_layer_guard.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  try {
    const payload = cmd === 'check' ? cmdCheck(args)
      : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'strategy_profile_layer_guard_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { loadPolicy, loadActiveProfile, checkGenericity, cmdCheck, cmdStatus };
