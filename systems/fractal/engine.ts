#!/usr/bin/env node
'use strict';
export {};

/**
 * Fractal Engine v1 (V3-RACE-019)
 *
 * Loop:
 * telemetry -> critique -> mutation -> shadow trial -> two-gate apply -> reversion drill
 *
 * Hard invariants:
 * 1) Mutation tier <= 2 until confidence >= 99.7%
 * 2) All mutation decisions are event-sourced to the control-plane stream
 * 3) Soul anchor updates on successful applies
 * 4) Tier 3+ requires explicit human second-gate approval
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const telemetry = require('./telemetry_aggregator');
const critic = require('./critic');
const mutator = require('./mutator');
const shadowRunner = require('./shadow_trial_runner');
const twoGate = require('./two_gate_applier');
const reversion = require('./reversion_drill');

const FRACTAL_STATE_PATH = path.join(ROOT, 'systems', 'fractal', 'fractal_state.json');
const EVENT_STREAM_SCRIPT = path.join(ROOT, 'systems', 'ops', 'event_sourced_control_plane.js');
const SOUL_VECTOR_SCRIPT = path.join(ROOT, 'systems', 'symbiosis', 'soul_vector_substrate.js');
const GATED_LOOP_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'gated_self_improvement_loop.js');

const HARD_INVARIANTS = Object.freeze({
  max_risk_tier_before_high_confidence: 2,
  min_confidence_for_tier_gt2: 0.997,
  min_shadow_pass_rate_for_apply: 0.997,
  tier3_plus_requires_human_gate: true,
  cycle_interval_minutes: 15
});

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNodeJson(scriptPath: string, args: string[], timeoutMs = 30000) {
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return { ok: false, code: 127, payload: null, stderr: 'script_missing', stdout: '' };
  }
  const run = spawnSync('node', [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs)
  });
  return {
    ok: Number(run.status || 0) === 0,
    code: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: parseJsonFromStdout(run.stdout),
    stderr: cleanText(run.stderr || '', 900),
    stdout: cleanText(run.stdout || '', 900)
  };
}

function defaultState() {
  return {
    schema_id: 'fractal_engine_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    cycles: 0,
    successful_applies: 0,
    last_cycle_at: null,
    last_cycle_result: null,
    last_stream_event_count: 0,
    last_apply_event_count: 0,
    soul_vector_hash: null,
    last_anchor_update_at: null,
    last_anchor_mutation_id: null,
    anchor_cipher: 'sha256:bootstrap_pending',
    event_stream: {
      authority: 'jetstream',
      last_event_id: null,
      last_subject: null
    }
  };
}

function loadState() {
  const src = readJson(FRACTAL_STATE_PATH, null);
  const base = defaultState();
  if (!src || typeof src !== 'object') return base;
  return {
    ...base,
    ...src,
    event_stream: {
      ...base.event_stream,
      ...(src.event_stream && typeof src.event_stream === 'object' ? src.event_stream : {})
    }
  };
}

function encryptAnchor(payload: any) {
  const secret = String(process.env.FRACTAL_STATE_KEY || 'fractal_state_key_v1');
  return `sha256:${stableHash(`${secret}|${JSON.stringify(payload || {})}`, 64)}`;
}

function saveState(state: any) {
  writeJsonAtomic(FRACTAL_STATE_PATH, {
    schema_id: 'fractal_engine_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    cycles: Math.max(0, Number(state.cycles || 0)),
    successful_applies: Math.max(0, Number(state.successful_applies || 0)),
    last_cycle_at: state.last_cycle_at || null,
    last_cycle_result: state.last_cycle_result || null,
    last_stream_event_count: Math.max(0, Number(state.last_stream_event_count || 0)),
    last_apply_event_count: Math.max(0, Number(state.last_apply_event_count || 0)),
    soul_vector_hash: state.soul_vector_hash || null,
    last_anchor_update_at: state.last_anchor_update_at || null,
    last_anchor_mutation_id: state.last_anchor_mutation_id || null,
    anchor_cipher: cleanText(state.anchor_cipher || 'sha256:bootstrap_pending', 120) || 'sha256:bootstrap_pending',
    event_stream: {
      authority: cleanText(state.event_stream && state.event_stream.authority || 'jetstream', 40) || 'jetstream',
      last_event_id: state.event_stream && state.event_stream.last_event_id || null,
      last_subject: state.event_stream && state.event_stream.last_subject || null
    }
  });
}

function publishEvent(event: string, payload: any, options: any = {}) {
  const stream = normalizeToken(options.stream || 'fractal', 80) || 'fractal';
  const evt = normalizeToken(event || 'mutation', 80) || 'mutation';
  const payloadJson = JSON.stringify({
    schema_id: 'fractal_engine_event',
    schema_version: '1.0',
    ts: nowIso(),
    event: evt,
    ...payload
  });
  const run = runNodeJson(EVENT_STREAM_SCRIPT, [
    'append',
    `--stream=${stream}`,
    `--event=${evt}`,
    `--payload_json=${payloadJson}`
  ], clampInt(options.timeout_ms, 1000, 120000, 10000));

  return {
    ok: run.ok,
    event: evt,
    stream,
    receipt: run.payload || null,
    error: run.ok ? null : (run.stderr || 'event_stream_append_failed')
  };
}

function updateSoulAnchor(candidate: any, trialResult: any, state: any) {
  const refresh = runNodeJson(SOUL_VECTOR_SCRIPT, ['refresh'], 20000);
  const latestSoul = readJson(path.join(ROOT, 'state', 'symbiosis', 'soul_vector', 'latest.json'), null);
  const soulHash = latestSoul && (
    latestSoul.continuity_fingerprint
    || latestSoul.soul_vector_hash
    || (latestSoul.latest && latestSoul.latest.continuity_fingerprint)
  ) || null;

  const anchorPayload = {
    mutation_id: normalizeToken(candidate && candidate.id || candidate && candidate.candidate_id || '', 120) || null,
    proposal_id: normalizeToken(trialResult && trialResult.proposal_id || '', 160) || null,
    pass_rate: Number(trialResult && trialResult.passRate || 0),
    soul_vector_hash: soulHash,
    refreshed: refresh.ok === true,
    ts: nowIso()
  };

  state.soul_vector_hash = soulHash;
  state.last_anchor_update_at = anchorPayload.ts;
  state.last_anchor_mutation_id = anchorPayload.mutation_id;
  state.anchor_cipher = encryptAnchor(anchorPayload);

  return {
    ok: refresh.ok,
    soul_vector_hash: soulHash,
    refresh_code: refresh.code,
    refresh_error: refresh.ok ? null : (refresh.stderr || 'soul_refresh_failed')
  };
}

function applyMutation(candidate: any, trialResult: any, options: any = {}) {
  const applyLive = toBool(options.applyLive, false);
  const proposalId = normalizeToken(trialResult && trialResult.proposal_id || '', 160) || null;

  if (!applyLive || !proposalId) {
    return {
      ok: true,
      applied: false,
      mode: 'shadow_record_only',
      proposal_id: proposalId,
      reason: applyLive ? 'proposal_id_missing' : 'live_apply_disabled'
    };
  }

  const approvalA = cleanText(options.approvalA || options.approval_a || '', 120);
  const approvalB = cleanText(options.approvalB || options.approval_b || '', 120);
  const args = [
    'run',
    `--proposal-id=${proposalId}`,
    '--apply=1'
  ];
  if (approvalA) args.push(`--approval-a=${approvalA}`);
  if (approvalB) args.push(`--approval-b=${approvalB}`);

  const run = runNodeJson(GATED_LOOP_SCRIPT, args, 120000);
  return {
    ok: run.ok && !!(run.payload && run.payload.ok === true),
    applied: run.ok && !!(run.payload && run.payload.applied === true),
    mode: 'governed_live_apply',
    proposal_id: proposalId,
    receipt_id: run.payload && run.payload.receipt_id || null,
    stage: run.payload && run.payload.stage || null,
    error: run.ok ? null : (run.stderr || 'live_apply_failed')
  };
}

function runFractalCycle(options: any = {}) {
  const state = loadState();
  const cycleTs = nowIso();
  const model = cleanText(options.model || 'grok-4-deep', 80) || 'grok-4-deep';

  const telemetrySnapshot = telemetry.collect({
    paths: options.paths || {},
    window_hours: options.window_hours
  });

  const critique = critic.analyze(telemetrySnapshot, { model });

  publishEvent('critique', {
    confidence: critique.confidence,
    risk_tier_ceiling: critique.risk_tier_ceiling,
    findings: critique.findings
  });

  if (Number(critique.confidence || 0) < 0.85) {
    state.cycles += 1;
    state.last_cycle_at = cycleTs;
    state.last_stream_event_count = Number(telemetrySnapshot && telemetrySnapshot.stream && telemetrySnapshot.stream.event_count_window || 0);
    state.last_apply_event_count = Number(telemetrySnapshot && telemetrySnapshot.stream && telemetrySnapshot.stream.apply_count_window || 0);
    state.last_cycle_result = {
      ts: cycleTs,
      status: 'skipped_low_confidence',
      confidence: Number(critique.confidence || 0)
    };
    saveState(state);

    return {
      ok: true,
      type: 'fractal_cycle',
      ts: cycleTs,
      status: 'skipped_low_confidence',
      confidence: Number(critique.confidence || 0),
      candidates: 0,
      applies: 0
    };
  }

  const candidates = mutator.generate(critique, {
    maxMutations: clampInt(options.maxMutations, 1, 12, 3),
    respectConstitution: true
  });

  const applied = [];
  const skipped = [];

  for (const candidate of candidates) {
    const desiredTier = clampInt(candidate && candidate.risk_tier, 0, 9, 2);
    const effectiveTier = Number(critique.confidence || 0) >= HARD_INVARIANTS.min_confidence_for_tier_gt2
      ? desiredTier
      : Math.min(desiredTier, HARD_INVARIANTS.max_risk_tier_before_high_confidence);

    const trialResult = shadowRunner.run(candidate, {
      duration: cleanText(options.duration || '30m', 40) || '30m',
      timeout_ms: options.shadow_timeout_ms
    });

    if (Number(trialResult.passRate || 0) < HARD_INVARIANTS.min_shadow_pass_rate_for_apply) {
      skipped.push({
        candidate_id: candidate.id,
        reason: 'shadow_pass_rate_below_gate',
        pass_rate: Number(trialResult.passRate || 0)
      });
      publishEvent('trial_skip', {
        candidate_id: candidate.id,
        pass_rate: Number(trialResult.passRate || 0),
        reason: 'shadow_pass_rate_below_gate'
      });
      continue;
    }

    const approval = twoGate.approve(candidate, trialResult, {
      tier: effectiveTier,
      confidence_threshold: HARD_INVARIANTS.min_confidence_for_tier_gt2,
      max_tier_before_confidence: HARD_INVARIANTS.max_risk_tier_before_high_confidence,
      humanApprovalId: options.humanApprovalId || options.human_approval_id,
      remoteApproved: options.remoteApproved
    });

    if (!approval.approved) {
      skipped.push({
        candidate_id: candidate.id,
        reason: 'two_gate_denied',
        reasons: approval.reasons
      });
      publishEvent('apply_denied', {
        candidate_id: candidate.id,
        tier: effectiveTier,
        reasons: approval.reasons
      });
      continue;
    }

    const applyResult = applyMutation(candidate, trialResult, {
      applyLive: toBool(options.applyLive, false),
      approvalA: options.approvalA,
      approvalB: options.approvalB
    });

    const soulUpdate = updateSoulAnchor(candidate, trialResult, state);
    const streamReceipt = publishEvent('apply', {
      mutationId: candidate.id,
      candidate_id: candidate.id,
      proposal_id: trialResult.proposal_id,
      trial_pass_rate: Number(trialResult.passRate || 0),
      effective_tier: effectiveTier,
      apply_result: {
        applied: applyResult.applied,
        mode: applyResult.mode,
        receipt_id: applyResult.receipt_id || null
      },
      soul_vector_hash: soulUpdate.soul_vector_hash
    });

    const drill = reversion.scheduleDrill(candidate.id, '24h', {
      proposalId: trialResult.proposal_id,
      source: 'fractal_engine',
      reason: 'post_apply_reversion_drill'
    });

    applied.push({
      candidate_id: candidate.id,
      tier: effectiveTier,
      trial_pass_rate: Number(trialResult.passRate || 0),
      apply: applyResult,
      soul: soulUpdate,
      stream: streamReceipt,
      reversion_drill_id: drill.drill_id
    });

    state.successful_applies = Math.max(0, Number(state.successful_applies || 0)) + 1;
  }

  state.cycles = Math.max(0, Number(state.cycles || 0)) + 1;
  state.last_cycle_at = cycleTs;
  state.last_stream_event_count = Number(telemetrySnapshot && telemetrySnapshot.stream && telemetrySnapshot.stream.event_count_window || 0);
  state.last_apply_event_count = Number(telemetrySnapshot && telemetrySnapshot.stream && telemetrySnapshot.stream.apply_count_window || 0);
  state.last_cycle_result = {
    ts: cycleTs,
    status: 'completed',
    critique_confidence: Number(critique.confidence || 0),
    candidates: candidates.length,
    applied: applied.length,
    skipped: skipped.length
  };
  saveState(state);

  return {
    ok: true,
    type: 'fractal_cycle',
    ts: cycleTs,
    status: 'completed',
    invariants: HARD_INVARIANTS,
    critique,
    telemetry: telemetrySnapshot,
    candidates: candidates.length,
    applied,
    skipped,
    state_path: path.relative(ROOT, FRACTAL_STATE_PATH).replace(/\\/g, '/')
  };
}

function status() {
  return {
    ok: true,
    type: 'fractal_engine_status',
    ts: nowIso(),
    invariants: HARD_INVARIANTS,
    state: loadState(),
    reversion: reversion.status()
  };
}

function startPersistentLoop(options: any = {}) {
  const intervalMinutes = clampInt(
    options.intervalMinutes != null ? options.intervalMinutes : HARD_INVARIANTS.cycle_interval_minutes,
    1,
    24 * 60,
    HARD_INVARIANTS.cycle_interval_minutes
  );
  const intervalMs = intervalMinutes * 60 * 1000;

  const tick = () => {
    try {
      const out = runFractalCycle(options);
      process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        type: 'fractal_cycle',
        ts: nowIso(),
        error: cleanText(err && err.message || String(err), 280)
      })}\n`);
    }
  };

  tick();
  setInterval(tick, intervalMs);
  return {
    ok: true,
    type: 'fractal_engine_start',
    ts: nowIso(),
    interval_minutes: intervalMinutes,
    interval_ms: intervalMs
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/engine.ts run-once [--model=<id>] [--apply-live=0|1] [--max-mutations=N]');
  console.log('  node systems/fractal/engine.ts start [--interval-minutes=N] [--apply-live=0|1]');
  console.log('  node systems/fractal/engine.ts drills [--apply=0|1]');
  console.log('  node systems/fractal/engine.ts status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }

  if (cmd === 'run-once' || cmd === 'run') {
    emit(runFractalCycle({
      model: args.model,
      applyLive: toBool(args['apply-live'] != null ? args['apply-live'] : args.apply_live, false),
      maxMutations: args['max-mutations'] != null ? args['max-mutations'] : args.max_mutations,
      humanApprovalId: args['human-approval-id'] || args.human_approval_id,
      approvalA: args['approval-a'] || args.approval_a,
      approvalB: args['approval-b'] || args.approval_b,
      intervalMinutes: args['interval-minutes'] || args.interval_minutes
    }));
  }

  if (cmd === 'start') {
    emit(startPersistentLoop({
      intervalMinutes: args['interval-minutes'] || args.interval_minutes,
      applyLive: toBool(args['apply-live'] != null ? args['apply-live'] : args.apply_live, false),
      maxMutations: args['max-mutations'] != null ? args['max-mutations'] : args.max_mutations,
      humanApprovalId: args['human-approval-id'] || args.human_approval_id,
      approvalA: args['approval-a'] || args.approval_a,
      approvalB: args['approval-b'] || args.approval_b
    }));
  }

  if (cmd === 'drills') {
    emit(reversion.runDue({
      apply: toBool(args.apply, false),
      reason: args.reason
    }));
  }

  if (cmd === 'status') emit(status());

  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  HARD_INVARIANTS,
  runFractalCycle,
  startPersistentLoop,
  status,
  publishEvent,
  applyMutation,
  updateSoulAnchor,
  loadState,
  saveState
};
