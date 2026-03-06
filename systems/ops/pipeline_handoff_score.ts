#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-021
 * Deterministic scorecard for pipeline handoff integration outputs.
 *
 * Usage:
 *   node systems/ops/pipeline_handoff_score.js score --queue-log=<jsonl> --receipt-log=<jsonl> [--strict=1|0]
 *   node systems/ops/pipeline_handoff_score.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.PIPELINE_HANDOFF_SCORE_ROOT
  ? path.resolve(process.env.PIPELINE_HANDOFF_SCORE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.PIPELINE_HANDOFF_SCORE_POLICY_PATH
  ? path.resolve(process.env.PIPELINE_HANDOFF_SCORE_POLICY_PATH)
  : path.join(ROOT, 'config', 'pipeline_handoff_score_policy.json');

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
function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
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
    thresholds: {
      min_score: 0.6
    },
    weights: {
      generation: 0.2,
      queue_quality: 0.2,
      execution: 0.3,
      verification: 0.3
    },
    outputs: {
      latest_path: 'state/ops/pipeline_handoff_score/latest.json',
      history_path: 'state/ops/pipeline_handoff_score/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const weights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};

  const normWeights = {
    generation: clampNumber(weights.generation, 0, 1, base.weights.generation),
    queue_quality: clampNumber(weights.queue_quality, 0, 1, base.weights.queue_quality),
    execution: clampNumber(weights.execution, 0, 1, base.weights.execution),
    verification: clampNumber(weights.verification, 0, 1, base.weights.verification)
  };
  const total = Object.values(normWeights).reduce((sum: number, v: any) => sum + Number(v || 0), 0);
  const normalized = total > 0
    ? {
      generation: Number((normWeights.generation / total).toFixed(6)),
      queue_quality: Number((normWeights.queue_quality / total).toFixed(6)),
      execution: Number((normWeights.execution / total).toFixed(6)),
      verification: Number((normWeights.verification / total).toFixed(6))
    }
    : { ...base.weights };

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    thresholds: {
      min_score: clampNumber(thresholds.min_score, 0, 1, base.thresholds.min_score)
    },
    weights: normalized,
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function scoreFromArtifacts(queueEvents: AnyObj[], receipts: AnyObj[], policy: AnyObj) {
  const generated = queueEvents.filter((row: AnyObj) => String(row && row.type || '') === 'proposal_generated').length;
  const filtered = queueEvents.filter((row: AnyObj) => String(row && row.type || '') === 'proposal_filtered').length;
  const filteredForQuality = queueEvents.filter((row: AnyObj) => {
    const t = String(row && row.type || '');
    const reason = String(row && row.filter_reason || '');
    return t === 'proposal_filtered' && ['action_spec_missing', 'duplicate_proposal_id', 'unknown_eye', 'stub_proposal'].includes(reason);
  }).length;

  const executed = receipts.length;
  const attempted = receipts.filter((row: AnyObj) => row && row.receipt_contract && row.receipt_contract.attempted === true).length;
  const verified = receipts.filter((row: AnyObj) => row && row.receipt_contract && row.receipt_contract.verified === true).length;
  const succeeded = receipts.filter((row: AnyObj) => row && row.ok === true).length;

  const generationSignal = generated > 0 ? 1 : 0;
  const queueQualitySignal = filtered > 0 ? Number((Math.min(1, filteredForQuality / filtered)).toFixed(6)) : (generated > 0 ? 1 : 0);
  const executionSignal = generated > 0 ? Number((Math.min(1, executed / generated)).toFixed(6)) : (executed > 0 ? 1 : 0);
  const verificationSignal = executed > 0 ? Number((verified / executed).toFixed(6)) : 0;

  const score = Number((
    (policy.weights.generation * generationSignal)
    + (policy.weights.queue_quality * queueQualitySignal)
    + (policy.weights.execution * executionSignal)
    + (policy.weights.verification * verificationSignal)
  ).toFixed(6));

  return {
    score,
    metrics: {
      generated,
      filtered,
      filtered_for_quality: filteredForQuality,
      executed,
      attempted,
      succeeded,
      verified
    },
    signals: {
      generation: generationSignal,
      queue_quality: queueQualitySignal,
      execution: executionSignal,
      verification: verificationSignal
    }
  };
}

function cmdScore(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const queueLogPath = resolvePath(args['queue-log'] || args.queue_log, 'state/sensory/queue_log.jsonl');
  const receiptLogPath = resolvePath(args['receipt-log'] || args.receipt_log, 'state/actuation/receipts/latest.jsonl');

  const queueEvents = readJsonl(queueLogPath);
  const receipts = readJsonl(receiptLogPath);

  const score = scoreFromArtifacts(queueEvents, receipts, policy);
  const pass = score.score >= Number(policy.thresholds.min_score || 0);

  const out = {
    ok: pass,
    ts: nowIso(),
    type: 'pipeline_handoff_score',
    strict,
    threshold: Number(policy.thresholds.min_score || 0),
    score: score.score,
    metrics: score.metrics,
    signals: score.signals,
    queue_log_path: rel(queueLogPath),
    receipt_log_path: rel(receiptLogPath),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    score: out.score,
    threshold: out.threshold,
    generated: out.metrics.generated,
    executed: out.metrics.executed,
    verified: out.metrics.verified,
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
    type: 'pipeline_handoff_score_status',
    policy_path: rel(policy.policy_path),
    latest: readJson(policy.outputs.latest_path, null),
    latest_path: rel(policy.outputs.latest_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/pipeline_handoff_score.js score --queue-log=<jsonl> --receipt-log=<jsonl> [--strict=1|0]');
  console.log('  node systems/ops/pipeline_handoff_score.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  const payload = cmd === 'score' ? cmdScore(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'pipeline_handoff_score_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, scoreFromArtifacts, cmdScore, cmdStatus };
