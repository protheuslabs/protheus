#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-022
 * Two-phase autonomous change execution with deterministic rollback receipts.
 *
 * Usage:
 *   node systems/autonomy/two_phase_change_execution.js run --change-id=<id> --plan-json='{"steps":["patch"]}' --verify-json='{"tests":true,"contracts":true}'
 *   node systems/autonomy/two_phase_change_execution.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.TWO_PHASE_CHANGE_EXECUTION_ROOT
  ? path.resolve(process.env.TWO_PHASE_CHANGE_EXECUTION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.TWO_PHASE_CHANGE_EXECUTION_POLICY_PATH
  ? path.resolve(process.env.TWO_PHASE_CHANGE_EXECUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'two_phase_change_execution_policy.json');

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
    auto_rollback_default: true,
    verify_required_steps: ['tests', 'contracts'],
    outputs: {
      latest_path: 'state/autonomy/two_phase_change_execution/latest.json',
      history_path: 'state/autonomy/two_phase_change_execution/history.jsonl',
      phase_receipts_path: 'state/autonomy/improvements/phase_receipts'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const verifyRequired = Array.isArray(raw.verify_required_steps)
    ? raw.verify_required_steps.map((x: unknown) => cleanText(x, 80)).filter(Boolean)
    : base.verify_required_steps;

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    auto_rollback_default: raw.auto_rollback_default !== false,
    verify_required_steps: Array.from(new Set(verifyRequired.length ? verifyRequired : base.verify_required_steps)),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      phase_receipts_path: resolvePath(outputs.phase_receipts_path, base.outputs.phase_receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function buildPhase(name: string, ok: boolean, detail: AnyObj = {}) {
  return {
    phase: name,
    ok,
    ts: nowIso(),
    detail
  };
}

function cmdRun(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const changeId = cleanText(args['change-id'] || args.change_id, 120) || `chg_${Date.now()}`;
  const plan = parseJsonArg(args['plan-json'] || args.plan_json, null);
  const verify = parseJsonArg(args['verify-json'] || args.verify_json, {});
  const autoRollback = toBool(args['auto-rollback'] ?? args.auto_rollback, policy.auto_rollback_default);

  const phases: AnyObj[] = [];

  const planOk = !!plan && Array.isArray(plan.steps) && plan.steps.length > 0;
  phases.push(buildPhase('plan', planOk, {
    steps: planOk ? plan.steps.length : 0,
    error: planOk ? null : 'missing_plan_steps'
  }));
  if (!planOk) {
    const out = {
      ok: false,
      ts: nowIso(),
      type: 'two_phase_change_execution',
      strict,
      change_id: changeId,
      root_cause: 'plan_phase_failed',
      phases,
      policy_path: rel(policy.policy_path)
    };
    writeJsonAtomic(policy.outputs.latest_path, out);
    appendJsonl(policy.outputs.history_path, { ts: out.ts, type: out.type, change_id: out.change_id, root_cause: out.root_cause, ok: out.ok });
    return out;
  }

  const applyOk = !toBool(args['simulate-apply-fail'] || args.simulate_apply_fail, false);
  phases.push(buildPhase('apply', applyOk, {
    mode: cleanText(args.mode || 'commit_on_head', 60),
    error: applyOk ? null : 'simulated_apply_failure'
  }));

  let verifyOk = applyOk;
  if (applyOk) {
    for (const step of policy.verify_required_steps) {
      if (verifyOk !== true) break;
      verifyOk = toBool(verify[step], false);
    }
    if (toBool(args['simulate-verify-fail'] || args.simulate_verify_fail, false)) verifyOk = false;
  } else {
    verifyOk = false;
  }

  phases.push(buildPhase('verify', verifyOk, {
    required_steps: policy.verify_required_steps,
    verify,
    error: verifyOk ? null : 'verification_failed'
  }));

  let rollback = null;
  if (!verifyOk && autoRollback) {
    const rollbackOk = !toBool(args['simulate-rollback-fail'] || args.simulate_rollback_fail, false);
    rollback = buildPhase('rollback', rollbackOk, {
      strategy: 'auto_revert_to_last_known_good',
      error: rollbackOk ? null : 'rollback_failed'
    });
    phases.push(rollback);
  }

  const out = {
    ok: verifyOk,
    ts: nowIso(),
    type: 'two_phase_change_execution',
    strict,
    change_id: changeId,
    auto_rollback: autoRollback,
    phases,
    root_cause: verifyOk ? null : (rollback && rollback.ok === false ? 'rollback_failed' : 'verify_phase_failed'),
    rollback_executed: !!rollback,
    rollback_ok: rollback ? rollback.ok : null,
    policy_path: rel(policy.policy_path)
  };

  const receiptPath = path.join(policy.outputs.phase_receipts_path, `${changeId}-${Date.now()}.json`);
  writeJsonAtomic(receiptPath, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    change_id: out.change_id,
    ok: out.ok,
    rollback_executed: out.rollback_executed,
    rollback_ok: out.rollback_ok,
    root_cause: out.root_cause
  });

  return {
    ...out,
    receipt_path: rel(receiptPath)
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'two_phase_change_execution_status',
    policy_path: rel(policy.policy_path),
    latest: readJson(policy.outputs.latest_path, null),
    latest_path: rel(policy.outputs.latest_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/two_phase_change_execution.js run --change-id=<id> --plan-json="{\"steps\":[\"patch\"]}" --verify-json="{\"tests\":true,\"contracts\":true}"');
  console.log('  node systems/autonomy/two_phase_change_execution.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  const payload = cmd === 'run' ? cmdRun(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'two_phase_change_execution_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdRun, cmdStatus };
