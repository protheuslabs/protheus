#!/usr/bin/env node
'use strict';

/**
 * canary_scheduler.js
 *
 * Readiness-gated autonomy scheduler:
 * - Runs autonomy only when readiness can_run=true
 * - Writes a deterministic scheduler receipt every invocation
 * - Records blocked readiness outcomes into autonomy run history
 *
 * Usage:
 *   node systems/autonomy/canary_scheduler.js run [YYYY-MM-DD]
 *   node systems/autonomy/canary_scheduler.js status [YYYY-MM-DD]
 *   node systems/autonomy/canary_scheduler.js --help
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { writeContractReceipt } = require('../../lib/action_receipts');
const { resolveRolloutPlan } = require('./autonomy_rollout_controller');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const RECEIPTS_DIR = process.env.AUTONOMY_RECEIPTS_DIR
  ? path.resolve(process.env.AUTONOMY_RECEIPTS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'receipts');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/canary_scheduler.js run [YYYY-MM-DD]');
  console.log('  node systems/autonomy/canary_scheduler.js run-once [YYYY-MM-DD]');
  console.log('  node systems/autonomy/canary_scheduler.js status [YYYY-MM-DD]');
  console.log('  node systems/autonomy/canary_scheduler.js --help');
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function dateArgOrToday(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : todayStr();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function shortText(v, max = 180) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function makeReceiptId(suffix) {
  const seed = `${Date.now()}_${process.pid}_${Math.random()}`;
  const rand = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
  const tail = String(suffix || 'event').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
  return `scheduler_${tail}_${rand}`;
}

function runNodeJson(scriptPath, args = [], envOverride = null) {
  const env = envOverride && typeof envOverride === 'object'
    ? { ...process.env, ...envOverride }
    : process.env;
  const r = spawnSync('node', [scriptPath, ...args], { cwd: ROOT, encoding: 'utf8', env });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      const line = stdout.split('\n').find((x) => x.trim().startsWith('{') && x.trim().endsWith('}'));
      if (line) {
        try { payload = JSON.parse(line); } catch {}
      }
    }
  }
  return {
    ok: r.status === 0,
    code: r.status == null ? 1 : r.status,
    payload,
    stdout,
    stderr
  };
}

function writeRunEvent(dateStr, evt) {
  appendJsonl(path.join(RUNS_DIR, `${dateStr}.jsonl`), evt);
}

function writeSchedulerReceipt(dateStr, receipt, contract = {}) {
  const c = (contract && typeof contract === 'object' ? contract : {}) as Record<string, any>;
  const filePath = path.join(RECEIPTS_DIR, `${dateStr}.jsonl`);
  return writeContractReceipt(filePath, receipt, {
    attempted: c.attempted === true,
    verified: c.verified === true
  });
}

function firstBlocker(readinessPayload) {
  const blockers = readinessPayload && Array.isArray(readinessPayload.blockers)
    ? readinessPayload.blockers
    : [];
  return blockers.length ? blockers[0] : null;
}

function receiptBase(dateStr, readinessPayload, intentReason) {
  return {
    ts: nowIso(),
    type: 'autonomy_action_receipt',
    receipt_id: makeReceiptId(intentReason),
    proposal_id: null,
    proposal_date: String(dateStr || ''),
    intent: {
      scheduler: true,
      reason: String(intentReason || ''),
      execution_mode: readinessPayload ? readinessPayload.execution_mode || null : null,
      strategy_id: readinessPayload ? readinessPayload.strategy_id || null : null
    }
  };
}

function schedulerQuality(attempted, verified, failReason) {
  return {
    attempted: attempted === true,
    verified: verified === true,
    fail_reason: failReason ? String(failReason).slice(0, 120) : null
  };
}

function readinessVerdict(readinessPayload) {
  const payload = readinessPayload && typeof readinessPayload === 'object'
    ? readinessPayload
    : {};
  const explicit = payload.preexec_verdict && typeof payload.preexec_verdict === 'object'
    ? payload.preexec_verdict
    : null;
  if (explicit) {
    return {
      verdict: String(explicit.verdict || 'unknown'),
      confidence: Number.isFinite(Number(explicit.confidence)) ? Number(explicit.confidence) : null,
      blocker_count: Number(explicit.blocker_count || 0),
      blocker_codes: Array.isArray(explicit.blocker_codes) ? explicit.blocker_codes.slice(0, 12) : [],
      manual_action_required: explicit.manual_action_required === true,
      next_runnable_at: explicit.next_runnable_at || null,
      signals: explicit.signals && typeof explicit.signals === 'object' ? explicit.signals : {}
    };
  }
  const blockers = Array.isArray(payload.blockers) ? payload.blockers : [];
  const blockerCodes = blockers
    .map((b) => String(b && b.code || '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const manualActionRequired = blockers.some((b) => b && b.retryable !== true);
  return {
    verdict: blockers.length === 0 ? 'proceed' : (manualActionRequired ? 'reject' : 'defer'),
    confidence: null,
    blocker_count: blockers.length,
    blocker_codes: blockerCodes,
    manual_action_required: manualActionRequired,
    next_runnable_at: payload.next_runnable_at || null,
    signals: {}
  };
}

function cmdStatus(dateStr) {
  const readiness = runNodeJson('systems/autonomy/autonomy_controller.js', ['readiness', dateStr]);
  const rollout = resolveRolloutPlan(dateStr, { autoEvaluate: false });
  process.stdout.write(JSON.stringify({
    ok: readiness.ok && !!(readiness.payload && readiness.payload.ok === true),
    ts: nowIso(),
    date: dateStr,
    readiness: readiness.payload || null,
    rollout: rollout && rollout.ok
      ? {
          stage: rollout.state && rollout.state.stage ? rollout.state.stage : null,
          decision: rollout.decision && rollout.decision.controller_cmd ? rollout.decision.controller_cmd : null,
          sampled_live: !!(rollout.decision && rollout.decision.sampled_live)
        }
      : null,
    error: readiness.ok ? null : shortText(readiness.stderr || readiness.stdout || `readiness_exit_${readiness.code}`, 200)
  }, null, 2) + '\n');
}

function cmdRun(dateStr, opts = {}) {
  const ts = nowIso();
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const runOnce = !!(o.runOnce === true);
  const rollout = !runOnce
    ? resolveRolloutPlan(dateStr, { autoEvaluate: true })
    : null;
  const rolloutDecision = rollout && rollout.ok && rollout.decision && typeof rollout.decision === 'object'
    ? rollout.decision
    : {};
  const controllerCmd = runOnce
    ? 'run'
    : (String(rolloutDecision.controller_cmd || '').trim().toLowerCase() === 'evidence' ? 'evidence' : 'run');
  const rolloutEnv = !runOnce && rolloutDecision && rolloutDecision.env && typeof rolloutDecision.env === 'object'
    ? rolloutDecision.env
    : null;
  const runEnv = {
    ...(runOnce ? { AUTONOMY_ENABLED: '1' } : {}),
    ...(rolloutEnv || {})
  };
  const requireReadiness = !runOnce && controllerCmd === 'run';
  const requireStartupAttestation = String(process.env.AUTONOMY_REQUIRE_STARTUP_ATTESTATION || '0') === '1';
  if (requireStartupAttestation && requireReadiness) {
    const att = runNodeJson('systems/security/startup_attestation.js', ['verify', '--strict']);
    const attPayload = att.payload && typeof att.payload === 'object' ? att.payload : null;
    const attOk = att.ok && !!(attPayload && attPayload.ok === true);
    if (!attOk) {
      const failCode = 'startup_attestation_blocked';
      const quality = schedulerQuality(false, false, failCode);
      writeRunEvent(dateStr, {
        ts,
        type: 'autonomy_run',
        result: 'stop_init_gate_startup_attestation',
        scheduler: true,
        scheduler_error: shortText(
          (attPayload && attPayload.reason) || att.stderr || att.stdout || `startup_attestation_exit_${att.code}`,
          180
        )
      });
      const rec = writeSchedulerReceipt(
        dateStr,
        {
          ...receiptBase(dateStr, null, failCode),
          verdict: 'fail',
          execution: {
            scheduler: true,
            startup_attestation_ok: false
          },
          verification: {
            passed: false,
            primary_failure: failCode,
            failed: [failCode]
          },
          scheduler_quality: quality
        },
        { attempted: false, verified: false }
      );
      process.stdout.write(JSON.stringify({
        ok: true,
        ts,
        date: dateStr,
        result: failCode,
        can_run: null,
        readiness: null,
        rollout: {
          stage: rollout && rollout.state ? rollout.state.stage || null : null,
          decision: controllerCmd
        },
        scheduler_receipt_id: rec.receipt_id,
        scheduler_quality: quality,
        error: shortText((attPayload && attPayload.reason) || att.stderr || att.stdout || `startup_attestation_exit_${att.code}`, 200)
      }, null, 2) + '\n');
      return;
    }
  }

  const readiness = requireReadiness
    ? runNodeJson('systems/autonomy/autonomy_controller.js', ['readiness', dateStr], runEnv)
    : { ok: true, code: 0, payload: { ok: true, can_run: true, shadow_only: true }, stdout: '', stderr: '' };
  const readinessPayload = readiness && readiness.payload && typeof readiness.payload === 'object'
    ? readiness.payload
    : null;
  const readinessOk = !!(readiness && readiness.ok && readinessPayload && readinessPayload.ok === true);
  const preexecVerdict = readinessVerdict(readinessPayload);

  if (!readinessOk && requireReadiness) {
    const failCode = 'readiness_unavailable';
    const quality = schedulerQuality(false, false, failCode);
    writeRunEvent(dateStr, {
      ts,
      type: 'autonomy_run',
      result: 'stop_init_gate_readiness_unavailable',
      scheduler: true,
      scheduler_error: shortText(readiness.stderr || readiness.stdout || `readiness_exit_${readiness.code}`, 180)
    });
    const rec = writeSchedulerReceipt(
      dateStr,
      {
        ...receiptBase(dateStr, null, failCode),
        verdict: 'fail',
        execution: {
          scheduler: true,
          readiness_ok: false,
          preexec_verdict: preexecVerdict
        },
        verification: {
          passed: false,
          primary_failure: failCode,
          failed: [failCode]
        },
        scheduler_quality: quality
      },
      { attempted: false, verified: false }
    );
    process.stdout.write(JSON.stringify({
      ok: true,
      ts,
      date: dateStr,
      result: failCode,
      can_run: null,
      readiness: null,
      preexec_verdict: preexecVerdict,
      rollout: {
        stage: rollout && rollout.state ? rollout.state.stage || null : null,
        decision: controllerCmd
      },
      scheduler_receipt_id: rec.receipt_id,
      scheduler_quality: quality,
      error: shortText(readiness.stderr || readiness.stdout || `readiness_exit_${readiness.code}`, 200)
    }, null, 2) + '\n');
    return;
  }

  if (requireReadiness && readinessPayload && readinessPayload.can_run !== true) {
    const blocker = firstBlocker(readinessPayload);
    const blockerCode = String(blocker && blocker.code || 'readiness_blocked');
    const quality = schedulerQuality(false, false, blockerCode);
    writeRunEvent(dateStr, {
      ts,
      type: 'autonomy_run',
      result: 'stop_init_gate_readiness_blocked',
      scheduler: true,
      strategy_id: readinessPayload.strategy_id || null,
      execution_mode: readinessPayload.execution_mode || null,
      readiness_blocker: blockerCode,
      blocker_count: Array.isArray(readinessPayload.blockers) ? readinessPayload.blockers.length : 0,
      manual_action_required: readinessPayload.manual_action_required === true,
      next_runnable_at: readinessPayload.next_runnable_at || null,
      preexec_verdict: preexecVerdict
    });
    const rec = writeSchedulerReceipt(
      dateStr,
      {
        ...receiptBase(dateStr, readinessPayload, blockerCode),
        verdict: 'fail',
        execution: {
          scheduler: true,
          readiness_ok: true,
          blocked: true,
          blocker_code: blockerCode,
          preexec_verdict: preexecVerdict
        },
        verification: {
          passed: false,
          primary_failure: blockerCode,
          failed: [blockerCode]
        },
        scheduler_quality: quality
      },
      { attempted: false, verified: false }
    );
    process.stdout.write(JSON.stringify({
      ok: true,
      ts,
      date: dateStr,
      result: 'skipped_blocked',
      can_run: false,
      readiness: readinessPayload,
      preexec_verdict: preexecVerdict,
      rollout: {
        stage: rollout && rollout.state ? rollout.state.stage || null : null,
        decision: controllerCmd,
        sampled_live: !!(rolloutDecision && rolloutDecision.sampled_live)
      },
      scheduler_receipt_id: rec.receipt_id,
      scheduler_quality: quality
    }, null, 2) + '\n');
    return;
  }

  const runRep = runNodeJson('systems/autonomy/autonomy_controller.js', [controllerCmd, dateStr], runEnv);
  const runPayload = runRep.payload && typeof runRep.payload === 'object' ? runRep.payload : null;
  const receiptFromRun = !!(runPayload && (runPayload.receipt_id || runPayload.preview_receipt_id));
  const runResult = String(runPayload && runPayload.result || (runRep.ok ? 'unknown' : `run_exit_${runRep.code}`));
  const runVerified = controllerCmd === 'evidence'
    ? runRep.ok
    : (
      !!(
        runPayload
        && runPayload.verification
        && runPayload.verification.passed === true
      ) || (runRep.ok && runResult === 'executed')
    );
  const runPrimaryFailure = runPayload && runPayload.verification && runPayload.verification.primary_failure
    ? String(runPayload.verification.primary_failure)
    : null;
  const quality = schedulerQuality(true, runVerified, runVerified ? null : (runPrimaryFailure || runResult));
  let schedulerReceiptId = null;

  if (!receiptFromRun) {
    const passed = runVerified;
    const rec = writeSchedulerReceipt(
      dateStr,
      {
        ...receiptBase(dateStr, readinessPayload, runResult),
        verdict: passed ? 'pass' : 'fail',
        execution: {
          scheduler: true,
          readiness_ok: requireReadiness ? true : null,
          preexec_verdict: preexecVerdict,
          controller_cmd: controllerCmd,
          rollout_stage: rollout && rollout.state ? rollout.state.stage || null : null,
          rollout_sampled_live: !!(rolloutDecision && rolloutDecision.sampled_live),
          run_ok: runRep.ok,
          run_result: runResult,
          run_code: runRep.code
        },
        verification: {
          passed,
          primary_failure: passed ? null : runResult,
          failed: passed ? [] : [runResult]
        },
        scheduler_quality: quality
      },
      { attempted: true, verified: passed }
    );
    schedulerReceiptId = rec.receipt_id;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    ts,
    date: dateStr,
    run_once: runOnce,
    controller_cmd: controllerCmd,
    result: String(runPayload && runPayload.result || (runRep.ok ? 'run_ok' : 'run_unavailable')),
    can_run: true,
    readiness: readinessPayload,
    preexec_verdict: preexecVerdict,
    rollout: {
      stage: rollout && rollout.state ? rollout.state.stage || null : null,
      decision: controllerCmd,
      sampled_live: !!(rolloutDecision && rolloutDecision.sampled_live),
      sample_value: rolloutDecision && rolloutDecision.sample_value != null
        ? Number(rolloutDecision.sample_value)
        : null,
      evaluate: rollout && rollout.evaluate && rollout.evaluate.ok === true
        ? {
            transition: !!(rollout.evaluate.transition && rollout.evaluate.transition.transition),
            reason: rollout.evaluate.transition ? rollout.evaluate.transition.reason || null : null,
            stage_after: rollout.evaluate.after ? rollout.evaluate.after.stage || null : null
          }
        : null
    },
    scheduler_quality: quality,
    run: {
      ok: runRep.ok,
      code: runRep.code,
      payload: runPayload,
      error: runRep.ok ? null : shortText(runRep.stderr || runRep.stdout || `run_exit_${runRep.code}`, 200)
    },
    scheduler_receipt_id: schedulerReceiptId
  }, null, 2) + '\n');
}

function main() {
  const cmd = String(process.argv[2] || '').trim();
  const dateStr = dateArgOrToday(process.argv[3]);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(dateStr, { runOnce: false });
  if (cmd === 'run-once') return cmdRun(dateStr, { runOnce: true });
  if (cmd === 'status') return cmdStatus(dateStr);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
export {};
