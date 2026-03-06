#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DOCTOR_FORGE_MICRO_DEBUG_POLICY_PATH
  ? path.resolve(process.env.DOCTOR_FORGE_MICRO_DEBUG_POLICY_PATH)
  : path.join(ROOT, 'config', 'doctor_forge_micro_debug_policy.json');
const ITERATIVE_REPAIR_SCRIPT = path.join(ROOT, 'systems', 'primitives', 'iterative_repair_primitive.js');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 260) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 160) {
  return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}
function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function relPath(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2); const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    rollout_mode: 'shadow',
    allow_apply_modes: ['live'],
    max_risk_score: 0.35,
    receipts_path: 'state/autonomy/doctor_forge_micro_debug/receipts.jsonl',
    latest_path: 'state/autonomy/doctor_forge_micro_debug/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    rollout_mode: normalizeToken(src.rollout_mode || base.rollout_mode, 40) || base.rollout_mode,
    allow_apply_modes: Array.isArray(src.allow_apply_modes)
      ? src.allow_apply_modes.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)
      : base.allow_apply_modes.slice(0),
    max_risk_score: Number(src.max_risk_score != null ? src.max_risk_score : base.max_risk_score) || base.max_risk_score,
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function runLane(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'doctor_forge_micro_debug_run', error: 'policy_disabled' };

  const targetPath = cleanText(args['target-path'] || args.target_path || '', 520);
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 180) || null;
  const riskScore = Math.max(0, Math.min(1, Number(args['risk-score'] || args.risk_score || 0.1) || 0.1));
  const requestedApply = toBool(args.apply, false);
  const applyAllowedByMode = policy.allow_apply_modes.includes(policy.rollout_mode);
  const apply = requestedApply && applyAllowedByMode;

  if (!targetPath) return { ok: false, type: 'doctor_forge_micro_debug_run', error: 'target_path_required' };
  if (riskScore > Number(policy.max_risk_score || 0.35)) {
    return {
      ok: false,
      type: 'doctor_forge_micro_debug_run',
      error: 'risk_score_exceeds_policy',
      risk_score: riskScore,
      max_risk_score: Number(policy.max_risk_score || 0.35)
    };
  }

  const child = spawnSync(
    process.execPath,
    [
      ITERATIVE_REPAIR_SCRIPT,
      'run',
      `--target-path=${targetPath}`,
      objectiveId ? `--objective-id=${objectiveId}` : '--objective-id=doctor_forge_micro_debug',
      '--iterations=3',
      apply ? '--apply=1' : '--apply=0'
    ],
    {
      cwd: ROOT,
      encoding: 'utf8'
    }
  );

  let repair = null;
  const stdout = String(child.stdout || '').trim();
  if (stdout) {
    try { repair = JSON.parse(stdout); } catch {
      const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { repair = JSON.parse(lines[i]); break; } catch {}
      }
    }
  }

  const out = {
    ok: child.status === 0 && repair && repair.ok === true,
    type: 'doctor_forge_micro_debug_run',
    ts: nowIso(),
    rollout_mode: policy.rollout_mode,
    apply_requested: requestedApply,
    apply_effective: apply,
    target_path: targetPath,
    objective_id: objectiveId,
    risk_score: riskScore,
    repair: repair || null,
    child_status: Number(child.status || 0),
    child_stderr: cleanText(child.stderr || '', 600),
    receipts_path: relPath(policy.receipts_path)
  };

  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const receiptsCount = fs.existsSync(policy.receipts_path)
    ? String(fs.readFileSync(policy.receipts_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'doctor_forge_micro_debug_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      rollout_mode: policy.rollout_mode,
      max_risk_score: policy.max_risk_score
    },
    receipts_count: receiptsCount,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        ok: latest.ok === true,
        target_path: latest.target_path || null,
        apply_effective: latest.apply_effective === true
      }
      : null,
    paths: {
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/doctor_forge_micro_debug_lane.js run --target-path=<path> [--objective-id=<id>] [--risk-score=0.2] [--apply=0|1]');
  console.log('  node systems/autonomy/doctor_forge_micro_debug_lane.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') out = runLane(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'doctor_forge_micro_debug', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runLane,
  status
};
