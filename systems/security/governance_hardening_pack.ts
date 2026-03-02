#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-013
 * Governance hardening pack:
 * - Dual-control for strategy escalation
 * - Non-bypass budget/risk caps
 * - Immutable policy/kernel verification
 * - One-command emergency stop
 *
 * Usage:
 *   node systems/security/governance_hardening_pack.js evaluate [--target-mode=score_only|canary_execute|execute] [--approval=<id> ...] [--daily-usd=<n>] [--risk-score=<n>] [--strict=1|0]
 *   node systems/security/governance_hardening_pack.js emergency-stop --reason="..." [--source=operator] [--apply=1|0]
 *   node systems/security/governance_hardening_pack.js refresh-baseline [--apply=1|0]
 *   node systems/security/governance_hardening_pack.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.GOV_HARDENING_ROOT
  ? path.resolve(process.env.GOV_HARDENING_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.GOV_HARDENING_POLICY_PATH
  ? path.resolve(process.env.GOV_HARDENING_POLICY_PATH)
  : path.join(ROOT, 'config', 'governance_hardening_pack_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 360) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [], approval: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      const key = tok.slice(2, eq);
      const value = tok.slice(eq + 1);
      if (key === 'approval') out.approval.push(value);
      else out[key] = value;
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (key === 'approval' && next != null && !String(next).startsWith('--')) {
      out.approval.push(String(next));
      i += 1;
      continue;
    }
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function asStringArray(v: unknown) {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = cleanText(item, 120);
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function sha256File(filePath: string) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    escalation_target_modes: ['canary_execute', 'execute'],
    dual_control: {
      required_approvals: 2,
      require_distinct: true
    },
    caps: {
      max_daily_usd: 10.5,
      max_risk_score: 0.6
    },
    immutable_files: [
      'config/capability_switchboard_policy.json',
      'systems/security/integrity_kernel.ts'
    ],
    immutable_baseline_path: 'state/security/governance_hardening_pack/immutable_baseline.json',
    emergency_stop_path: 'state/security/governance_hardening_pack/emergency_stop.json',
    outputs: {
      latest_path: 'state/security/governance_hardening_pack/latest.json',
      history_path: 'state/security/governance_hardening_pack/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const dual = raw.dual_control && typeof raw.dual_control === 'object' ? raw.dual_control : {};
  const caps = raw.caps && typeof raw.caps === 'object' ? raw.caps : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const baselineHashes = raw.immutable_baseline_hashes && typeof raw.immutable_baseline_hashes === 'object'
    ? raw.immutable_baseline_hashes
    : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    escalation_target_modes: asStringArray(raw.escalation_target_modes || base.escalation_target_modes),
    dual_control: {
      required_approvals: Math.max(1, Number(dual.required_approvals || base.dual_control.required_approvals || 2)),
      require_distinct: dual.require_distinct !== false
    },
    caps: {
      max_daily_usd: clampNumber(caps.max_daily_usd, 0, 1_000_000, base.caps.max_daily_usd),
      max_risk_score: clampNumber(caps.max_risk_score, 0, 1, base.caps.max_risk_score)
    },
    immutable_files: asStringArray(raw.immutable_files || base.immutable_files),
    immutable_baseline_path: resolvePath(raw.immutable_baseline_path, base.immutable_baseline_path),
    immutable_baseline_hashes: baselineHashes,
    emergency_stop_path: resolvePath(raw.emergency_stop_path, base.emergency_stop_path),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadBaseline(policy: AnyObj) {
  const fromFile = readJson(policy.immutable_baseline_path, null);
  if (fromFile && typeof fromFile === 'object') return fromFile;
  return policy.immutable_baseline_hashes && typeof policy.immutable_baseline_hashes === 'object'
    ? policy.immutable_baseline_hashes
    : {};
}

function computeImmutableSnapshot(policy: AnyObj) {
  const out: AnyObj = {};
  const missing: string[] = [];
  for (const relPath of policy.immutable_files || []) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      missing.push(relPath);
      continue;
    }
    out[relPath] = sha256File(abs);
  }
  return { hashes: out, missing };
}

function evaluateDualControl(policy: AnyObj, targetMode: string, approvals: string[]) {
  const escalation = (policy.escalation_target_modes || []).includes(targetMode);
  if (!escalation) {
    return {
      required: false,
      ok: true,
      approved_by: []
    };
  }
  const deduped = Array.from(new Set((approvals || []).map((x) => cleanText(x, 80)).filter(Boolean)));
  const enough = deduped.length >= Number(policy.dual_control.required_approvals || 2);
  const distinctOk = policy.dual_control.require_distinct !== true || deduped.length === (approvals || []).filter(Boolean).length;
  return {
    required: true,
    ok: enough && distinctOk,
    approved_by: deduped,
    required_approvals: Number(policy.dual_control.required_approvals || 2),
    require_distinct: policy.dual_control.require_distinct === true
  };
}

function evaluateImmutable(policy: AnyObj) {
  const baseline = loadBaseline(policy);
  const current = computeImmutableSnapshot(policy);
  const mismatches: AnyObj[] = [];
  for (const relPath of policy.immutable_files || []) {
    const expected = cleanText(baseline[relPath], 80);
    const actual = cleanText(current.hashes[relPath], 80);
    if (!actual) {
      mismatches.push({ file: relPath, reason: 'missing_file' });
      continue;
    }
    if (!expected) {
      mismatches.push({ file: relPath, reason: 'baseline_missing', actual });
      continue;
    }
    if (expected !== actual) {
      mismatches.push({ file: relPath, reason: 'hash_mismatch', expected, actual });
    }
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
    baseline_path: rel(policy.immutable_baseline_path),
    current_hashes: current.hashes,
    missing_files: current.missing
  };
}

function writeEmergencyStop(policy: AnyObj, reason: string, source: string, active: boolean) {
  const payload = {
    schema_id: 'governance_hardening_emergency_stop',
    ts: nowIso(),
    active,
    reason: cleanText(reason || (active ? 'emergency_stop_engaged' : 'emergency_stop_cleared'), 220),
    source: cleanText(source || 'operator', 80)
  };
  writeJsonAtomic(policy.emergency_stop_path, payload);
  return payload;
}

function cmdEvaluate(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const targetMode = cleanText(args['target-mode'] || args.target_mode || 'score_only', 60).toLowerCase() || 'score_only';
  const approvals = asStringArray(args.approval || []);
  const dailyUsd = clampNumber(args['daily-usd'] || args.daily_usd, 0, 1_000_000, 0);
  const riskScore = clampNumber(args['risk-score'] || args.risk_score, 0, 1, 0);

  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const dual = evaluateDualControl(policy, targetMode, approvals);
  const immutable = evaluateImmutable(policy);
  const blockers: AnyObj[] = [];

  if (!dual.ok) blockers.push({ gate: 'dual_control', reason: 'dual_control_missing_or_invalid', detail: dual });
  if (dailyUsd > Number(policy.caps.max_daily_usd || 0)) {
    blockers.push({ gate: 'budget_cap', reason: 'daily_usd_cap_exceeded', value: dailyUsd, cap: policy.caps.max_daily_usd });
  }
  if (riskScore > Number(policy.caps.max_risk_score || 0)) {
    blockers.push({ gate: 'risk_cap', reason: 'risk_cap_exceeded', value: riskScore, cap: policy.caps.max_risk_score });
  }
  if (!immutable.ok) blockers.push({ gate: 'immutable_check', reason: 'immutable_hash_mismatch', detail: immutable.mismatches.slice(0, 10) });

  const emergencyStop = readJson(policy.emergency_stop_path, null);
  if (emergencyStop && emergencyStop.active === true) {
    blockers.push({ gate: 'emergency_stop', reason: 'emergency_stop_active' });
  }

  const out = {
    ok: blockers.length === 0,
    ts: nowIso(),
    type: 'governance_hardening_pack',
    strict,
    target_mode: targetMode,
    blockers,
    dual_control: dual,
    caps: {
      daily_usd: dailyUsd,
      max_daily_usd: Number(policy.caps.max_daily_usd || 0),
      risk_score: riskScore,
      max_risk_score: Number(policy.caps.max_risk_score || 0)
    },
    immutable,
    emergency_stop_active: !!(emergencyStop && emergencyStop.active === true),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    target_mode: targetMode,
    blocker_count: blockers.length,
    ok: out.ok
  });

  return out;
}

function cmdEmergencyStop(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const apply = toBool(args.apply, false);
  const reason = cleanText(args.reason || 'manual_operator_stop', 220) || 'manual_operator_stop';
  const source = cleanText(args.source || 'operator', 80) || 'operator';
  const payload = apply
    ? writeEmergencyStop(policy, reason, source, true)
    : {
      schema_id: 'governance_hardening_emergency_stop',
      ts: nowIso(),
      active: true,
      reason,
      source,
      dry_run: true
    };
  return {
    ok: true,
    ts: nowIso(),
    type: 'governance_hardening_emergency_stop',
    applied: apply,
    emergency_stop_path: rel(policy.emergency_stop_path),
    emergency_stop: payload
  };
}

function cmdRefreshBaseline(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const apply = toBool(args.apply, false);
  const snapshot = computeImmutableSnapshot(policy);
  const payload = {
    schema_id: 'governance_hardening_immutable_baseline',
    ts: nowIso(),
    files: snapshot.hashes,
    missing_files: snapshot.missing,
    policy_path: rel(policy.policy_path)
  };
  if (apply) writeJsonAtomic(policy.immutable_baseline_path, payload.files);
  return {
    ok: true,
    ts: nowIso(),
    type: 'governance_hardening_refresh_baseline',
    applied: apply,
    baseline_path: rel(policy.immutable_baseline_path),
    file_count: Object.keys(snapshot.hashes).length,
    missing_files: snapshot.missing,
    baseline: payload
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'governance_hardening_pack_status',
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    emergency_stop_path: rel(policy.emergency_stop_path),
    emergency_stop: readJson(policy.emergency_stop_path, null)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/governance_hardening_pack.js evaluate [--target-mode=score_only|canary_execute|execute] [--approval=<id> ...] [--daily-usd=<n>] [--risk-score=<n>] [--strict=1|0]');
  console.log('  node systems/security/governance_hardening_pack.js emergency-stop --reason="..." [--source=operator] [--apply=1|0]');
  console.log('  node systems/security/governance_hardening_pack.js refresh-baseline [--apply=1|0]');
  console.log('  node systems/security/governance_hardening_pack.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'evaluate').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  try {
    const payload = cmd === 'evaluate'
      ? cmdEvaluate(args)
      : cmd === 'emergency-stop'
        ? cmdEmergencyStop(args)
        : cmd === 'refresh-baseline'
          ? cmdRefreshBaseline(args)
          : cmd === 'status'
            ? cmdStatus(args)
            : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (cmd === 'evaluate' && payload.ok === false && toBool(args.strict, true)) {
      process.exit(1);
    }
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'governance_hardening_pack_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdEvaluate,
  cmdEmergencyStop,
  cmdRefreshBaseline,
  cmdStatus
};
