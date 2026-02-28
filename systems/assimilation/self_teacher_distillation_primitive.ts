#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.SELF_TEACHER_DISTILLATION_ROOT
  ? path.resolve(process.env.SELF_TEACHER_DISTILLATION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SELF_TEACHER_DISTILLATION_POLICY_PATH
  ? path.resolve(process.env.SELF_TEACHER_DISTILLATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'self_teacher_distillation_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/self_teacher_distillation_primitive.js run --input-json="{...}" [--policy=<path>] [--apply=1|0]');
  console.log('  node systems/assimilation/self_teacher_distillation_primitive.js status [--policy=<path>] [--capability-id=<id>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function parseJsonArg(raw: unknown, fallback: any = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    schema_id: 'self_teacher_distillation_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    trajectories: {
      min_quality: 0.65,
      max_samples: 60,
      success_bonus: 0.08
    },
    distillation: {
      learning_rate: 0.18,
      apply_gain_cap: 0.3,
      acceptance_threshold: 0.66
    },
    state: {
      ledger_path: 'state/assimilation/self_teacher_distillation/ledger.json',
      latest_path: 'state/assimilation/self_teacher_distillation/latest.json',
      receipts_path: 'state/assimilation/self_teacher_distillation/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const trajectories = raw.trajectories && typeof raw.trajectories === 'object' ? raw.trajectories : {};
  const distillation = raw.distillation && typeof raw.distillation === 'object' ? raw.distillation : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    trajectories: {
      min_quality: clampNumber(trajectories.min_quality, 0, 1, base.trajectories.min_quality),
      max_samples: clampInt(trajectories.max_samples, 1, 20000, base.trajectories.max_samples),
      success_bonus: clampNumber(trajectories.success_bonus, 0, 1, base.trajectories.success_bonus)
    },
    distillation: {
      learning_rate: clampNumber(distillation.learning_rate, 0, 1, base.distillation.learning_rate),
      apply_gain_cap: clampNumber(distillation.apply_gain_cap, 0, 1, base.distillation.apply_gain_cap),
      acceptance_threshold: clampNumber(
        distillation.acceptance_threshold,
        0,
        1,
        base.distillation.acceptance_threshold
      )
    },
    state: {
      ledger_path: resolvePath(state.ledger_path || base.state.ledger_path, base.state.ledger_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadLedger(filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      schema_id: 'self_teacher_distillation_ledger',
      schema_version: '1.0',
      updated_at: null,
      capabilities: {}
    };
  }
  return {
    schema_id: 'self_teacher_distillation_ledger',
    schema_version: '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    capabilities: payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {}
  };
}

function runSelfTeacherDistillation(inputRaw: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'self_teacher_distillation_primitive',
      error: 'policy_disabled'
    };
  }

  const ts = nowIso();
  const apply = toBool(opts.apply, false);
  const capabilityId = normalizeToken(inputRaw.capability_id || '', 160) || 'unknown_capability';

  const trajectories = (Array.isArray(inputRaw.trajectories) ? inputRaw.trajectories : [])
    .slice(0, Number(policy.trajectories.max_samples || 60))
    .map((row: AnyObj, idx: number) => ({
      trajectory_id: normalizeToken(row && row.trajectory_id || `traj_${idx + 1}`, 160),
      quality: clampNumber(row && row.quality, 0, 1, 0.5),
      outcome: normalizeToken(row && row.outcome || 'unknown', 60),
      steps: clampInt(row && row.steps, 1, 1000000, 12)
    }))
    .filter((row: AnyObj) => row.trajectory_id);

  const golden = trajectories.filter((row: AnyObj) => {
    if (row.quality < Number(policy.trajectories.min_quality || 0.65)) return false;
    if (row.outcome === 'reject' || row.outcome === 'fail') return false;
    return true;
  });

  const teacherSignal = golden.length
    ? (golden.reduce((acc: number, row: AnyObj) => {
      const bonus = row.outcome === 'success' ? Number(policy.trajectories.success_bonus || 0) : 0;
      return acc + row.quality + bonus;
    }, 0) / golden.length)
    : 0;

  const ledger = loadLedger(policy.state.ledger_path);
  const prev = ledger.capabilities[capabilityId] && typeof ledger.capabilities[capabilityId] === 'object'
    ? ledger.capabilities[capabilityId]
    : {
      student_score: 0.5,
      updates: 0,
      last_gain: 0,
      updated_at: null
    };

  const studentScorePrev = clampNumber(prev.student_score, 0, 1, 0.5);
  const rawGain = (teacherSignal - studentScorePrev) * Number(policy.distillation.learning_rate || 0.18);
  const candidateGain = clampNumber(rawGain, -1, Number(policy.distillation.apply_gain_cap || 0.3), 0);
  const studentScoreNext = clampNumber(studentScorePrev + candidateGain, 0, 1, studentScorePrev);

  ledger.capabilities[capabilityId] = {
    student_score: studentScoreNext,
    updates: clampInt(prev.updates, 0, 1000000000, 0) + 1,
    last_gain: candidateGain,
    golden_count: golden.length,
    updated_at: ts
  };
  ledger.updated_at = ts;

  const accepted = teacherSignal >= Number(policy.distillation.acceptance_threshold || 0.66)
    && candidateGain > 0;

  const out = {
    ok: true,
    type: 'self_teacher_distillation_primitive',
    ts,
    shadow_only: policy.shadow_only === true,
    apply_requested: apply,
    capability_id: capabilityId,
    trajectory_count: trajectories.length,
    golden_count: golden.length,
    teacher_signal: Number(teacherSignal.toFixed(6)),
    student_score_before: Number(studentScorePrev.toFixed(6)),
    student_score_after: Number(studentScoreNext.toFixed(6)),
    candidate_gain: Number(candidateGain.toFixed(6)),
    accepted,
    golden_trajectory_ids: golden.slice(0, 12).map((row: AnyObj) => row.trajectory_id),
    state_path: rel(policy.state.ledger_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.state.ledger_path, ledger);
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function commandRun(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.SELF_TEACHER_DISTILLATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const input = parseJsonArg(args['input-json'] || args.input_json, {});
  return runSelfTeacherDistillation(input, {
    policyPath,
    apply: toBool(args.apply, false)
  });
}

function commandStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.SELF_TEACHER_DISTILLATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const ledger = loadLedger(policy.state.ledger_path);
  const latest = readJson(policy.state.latest_path, null);
  const capabilityId = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  return {
    ok: true,
    type: 'self_teacher_distillation_status',
    ts: nowIso(),
    tracked_capabilities: Object.keys(ledger.capabilities || {}).length,
    capability_id: capabilityId || null,
    snapshot: capabilityId ? (ledger.capabilities[capabilityId] || null) : null,
    latest: latest && typeof latest === 'object'
      ? {
        capability_id: latest.capability_id || null,
        accepted: !!latest.accepted,
        candidate_gain: latest.candidate_gain || null
      }
      : null,
    state_path: rel(policy.state.ledger_path),
    policy_path: rel(policy.policy_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  try {
    let out: AnyObj;
    if (cmd === 'run') out = commandRun(args);
    else if (cmd === 'status') out = commandStatus(args);
    else if (!cmd || cmd === '--help' || cmd === 'help') {
      usage();
      process.exit(0);
      return;
    } else {
      throw new Error(`unknown_command:${cmd}`);
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'self_teacher_distillation_primitive',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'run_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  runSelfTeacherDistillation,
  commandRun,
  commandStatus,
  loadPolicy
};
