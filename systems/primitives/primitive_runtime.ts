#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const { compileCommandToGrammar, compileActuationToGrammar } = require('./action_grammar.js');
const { evaluatePrimitivePolicy } = require('./policy_vm.js');
const { appendCanonicalEvent } = require('./canonical_event_log.js');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function previewCommandPrimitive(command: unknown, step: AnyObj = {}, context: AnyObj = {}, opts: AnyObj = {}) {
  const grammar = compileCommandToGrammar(command, {
    step_id: step && step.id ? step.id : '',
    step_type: step && step.type ? step.type : 'command',
    workflow_id: context && context.workflow_id ? context.workflow_id : '',
    run_id: context && context.run_id ? context.run_id : '',
    objective_id: context && context.objective_id ? context.objective_id : '',
    adapter: context && context.adapter ? context.adapter : '',
    provider: context && context.provider ? context.provider : '',
    dry_run: opts.dry_run === true
  });
  const policy = evaluatePrimitivePolicy(grammar, context, { dry_run: opts.dry_run === true });
  return {
    primitive: grammar,
    policy
  };
}

function deniedRun(reasonRaw: unknown, timeoutMs: number) {
  const ts = nowIso();
  const reason = cleanText(reasonRaw || 'primitive_policy_denied', 160) || 'primitive_policy_denied';
  return {
    ok: false,
    shell_ok: false,
    exit_code: 126,
    signal: null,
    timed_out: false,
    started_at: ts,
    ended_at: ts,
    duration_ms: 0,
    timeout_ms: timeoutMs,
    stdout: '',
    stderr: reason,
    error: reason
  };
}

function executeCommandPrimitiveSync(opts: AnyObj = {}) {
  const command = cleanText(opts.command || '', 4000);
  const step = opts.step && typeof opts.step === 'object' ? opts.step : {};
  const context = opts.context && typeof opts.context === 'object' ? opts.context : {};
  const timeoutMs = Number.isFinite(Number(opts.timeout_ms)) ? Number(opts.timeout_ms) : 120000;
  const dryRun = opts.dry_run === true;
  const grammar = compileCommandToGrammar(command, {
    step_id: step.id || null,
    step_type: step.type || 'command',
    workflow_id: context.workflow_id || null,
    run_id: context.run_id || null,
    objective_id: context.objective_id || null,
    adapter: context.adapter || null,
    provider: context.provider || null,
    dry_run: dryRun
  });
  const policy = evaluatePrimitivePolicy(grammar, context, { dry_run: dryRun });
  const started = nowIso();
  const startedEvent = appendCanonicalEvent({
    ts: started,
    type: 'primitive_execution',
    phase: 'start',
    run_id: context.run_id || null,
    workflow_id: context.workflow_id || null,
    step_id: step.id || null,
    opcode: grammar.opcode,
    effect: grammar.effect,
    payload: {
      dry_run: dryRun,
      policy_decision: policy.decision,
      command_hash: grammar.command_hash,
      primitive_metadata: grammar.primitive_metadata || null
    }
  });
  const eventIds = [startedEvent.event_id];
  const blocked = policy.ok !== true;

  if (dryRun) {
    const finishedEvent = appendCanonicalEvent({
      type: 'primitive_execution',
      phase: 'finish',
      run_id: context.run_id || null,
      workflow_id: context.workflow_id || null,
      step_id: step.id || null,
      opcode: grammar.opcode,
      effect: grammar.effect,
      ok: true,
      payload: {
        dry_run: true,
        policy_decision: policy.decision,
        result: 'preview_only'
      }
    });
    eventIds.push(finishedEvent.event_id);
    return {
      primitive: grammar,
      policy,
      blocked: false,
      run: {
        ok: true,
        shell_ok: true,
        exit_code: 0,
        signal: null,
        timed_out: false,
        started_at: started,
        ended_at: started,
        duration_ms: 0,
        stdout: '',
        stderr: '',
        error: null
      },
      event_ids: eventIds
    };
  }

  if (blocked) {
    const denied = deniedRun(policy.decision, timeoutMs);
    const finishedEvent = appendCanonicalEvent({
      type: 'primitive_execution',
      phase: 'finish',
      run_id: context.run_id || null,
      workflow_id: context.workflow_id || null,
      step_id: step.id || null,
      opcode: grammar.opcode,
      effect: grammar.effect,
      ok: false,
      payload: {
        dry_run: false,
        policy_decision: policy.decision,
        deny_reasons: policy.deny_reasons || []
      }
    });
    eventIds.push(finishedEvent.event_id);
    return {
      primitive: grammar,
      policy,
      blocked: true,
      run: denied,
      event_ids: eventIds
    };
  }

  const runner = typeof opts.runner === 'function' ? opts.runner : null;
  let run = null;
  let runnerError = null;
  try {
    run = runner
      ? runner({
        command,
        timeout_ms: timeoutMs,
        env: opts.env || process.env,
        cwd: opts.cwd || process.cwd(),
        primitive: grammar,
        policy
      })
      : deniedRun('primitive_runner_missing', timeoutMs);
  } catch (err) {
    runnerError = err;
  }

  if (!run || typeof run !== 'object') {
    run = deniedRun('primitive_runner_invalid_result', timeoutMs);
  }
  if (runnerError) {
    run = {
      ...run,
      ok: false,
      shell_ok: false,
      error: cleanText(runnerError && (runnerError as AnyObj).message ? (runnerError as AnyObj).message : runnerError, 240)
    };
  }

  const ok = run.ok === true;
  const finishedEvent = appendCanonicalEvent({
    type: 'primitive_execution',
    phase: 'finish',
    run_id: context.run_id || null,
    workflow_id: context.workflow_id || null,
    step_id: step.id || null,
    opcode: grammar.opcode,
    effect: grammar.effect,
    ok,
    payload: {
      dry_run: false,
      policy_decision: policy.decision,
      exit_code: Number.isFinite(Number(run.exit_code)) ? Number(run.exit_code) : null,
      duration_ms: Number.isFinite(Number(run.duration_ms)) ? Number(run.duration_ms) : null,
      stderr_hash: crypto.createHash('sha1').update(String(run.stderr || '')).digest('hex').slice(0, 16)
    }
  });
  eventIds.push(finishedEvent.event_id);
  return {
    primitive: grammar,
    policy,
    blocked: false,
    run,
    event_ids: eventIds
  };
}

async function executeActuationPrimitiveAsync(opts: AnyObj = {}) {
  const kind = cleanText(opts.kind || '', 80) || 'unknown_adapter';
  const params = opts.params && typeof opts.params === 'object' ? opts.params : {};
  const context = opts.context && typeof opts.context === 'object' ? opts.context : {};
  const dryRun = opts.dry_run === true;
  const grammar = compileActuationToGrammar(kind, params, {
    workflow_id: context.workflow_id || null,
    run_id: context.run_id || null,
    objective_id: context.objective_id || null,
    dry_run: dryRun
  });
  const policy = evaluatePrimitivePolicy(grammar, context, { dry_run: dryRun });

  const startEvent = appendCanonicalEvent({
    type: 'primitive_execution',
    phase: 'start',
    run_id: context.run_id || null,
    workflow_id: context.workflow_id || null,
    step_id: cleanText(opts.step_id || '', 120) || null,
    opcode: grammar.opcode,
    effect: grammar.effect,
    payload: {
      dry_run: dryRun,
      policy_decision: policy.decision,
      adapter_kind: kind,
      params_hash: grammar.params_hash,
      primitive_metadata: grammar.primitive_metadata || null
    }
  });
  const eventIds = [startEvent.event_id];

  if (policy.ok !== true) {
    const finishEvent = appendCanonicalEvent({
      type: 'primitive_execution',
      phase: 'finish',
      run_id: context.run_id || null,
      workflow_id: context.workflow_id || null,
      step_id: cleanText(opts.step_id || '', 120) || null,
      opcode: grammar.opcode,
      effect: grammar.effect,
      ok: false,
      payload: {
        dry_run: dryRun,
        policy_decision: policy.decision,
        deny_reasons: policy.deny_reasons || []
      }
    });
    eventIds.push(finishEvent.event_id);
    return {
      ok: false,
      blocked: true,
      primitive: grammar,
      policy,
      result: null,
      error: {
        message: cleanText(policy.deny_reasons && policy.deny_reasons[0] ? policy.deny_reasons[0] : policy.decision, 200)
      },
      duration_ms: 0,
      event_ids: eventIds
    };
  }

  const runner = typeof opts.runner === 'function' ? opts.runner : null;
  const started = Date.now();
  let result = null;
  let error = null;
  try {
    result = runner
      ? await runner({ primitive: grammar, policy, kind, params, context, dry_run: dryRun })
      : null;
  } catch (err) {
    error = err;
  }
  const durationMs = Date.now() - started;
  const ok = !error && result && result.ok === true;
  const finishEvent = appendCanonicalEvent({
    type: 'primitive_execution',
    phase: 'finish',
    run_id: context.run_id || null,
    workflow_id: context.workflow_id || null,
    step_id: cleanText(opts.step_id || '', 120) || null,
    opcode: grammar.opcode,
    effect: grammar.effect,
    ok,
    payload: {
      dry_run: dryRun,
      policy_decision: policy.decision,
      adapter_kind: kind,
      duration_ms: durationMs
    }
  });
  eventIds.push(finishEvent.event_id);

  return {
    ok,
    blocked: false,
    primitive: grammar,
    policy,
    result: result || null,
    error: error
      ? { message: cleanText((error as AnyObj).message ? (error as AnyObj).message : error, 240) }
      : null,
    duration_ms: durationMs,
    event_ids: eventIds
  };
}

module.exports = {
  previewCommandPrimitive,
  executeCommandPrimitiveSync,
  executeActuationPrimitiveAsync
};
