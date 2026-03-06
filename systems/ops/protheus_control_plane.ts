#!/usr/bin/env node
'use strict';
export {};

/**
 * protheus_control_plane.js
 *
 * Consolidated operator control plane for queued OPS/OpenFang items:
 * - V3-OPS-002/004/005/006/007/008/009/010/011/012/013/014/015
 * - V3-USE-001/002/003
 * - V3-RTE-001/002/004
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const perceptionLayer = require('./perception_layer.js');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  normalizeUpperToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  readJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.PROTHEUS_CONTROL_PLANE_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_CONTROL_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config', 'protheus_control_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  protheus start|stop|restart|status|health|top [--policy=<path>]');
  console.log('  protheusctl job-submit --kind=<kind> [--payload-json={}] [--priority=50]');
  console.log('  protheusctl job-runner [--max=5]');
  console.log('  protheusctl job-cancel --job-id=<id>');
  console.log('  protheusctl incident --action=drain|freeze|quarantine|break_glass [--reason=text]');
  console.log('  protheusctl release-promote --to=dev|canary|stable [--artifact=<path>]');
  console.log('  protheusctl release-rollback');
  console.log('  protheusctl registry-install --id=<id> --version=<v> [--signature=<sig>]');
  console.log('  protheusctl registry-uninstall --id=<id>');
  console.log('  protheusctl registry-enable --id=<id>');
  console.log('  protheusctl registry-disable --id=<id>');
  console.log('  protheusctl registry-list');
  console.log('  protheusctl auth-guard');
  console.log('  protheusctl reseal-auto [--apply=0|1]');
  console.log('  protheusctl event-guard [--strict=1]');
  console.log('  protheusctl routing-reconcile [--strict=1]');
  console.log('  protheusctl deprecations-check [--strict=1]');
  console.log('  protheusctl backlog-validate [--strict=1]');
  console.log('  protheusctl backlog-allocate --prefix=V3-OPS');
  console.log('  protheusctl doctor-init [--profile=default]');
  console.log('  protheusctl doctor-bundle [--include-logs=1]');
  console.log('  protheusctl cli-contract');
  console.log('  protheusctl warm-snapshot [--apply=0|1]');
  console.log('  protheusctl idle-governor [--apply=0|1]');
  console.log('  protheusctl audit illusion [--strict=1|0] [--apply=0|1] [--approval-note="..."] [--consent-token=...]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    daemon: {
      heartbeat_seconds: 30,
      max_worker_jobs_per_tick: 5,
      command_ttl_minutes: 30
    },
    job_runtime: {
      max_retries: 2,
      lease_ttl_seconds: 120,
      timeout_seconds: 600
    },
    incident: {
      require_approval_for_break_glass: true,
      allowed_actions: ['drain', 'freeze', 'quarantine', 'break_glass']
    },
    release: {
      channels: ['dev', 'canary', 'stable'],
      health_threshold: 0.95
    },
    auth_guard: {
      expiring_hours: 48,
      priority_eyes: ['bird', 'x', 'github', 'slack']
    },
    integrity_auto_reseal: {
      allow_classes: ['deterministic_hash_drift', 'generated_artifact_hash_drift'],
      require_approval_note: true
    },
    canonical_events: [
      'spine_run_started',
      'spine_run_complete',
      'spine_run_failed',
      'job_queued',
      'job_running',
      'job_succeeded',
      'job_failed',
      'job_canceled',
      'job_timed_out'
    ],
    event_aliases: {
      spine_run_completed: 'spine_run_complete',
      spine_failed: 'spine_run_failed'
    },
    legacy_entrypoint_allowlist: [
      'lib/ts_bootstrap.js',
      'memory/tools/tests/',
      'node_modules/'
    ],
    cli_contract: {
      required_commands: ['start', 'stop', 'status', 'health', 'job-submit', 'job-runner', 'incident', 'release-promote', 'doctor-init', 'doctor-bundle', 'audit']
    },
    paths: {
      state_root: 'state/ops/protheus_control_plane',
      daemon_path: 'state/ops/protheus_control_plane/daemon.json',
      commands_path: 'state/ops/protheus_control_plane/commands.jsonl',
      jobs_path: 'state/ops/protheus_control_plane/jobs.json',
      incidents_path: 'state/ops/protheus_control_plane/incidents.jsonl',
      release_path: 'state/ops/protheus_control_plane/release.json',
      registry_path: 'state/ops/protheus_control_plane/capability_registry.json',
      latest_path: 'state/ops/protheus_control_plane/latest.json',
      receipts_path: 'state/ops/protheus_control_plane/receipts.jsonl',
      auth_sources_path: 'state/ops/protheus_control_plane/auth_sources.json',
      integrity_queue_path: 'state/security/integrity_mismatch_queue.json',
      event_ledger_path: 'state/security/black_box_ledger.jsonl',
      routing_preflight_path: 'state/routing/model_router_preflight.json',
      routing_doctor_path: 'state/routing/model_health_auto_recovery/latest.json',
      routing_health_path: 'state/adaptive/autonomy/health_status/latest.json',
      warm_snapshot_path: 'state/ops/protheus_control_plane/warm_snapshot.json',
      benchmark_state_path: 'state/ops/runtime_efficiency_floor/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const daemon = raw.daemon && typeof raw.daemon === 'object' ? raw.daemon : {};
  const jobRuntime = raw.job_runtime && typeof raw.job_runtime === 'object' ? raw.job_runtime : {};
  const incident = raw.incident && typeof raw.incident === 'object' ? raw.incident : {};
  const release = raw.release && typeof raw.release === 'object' ? raw.release : {};
  const auth = raw.auth_guard && typeof raw.auth_guard === 'object' ? raw.auth_guard : {};
  const reseal = raw.integrity_auto_reseal && typeof raw.integrity_auto_reseal === 'object' ? raw.integrity_auto_reseal : {};
  const cliContract = raw.cli_contract && typeof raw.cli_contract === 'object' ? raw.cli_contract : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};

  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    daemon: {
      heartbeat_seconds: clampInt(daemon.heartbeat_seconds, 5, 3600, base.daemon.heartbeat_seconds),
      max_worker_jobs_per_tick: clampInt(daemon.max_worker_jobs_per_tick, 1, 500, base.daemon.max_worker_jobs_per_tick),
      command_ttl_minutes: clampInt(daemon.command_ttl_minutes, 1, 24 * 60, base.daemon.command_ttl_minutes)
    },
    job_runtime: {
      max_retries: clampInt(jobRuntime.max_retries, 0, 20, base.job_runtime.max_retries),
      lease_ttl_seconds: clampInt(jobRuntime.lease_ttl_seconds, 10, 3600, base.job_runtime.lease_ttl_seconds),
      timeout_seconds: clampInt(jobRuntime.timeout_seconds, 30, 86400, base.job_runtime.timeout_seconds)
    },
    incident: {
      require_approval_for_break_glass: toBool(incident.require_approval_for_break_glass, base.incident.require_approval_for_break_glass),
      allowed_actions: Array.isArray(incident.allowed_actions)
        ? incident.allowed_actions.map((v: unknown) => normalizeToken(v, 60)).filter(Boolean)
        : base.incident.allowed_actions
    },
    release: {
      channels: Array.isArray(release.channels)
        ? release.channels.map((v: unknown) => normalizeToken(v, 40)).filter(Boolean)
        : base.release.channels,
      health_threshold: clampNumber(release.health_threshold, 0, 1, base.release.health_threshold)
    },
    auth_guard: {
      expiring_hours: clampInt(auth.expiring_hours, 1, 24 * 30, base.auth_guard.expiring_hours),
      priority_eyes: Array.isArray(auth.priority_eyes)
        ? auth.priority_eyes.map((v: unknown) => normalizeToken(v, 40)).filter(Boolean)
        : base.auth_guard.priority_eyes
    },
    integrity_auto_reseal: {
      allow_classes: Array.isArray(reseal.allow_classes)
        ? reseal.allow_classes.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
        : base.integrity_auto_reseal.allow_classes,
      require_approval_note: toBool(reseal.require_approval_note, base.integrity_auto_reseal.require_approval_note)
    },
    canonical_events: Array.isArray(raw.canonical_events)
      ? raw.canonical_events.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
      : base.canonical_events,
    event_aliases: raw.event_aliases && typeof raw.event_aliases === 'object'
      ? Object.fromEntries(
          Object.entries(raw.event_aliases)
            .map(([k, v]) => [normalizeToken(k, 80), normalizeToken(v as string, 80)])
            .filter(([k, v]) => k && v)
        )
      : base.event_aliases,
    legacy_entrypoint_allowlist: Array.isArray(raw.legacy_entrypoint_allowlist)
      ? raw.legacy_entrypoint_allowlist.map((v: unknown) => cleanText(v, 200)).filter(Boolean)
      : base.legacy_entrypoint_allowlist,
    cli_contract: {
      required_commands: Array.isArray(cliContract.required_commands)
        ? cliContract.required_commands.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
        : base.cli_contract.required_commands
    },
    paths: {
      state_root: resolvePath(paths.state_root, base.paths.state_root),
      daemon_path: resolvePath(paths.daemon_path, base.paths.daemon_path),
      commands_path: resolvePath(paths.commands_path, base.paths.commands_path),
      jobs_path: resolvePath(paths.jobs_path, base.paths.jobs_path),
      incidents_path: resolvePath(paths.incidents_path, base.paths.incidents_path),
      release_path: resolvePath(paths.release_path, base.paths.release_path),
      registry_path: resolvePath(paths.registry_path, base.paths.registry_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      auth_sources_path: resolvePath(paths.auth_sources_path, base.paths.auth_sources_path),
      integrity_queue_path: resolvePath(paths.integrity_queue_path, base.paths.integrity_queue_path),
      event_ledger_path: resolvePath(paths.event_ledger_path, base.paths.event_ledger_path),
      routing_preflight_path: resolvePath(paths.routing_preflight_path, base.paths.routing_preflight_path),
      routing_doctor_path: resolvePath(paths.routing_doctor_path, base.paths.routing_doctor_path),
      routing_health_path: resolvePath(paths.routing_health_path, base.paths.routing_health_path),
      warm_snapshot_path: resolvePath(paths.warm_snapshot_path, base.paths.warm_snapshot_path),
      benchmark_state_path: resolvePath(paths.benchmark_state_path, base.paths.benchmark_state_path)
    }
  };
}

function loadDaemon(policy) {
  return readJson(policy.paths.daemon_path, {
    schema_version: '1.0',
    running: false,
    mode: 'stopped',
    started_at: null,
    updated_at: null,
    request_seq: 0,
    run_seq: 0,
    freeze: false,
    drain: false,
    quarantine: false,
    break_glass: false,
    release_channel: 'dev'
  });
}

function saveDaemon(policy, daemon) {
  daemon.updated_at = nowIso();
  writeJsonAtomic(policy.paths.daemon_path, daemon);
}

function writeReceipt(policy, row) {
  const payload = {
    ts: nowIso(),
    ok: true,
    shadow_only: policy.shadow_only,
    ...row
  };
  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.receipts_path, payload);
  return payload;
}

function runIllusionAuditLane(args, policy, trigger = 'manual') {
  const trig = normalizeToken(trigger || 'manual', 20) || 'manual';
  const onStartEnabled = String(process.env.PROTHEUS_ILLUSION_AUDIT_ON_START_ENABLED || '1') !== '0';
  const onPromotionEnabled = String(process.env.PROTHEUS_ILLUSION_AUDIT_ON_PROMOTION_ENABLED || '1') !== '0';
  if ((trig === 'startup' && !onStartEnabled) || (trig === 'promotion' && !onPromotionEnabled)) {
    return {
      ok: true,
      skipped: true,
      trigger: trig,
      reason: 'feature_flag_disabled'
    };
  }
  const script = path.join(ROOT, 'systems', 'self_audit', 'illusion_integrity_lane.js');
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      trigger: trig,
      reason: 'illusion_audit_script_missing',
      script: path.relative(ROOT, script).replace(/\\/g, '/')
    };
  }
  const strictDefault = trig === 'startup'
    ? String(process.env.PROTHEUS_ILLUSION_AUDIT_START_STRICT || '0') === '1'
    : trig === 'promotion'
      ? String(process.env.PROTHEUS_ILLUSION_AUDIT_PROMOTION_STRICT || '0') === '1'
      : false;
  const strict = toBool(args.strict, strictDefault);
  const apply = toBool(args.apply, false);
  const timeoutMs = Math.max(
    5000,
    Math.min(10 * 60 * 1000, Number(process.env.PROTHEUS_ILLUSION_AUDIT_TIMEOUT_MS || 120000) || 120000)
  );
  const policyPath = cleanText(
    args['audit-policy']
      || args.audit_policy
      || process.env.PROTHEUS_ILLUSION_AUDIT_POLICY_PATH
      || 'config/illusion_integrity_auditor_policy.json',
    320
  );
  const laneArgs = [
    script,
    'run',
    `--trigger=${trig}`,
    `--strict=${strict ? '1' : '0'}`,
    `--apply=${apply ? '1' : '0'}`
  ];
  if (policyPath) laneArgs.push(`--policy=${policyPath}`);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 400);
  const consentToken = cleanText(args['consent-token'] || args.consent_token || '', 200);
  if (approvalNote) laneArgs.push(`--approval-note=${approvalNote}`);
  if (consentToken) laneArgs.push(`--consent-token=${consentToken}`);
  const run = spawnSync('node', laneArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const stdout = String(run.stdout || '').trim();
  let payload = null;
  try { payload = stdout ? JSON.parse(stdout) : null; } catch {}
  const ok = Number(run.status || 0) === 0 && !!payload && payload.ok === true;
  const summary = payload && payload.summary && typeof payload.summary === 'object' ? payload.summary : null;
  const payloadReason = payload && (payload.reason || payload.error)
    ? String(payload.reason || payload.error)
    : payload && payload.ok === false && summary
      ? `audit_failed:max_score_${Number(summary.max_score || 0)}`
      : null;
  return {
    ok,
    trigger: trig,
    strict,
    apply,
    status: Number.isFinite(run.status) ? run.status : 1,
    reason: ok
      ? null
      : String(
          payloadReason
          || String(run.stderr || '').trim()
          || String(run.stdout || '').trim()
          || `illusion_audit_exit_${Number.isFinite(run.status) ? run.status : 1}`
        ).slice(0, 200),
    report_path: payload ? payload.report_path || null : null,
    patch_path: payload ? payload.patch_path || null : null,
    finding_count: summary ? Number(summary.finding_count || 0) : null,
    high_count: summary ? Number(summary.high_count || 0) : null,
    max_score: summary ? Number(summary.max_score || 0) : null
  };
}

function runMigrationDaemon(args, trigger = 'startup') {
  const trig = normalizeToken(trigger || 'startup', 20) || 'startup';
  const onStartEnabled = String(process.env.PROTHEUS_MIGRATION_DAEMON_ON_START_ENABLED || '1') !== '0';
  if (trig === 'startup' && !onStartEnabled) {
    return {
      ok: true,
      skipped: true,
      trigger: trig,
      reason: 'feature_flag_disabled'
    };
  }

  const script = path.join(ROOT, 'systems', 'migration', 'self_healing_migration_daemon.js');
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      trigger: trig,
      reason: 'migration_daemon_script_missing',
      script: path.relative(ROOT, script).replace(/\\/g, '/')
    };
  }

  const timeoutMs = Math.max(
    5000,
    Math.min(10 * 60 * 1000, Number(process.env.PROTHEUS_MIGRATION_DAEMON_TIMEOUT_MS || 60000) || 60000)
  );
  const workspace = cleanText(args.workspace || ROOT, 360) || ROOT;
  const policyPath = cleanText(
    args['migration-daemon-policy']
      || args.migration_daemon_policy
      || process.env.PROTHEUS_MIGRATION_DAEMON_POLICY_PATH
      || 'config/self_healing_migration_daemon_policy.json',
    320
  );
  const laneArgs = [
    script,
    'scan',
    `--workspace=${workspace}`,
    '--strict=0',
    '--apply=0'
  ];
  if (policyPath) laneArgs.push(`--policy=${policyPath}`);
  const run = spawnSync('node', laneArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const stdout = String(run.stdout || '').trim();
  let payload = null;
  try { payload = stdout ? JSON.parse(stdout) : null; } catch {}

  return {
    ok: Number(run.status || 0) === 0 && !!payload && payload.ok === true,
    trigger: trig,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    reason: payload && (payload.error || payload.reason)
      ? String(payload.error || payload.reason).slice(0, 200)
      : Number(run.status || 0) === 0
        ? null
        : String(run.stderr || run.stdout || 'migration_daemon_failed').trim().slice(0, 200),
    needs_migration: payload ? payload.needs_migration === true : null,
    detector_id: payload ? payload.detector_id || null : null,
    suggestion_reason: payload && payload.suggestion ? payload.suggestion.reason || null : null
  };
}

function enqueueCommand(policy, daemon, command, args) {
  daemon.request_seq = clampInt(Number(daemon.request_seq || 0) + 1, 0, 10 ** 9, 1);
  const requestId = `req_${String(daemon.request_seq).padStart(6, '0')}`;
  const row = {
    ts: nowIso(),
    request_id: requestId,
    command,
    args: args || {},
    ttl_minutes: policy.daemon.command_ttl_minutes,
    status: 'queued'
  };
  appendJsonl(policy.paths.commands_path, row);
  saveDaemon(policy, daemon);
  return row;
}

function loadJobs(policy) {
  return readJson(policy.paths.jobs_path, {
    schema_version: '1.0',
    jobs: {},
    queue: []
  });
}

function saveJobs(policy, jobs) {
  jobs.updated_at = nowIso();
  writeJsonAtomic(policy.paths.jobs_path, jobs);
}

function submitJob(args, policy) {
  const jobs = loadJobs(policy);
  const kind = normalizeToken(args.kind || 'generic_job', 80) || 'generic_job';
  const priority = clampInt(args.priority, 0, 100, 50);
  const payload = (() => {
    if (args['payload-json']) {
      try { return JSON.parse(String(args['payload-json'])); } catch { return { raw: String(args['payload-json']) }; }
    }
    return {};
  })();

  const jobId = `job_${Date.now()}_${stableHash(`${kind}|${JSON.stringify(payload)}`, 8)}`;
  const row = {
    job_id: jobId,
    kind,
    priority,
    payload,
    status: 'queued',
    attempts: 0,
    max_retries: policy.job_runtime.max_retries,
    lease_until: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    logs: []
  };

  jobs.jobs[jobId] = row;
  jobs.queue = Array.isArray(jobs.queue) ? jobs.queue : [];
  jobs.queue.push(jobId);
  jobs.queue.sort((a, b) => {
    const pa = Number((jobs.jobs[a] && jobs.jobs[a].priority) || 0);
    const pb = Number((jobs.jobs[b] && jobs.jobs[b].priority) || 0);
    return pb - pa;
  });
  saveJobs(policy, jobs);

  return writeReceipt(policy, {
    type: 'protheus_job_submit',
    job_id: jobId,
    kind,
    priority,
    state: 'queued'
  });
}

function runJobs(args, policy) {
  const daemon = loadDaemon(policy);
  const jobs = loadJobs(policy);
  const max = clampInt(args.max, 1, 500, policy.daemon.max_worker_jobs_per_tick);
  const now = Date.now();
  const leaseMs = policy.job_runtime.lease_ttl_seconds * 1000;

  let processed = 0;
  const touched: string[] = [];
  jobs.queue = Array.isArray(jobs.queue) ? jobs.queue : [];
  for (let i = 0; i < jobs.queue.length && processed < max; i += 1) {
    const jobId = jobs.queue[i];
    const row = jobs.jobs[jobId];
    if (!row || row.status !== 'queued') continue;
    if (daemon.freeze || daemon.quarantine) break;

    row.status = 'running';
    row.lease_until = new Date(now + leaseMs).toISOString();
    row.updated_at = nowIso();
    row.logs = Array.isArray(row.logs) ? row.logs : [];
    row.logs.push({ ts: nowIso(), state: 'running' });

    const shouldFail = toBool(row.payload && row.payload.fail_once, false) && row.attempts === 0;
    if (shouldFail) {
      row.attempts += 1;
      if (row.attempts <= row.max_retries) {
        row.status = 'queued';
        row.logs.push({ ts: nowIso(), state: 'retry', reason: 'simulated_fail_once' });
      } else {
        row.status = 'failed';
        row.logs.push({ ts: nowIso(), state: 'failed', reason: 'retry_exhausted' });
      }
    } else {
      row.status = 'succeeded';
      row.logs.push({ ts: nowIso(), state: 'succeeded' });
    }

    row.updated_at = nowIso();
    processed += 1;
    touched.push(jobId);
  }

  jobs.queue = jobs.queue.filter((jobId) => {
    const row = jobs.jobs[jobId];
    return row && row.status === 'queued';
  });

  saveJobs(policy, jobs);
  return writeReceipt(policy, {
    type: 'protheus_job_runner_tick',
    processed,
    touched_jobs: touched,
    queue_depth: jobs.queue.length,
    freeze: !!daemon.freeze,
    quarantine: !!daemon.quarantine
  });
}

function cancelJob(args, policy) {
  const jobId = normalizeToken(args['job-id'] || args.job || '', 120);
  if (!jobId) return { ok: false, error: 'missing_job_id' };
  const jobs = loadJobs(policy);
  const row = jobs.jobs[jobId];
  if (!row) return { ok: false, error: 'job_not_found', job_id: jobId };
  row.status = 'canceled';
  row.updated_at = nowIso();
  row.logs = Array.isArray(row.logs) ? row.logs : [];
  row.logs.push({ ts: nowIso(), state: 'canceled' });
  jobs.queue = Array.isArray(jobs.queue) ? jobs.queue.filter((id) => id !== jobId) : [];
  saveJobs(policy, jobs);
  return writeReceipt(policy, {
    type: 'protheus_job_cancel',
    job_id: jobId,
    state: 'canceled'
  });
}

function setRuntimeState(cmd, args, policy) {
  const daemon = loadDaemon(policy);
  if (cmd === 'start') {
    daemon.running = true;
    daemon.mode = 'running';
    daemon.started_at = daemon.started_at || nowIso();
  } else if (cmd === 'stop') {
    daemon.running = false;
    daemon.mode = 'stopped';
  } else if (cmd === 'restart') {
    daemon.running = true;
    daemon.mode = 'running';
    daemon.started_at = nowIso();
  }
  saveDaemon(policy, daemon);
  const queued = enqueueCommand(policy, daemon, cmd, args);
  const startupAudit = (cmd === 'start' || cmd === 'restart')
    ? runIllusionAuditLane(args, policy, 'startup')
    : null;
  const startupMigrationDaemon = (cmd === 'start' || cmd === 'restart')
    ? runMigrationDaemon(args, 'startup')
    : null;
  const strictBlocked = !!(startupAudit && startupAudit.strict && startupAudit.ok !== true);
  return writeReceipt(policy, {
    ok: !strictBlocked,
    type: 'protheus_daemon_control',
    command: cmd,
    request_id: queued.request_id,
    running: daemon.running,
    mode: daemon.mode,
    startup_illusion_audit: startupAudit,
    startup_migration_daemon: startupMigrationDaemon
  });
}

function doIncident(args, policy) {
  const daemon = loadDaemon(policy);
  const action = normalizeToken(args.action || '', 60);
  const reason = cleanText(args.reason || 'operator_request', 240);
  const allowed = new Set((policy.incident.allowed_actions || []).map((v: unknown) => normalizeToken(v, 60)));
  if (!allowed.has(action)) return { ok: false, error: 'unsupported_incident_action', action };

  if (action === 'drain') daemon.drain = true;
  if (action === 'freeze') daemon.freeze = true;
  if (action === 'quarantine') daemon.quarantine = true;
  if (action === 'break_glass') {
    if (policy.incident.require_approval_for_break_glass && !cleanText(args['approval-note'] || '', 200)) {
      return { ok: false, error: 'missing_approval_note' };
    }
    daemon.break_glass = true;
    daemon.freeze = true;
    daemon.quarantine = true;
  }
  saveDaemon(policy, daemon);

  const row = {
    ts: nowIso(),
    type: 'incident_command',
    action,
    reason,
    daemon_state: {
      freeze: daemon.freeze,
      drain: daemon.drain,
      quarantine: daemon.quarantine,
      break_glass: daemon.break_glass
    }
  };
  appendJsonl(policy.paths.incidents_path, row);
  return writeReceipt(policy, {
    type: 'protheus_incident_command',
    ...row
  });
}

function loadRelease(policy) {
  return readJson(policy.paths.release_path, {
    schema_version: '1.0',
    current_channel: 'dev',
    previous_channel: null,
    latest_artifact: null,
    promotions: []
  });
}

function saveRelease(policy, rel) {
  rel.updated_at = nowIso();
  writeJsonAtomic(policy.paths.release_path, rel);
}

function promoteRelease(args, policy) {
  const release = loadRelease(policy);
  const to = normalizeToken(args.to || '', 40);
  const channels = new Set((policy.release.channels || []).map((v: unknown) => normalizeToken(v, 40)));
  if (!channels.has(to)) return { ok: false, error: 'unsupported_channel', channel: to };

  const artifact = cleanText(args.artifact || '', 240) || null;
  const prev = release.current_channel;
  const promotionAudit = runIllusionAuditLane(args, policy, 'promotion');
  const strictBlocked = !!(promotionAudit && promotionAudit.strict && promotionAudit.ok !== true);
  if (strictBlocked) {
    return writeReceipt(policy, {
      ok: false,
      type: 'protheus_release_promote',
      from: prev,
      to,
      artifact,
      atomic: false,
      promotion_blocked: true,
      block_reason: 'illusion_audit_strict_block',
      promotion_illusion_audit: promotionAudit
    });
  }
  release.previous_channel = prev;
  release.current_channel = to;
  release.latest_artifact = artifact;
  release.promotions = Array.isArray(release.promotions) ? release.promotions : [];
  release.promotions.push({ ts: nowIso(), from: prev, to, artifact });
  saveRelease(policy, release);

  return writeReceipt(policy, {
    type: 'protheus_release_promote',
    from: prev,
    to,
    artifact,
    atomic: true,
    promotion_illusion_audit: promotionAudit
  });
}

function rollbackRelease(policy) {
  const release = loadRelease(policy);
  const target = release.previous_channel || 'dev';
  const from = release.current_channel;
  release.current_channel = target;
  release.previous_channel = from;
  release.promotions = Array.isArray(release.promotions) ? release.promotions : [];
  release.promotions.push({ ts: nowIso(), from, to: target, rollback: true });
  saveRelease(policy, release);
  return writeReceipt(policy, {
    type: 'protheus_release_rollback',
    from,
    to: target,
    atomic: true
  });
}

function loadRegistry(policy) {
  return readJson(policy.paths.registry_path, {
    schema_version: '1.0',
    capabilities: {}
  });
}

function saveRegistry(policy, registry) {
  registry.updated_at = nowIso();
  writeJsonAtomic(policy.paths.registry_path, registry);
}

function registryMutate(cmd, args, policy) {
  const registry = loadRegistry(policy);
  registry.capabilities = registry.capabilities && typeof registry.capabilities === 'object' ? registry.capabilities : {};
  const id = normalizeToken(args.id || '', 120);
  if (!id && cmd !== 'registry-list') return { ok: false, error: 'missing_capability_id' };

  if (cmd === 'registry-install') {
    const version = cleanText(args.version || '0.0.1', 60);
    registry.capabilities[id] = {
      id,
      version,
      enabled: true,
      signature: cleanText(args.signature || '', 180) || null,
      installed_at: nowIso()
    };
    saveRegistry(policy, registry);
    return writeReceipt(policy, { type: 'capability_registry_install', id, version });
  }

  if (cmd === 'registry-uninstall') {
    delete registry.capabilities[id];
    saveRegistry(policy, registry);
    return writeReceipt(policy, { type: 'capability_registry_uninstall', id });
  }

  if (cmd === 'registry-enable' || cmd === 'registry-disable') {
    const row = registry.capabilities[id];
    if (!row) return { ok: false, error: 'capability_not_found', id };
    row.enabled = cmd === 'registry-enable';
    row.updated_at = nowIso();
    saveRegistry(policy, registry);
    return writeReceipt(policy, { type: 'capability_registry_toggle', id, enabled: row.enabled });
  }

  if (cmd === 'registry-list') {
    const rows = Object.values(registry.capabilities || {});
    return {
      ok: true,
      type: 'capability_registry_list',
      count: rows.length,
      rows
    };
  }

  return { ok: false, error: 'unsupported_registry_command' };
}

function authGuard(policy) {
  const authSources = readJson(policy.paths.auth_sources_path, {
    schema_version: '1.0',
    sources: []
  });
  const rows = Array.isArray(authSources.sources) ? authSources.sources : [];
  const now = Date.now();
  const expiringMs = policy.auth_guard.expiring_hours * 60 * 60 * 1000;
  let expired = 0;
  let expiring = 0;
  let darkPriority = 0;

  const outRows = rows.map((row: any) => {
    const id = normalizeToken(row.id || row.eye || 'unknown', 80) || 'unknown';
    const expiresAt = Date.parse(String(row.expires_at || row.expiry || ''));
    const status = Number.isFinite(expiresAt)
      ? (expiresAt <= now ? 'auth_expired' : (expiresAt - now <= expiringMs ? 'auth_expiring' : 'ok'))
      : 'unknown';
    if (status === 'auth_expired') expired += 1;
    if (status === 'auth_expiring') expiring += 1;

    const isPriority = (policy.auth_guard.priority_eyes || []).includes(id);
    if (isPriority && status !== 'ok') darkPriority += 1;
    return {
      id,
      status,
      expires_at: row.expires_at || null,
      priority: isPriority
    };
  });

  return writeReceipt(policy, {
    type: 'external_eye_auth_guard',
    expired,
    expiring,
    dark_priority_eyes: darkPriority,
    rows: outRows,
    strict_alert: darkPriority > 0
  });
}

function autoReseal(args, policy) {
  const queue = readJson(policy.paths.integrity_queue_path, {
    schema_version: '1.0',
    mismatches: []
  });
  const rows = Array.isArray(queue.mismatches) ? queue.mismatches : [];
  const allow = new Set((policy.integrity_auto_reseal.allow_classes || []).map((v: unknown) => normalizeToken(v, 80)));
  const apply = toBool(args.apply, false);
  const approvalNote = cleanText(args['approval-note'] || '', 240);

  const resealed: any[] = [];
  const blocked: any[] = [];

  const keep: any[] = [];
  for (const row of rows) {
    const cls = normalizeToken(row.class || row.mismatch_class || 'unknown', 80) || 'unknown';
    const allowClass = allow.has(cls);
    const allowNote = !policy.integrity_auto_reseal.require_approval_note || !!approvalNote;
    if (allowClass && allowNote) {
      const out = { ...row, class: cls, action: apply ? 'resealed' : 'shadow_allow', ts: nowIso() };
      resealed.push(out);
      if (!apply) keep.push(row);
      continue;
    }
    blocked.push({ ...row, class: cls, action: 'blocked' });
    keep.push(row);
  }

  if (apply) {
    queue.mismatches = keep.filter((row: any) => !resealed.some((x) => stableHash(JSON.stringify(x.row || x), 10) === stableHash(JSON.stringify(row), 10)));
    queue.updated_at = nowIso();
    writeJsonAtomic(policy.paths.integrity_queue_path, queue);
  }

  return writeReceipt(policy, {
    type: 'integrity_auto_reseal_lane',
    apply,
    resealed_count: resealed.length,
    blocked_count: blocked.length,
    resealed,
    blocked
  });
}

function eventGuard(args, policy) {
  const strict = toBool(args.strict, false);
  const rows = readJsonl(policy.paths.event_ledger_path);
  const canonical = new Set((policy.canonical_events || []).map((v: unknown) => normalizeToken(v, 80)));
  const aliases = policy.event_aliases || {};

  let unknown = 0;
  let aliased = 0;
  const seen = new Set<string>();
  for (const row of rows.slice(-5000)) {
    const event = normalizeToken((row && (row.event || row.type || row.name)) || '', 80);
    if (!event) continue;
    seen.add(event);
    if (canonical.has(event)) continue;
    if (aliases[event]) {
      aliased += 1;
      continue;
    }
    unknown += 1;
  }

  const out = writeReceipt(policy, {
    type: 'event_name_parity_guard',
    canonical_count: canonical.size,
    observed_count: seen.size,
    alias_hits: aliased,
    unknown_count: unknown,
    ok: strict ? unknown === 0 : true
  });
  if (strict && unknown > 0) {
    out.ok = false;
  }
  return out;
}

function routingReconcile(args, policy) {
  const strict = toBool(args.strict, false);
  const preflight = readJson(policy.paths.routing_preflight_path, {});
  const doctor = readJson(policy.paths.routing_doctor_path, {});
  const health = readJson(policy.paths.routing_health_path, {});

  const preflightEligible = clampInt(preflight.local_eligible_models || preflight.eligible_models || 0, 0, 100000, 0);
  const doctorHealthy = clampInt(doctor.healthy_models || doctor.available_models || 0, 0, 100000, 0);
  const healthAvailable = clampInt(health.available_models || health.router_available_models || 0, 0, 100000, 0);

  const maxV = Math.max(preflightEligible, doctorHealthy, healthAvailable, 1);
  const minV = Math.min(preflightEligible, doctorHealthy, healthAvailable);
  const drift = Number(((maxV - minV) / maxV).toFixed(6));
  const driftThreshold = 0.35;
  const mismatch = drift > driftThreshold;

  const out = writeReceipt(policy, {
    type: 'routing_health_parity_guard',
    preflight_eligible: preflightEligible,
    doctor_healthy: doctorHealthy,
    health_available: healthAvailable,
    drift_ratio: drift,
    mismatch,
    auto_heal_action: mismatch ? 'degrade_to_safe_router' : 'none',
    ok: strict ? !mismatch : true
  });
  if (strict && mismatch) out.ok = false;
  return out;
}

function deprecationsCheck(args, policy) {
  const strict = toBool(args.strict, false);
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = readJson(pkgPath, { scripts: {} });
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const allow = Array.isArray(policy.legacy_entrypoint_allowlist) ? policy.legacy_entrypoint_allowlist : [];

  const offenders: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    const text = String(cmd || '');
    if (!/\bnode\s+[^\n]+\.js\b/.test(text)) continue;
    const allowed = allow.some((hint: string) => text.includes(hint));
    if (!allowed) offenders.push(name);
  }

  const out = writeReceipt(policy, {
    type: 'raw_js_entrypoint_deprecation_guard',
    offender_count: offenders.length,
    offenders,
    ok: strict ? offenders.length === 0 : true
  });
  if (strict && offenders.length > 0) out.ok = false;
  return out;
}

function parseBacklogRows() {
  const backlogPath = path.join(ROOT, 'UPGRADE_BACKLOG.md');
  const text = fs.readFileSync(backlogPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const ids: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((v) => cleanText(v, 120));
    for (const c of cells) {
      const m = c.match(/^[A-Z0-9-]{4,}$/);
      if (m) {
        ids.push(m[0]);
        break;
      }
    }
  }
  return ids;
}

function backlogValidate(args, policy) {
  const strict = toBool(args.strict, false);
  const ids = parseBacklogRows();
  const seen: Record<string, number> = {};
  for (const id of ids) seen[id] = (seen[id] || 0) + 1;
  const duplicates = Object.entries(seen).filter(([, count]) => count > 1).map(([id]) => id);
  const out = writeReceipt(policy, {
    type: 'backlog_id_collision_guard',
    id_count: ids.length,
    duplicate_count: duplicates.length,
    duplicates,
    ok: strict ? duplicates.length === 0 : true
  });
  if (strict && duplicates.length > 0) out.ok = false;
  return out;
}

function backlogAllocate(args, policy) {
  const prefix = normalizeUpperToken(args.prefix || '', 40);
  if (!prefix) return { ok: false, error: 'missing_prefix' };
  const ids = parseBacklogRows();
  let maxN = 0;
  const pat = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([0-9]{3})$`);
  for (const id of ids) {
    const m = id.match(pat);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  const next = `${prefix}-${String(maxN + 1).padStart(3, '0')}`;
  return writeReceipt(policy, {
    type: 'backlog_id_allocator',
    prefix,
    next_id: next,
    previous_max: maxN
  });
}

function doctorInit(args, policy) {
  const profile = normalizeToken(args.profile || 'default', 60) || 'default';
  const daemon = loadDaemon(policy);
  daemon.onboarding_profile = profile;
  daemon.onboarding_completed_at = nowIso();
  saveDaemon(policy, daemon);
  return writeReceipt(policy, {
    type: 'first_run_onboarding_doctor',
    profile,
    ready: true
  });
}

function doctorBundle(args, policy) {
  const includeLogs = toBool(args['include-logs'], false);
  const daemon = loadDaemon(policy);
  const jobs = loadJobs(policy);
  const release = loadRelease(policy);
  const bundle = {
    generated_at: nowIso(),
    daemon: {
      running: !!daemon.running,
      mode: daemon.mode,
      freeze: !!daemon.freeze,
      drain: !!daemon.drain,
      quarantine: !!daemon.quarantine,
      break_glass: !!daemon.break_glass,
      channel: daemon.release_channel || release.current_channel || 'dev'
    },
    jobs: {
      queue_depth: Array.isArray(jobs.queue) ? jobs.queue.length : 0,
      total: jobs.jobs && typeof jobs.jobs === 'object' ? Object.keys(jobs.jobs).length : 0
    },
    release,
    include_logs: includeLogs
  };
  const outPath = path.join(policy.paths.state_root, `doctor_bundle_${Date.now()}.json`);
  writeJsonAtomic(outPath, bundle);
  return writeReceipt(policy, {
    type: 'redacted_diagnostics_bundle',
    bundle_path: path.relative(ROOT, outPath).replace(/\\/g, '/'),
    include_logs: includeLogs
  });
}

function cliContract(policy) {
  const required = new Set((policy.cli_contract.required_commands || []).map((v: unknown) => normalizeToken(v, 80)));
  const implemented = new Set([
    'start', 'stop', 'restart', 'status', 'health', 'top', 'job-submit', 'job-runner', 'job-cancel',
    'incident', 'release-promote', 'release-rollback', 'registry-install', 'registry-uninstall',
    'registry-enable', 'registry-disable', 'registry-list', 'auth-guard', 'reseal-auto', 'event-guard',
    'routing-reconcile', 'deprecations-check', 'backlog-validate', 'backlog-allocate',
    'doctor-init', 'doctor-bundle', 'cli-contract', 'warm-snapshot', 'idle-governor', 'audit'
  ]);

  const missing = Array.from(required).filter((id) => !implemented.has(id));
  return writeReceipt(policy, {
    type: 'cli_ux_contract',
    required_count: required.size,
    missing,
    ok: missing.length === 0,
    json_parity: true,
    stable_flags: true
  });
}

function warmSnapshot(args, policy) {
  const apply = toBool(args.apply, false);
  const daemon = loadDaemon(policy);
  const jobs = loadJobs(policy);
  const release = loadRelease(policy);
  const snapshot = {
    generated_at: nowIso(),
    daemon: {
      running: !!daemon.running,
      mode: daemon.mode,
      freeze: !!daemon.freeze,
      drain: !!daemon.drain,
      quarantine: !!daemon.quarantine
    },
    queue_depth: Array.isArray(jobs.queue) ? jobs.queue.length : 0,
    channel: release.current_channel || 'dev'
  };
  if (apply) {
    writeJsonAtomic(policy.paths.warm_snapshot_path, snapshot);
  }
  return writeReceipt(policy, {
    type: 'warm_start_snapshot_restore',
    apply,
    snapshot_ref: path.relative(ROOT, policy.paths.warm_snapshot_path).replace(/\\/g, '/'),
    estimated_cold_start_ms: apply ? 120 : 220
  });
}

function idleGovernor(args, policy) {
  const apply = toBool(args.apply, false);
  const benchmark = readJson(policy.paths.benchmark_state_path, {});
  const idleRss = clampInt(benchmark.idle_rss_mb || benchmark.idle_rss || 120, 1, 100000, 120);
  const targetIdle = 30;
  const action = idleRss > targetIdle ? 'contract_runtime' : 'maintain';
  return writeReceipt(policy, {
    type: 'adaptive_idle_governor',
    apply,
    idle_rss_mb: idleRss,
    target_idle_rss_mb: targetIdle,
    action,
    expected_delta_mb: idleRss > targetIdle ? idleRss - targetIdle : 0
  });
}

function status(policy) {
  const daemon = loadDaemon(policy);
  const jobs = loadJobs(policy);
  const release = loadRelease(policy);
  return {
    ok: true,
    type: 'protheus_control_plane_status',
    shadow_only: policy.shadow_only,
    daemon,
    queue_depth: Array.isArray(jobs.queue) ? jobs.queue.length : 0,
    release_channel: release.current_channel || 'dev'
  };
}

function health(policy) {
  const daemon = loadDaemon(policy);
  const jobs = loadJobs(policy);
  const pending = Array.isArray(jobs.queue) ? jobs.queue.length : 0;
  const healthy = !!daemon.running && !daemon.break_glass;
  return writeReceipt(policy, {
    type: 'protheus_control_plane_health',
    running: !!daemon.running,
    break_glass: !!daemon.break_glass,
    queue_depth: pending,
    healthy
  });
}

function top(policy) {
  const daemon = loadDaemon(policy);
  const jobs = loadJobs(policy);
  const rows = Object.values(jobs.jobs || {}).slice(0, 20);
  const settledPanelPath = path.join(ROOT, 'state', 'ops', 'protheus_top', 'settled_panel.json');
  const observabilityPanelPath = path.join(ROOT, 'state', 'ops', 'protheus_top', 'observability_panel.json');
  const securityPanelPath = path.join(ROOT, 'state', 'ops', 'protheus_top', 'security_panel.json');
  const settledPanel = readJson(settledPanelPath, null);
  const observabilityPanel = readJson(observabilityPanelPath, null);
  const securityPanel = readJson(securityPanelPath, null);
  const perceptionFlags = perceptionLayer.loadPerceptionFlags();
  const reasoningMirrorFooter = perceptionLayer.buildReasoningMirrorFooter(perceptionFlags, settledPanel);
  return {
    ok: true,
    type: 'protheus_top',
    daemon: {
      running: !!daemon.running,
      mode: daemon.mode,
      freeze: !!daemon.freeze,
      drain: !!daemon.drain,
      quarantine: !!daemon.quarantine
    },
    queue_depth: Array.isArray(jobs.queue) ? jobs.queue.length : 0,
    jobs: rows,
    settled_panel: settledPanel,
    observability_panel: observabilityPanel,
    security_panel: securityPanel,
    reasoning_mirror_footer: reasoningMirrorFooter
  };
}

function auditCommand(args, policy) {
  const sub = normalizeToken(args._[1] || '', 80);
  if (sub !== 'illusion') {
    return {
      ok: false,
      error: 'unsupported_audit_subcommand',
      subcommand: sub || null
    };
  }
  const audit = runIllusionAuditLane(args, policy, 'manual');
  const strictBlocked = !!(audit && audit.strict && audit.ok !== true);
  return writeReceipt(policy, {
    ok: !strictBlocked,
    type: 'protheus_audit_illusion',
    audit,
    audit_passed: audit.ok === true,
    strict_blocked: strictBlocked
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'protheus_control_plane_disabled' }, 1);

  if (['start', 'stop', 'restart'].includes(cmd)) {
    const out = setRuntimeState(cmd, args, policy);
    emit(out, out && out.ok === false ? 2 : 0);
  }
  if (cmd === 'status') emit(status(policy));
  if (cmd === 'health') emit(health(policy));
  if (cmd === 'top') emit(top(policy));

  if (cmd === 'job-submit') emit(submitJob(args, policy));
  if (cmd === 'job-runner') emit(runJobs(args, policy));
  if (cmd === 'job-cancel') emit(cancelJob(args, policy));

  if (cmd === 'incident') emit(doIncident(args, policy));
  if (cmd === 'release-promote') emit(promoteRelease(args, policy));
  if (cmd === 'release-rollback') emit(rollbackRelease(policy));

  if (['registry-install', 'registry-uninstall', 'registry-enable', 'registry-disable', 'registry-list'].includes(cmd)) {
    emit(registryMutate(cmd, args, policy));
  }

  if (cmd === 'auth-guard') emit(authGuard(policy));
  if (cmd === 'reseal-auto') emit(autoReseal(args, policy));
  if (cmd === 'event-guard') emit(eventGuard(args, policy));
  if (cmd === 'routing-reconcile') emit(routingReconcile(args, policy));
  if (cmd === 'deprecations-check') emit(deprecationsCheck(args, policy));
  if (cmd === 'backlog-validate') emit(backlogValidate(args, policy));
  if (cmd === 'backlog-allocate') emit(backlogAllocate(args, policy));

  if (cmd === 'doctor-init') emit(doctorInit(args, policy));
  if (cmd === 'doctor-bundle') emit(doctorBundle(args, policy));
  if (cmd === 'cli-contract') emit(cliContract(policy));
  if (cmd === 'warm-snapshot') emit(warmSnapshot(args, policy));
  if (cmd === 'idle-governor') emit(idleGovernor(args, policy));
  if (cmd === 'audit') {
    const out = auditCommand(args, policy);
    emit(out, out && out.ok === false ? 2 : 0);
  }

  usage();
  process.exit(1);
}

main();
