#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-027
 * Execution-worthiness scoring gate for queue admission.
 *
 * Usage:
 *   node systems/autonomy/execution_worthiness_gate.js score --proposal-json='{"id":"p1"}'
 *   node systems/autonomy/execution_worthiness_gate.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.EXEC_WORTHINESS_GATE_ROOT
  ? path.resolve(process.env.EXEC_WORTHINESS_GATE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.EXEC_WORTHINESS_GATE_POLICY_PATH
  ? path.resolve(process.env.EXEC_WORTHINESS_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'execution_worthiness_gate_policy.json');

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
  const txt = cleanText(raw, 120000);
  if (!txt) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    threshold: 0.62,
    weights: {
      objective_clarity: 0.25,
      command_concreteness: 0.3,
      verification_strength: 0.25,
      rollback_quality: 0.2
    },
    outputs: {
      latest_path: 'state/autonomy/execution_worthiness_gate/latest.json',
      history_path: 'state/autonomy/execution_worthiness_gate/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const weights = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const norm = {
    objective_clarity: clampNumber(weights.objective_clarity, 0, 1, base.weights.objective_clarity),
    command_concreteness: clampNumber(weights.command_concreteness, 0, 1, base.weights.command_concreteness),
    verification_strength: clampNumber(weights.verification_strength, 0, 1, base.weights.verification_strength),
    rollback_quality: clampNumber(weights.rollback_quality, 0, 1, base.weights.rollback_quality)
  };
  const total = Object.values(norm).reduce((s: number, v: any) => s + Number(v || 0), 0) || 1;
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    threshold: clampNumber(raw.threshold, 0, 1, base.threshold),
    weights: {
      objective_clarity: Number((norm.objective_clarity / total).toFixed(6)),
      command_concreteness: Number((norm.command_concreteness / total).toFixed(6)),
      verification_strength: Number((norm.verification_strength / total).toFixed(6)),
      rollback_quality: Number((norm.rollback_quality / total).toFixed(6))
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function signalScore(proposal: AnyObj) {
  const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const objective = cleanText(proposal.objective_id || proposal.directive_objective_id || meta.objective_id, 160);
  const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : null;

  const objectiveClarity = objective ? 1 : 0;
  const commandConcreteness = actionSpec && cleanText(actionSpec.command || actionSpec.kind, 200) ? 1 : 0;

  const verify = actionSpec && actionSpec.verify && typeof actionSpec.verify === 'object' ? actionSpec.verify : {};
  const verificationStrength = cleanText(verify.command || verify.expect || '', 200) ? 1 : 0;

  const rollback = actionSpec && actionSpec.rollback && typeof actionSpec.rollback === 'object' ? actionSpec.rollback : {};
  const rollbackQuality = cleanText(rollback.command || rollback.strategy || '', 200) ? 1 : 0;

  return {
    objective_clarity: objectiveClarity,
    command_concreteness: commandConcreteness,
    verification_strength: verificationStrength,
    rollback_quality: rollbackQuality
  };
}

function cmdScore(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const proposal = parseJsonArg(args['proposal-json'] || args.proposal_json, null);
  if (!proposal || typeof proposal !== 'object') return { ok: false, error: 'invalid_proposal_json' };

  const signals = signalScore(proposal);
  const score = Number((
    signals.objective_clarity * policy.weights.objective_clarity
    + signals.command_concreteness * policy.weights.command_concreteness
    + signals.verification_strength * policy.weights.verification_strength
    + signals.rollback_quality * policy.weights.rollback_quality
  ).toFixed(6));

  const blockers: AnyObj[] = [];
  if (signals.objective_clarity < 1) blockers.push({ gate: 'objective_clarity', reason: 'missing_objective_id' });
  if (signals.command_concreteness < 1) blockers.push({ gate: 'command_concreteness', reason: 'missing_action_command' });
  if (signals.verification_strength < 1) blockers.push({ gate: 'verification_strength', reason: 'missing_verify_contract' });
  if (signals.rollback_quality < 1) blockers.push({ gate: 'rollback_quality', reason: 'missing_rollback_contract' });

  const out = {
    ok: score >= Number(policy.threshold || 0),
    ts: nowIso(),
    type: 'execution_worthiness_gate',
    strict,
    proposal_id: cleanText(proposal.id || proposal.proposal_id, 120) || null,
    threshold: policy.threshold,
    score,
    signals,
    blockers,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    proposal_id: out.proposal_id,
    score: out.score,
    threshold: out.threshold,
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
    type: 'execution_worthiness_gate_status',
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/execution_worthiness_gate.js score --proposal-json="{...}"');
  console.log('  node systems/autonomy/execution_worthiness_gate.js status');
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
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'execution_worthiness_gate_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdScore, cmdStatus, signalScore };
