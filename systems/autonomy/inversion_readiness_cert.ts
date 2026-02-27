#!/usr/bin/env node
'use strict';
export {};

/**
 * inversion_readiness_cert.js
 *
 * V2-053 live-activation readiness certification for inversion.
 *
 * Usage:
 *   node systems/autonomy/inversion_readiness_cert.js run [--policy=path]
 *   node systems/autonomy/inversion_readiness_cert.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'inversion_readiness_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx === -1) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function clean(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const s = clean(raw, 260);
  if (!s) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

function parseTsMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function daysAgoIso(days: number) {
  const dt = new Date(Date.now() - Math.max(0, Number(days || 0)) * 24 * 60 * 60 * 1000);
  return dt.toISOString();
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    require_runtime_mode_test: true,
    shadow_window_days: 30,
    max_critical_failures_shadow_window: 0,
    required_harness_tests: ['imh-01', 'imh-02', 'imh-03'],
    require_human_veto_policy: true,
    paths: {
      inversion_policy: 'config/inversion_policy.json',
      receipts: 'state/autonomy/inversion/receipts.jsonl',
      events: 'state/autonomy/inversion/events',
      history: 'state/autonomy/inversion/history.jsonl',
      latest_state: 'state/autonomy/inversion/latest.json',
      activation_receipt: 'state/autonomy/inversion/live_activation_receipt.json',
      out_latest: 'state/autonomy/inversion/readiness/latest.json',
      out_history: 'state/autonomy/inversion/readiness/history.jsonl'
    }
  };
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    require_runtime_mode_test: raw.require_runtime_mode_test !== false,
    shadow_window_days: Number.isFinite(Number(raw.shadow_window_days)) ? Math.max(1, Math.floor(Number(raw.shadow_window_days))) : base.shadow_window_days,
    max_critical_failures_shadow_window: Number.isFinite(Number(raw.max_critical_failures_shadow_window))
      ? Math.max(0, Math.floor(Number(raw.max_critical_failures_shadow_window)))
      : base.max_critical_failures_shadow_window,
    required_harness_tests: Array.isArray(raw.required_harness_tests)
      ? raw.required_harness_tests.map((row: unknown) => clean(row, 80)).filter(Boolean)
      : base.required_harness_tests,
    require_human_veto_policy: raw.require_human_veto_policy !== false,
    paths: {
      inversion_policy: resolvePath(paths.inversion_policy, base.paths.inversion_policy),
      receipts: resolvePath(paths.receipts, base.paths.receipts),
      events: resolvePath(paths.events, base.paths.events),
      history: resolvePath(paths.history, base.paths.history),
      latest_state: resolvePath(paths.latest_state, base.paths.latest_state),
      activation_receipt: resolvePath(paths.activation_receipt, base.paths.activation_receipt),
      out_latest: resolvePath(paths.out_latest, base.paths.out_latest),
      out_history: resolvePath(paths.out_history, base.paths.out_history)
    }
  };
}

function collectHarnessEvidence(receipts: AnyObj[], requiredIds: string[]) {
  const seen = new Set<string>();
  for (const row of receipts) {
    const note = clean(row && row.note || '', 200);
    const m = note.match(/harness:([a-z0-9_-]+)/i);
    if (m && m[1]) seen.add(String(m[1]).toLowerCase());
  }
  const missing = requiredIds
    .map((id) => String(id || '').toLowerCase())
    .filter(Boolean)
    .filter((id) => !seen.has(id));
  return {
    required: requiredIds,
    seen: Array.from(seen),
    missing
  };
}

function evaluate(policy: AnyObj) {
  const inversionPolicy = readJson(policy.paths.inversion_policy, {});
  const receipts = readJsonl(policy.paths.receipts);
  const history = readJsonl(policy.paths.history);
  const activationReceipt = readJson(policy.paths.activation_receipt, null);
  const latestState = readJson(policy.paths.latest_state, null);

  const blockers = [] as string[];
  const checks: AnyObj = {};

  checks.runtime_mode = clean(inversionPolicy && inversionPolicy.runtime && inversionPolicy.runtime.mode || '', 24) || null;
  if (policy.require_runtime_mode_test && checks.runtime_mode !== 'test') {
    blockers.push('runtime_mode_not_test');
  }

  const harnessEvidence = collectHarnessEvidence(receipts, policy.required_harness_tests);
  checks.harness = harnessEvidence;
  if (harnessEvidence.missing.length > 0) blockers.push('required_harness_tests_missing');

  const cutoffMs = parseTsMs(daysAgoIso(policy.shadow_window_days));
  const recentHistory = history.filter((row: AnyObj) => {
    const ms = parseTsMs(row && row.ts);
    return ms != null && cutoffMs != null && ms >= cutoffMs;
  });
  const criticalFailures = recentHistory.filter((row: AnyObj) => {
    const reasons = Array.isArray(row && row.reasons) ? row.reasons.map((r: unknown) => String(r || '')) : [];
    return reasons.some((reason: string) => /destructive|immutable_axiom|target_disabled_live/i.test(reason));
  }).length;
  checks.shadow_window = {
    days: policy.shadow_window_days,
    samples: recentHistory.length,
    critical_failures: criticalFailures
  };
  if (criticalFailures > Number(policy.max_critical_failures_shadow_window || 0)) {
    blockers.push('shadow_window_critical_failures_exceeded');
  }

  const tierTransition = inversionPolicy && inversionPolicy.tier_transition && typeof inversionPolicy.tier_transition === 'object'
    ? inversionPolicy.tier_transition
    : {};
  const firstNUse = tierTransition.first_live_uses_require_human_veto && typeof tierTransition.first_live_uses_require_human_veto === 'object'
    ? tierTransition.first_live_uses_require_human_veto
    : {};
  checks.human_veto_policy = {
    enabled: tierTransition.enabled === true,
    first_live_uses_require_human_veto: firstNUse
  };
  if (policy.require_human_veto_policy) {
    const belief = Number(firstNUse.belief || 0);
    const identity = Number(firstNUse.identity || 0);
    if (!(belief > 0 && identity > 0 && tierTransition.enabled === true)) {
      blockers.push('human_veto_policy_missing');
    }
  }

  checks.activation_receipt = activationReceipt && typeof activationReceipt === 'object'
    ? {
        present: true,
        approved: activationReceipt.approved === true,
        ts: clean(activationReceipt.ts || '', 64) || null
      }
    : { present: false, approved: false, ts: null };
  if (!(checks.activation_receipt.present && checks.activation_receipt.approved === true)) {
    blockers.push('live_activation_receipt_missing');
  }

  const ready = blockers.length === 0;
  const payload = {
    ok: true,
    type: 'inversion_readiness_cert',
    ts: nowIso(),
    ready,
    blockers,
    checks,
    latest_state_path: latestState ? relPath(policy.paths.latest_state) : null
  };
  return payload;
}

function runCert(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'inversion_readiness_cert',
      ts: nowIso(),
      ready: false,
      blockers: ['readiness_policy_disabled']
    };
  }
  const payload = evaluate(policy);
  writeJsonAtomic(policy.paths.out_latest, payload);
  fs.appendFileSync(policy.paths.out_history, `${JSON.stringify(payload)}\n`, 'utf8');
  payload.out_latest_path = relPath(policy.paths.out_latest);
  payload.out_history_path = relPath(policy.paths.out_history);
  return payload;
}

function status(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.paths.out_latest, null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'inversion_readiness_status',
      error: 'readiness_snapshot_missing',
      out_latest_path: relPath(policy.paths.out_latest)
    };
  }
  return {
    ok: true,
    type: 'inversion_readiness_status',
    ts: clean(payload.ts || '', 64) || null,
    ready: payload.ready === true,
    blocker_count: Array.isArray(payload.blockers) ? payload.blockers.length : 0,
    blockers: Array.isArray(payload.blockers) ? payload.blockers : [],
    out_latest_path: relPath(policy.paths.out_latest)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/inversion_readiness_cert.js run [--policy=path]');
  console.log('  node systems/autonomy/inversion_readiness_cert.js status [--policy=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    process.stdout.write(`${JSON.stringify(runCert(args))}\n`);
    return;
  }
  if (cmd === 'status') {
    const payload = status(args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (payload.ok !== true) process.exitCode = 1;
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'inversion_readiness_cert',
      error: clean(err && err.message ? err.message : err || 'inversion_readiness_failed', 220)
    })}\n`);
    process.exit(1);
  }
}

