#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.TRAJECTORY_SKILL_DISTILLER_POLICY_PATH
  ? path.resolve(process.env.TRAJECTORY_SKILL_DISTILLER_POLICY_PATH)
  : path.join(ROOT, 'config', 'trajectory_skill_distiller_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 280) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 180) { return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
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
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw || '', 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    distill_min_steps: 3,
    output_root: 'state/assimilation/distilled_skill_profiles',
    receipts_path: 'state/assimilation/trajectory_skill_distiller/receipts.jsonl',
    latest_path: 'state/assimilation/trajectory_skill_distiller/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    shadow_only: src.shadow_only !== false,
    distill_min_steps: Number(src.distill_min_steps != null ? src.distill_min_steps : base.distill_min_steps) || base.distill_min_steps,
    output_root: resolvePath(src.output_root || base.output_root, base.output_root),
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function parseTrajectory(raw: string) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

function distill(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'trajectory_skill_distill', error: 'policy_disabled' };

  const trajectoryRaw = cleanText(args['trajectory-json'] || args.trajectory_json || '', 2000000);
  const trajectory = parseTrajectory(trajectoryRaw);
  if (!trajectory.length) {
    return { ok: false, type: 'trajectory_skill_distill', error: 'trajectory_required' };
  }
  if (trajectory.length < Number(policy.distill_min_steps || 3)) {
    return {
      ok: false,
      type: 'trajectory_skill_distill',
      error: 'trajectory_too_short',
      min_steps: Number(policy.distill_min_steps || 3),
      actual_steps: trajectory.length
    };
  }

  const profileId = normalizeToken(args['profile-id'] || args.profile_id || `distilled_${Date.now()}`, 180);
  const successCount = trajectory.filter((row: AnyObj) => row && row.ok === true).length;
  const failureCount = trajectory.length - successCount;
  const profile = {
    schema_id: 'distilled_skill_profile',
    schema_version: '1.0',
    profile_id: profileId,
    generated_at: nowIso(),
    source: 'trajectory_skill_distiller',
    summary: {
      steps: trajectory.length,
      success_count: successCount,
      failure_count: failureCount,
      success_rate: Number((successCount / Math.max(1, trajectory.length)).toFixed(4))
    },
    reusable_checks: [
      'preconditions',
      'rollback_path',
      'post_verify'
    ],
    compact_profile: {
      dominant_actions: trajectory.slice(0, 10).map((row: AnyObj) => normalizeToken(row && (row.action || row.step || row.opcode || 'action'), 80)),
      failure_patterns: trajectory.filter((row: AnyObj) => row && row.ok === false).slice(0, 5)
    }
  };

  const outPath = path.join(policy.output_root, `${profileId}.json`);
  writeJsonAtomic(outPath, profile);

  const out = {
    ok: true,
    type: 'trajectory_skill_distill',
    ts: nowIso(),
    profile_id: profileId,
    output_path: relPath(outPath),
    shadow_only: policy.shadow_only === true,
    summary: profile.summary
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const profiles = fs.existsSync(policy.output_root)
    ? fs.readdirSync(policy.output_root).filter((row: string) => row.endsWith('.json')).length
    : 0;
  return {
    ok: true,
    type: 'trajectory_skill_distill_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only === true,
      distill_min_steps: policy.distill_min_steps
    },
    distilled_profiles: profiles,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        profile_id: latest.profile_id || null,
        output_path: latest.output_path || null
      }
      : null,
    paths: {
      output_root: relPath(policy.output_root),
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/trajectory_skill_distiller.js distill --trajectory-json=<json_array> [--profile-id=<id>]');
  console.log('  node systems/assimilation/trajectory_skill_distiller.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) { usage(); process.exit(0); }
  if (cmd === 'distill') out = distill(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'trajectory_skill_distiller', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  distill,
  status
};
