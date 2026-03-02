#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-005
 * Habit promotion quality hardening: require measured savings/effect thresholds.
 *
 * Usage:
 *   node systems/habits/habit_promotion_quality_gate.js evaluate --candidate-json="{...}" [--strict=1|0]
 *   node systems/habits/habit_promotion_quality_gate.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.HABIT_PROMOTION_QUALITY_ROOT
  ? path.resolve(process.env.HABIT_PROMOTION_QUALITY_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.HABIT_PROMOTION_QUALITY_POLICY_PATH
  ? path.resolve(process.env.HABIT_PROMOTION_QUALITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'habit_promotion_quality_policy.json');

function nowIso() { return new Date().toISOString(); }

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
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

function parseJsonArg(raw: unknown, fallback: any = null) {
  const txt = cleanText(raw, 20_000);
  if (!txt) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    thresholds: {
      min_sample_count: 5,
      min_time_saved_minutes_per_week: 45,
      min_effect_delta: 0.08,
      min_adoption_rate: 0.6
    },
    outputs: {
      latest_path: 'state/habits/habit_promotion_quality/latest.json',
      history_path: 'state/habits/habit_promotion_quality/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    thresholds: {
      min_sample_count: Math.max(1, Number(thresholds.min_sample_count || base.thresholds.min_sample_count)),
      min_time_saved_minutes_per_week: Math.max(0, Number(thresholds.min_time_saved_minutes_per_week || base.thresholds.min_time_saved_minutes_per_week)),
      min_effect_delta: clampNumber(thresholds.min_effect_delta, -1, 1, base.thresholds.min_effect_delta),
      min_adoption_rate: clampNumber(thresholds.min_adoption_rate, 0, 1, base.thresholds.min_adoption_rate)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function evaluateCandidate(candidate: AnyObj, policy: AnyObj) {
  const id = cleanText(candidate.id || candidate.habit_id || 'unknown_candidate', 80) || 'unknown_candidate';
  const sampleCount = Math.max(0, Number(candidate.sample_count || 0));
  const baselineMinutes = Math.max(0, Number(candidate.baseline_minutes_per_week || candidate.baseline_minutes || 0));
  const currentMinutes = Math.max(0, Number(candidate.current_minutes_per_week || candidate.current_minutes || 0));
  const beforeRate = clampNumber(candidate.effect_before || candidate.success_rate_before || 0, 0, 1, 0);
  const afterRate = clampNumber(candidate.effect_after || candidate.success_rate_after || 0, 0, 1, 0);
  const adoption = clampNumber(candidate.adoption_rate || 0, 0, 1, 0);

  const timeSaved = Math.max(0, baselineMinutes - currentMinutes);
  const effectDelta = afterRate - beforeRate;

  const reasons: string[] = [];
  if (sampleCount < Number(policy.thresholds.min_sample_count || 0)) reasons.push('insufficient_sample_count');
  if (timeSaved < Number(policy.thresholds.min_time_saved_minutes_per_week || 0)) reasons.push('time_saved_below_threshold');
  if (effectDelta < Number(policy.thresholds.min_effect_delta || 0)) reasons.push('effect_delta_below_threshold');
  if (adoption < Number(policy.thresholds.min_adoption_rate || 0)) reasons.push('adoption_rate_below_threshold');

  return {
    id,
    sample_count: sampleCount,
    baseline_minutes_per_week: baselineMinutes,
    current_minutes_per_week: currentMinutes,
    time_saved_minutes_per_week: Number(timeSaved.toFixed(4)),
    effect_before: Number(beforeRate.toFixed(4)),
    effect_after: Number(afterRate.toFixed(4)),
    effect_delta: Number(effectDelta.toFixed(4)),
    adoption_rate: Number(adoption.toFixed(4)),
    thresholds: policy.thresholds,
    reasons,
    pass: reasons.length === 0
  };
}

function cmdEvaluate(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) {
    return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };
  }
  const candidate = parseJsonArg(args['candidate-json'] || args.candidate_json || '', {});
  const evaluation = evaluateCandidate(candidate && typeof candidate === 'object' ? candidate : {}, policy);
  const out = {
    ok: evaluation.pass,
    ts: nowIso(),
    type: 'habit_promotion_quality_gate',
    strict,
    evaluation,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    candidate_id: evaluation.id,
    pass: evaluation.pass,
    reasons: evaluation.reasons,
    time_saved_minutes_per_week: evaluation.time_saved_minutes_per_week,
    effect_delta: evaluation.effect_delta,
    adoption_rate: evaluation.adoption_rate
  });
  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'habit_promotion_quality_gate_status',
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/habits/habit_promotion_quality_gate.js evaluate --candidate-json="{...}" [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/habits/habit_promotion_quality_gate.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'evaluate').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  try {
    const payload = cmd === 'evaluate'
      ? cmdEvaluate(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'habit_promotion_quality_gate_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  evaluateCandidate,
  cmdEvaluate,
  cmdStatus
};
