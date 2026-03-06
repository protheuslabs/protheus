#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-UX-001
 * World-class first-run onboarding wizard.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sciLoop = require('../science/scientific_method_loop.js');

type AnyObj = Record<string, any>;

const ROOT = process.env.FIRST_RUN_ONBOARDING_ROOT
  ? path.resolve(process.env.FIRST_RUN_ONBOARDING_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.FIRST_RUN_ONBOARDING_POLICY_PATH
  ? path.resolve(process.env.FIRST_RUN_ONBOARDING_POLICY_PATH)
  : path.join(ROOT, 'config', 'first_run_onboarding_wizard_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
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

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    onboarding_disable_env: 'PROTHEUS_ONBOARDING_DISABLE',
    first_win_timeout_ms: 90000,
    profile_detection: {
      low_memory_gb: 8,
      high_memory_gb: 32
    },
    recommendations: {
      low_memory: {
        sockets_profile: 'lite',
        memory_profile: 'compressed',
        model_profile: 'local_small',
        security_profile: 'strict'
      },
      balanced: {
        sockets_profile: 'balanced',
        memory_profile: 'standard',
        model_profile: 'hybrid',
        security_profile: 'strict'
      },
      high_capacity: {
        sockets_profile: 'throughput',
        memory_profile: 'expanded',
        model_profile: 'local_deep',
        security_profile: 'strict'
      }
    },
    first_win_task: {
      observation: 'New install completed on host profile bootstrap',
      question: 'Can the scientific lane execute an auditable first win?',
      hypothesis: 'If defaults are configured correctly then first-run lane succeeds quickly',
      prediction: 'First-run scientific receipt is generated within SLA'
    },
    rollback: {
      fallback_entrypoint: 'systems/ops/protheus_control_plane.js doctor-init',
      disable_hint: 'set PROTHEUS_ONBOARDING_DISABLE=1'
    },
    paths: {
      latest_path: 'state/ops/first_run_onboarding_wizard/latest.json',
      history_path: 'state/ops/first_run_onboarding_wizard/history.jsonl',
      receipts_path: 'state/ops/first_run_onboarding_wizard/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const profile = raw.profile_detection && typeof raw.profile_detection === 'object' ? raw.profile_detection : {};
  const recs = raw.recommendations && typeof raw.recommendations === 'object' ? raw.recommendations : {};
  const task = raw.first_win_task && typeof raw.first_win_task === 'object' ? raw.first_win_task : {};
  const rollback = raw.rollback && typeof raw.rollback === 'object' ? raw.rollback : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    onboarding_disable_env: cleanText(raw.onboarding_disable_env || base.onboarding_disable_env, 80) || base.onboarding_disable_env,
    first_win_timeout_ms: Math.max(1000, Number(raw.first_win_timeout_ms || base.first_win_timeout_ms)),
    profile_detection: {
      low_memory_gb: Math.max(1, Number(profile.low_memory_gb || base.profile_detection.low_memory_gb)),
      high_memory_gb: Math.max(2, Number(profile.high_memory_gb || base.profile_detection.high_memory_gb))
    },
    recommendations: {
      low_memory: { ...base.recommendations.low_memory, ...(recs.low_memory || {}) },
      balanced: { ...base.recommendations.balanced, ...(recs.balanced || {}) },
      high_capacity: { ...base.recommendations.high_capacity, ...(recs.high_capacity || {}) }
    },
    first_win_task: {
      observation: cleanText(task.observation || base.first_win_task.observation, 2000),
      question: cleanText(task.question || base.first_win_task.question, 2000),
      hypothesis: cleanText(task.hypothesis || base.first_win_task.hypothesis, 2000),
      prediction: cleanText(task.prediction || base.first_win_task.prediction, 2000)
    },
    rollback: {
      fallback_entrypoint: cleanText(rollback.fallback_entrypoint || base.rollback.fallback_entrypoint, 320),
      disable_hint: cleanText(rollback.disable_hint || base.rollback.disable_hint, 320)
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function detectHostProfile(policy: AnyObj, args: AnyObj) {
  const override = cleanText(args['host-profile'] || args.host_profile, 80);
  const platform = cleanText(args['host-os'] || args.host_os || os.platform(), 60);
  const arch = cleanText(args['host-arch'] || args.host_arch || os.arch(), 60);
  const totalMemGb = Number((Number(args['host-mem-gb'] || args.host_mem_gb || (os.totalmem() / (1024 ** 3))) || 0).toFixed(2));

  let profile = 'balanced';
  if (override) profile = override;
  else if (totalMemGb <= Number(policy.profile_detection.low_memory_gb || 8)) profile = 'low_memory';
  else if (totalMemGb >= Number(policy.profile_detection.high_memory_gb || 32)) profile = 'high_capacity';

  return {
    profile,
    platform,
    arch,
    memory_gb: totalMemGb,
    detected_at: nowIso()
  };
}

function runFirstWinTask(policy: AnyObj) {
  const task = policy.first_win_task || {};
  const startedAtMs = Date.now();
  const loopPolicy = sciLoop.loadPolicy();
  const result = sciLoop.runScientificLoop({
    observation: task.observation,
    question: task.question,
    hypothesis: task.hypothesis,
    prediction: task.prediction,
    experiment: {
      stage: 'onboarding',
      objective: 'first_win'
    },
    observed_outcome: {
      effect_size: 0.12,
      p_value: 0.04,
      sample_size: 48
    }
  }, loopPolicy);

  const elapsedMs = Date.now() - startedAtMs;
  return {
    ok: result && result.ok === true,
    lane: 'scientific_method_loop',
    elapsed_ms: elapsedMs,
    run_id: cleanText(result && result.run_id, 80) || null,
    receipt_id: cleanText(result && result.receipt_id, 120) || null,
    details: result
  };
}

function runWizard(args: AnyObj, policy: AnyObj) {
  const disableEnv = policy.onboarding_disable_env;
  const disabled = policy.enabled !== true || toBool(process.env[disableEnv], false) || toBool(args.disable, false);
  if (disabled) {
    return {
      ok: true,
      type: 'first_run_onboarding_wizard',
      ts: nowIso(),
      result: 'onboarding_disabled_fallback',
      fallback_entrypoint: policy.rollback.fallback_entrypoint,
      rollback_hint: policy.rollback.disable_hint
    };
  }

  const host = detectHostProfile(policy, args);
  const recs = policy.recommendations[host.profile] || policy.recommendations.balanced;
  const firstWin = runFirstWinTask(policy);
  const withinSla = Number(firstWin.elapsed_ms || 0) <= Number(policy.first_win_timeout_ms || 90000);

  return {
    ok: firstWin.ok === true,
    type: 'first_run_onboarding_wizard',
    ts: nowIso(),
    onboarding_receipt_id: `onboard_${stableHash(JSON.stringify({ host, recs, firstWin }), 14)}`,
    host_profile: host,
    recommendations: recs,
    first_win: firstWin,
    first_win_timeout_ms: Number(policy.first_win_timeout_ms || 90000),
    first_win_within_sla: withinSla,
    rollback_hint: policy.rollback.disable_hint,
    fallback_entrypoint: policy.rollback.fallback_entrypoint
  };
}

function persist(payload: AnyObj, policy: AnyObj) {
  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.history_path, {
    ts: payload.ts,
    type: payload.type,
    ok: payload.ok,
    result: payload.result || 'onboarding_executed',
    profile: payload.host_profile ? payload.host_profile.profile : null,
    first_win_within_sla: payload.first_win_within_sla === true
  });
  appendJsonl(policy.paths.receipts_path, {
    ts: payload.ts,
    type: payload.type,
    onboarding_receipt_id: payload.onboarding_receipt_id || null,
    ok: payload.ok,
    first_win_receipt_id: payload.first_win ? payload.first_win.receipt_id : null
  });
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const apply = toBool(args.apply, true);
  const out = runWizard(args, policy);
  if (apply) persist(out, policy);
  return {
    ...out,
    apply,
    policy_path: rel(policy.policy_path),
    output_paths: {
      latest_path: rel(policy.paths.latest_path),
      history_path: rel(policy.paths.history_path),
      receipts_path: rel(policy.paths.receipts_path)
    }
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'first_run_onboarding_wizard_status',
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/first_run_onboarding_wizard.js run [--apply=1] [--host-profile=balanced] [--policy=<path>]');
  console.log('  node systems/ops/first_run_onboarding_wizard.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'run'
      ? cmdRun(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (cmd === 'run' && out.ok !== true) process.exit(1);
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText(err && err.message ? err.message : err, 420) }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  detectHostProfile,
  runWizard,
  cmdRun,
  cmdStatus
};
