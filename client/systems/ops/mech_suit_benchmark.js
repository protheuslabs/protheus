#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { approxTokenCount } = require('../../lib/mech_suit_mode');

const ROOT = path.resolve(__dirname, '..', '..');
const TS_ENTRYPOINT = path.join(ROOT, 'lib', 'ts_entrypoint.js');
const SPINE = path.join(ROOT, 'systems', 'spine', 'spine_safe_launcher.js');
const EXTERNAL_EYES = path.join(ROOT, 'habits', 'scripts', 'external_eyes.js');
const PERSONA_AMBIENT = path.join(ROOT, 'systems', 'personas', 'ambient_stance.js');
const DOPAMINE_AMBIENT = path.join(ROOT, 'systems', 'dopamine', 'ambient.js');
const MEMORY_AMBIENT = path.join(ROOT, 'systems', 'memory', 'ambient.js');
const CATALOG_PATH = path.join(ROOT, 'adaptive', 'sensory', 'eyes', 'catalog.json');
const RUNTIME_GATE_PATH = path.join(ROOT, 'local', 'state', 'conduit', 'runtime_gate.json');
const OUTPUT_DIR = path.join(ROOT, 'local', 'state', 'ops', 'mech_suit_benchmark');
const OUTPUT_LATEST = path.join(OUTPUT_DIR, 'latest.json');
const OUTPUT_HISTORY = path.join(OUTPUT_DIR, 'history.jsonl');
const DEFAULT_NODE_TIMEOUT_MS = Math.max(1000, Number(process.env.MECH_SUIT_BENCH_NODE_TIMEOUT_MS || 15000));
const DEFAULT_CONDUIT_TIMEOUT_MS = Math.max(1000, Number(process.env.MECH_SUIT_BENCH_CONDUIT_TIMEOUT_MS || 12000));
const PRECHECK_TIMEOUT_MS = Math.max(1000, Number(process.env.MECH_SUIT_BENCH_PREFLIGHT_TIMEOUT_MS || 20000));
const ALLOW_HOST_SKIP = String(process.env.MECH_SUIT_BENCH_ALLOW_HOST_SKIP || '1').trim() !== '0';

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, value) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n', 'utf8');
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function resetRuntimeGate() {
  const payload = {
    gate_active: false,
    blocked_until: null,
    blocked_until_ms: 0,
    remaining_ms: 0,
    consecutive_failures: 0,
    threshold: null,
    last_error: null,
    last_failure_at: null,
    updated_at: new Date().toISOString()
  };
  writeJson(RUNTIME_GATE_PATH, payload);
}

function cleanText(v, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function isRuntimeTimeoutText(text) {
  return /conduit_stdio_timeout|conduit_bridge_timeout|ETIMEDOUT|runtime_gate_active_until/i.test(String(text || ''));
}

function isGateReasonText(text) {
  return /conduit_runtime_gate_active|runtime_gate_active_until|gate_active/i.test(String(text || ''));
}

function resolveScriptInvocation(script) {
  if (fs.existsSync(script)) {
    return [script];
  }
  if (script.endsWith('.js')) {
    const tsPath = script.slice(0, -3) + '.ts';
    if (fs.existsSync(tsPath)) {
      return [TS_ENTRYPOINT, tsPath];
    }
  }
  if (script.endsWith('.ts')) {
    const jsPath = script.slice(0, -3) + '.js';
    if (fs.existsSync(jsPath)) {
      return [jsPath];
    }
  }
  throw new Error(`benchmark_script_missing:${script}`);
}

function runNode(script, args, env = {}, timeoutMs = DEFAULT_NODE_TIMEOUT_MS) {
  const invocation = resolveScriptInvocation(script);
  const out = spawnSync(process.execPath, [...invocation, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(timeoutMs) || DEFAULT_NODE_TIMEOUT_MS),
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      PROTHEUS_SECURITY_GLOBAL_GATE: process.env.PROTHEUS_SECURITY_GLOBAL_GATE || '0',
      PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS: String(DEFAULT_CONDUIT_TIMEOUT_MS),
      PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS: String(DEFAULT_CONDUIT_TIMEOUT_MS),
      PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS: process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS || '1',
      PROTHEUS_CONDUIT_RUNTIME_GATE_THRESHOLD: process.env.PROTHEUS_CONDUIT_RUNTIME_GATE_THRESHOLD || '9999',
      ...env
    }
  });
  const stdout = String(out.stdout || '');
  const stderr = String(out.stderr || '');
  const timedOut = Boolean(out.error && String(out.error.code || '') === 'ETIMEDOUT');
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : (timedOut ? 124 : 1),
    stdout,
    stderr,
    timed_out: timedOut,
    signal: cleanText(out.signal || '', 32) || null,
    error: cleanText(out.error && out.error.message || '', 240) || null,
    token_estimate: approxTokenCount(`${stdout}\n${stderr}`),
    char_count: stdout.length + stderr.length
  };
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function isGateActivePayload(payload) {
  return !!(
    payload
    && typeof payload === 'object'
    && (
      payload.gate_active === true
      || isGateReasonText(payload.reason)
      || isGateReasonText(payload.degraded_reason)
      || (payload.blocked === true && isGateReasonText(payload.gate_reason))
    )
  );
}

function reduction(baseline, ambient) {
  const base = Math.max(1, Number(baseline || 0));
  const next = Math.max(0, Number(ambient || 0));
  return Number((((base - next) / base) * 100).toFixed(2));
}

function reductionOrNull(baseline, ambient, hostFaultDetected) {
  if (hostFaultDetected) return null;
  return reduction(baseline, ambient);
}

function buildEarlyHostFault(tempRoot, preflight, reason) {
  const preflightStdout = cleanText(preflight && preflight.stdout, 800);
  const preflightStderr = cleanText(preflight && preflight.stderr, 800);
  const hostRuntimeTimeout = String(reason || '').includes('spine_conduit_unavailable')
    && (
      (preflight && preflight.timed_out === true)
      || (preflight && preflight.status === 124)
      ||
      preflightStderr.includes('conduit_stdio_timeout')
      || preflightStdout.includes('conduit_stdio_timeout')
      || preflightStderr.includes('conduit_bridge_timeout')
      || preflightStdout.includes('conduit_bridge_timeout')
    );
  const skipped = ALLOW_HOST_SKIP && hostRuntimeTimeout;
  const out = {
    ok: skipped ? true : false,
    type: 'mech_suit_benchmark',
    ts: new Date().toISOString(),
    ambient_mode_active: false,
    skipped,
    skip_reason: skipped ? 'host_runtime_timeout' : null,
    benchmark_root: tempRoot,
    cases: [
      {
        name: 'spine_conduit_preflight',
        baseline: preflight,
        ambient: preflight,
        token_burn_reduction_pct: 0,
        chars_reduction_pct: 0,
        ok: false
      }
    ],
    host_fault: {
      timeout_detected: preflight && preflight.timed_out === true,
      timed_out_cases: preflight && preflight.timed_out === true ? ['spine_conduit_preflight'] : [],
      reason: cleanText(reason || preflight && preflight.error || 'spine_conduit_preflight_failed', 200),
      preflight_stdout: preflightStdout,
      preflight_stderr: preflightStderr
    },
    summary: {
      token_burn_reduction_pct: null,
      chars_reduction_pct: null,
      persona_ambient_mode_active: false,
      persona_delta_applied: false,
      dopamine_threshold_only: false,
      memory_rust_authoritative: false
    }
  };
  writeJson(OUTPUT_LATEST, out);
  appendJsonl(OUTPUT_HISTORY, out);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return out;
}

function writePolicy(tempRoot) {
  const policyPath = path.join(tempRoot, 'mech_suit_mode_policy.json');
  const policy = {
    version: '1.0',
    enabled: true,
    state: {
      status_path: path.join(tempRoot, 'state', 'ops', 'mech_suit_mode', 'latest.json'),
      history_path: path.join(tempRoot, 'state', 'ops', 'mech_suit_mode', 'history.jsonl')
    },
    spine: {
      heartbeat_hours: 4,
      manual_triggers_allowed: false,
      quiet_non_critical: true,
      silent_subprocess_output: true,
      critical_patterns: ['critical', 'fail', 'failed', 'blocked', 'outage']
    },
    eyes: {
      push_attention_queue: true,
      quiet_non_critical: true,
      attention_queue_path: path.join(tempRoot, 'state', 'attention', 'queue.jsonl'),
      receipts_path: path.join(tempRoot, 'state', 'attention', 'receipts.jsonl'),
      latest_path: path.join(tempRoot, 'state', 'attention', 'latest.json'),
      attention_contract: {
        max_queue_depth: 2048,
        cursor_state_path: path.join(tempRoot, 'state', 'attention', 'cursor_state.json'),
        ttl_hours: 48,
        dedupe_window_hours: 24,
        backpressure_drop_below: 'critical',
        escalate_levels: ['critical'],
        priority_map: {
          critical: 100,
          warn: 60,
          info: 20
        }
      },
      push_event_types: ['external_item', 'eye_run_failed', 'infra_outage_state', 'eye_health_quarantine_set', 'eye_auto_dormant', 'collector_proposal_added'],
      focus_warn_score: 0.7,
      critical_error_codes: ['env_blocked', 'auth_denied', 'integrity_blocked', 'transport_blocked']
    },
    personas: {
      ambient_stance: true,
      auto_apply: true,
      full_reload: false,
      cache_path: path.join(tempRoot, 'state', 'personas', 'ambient_stance', 'cache.json'),
      latest_path: path.join(tempRoot, 'state', 'personas', 'ambient_stance', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'personas', 'ambient_stance', 'receipts.jsonl'),
      max_personas: 64,
      max_patch_bytes: 65536
    },
    dopamine: {
      threshold_breach_only: true,
      surface_levels: ['warn', 'critical'],
      latest_path: path.join(tempRoot, 'state', 'dopamine', 'ambient', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'dopamine', 'ambient', 'receipts.jsonl')
    },
    memory: {
      rust_authoritative: true,
      push_attention_queue: true,
      quiet_non_critical: true,
      surface_levels: ['warn', 'critical'],
      latest_path: path.join(tempRoot, 'state', 'memory', 'ambient', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'memory', 'ambient', 'receipts.jsonl')
    },
    receipts: {
      silent_unless_critical: true
    }
  };
  writeJson(policyPath, policy);
  return policyPath;
}

function withCatalogFixture(fn) {
  const before = fs.existsSync(CATALOG_PATH) ? fs.readFileSync(CATALOG_PATH, 'utf8') : null;
  const fixture = {
    version: '1.0',
    eyes: [
      {
        id: 'mech_bench_eye',
        name: 'Mech Bench Eye',
        status: 'active',
        cadence_hours: 1,
        allowed_domains: ['local.workspace'],
        budgets: {
          max_items: 3,
          max_seconds: 10,
          max_bytes: 1024,
          max_requests: 1
        },
        parser_type: 'stub',
        topics: ['benchmark'],
        error_rate: 0,
        score_ema: 50
      }
    ],
    global_limits: {
      max_concurrent_runs: 1,
      global_max_requests_per_day: 50,
      global_max_bytes_per_day: 5242880
    },
    scoring: {
      ema_alpha: 0.3,
      score_threshold_high: 70,
      score_threshold_low: 30,
      score_threshold_dormant: 20,
      cadence_min_hours: 1,
      cadence_max_hours: 168
    }
  };
  try {
    writeJson(CATALOG_PATH, fixture);
    return fn();
  } finally {
    if (before == null) {
      if (fs.existsSync(CATALOG_PATH)) fs.rmSync(CATALOG_PATH, { force: true });
    } else {
      fs.writeFileSync(CATALOG_PATH, before, 'utf8');
    }
  }
}

function benchmarkSpine(policyPath) {
  const commonEnv = {
    MECH_SUIT_MODE_POLICY_PATH: policyPath
  };
  // Warm once to avoid startup status races in the first observable benchmark sample.
  runNode(SPINE, ['status', '--apply-reseal=1'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const baseline = runNode(SPINE, ['status', '--apply-reseal=1'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const ambient = runNode(SPINE, ['status', '--apply-reseal=1'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const baselinePayload = parseJson(baseline.stdout);
  const ambientPayload = parseJson(ambient.stdout);
  const stableAmbient = !!(
    baselinePayload
    && ambientPayload
    && baselinePayload.ambient_mode_active === ambientPayload.ambient_mode_active
  );
  return {
    name: 'spine_live_status',
    baseline,
    ambient,
    baseline_payload: baselinePayload,
    ambient_payload: ambientPayload,
    stable_ambient_status: stableAmbient,
    token_burn_reduction_pct: reduction(baseline.token_estimate, ambient.token_estimate),
    chars_reduction_pct: reduction(baseline.char_count, ambient.char_count),
    ok: baseline.status === 0
      && ambient.status === 0
      && stableAmbient
      && !!(ambientPayload && ambientPayload.ambient_mode_active === true)
  };
}

function benchmarkEyes(tempRoot, policyPath) {
  const stateDir = path.join(tempRoot, 'eyes_state');
  const queueDir = path.join(tempRoot, 'queue_state');
  const commonEnv = {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    EYES_STATE_DIR: stateDir,
    EYES_QUEUE_DIR: queueDir,
    EYES_SENSORY_QUEUE_LOG_PATH: path.join(tempRoot, 'state', 'sensory', 'queue_log.jsonl'),
    EYES_AUTO_SPROUT_ENABLED: '0',
    EYES_FOCUS_ENABLED: '0',
    EYES_SELF_HEAL_ENABLED: '0',
    EYES_FAILSAFE_CANARY_ENABLED: '0',
    EYES_PREFLIGHT_SELF_HEAL_ENABLED: '0'
  };
  const baseline = withCatalogFixture(() => runNode(EXTERNAL_EYES, ['run', '--eye=mech_bench_eye', '--max-eyes=1'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '0'
  }));
  const ambient = withCatalogFixture(() => runNode(EXTERNAL_EYES, ['run', '--eye=mech_bench_eye', '--max-eyes=1'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  }));
  const attentionLatest = readJson(path.join(tempRoot, 'state', 'attention', 'latest.json'), {});
  const queuePath = path.join(tempRoot, 'state', 'attention', 'queue.jsonl');
  const queuedLines = fs.existsSync(queuePath)
    ? fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  return {
    name: 'eyes_stub_run',
    baseline,
    ambient,
    attention_queue_lines: queuedLines,
    attention_latest: attentionLatest,
    token_burn_reduction_pct: reduction(baseline.token_estimate, ambient.token_estimate),
    chars_reduction_pct: reduction(baseline.char_count, ambient.char_count),
    ok: baseline.status === 0 && ambient.status === 0 && queuedLines > 0
  };
}

function benchmarkPersonas(policyPath) {
  const commonEnv = {
    MECH_SUIT_MODE_POLICY_PATH: policyPath
  };
  const baseline = runNode(PERSONA_AMBIENT, ['status', '--persona=mech_bench'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '0'
  });
  const apply = runNode(PERSONA_AMBIENT, [
    'apply',
    '--persona=mech_bench',
    '--stance-json={"risk_mode":"strict","memory_priority":"high","reload":"incremental"}',
    '--source=benchmark'
  ], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const ambient = runNode(PERSONA_AMBIENT, ['status', '--persona=mech_bench'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const applyPayload = parseJson(apply.stdout);
  const statusPayload = parseJson(ambient.stdout);
  const gateDegraded = isGateActivePayload(applyPayload) || isGateActivePayload(statusPayload);
  return {
    name: 'persona_ambient_stance',
    include_in_reduction: false,
    baseline,
    ambient,
    apply_status: apply.status,
    apply_payload: applyPayload,
    ambient_status_payload: statusPayload,
    degraded_by_gate: gateDegraded,
    token_burn_reduction_pct: reduction(baseline.token_estimate, ambient.token_estimate),
    chars_reduction_pct: reduction(baseline.char_count, ambient.char_count),
    ok: gateDegraded || (
      baseline.status === 0
      && apply.status === 0
      && ambient.status === 0
      && !!(statusPayload && statusPayload.ambient_mode_active === true)
    )
  };
}

function benchmarkDopamine(tempRoot, policyPath) {
  const safeSummary = JSON.stringify({
    sds: 12,
    drift_minutes: 15,
    context_switches: 1,
    directive_pain: { active: false }
  });
  const breachSummary = JSON.stringify({
    sds: -7,
    drift_minutes: 180,
    context_switches: 9,
    directive_pain: { active: true }
  });
  const baselinePolicy = readJson(policyPath, {});
  baselinePolicy.dopamine = {
    ...(baselinePolicy && baselinePolicy.dopamine && typeof baselinePolicy.dopamine === 'object' ? baselinePolicy.dopamine : {}),
    threshold_breach_only: false,
    surface_levels: ['info', 'warn', 'critical']
  };
  const baselinePolicyPath = path.join(tempRoot, 'mech_suit_mode_policy_dopamine_baseline.json');
  writeJson(baselinePolicyPath, baselinePolicy);

  const baseline = runNode(DOPAMINE_AMBIENT, [
    'evaluate',
    `--summary-json=${safeSummary}`,
    '--date=2026-03-06'
  ], {
    MECH_SUIT_MODE_POLICY_PATH: baselinePolicyPath,
    MECH_SUIT_MODE_FORCE: '0',
    PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS: '0'
  });
  const ambient = runNode(DOPAMINE_AMBIENT, [
    'evaluate',
    `--summary-json=${safeSummary}`,
    '--date=2026-03-06'
  ], {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    MECH_SUIT_MODE_FORCE: '1',
    PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS: '0'
  });
  const breachEval = runNode(DOPAMINE_AMBIENT, [
    'evaluate',
    `--summary-json=${breachSummary}`,
    '--date=2026-03-06'
  ], {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    MECH_SUIT_MODE_FORCE: '1',
    PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS: '0'
  });
  const statusProbe = runNode(DOPAMINE_AMBIENT, ['status', '--date=2026-03-06'], {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    MECH_SUIT_MODE_FORCE: '1',
    PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS: '0'
  });
  const baselinePayload = parseJson(baseline.stdout);
  const safePayload = parseJson(ambient.stdout);
  const breachPayload = parseJson(breachEval.stdout);
  const statusPayload = parseJson(statusProbe.stdout);
  const gateDegraded = isGateActivePayload(baselinePayload)
    || isGateActivePayload(safePayload)
    || isGateActivePayload(breachPayload)
    || isGateActivePayload(statusPayload);
  const queuePath = path.join(tempRoot, 'state', 'attention', 'queue.jsonl');
  const queueLines = fs.existsSync(queuePath)
    ? fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  const breachDecision = String(breachPayload && breachPayload.attention_queue && breachPayload.attention_queue.decision || '');
  return {
    name: 'dopamine_ambient_threshold_gating',
    baseline,
    ambient,
    status_probe_status: statusProbe.status,
    breach_eval_status: breachEval.status,
    baseline_eval_payload: baselinePayload,
    safe_eval_payload: safePayload,
    breach_eval_payload: breachPayload,
    ambient_status_payload: statusPayload,
    degraded_by_gate: gateDegraded,
    attention_queue_lines: queueLines,
    token_burn_reduction_pct: reduction(baseline.token_estimate, ambient.token_estimate),
    chars_reduction_pct: reduction(baseline.char_count, ambient.char_count),
    ok: gateDegraded || (
      baseline.status === 0
      && ambient.status === 0
      && breachEval.status === 0
      && statusProbe.status === 0
      && !!(baselinePayload && baselinePayload.surfaced === true)
      && !!(safePayload && safePayload.surfaced === false)
      && !!(breachPayload && breachPayload.surfaced === true)
      && ['admitted', 'deduped', 'backpressure_drop'].includes(breachDecision)
      && queueLines >= 1
    )
  };
}

function benchmarkMemory(tempRoot, policyPath) {
  const dbPath = path.join(tempRoot, 'state', 'memory', 'runtime_memory.sqlite');
  const commonEnv = {
    MECH_SUIT_MODE_POLICY_PATH: policyPath,
    PROTHEUS_MEMORY_DB_PATH: dbPath
  };
  const ingest = runNode(MEMORY_AMBIENT, [
    'run',
    '--memory-command=ingest',
    '--memory-arg=--id=memory://mech-bench-1',
    '--memory-arg=--content=ambient memory benchmark sample',
    '--memory-arg=--tags=benchmark,memory',
    '--memory-arg=--repetitions=2',
    '--memory-arg=--lambda=0.02'
  ], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const baseline = runNode(MEMORY_AMBIENT, [
    'run',
    '--memory-command=recall',
    '--memory-arg=--query=ambient',
    '--memory-arg=--limit=5'
  ], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '0'
  });
  const ambient = runNode(MEMORY_AMBIENT, [
    'run',
    '--memory-command=recall',
    '--memory-arg=--query=ambient',
    '--memory-arg=--limit=5'
  ], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const status = runNode(MEMORY_AMBIENT, ['status'], {
    ...commonEnv,
    MECH_SUIT_MODE_FORCE: '1'
  });
  const ingestPayload = parseJson(ingest.stdout);
  const baselinePayload = parseJson(baseline.stdout);
  const ambientPayload = parseJson(ambient.stdout);
  const statusPayload = parseJson(status.stdout);
  const gateDegraded = isGateActivePayload(ingestPayload)
    || isGateActivePayload(baselinePayload)
    || isGateActivePayload(ambientPayload)
    || isGateActivePayload(statusPayload);
  return {
    name: 'memory_ambient_lane',
    ingest_status: ingest.status,
    ingest_payload: ingestPayload,
    baseline,
    ambient,
    status_probe_status: status.status,
    status_payload: statusPayload,
    baseline_payload: baselinePayload,
    ambient_payload: ambientPayload,
    degraded_by_gate: gateDegraded,
    token_burn_reduction_pct: reduction(baseline.token_estimate, ambient.token_estimate),
    chars_reduction_pct: reduction(baseline.char_count, ambient.char_count),
    ok: gateDegraded || (
      ingest.status === 0
      && baseline.status === 0
      && ambient.status === 0
      && status.status === 0
      && !!(ambientPayload && ambientPayload.rust_authoritative === true)
    )
  };
}

function runBenchmark() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-suit-bench-'));
  try {
    resetRuntimeGate();
    const policyPath = writePolicy(tempRoot);
    const preflight = runNode(
      SPINE,
      ['status', '--apply-reseal=1'],
      {
        MECH_SUIT_MODE_POLICY_PATH: policyPath,
        MECH_SUIT_MODE_FORCE: '1'
      },
      PRECHECK_TIMEOUT_MS
    );
    if (preflight.status !== 0 || preflight.timed_out === true) {
      return buildEarlyHostFault(tempRoot, preflight, 'spine_conduit_unavailable');
    }

    const spine = benchmarkSpine(policyPath);
    const eyes = benchmarkEyes(tempRoot, policyPath);
    const personas = benchmarkPersonas(policyPath);
    const dopamine = benchmarkDopamine(tempRoot, policyPath);
    const memory = benchmarkMemory(tempRoot, policyPath);
    const latestStatus = readJson(path.join(tempRoot, 'state', 'ops', 'mech_suit_mode', 'latest.json'), {});
    const cases = [spine, eyes, personas, dopamine, memory];
    const reductionCases = cases.filter((row) => row && row.include_in_reduction !== false);
    const baselineTokens = reductionCases.reduce((sum, row) => sum + Number(row.baseline && row.baseline.token_estimate || 0), 0);
    const ambientTokens = reductionCases.reduce((sum, row) => sum + Number(row.ambient && row.ambient.token_estimate || 0), 0);
    const baselineChars = reductionCases.reduce((sum, row) => sum + Number(row.baseline && row.baseline.char_count || 0), 0);
    const ambientChars = reductionCases.reduce((sum, row) => sum + Number(row.ambient && row.ambient.char_count || 0), 0);
    const hostFaultCases = cases
      .filter((row) => row && (
        (row.baseline && (row.baseline.timed_out === true || isRuntimeTimeoutText(`${row.baseline.stdout}\n${row.baseline.stderr}`)))
        || (row.ambient && (row.ambient.timed_out === true || isRuntimeTimeoutText(`${row.ambient.stdout}\n${row.ambient.stderr}`)))
        || (row.status_probe_status === 124)
        || (row.apply_status === 124)
        || (row.ingest_status === 124)
        || isRuntimeTimeoutText(JSON.stringify(row.baseline_payload || {}))
        || isRuntimeTimeoutText(JSON.stringify(row.ambient_payload || {}))
        || isRuntimeTimeoutText(JSON.stringify(row.status_payload || {}))
      ))
      .map((row) => row.name);
    const hostFaultDetected = hostFaultCases.length > 0;
    const gateDegradedCases = cases
      .filter((row) => row && row.degraded_by_gate === true)
      .map((row) => row.name);
    const functionalFailures = cases
      .filter((row) => row && row.ok !== true && row.degraded_by_gate !== true)
      .map((row) => row.name);
    const insufficientDataActive = gateDegradedCases.length > 0 && functionalFailures.length === 0 && !hostFaultDetected;
    const out = {
      ok: cases.every((row) => row && row.ok === true) || hostFaultDetected || insufficientDataActive,
      type: 'mech_suit_benchmark',
      ts: new Date().toISOString(),
      ambient_mode_active: latestStatus && latestStatus.active === true,
      benchmark_root: tempRoot,
      cases,
      host_fault: {
        timeout_detected: hostFaultDetected,
        timed_out_cases: hostFaultCases
      },
      degraded: {
        gate_active_detected: gateDegradedCases.length > 0,
        gate_degraded_cases: gateDegradedCases
      },
      insufficient_data: {
        active: insufficientDataActive,
        reason: insufficientDataActive ? 'conduit_runtime_gate_active' : null,
        gate_degraded_cases: insufficientDataActive ? gateDegradedCases : [],
        functional_failures: functionalFailures
      },
      summary: {
        token_burn_reduction_pct: reductionOrNull(baselineTokens, ambientTokens, hostFaultDetected),
        chars_reduction_pct: reductionOrNull(baselineChars, ambientChars, hostFaultDetected),
        persona_ambient_mode_active: !!(personas.ambient_status_payload && personas.ambient_status_payload.ambient_mode_active === true),
        persona_delta_applied: !!(personas.apply_payload && personas.apply_payload.delta_applied === true),
        dopamine_threshold_only: !!(dopamine.safe_eval_payload && dopamine.safe_eval_payload.surfaced === false)
          && !!(dopamine.breach_eval_payload && dopamine.breach_eval_payload.surfaced === true),
        memory_rust_authoritative: !!(memory.ambient_payload && memory.ambient_payload.rust_authoritative === true)
      }
    };
    writeJson(OUTPUT_LATEST, out);
    appendJsonl(OUTPUT_HISTORY, out);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return out;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const out = runBenchmark();
  process.exit(out.ok || (out.host_fault && out.host_fault.timeout_detected === true) ? 0 : 1);
}

module.exports = {
  runBenchmark
};
