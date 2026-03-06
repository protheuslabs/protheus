#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-015
 * Optional reflex sub-layer under habits for fast micro-routines.
 *
 * Usage:
 *   node systems/reflex/reflex_micro_routine_layer.js route --task="..." [--confidence=<0..1>] [--latency-ms=<n>] [--strict=1|0]
 *   node systems/reflex/reflex_micro_routine_layer.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.REFLEX_MICRO_LAYER_ROOT
  ? path.resolve(process.env.REFLEX_MICRO_LAYER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.REFLEX_MICRO_LAYER_POLICY_PATH
  ? path.resolve(process.env.REFLEX_MICRO_LAYER_POLICY_PATH)
  : path.join(ROOT, 'config', 'reflex_micro_routine_policy.json');

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
function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    route: {
      min_confidence_for_reflex: 0.78,
      max_latency_ms_for_reflex: 900,
      reflex_allowed_task_tokens: ['triage', 'lint', 'status', 'summary', 'check']
    },
    outputs: {
      latest_path: 'state/reflex/micro_routine_layer/latest.json',
      history_path: 'state/reflex/micro_routine_layer/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const route = raw.route && typeof raw.route === 'object' ? raw.route : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const tokens = Array.isArray(route.reflex_allowed_task_tokens)
    ? route.reflex_allowed_task_tokens.map((x: unknown) => cleanText(x, 40).toLowerCase()).filter(Boolean)
    : base.route.reflex_allowed_task_tokens;
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    route: {
      min_confidence_for_reflex: clampNumber(route.min_confidence_for_reflex, 0, 1, base.route.min_confidence_for_reflex),
      max_latency_ms_for_reflex: Math.max(1, Number(route.max_latency_ms_for_reflex || base.route.max_latency_ms_for_reflex)),
      reflex_allowed_task_tokens: Array.from(new Set(tokens))
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function taskAllowedForReflex(task: string, policy: AnyObj) {
  const lower = cleanText(task, 1000).toLowerCase();
  return (policy.route.reflex_allowed_task_tokens || []).some((tok: string) => tok && lower.includes(tok));
}

function cmdRoute(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const task = cleanText(args.task || '', 2000);
  const confidence = clampNumber(args.confidence, 0, 1, 0);
  const latencyMs = Math.max(0, Number(args['latency-ms'] || args.latency_ms || 0));

  const gate = {
    task_allowed: taskAllowedForReflex(task, policy),
    confidence_ok: confidence >= Number(policy.route.min_confidence_for_reflex || 0),
    latency_ok: latencyMs <= Number(policy.route.max_latency_ms_for_reflex || 0)
  };

  const preferReflex = gate.task_allowed && gate.confidence_ok && gate.latency_ok;
  const route = preferReflex ? 'reflex' : 'habit';
  const reason = preferReflex
    ? 'reflex_lane_selected'
    : !gate.task_allowed
      ? 'task_not_reflex_eligible'
      : !gate.confidence_ok
        ? 'confidence_below_reflex_threshold'
        : 'latency_budget_exceeded';

  const out = {
    ok: !!task || route === 'habit',
    ts: nowIso(),
    type: 'reflex_micro_routine_layer',
    strict,
    task,
    confidence: Number(confidence.toFixed(4)),
    latency_ms: latencyMs,
    route,
    reason,
    gate,
    thresholds: {
      min_confidence_for_reflex: Number(policy.route.min_confidence_for_reflex || 0),
      max_latency_ms_for_reflex: Number(policy.route.max_latency_ms_for_reflex || 0)
    },
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    route,
    reason,
    confidence: out.confidence,
    latency_ms: latencyMs,
    gate,
    ok: out.ok
  });

  if (!out.ok && strict) return { ...out, error: 'missing_task' };
  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'reflex_micro_routine_layer_status',
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/reflex/reflex_micro_routine_layer.js route --task="..." [--confidence=<0..1>] [--latency-ms=<n>] [--strict=1|0]');
  console.log('  node systems/reflex/reflex_micro_routine_layer.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'route').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  try {
    const payload = cmd === 'route' ? cmdRoute(args)
      : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'reflex_micro_routine_layer_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { loadPolicy, taskAllowedForReflex, cmdRoute, cmdStatus };
