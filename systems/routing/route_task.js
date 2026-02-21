#!/usr/bin/env node
/**
 * route_task.js v1.2 - Directive Gate + Optional Model Router Integration
 * Decide: MANUAL vs RUN_HABIT vs RUN_CANDIDATE_FOR_VERIFICATION with T0/T1 tiered directive enforcement
 *
 * v1.2:
 * - Retains existing decision behavior
 * - Optionally annotates decisions with selected model from model_router.js
 *   when ROUTER_ENABLED=1
 *
 * Inputs:
 * --task "free text description"
 * --tokens_est 0
 * --repeats_14d 0
 * --errors_30d 0
 *
 * Output: JSON { decision, reason, gate_decision?, gate_reasons?, ... }
 */
const fs = require('fs');
const path = require('path');

// v1.1: Import directive gate for T0/T1 enforcement
const { evaluateTask, logGateDecision } = require('../security/directive_gate.js');
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'habits', 'registry.json');
const TRUSTED_HABITS_PATH = path.join(REPO_ROOT, 'config', 'trusted_habits.json');

function normalizeIntent(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d+)?(Z|[+-]\d{2}:\d{2})?/g, '')
    .replace(/["'][^"']*["']/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join('_');
}

function getArg(name, def = null) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  return (v === undefined) ? def : v;
}

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`registry.json not found at ${REGISTRY_PATH}`);
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function loadTrustedHabits() {
  if (!fs.existsSync(TRUSTED_HABITS_PATH)) return { trusted_files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(TRUSTED_HABITS_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { trusted_files: {} };
    if (!parsed.trusted_files || typeof parsed.trusted_files !== 'object') parsed.trusted_files = {};
    return parsed;
  } catch {
    return { trusted_files: {} };
  }
}

function requiredInputKeys(habit) {
  if (!habit || !habit.inputs_schema || !Array.isArray(habit.inputs_schema.required)) return [];
  return habit.inputs_schema.required
    .map(x => String(x || '').trim())
    .filter(Boolean);
}

function isTrustedEntrypoint(habit, trusted) {
  const entry = habit && habit.entrypoint ? String(habit.entrypoint) : '';
  if (!entry) return false;
  const resolved = path.resolve(REPO_ROOT, entry);
  const map = trusted && trusted.trusted_files ? trusted.trusted_files : {};
  return !!map[resolved];
}

function pickBestMatch(habits, intentKey, skipHabitId = '') {
  // Exact match on id
  let exact = habits.find(h => h.id === intentKey && h.id !== skipHabitId);
  if (exact) return exact;
  // Heuristic: if the task contains the habit id token
  const tokenMatch = habits.find(h => h.id !== skipHabitId && intentKey.includes(h.id));
  if (tokenMatch) return tokenMatch;
  return null;
}

function makeRunInputs(task, intentKey) {
  return {
    task: String(task || '').slice(0, 1000),
    intent_key: String(intentKey || '').slice(0, 120),
    source: 'route_task',
    ts: new Date().toISOString()
  };
}

function predictHabitId(intentKey, task) {
  const base = String(intentKey || normalizeIntent(task) || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return base || 'habit';
}

function jsonArg(obj) {
  return JSON.stringify(obj || {});
}

function estimateComplexity(tokensEst, task, match, anyTrigger) {
  if (tokensEst >= 2500) return 'high';
  if (tokensEst >= 800) return 'medium';
  if ((task || '').length >= 240) return 'medium';
  if (match || anyTrigger) return 'medium';
  return 'low';
}

function shouldUseRouter() {
  const raw = String(process.env.ROUTER_ENABLED == null ? '1' : process.env.ROUTER_ENABLED).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return true;
}

function shouldEmitFullRoute() {
  if (process.argv.includes('--full-route') || process.argv.includes('--full_route')) return true;
  const raw = String(process.env.ROUTE_TASK_FULL_ROUTE || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function compactRouteMeta(routeMeta) {
  if (!routeMeta || typeof routeMeta !== 'object') return routeMeta;
  if (shouldEmitFullRoute()) return routeMeta;
  const handoff = routeMeta.handoff_packet && typeof routeMeta.handoff_packet === 'object'
    ? routeMeta.handoff_packet
    : null;
  if (handoff) return handoff;
  return {
    selected_model: routeMeta.selected_model || null,
    previous_model: routeMeta.previous_model || null,
    model_changed: routeMeta.model_changed === true,
    reason: routeMeta.reason || null,
    tier: routeMeta.tier || null,
    role: routeMeta.role || null,
    slot: routeMeta.slot || null,
    mode: routeMeta.mode || null,
    route_class: routeMeta.route_class || null,
    task_type: routeMeta.task_type || null,
    escalation_chain: Array.isArray(routeMeta.escalation_chain) ? routeMeta.escalation_chain.slice(0, 3) : [],
    budget: routeMeta.budget && typeof routeMeta.budget === 'object'
      ? {
          pressure: routeMeta.budget.pressure || null,
          projected_pressure: routeMeta.budget.projected_pressure || null
        }
      : null
  };
}

function tryRouteModel({ gateRisk, complexity, intent, task, mode, forceModel, tokensEst }) {
  try {
    // Lazy require keeps route_task resilient if router file is missing.
    const { routeDecision } = require('../../systems/routing/model_router.js');
    const risk = gateRisk || 'medium';
    return routeDecision({
      risk,
      complexity,
      intent,
      task,
      mode,
      forceModel,
      tokensEst
    });
  } catch (err) {
    return {
      type: 'route_error',
      reason: String(err && err.message ? err.message : err).slice(0, 200)
    };
  }
}

function main() {
  const task = getArg('--task', '');
  const tokensEst = parseInt(getArg('--tokens_est', '0'), 10) || 0;
  const repeats14d = parseInt(getArg('--repeats_14d', '0'), 10) || 0;
  const errors30d = parseInt(getArg('--errors_30d', '0'), 10) || 0;
  const skipHabitId = getArg('--skip_habit_id', '') || getArg('--skip-habit-id', '');
  const mode = getArg('--mode', process.env.AGENT_MODE || 'normal');
  const forceModel = getArg('--force_model', process.env.ROUTER_FORCE_MODEL || '');

  const emergency = isEmergencyStopEngaged('routing');
  if (emergency.engaged) {
    const out = {
      decision: 'MANUAL',
      reason: 'routing emergency stop engaged',
      gate_decision: 'DENY',
      gate_risk: 'high',
      gate_reasons: ['emergency_stop_engaged'],
      gate_event: null,
      which_met: [],
      thresholds: {
        A: { repeats_14d_min: 3, tokens_min: 500, met: false },
        B: { tokens_min: 2000, met: false },
        C: { errors_30d_min: 2, met: false }
      },
      route: {
        type: 'route_blocked',
        reason: 'emergency_stop_engaged'
      },
      emergency_stop: emergency.state || null
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  
  // v1.1: Evaluate task through directive gate
  const gateResult = evaluateTask(task);
  const gateEvent = logGateDecision(task, gateResult, { tokens_est: tokensEst, source: 'route_task' });
  
  // Print gate summary line
  console.error(`GATE: ${gateResult.decision} - ${gateResult.reasons[0]}`);
  
  // v1.1: DENY trumps all - force immediate exit
  if (gateResult.decision === 'DENY') {
    const out = {
      decision: 'DENY',
      reason: `T0 violation blocked: ${gateResult.reasons.join('; ')}`,
      gate_decision: gateResult.decision,
      gate_risk: gateResult.risk,
      gate_reasons: gateResult.reasons,
      gate_event: gateEvent
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }
  
  // v1.1: MANUAL forces manual routing even if habit matched
  const gateOverridesToManual = gateResult.decision === 'MANUAL';
  
  const intentKey = normalizeIntent(task);
  const registry = loadRegistry();
  const habits = registry.habits || [];
  const trusted = loadTrustedHabits();
  const match = pickBestMatch(habits, intentKey, skipHabitId);
  
  // A/B/C triggers per Governance v1.0
  const triggerA = repeats14d >= 3 && tokensEst >= 500;
  const triggerB = tokensEst >= 2000;
  const triggerC = errors30d >= 2;
  const anyTrigger = triggerA || triggerB || triggerC;
  const intent = task ? task.split(/\s+/).slice(0, 6).join('_').toLowerCase() : 'task';
  const complexity = estimateComplexity(tokensEst, task, match, anyTrigger);

  // Optional router annotation (feature-flagged). Does not alter decision logic.
  const routeMeta = shouldUseRouter()
    ? tryRouteModel({
        gateRisk: gateResult.risk,
      complexity,
      intent,
      task,
      mode,
      forceModel,
      tokensEst
    })
    : null;
  const routeOut = compactRouteMeta(routeMeta);
  
  // Build triggers_met array
  const whichMet = [
    triggerA ? 'A' : null,
    triggerB ? 'B' : null,
    triggerC ? 'C' : null
  ].filter(Boolean);
  
  // Thresholds object for transparency
  const thresholds = {
    A: { repeats_14d_min: 3, tokens_min: 500, met: triggerA },
    B: { tokens_min: 2000, met: triggerB },
    C: { errors_30d_min: 2, met: triggerC }
  };
  
  // v1.1: Gate can force MANUAL even for active habits
  if (gateOverridesToManual) {
    const out = {
      decision: 'MANUAL',
      reason: `High-risk action requires manual approval: ${gateResult.reasons.join('; ')}`,
      suggested_habit_id: match ? match.id : null,
      executor: null,
      gate_decision: gateResult.decision,
      gate_risk: gateResult.risk,
      gate_reasons: gateResult.reasons,
      which_met: whichMet,
      thresholds: thresholds,
      gate_event: gateEvent,
      route: routeOut
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  
  // 1) If it matches an ACTIVE habit → RUN it.
  if (match && (match.governance && match.governance.state === 'active' || match.status === 'active')) {
    const req = requiredInputKeys(match);
    if (req.length > 0) {
      const out = {
        decision: 'MANUAL',
        suggested_habit_id: match.id,
        reason: `Matched active habit requires explicit inputs: ${req.join(', ')}`,
        required_inputs: req,
        executor: null,
        which_met: whichMet,
        thresholds: thresholds,
        gate_decision: gateResult.decision,
        gate_risk: gateResult.risk,
        route: routeOut
      };
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    if (!isTrustedEntrypoint(match, trusted)) {
      const out = {
        decision: 'MANUAL',
        suggested_habit_id: match.id,
        reason: `Matched active habit is not trusted: ${match.entrypoint}`,
        executor: null,
        which_met: whichMet,
        thresholds: thresholds,
        gate_decision: gateResult.decision,
        gate_risk: gateResult.risk,
        route: routeOut
      };
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    const inputs = makeRunInputs(task, intentKey);
    const inputsArg = jsonArg(inputs);
    const runArgs = ['habits/scripts/run_habit.js', '--id', match.id, '--json', inputsArg];
    const out = {
      decision: 'RUN_HABIT',
      suggested_habit_id: match.id,
      reason: `Matched active habit: ${match.id}`,
      run_command: `node habits/scripts/run_habit.js --id ${match.id} --json '${inputsArg.replace(/'/g, "'\\''")}'`,
      executor: { cmd: 'node', args: runArgs },
      which_met: whichMet,
      thresholds: thresholds,
      gate_decision: gateResult.decision,
      gate_risk: gateResult.risk,
      route: routeOut
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  
  // 2) If it matches a CANDIDATE habit → recommend running it (testing)
  if (match && (match.governance && match.governance.state === 'candidate' || match.status === 'candidate')) {
    const req = requiredInputKeys(match);
    if (req.length > 0) {
      const out = {
        decision: 'MANUAL',
        suggested_habit_id: match.id,
        reason: `Matched candidate habit requires explicit inputs: ${req.join(', ')}`,
        required_inputs: req,
        executor: null,
        which_met: whichMet,
        thresholds: thresholds,
        gate_decision: gateResult.decision,
        gate_risk: gateResult.risk,
        route: routeOut
      };
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    if (!isTrustedEntrypoint(match, trusted)) {
      const out = {
        decision: 'MANUAL',
        suggested_habit_id: match.id,
        reason: `Matched candidate habit is not trusted yet: ${match.entrypoint}`,
        executor: null,
        which_met: whichMet,
        thresholds: thresholds,
        gate_decision: gateResult.decision,
        gate_risk: gateResult.risk,
        route: routeOut
      };
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }

    const inputs = makeRunInputs(task, intentKey);
    const inputsArg = jsonArg(inputs);
    const runArgs = ['habits/scripts/run_habit.js', '--id', match.id, '--json', inputsArg];
    const out = {
      decision: 'RUN_CANDIDATE_FOR_VERIFICATION',
      suggested_habit_id: match.id,
      reason: `Matched candidate habit: ${match.id}. Run to accumulate successes before promotion.`,
      run_command: `node habits/scripts/run_habit.js --id ${match.id} --json '${inputsArg.replace(/'/g, "'\\''")}'`,
      executor: { cmd: 'node', args: runArgs },
      which_met: whichMet,
      thresholds: thresholds,
      gate_decision: gateResult.decision,
      gate_risk: gateResult.risk,
      route: routeOut
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  
  // 3) If no match exists, but triggers say "worth it" → auto-crystallize candidate + verify run.
  if (!match && anyTrigger) {
    const escapedTask = task.replace(/"/g, '\\"');
    const crystallizerPath = path.join(REPO_ROOT, 'habits', 'scripts', 'habit_crystallizer.js');
    const proposeScript = fs.existsSync(crystallizerPath)
      ? 'habits/scripts/habit_crystallizer.js'
      : 'habits/scripts/propose_habit.js';
    const autoTrust = String(process.env.ROUTE_TASK_AUTO_TRUST_CANDIDATE || '1') !== '0';
    const predictedHabitId = predictHabitId(intentKey, task);
    const proposeArgs = [
      proposeScript,
      '--from', task,
      '--tokens_est', String(tokensEst),
      '--repeats_14d', String(repeats14d),
      '--errors_30d', String(errors30d),
      '--intent_key', intentKey,
      '--auto_trust', autoTrust ? '1' : '0'
    ];
    const crystallizeCommand = `node ${proposeScript} --from "${escapedTask}" --tokens_est ${tokensEst} --repeats_14d ${repeats14d} --errors_30d ${errors30d} --intent_key "${intentKey}" --auto_trust ${autoTrust ? 1 : 0}`;
    const out = {
      decision: 'RUN_CANDIDATE_FOR_VERIFICATION',
      reason: `No matching habit. Triggers met: ${whichMet.join(',')}. Auto-crystallize candidate and verify.`,
      suggested_habit_id: predictedHabitId,
      auto_habit_flow: true,
      crystallize_command: crystallizeCommand,
      propose_command: crystallizeCommand,
      executor: { cmd: 'node', args: proposeArgs },
      which_met: whichMet,
      thresholds: thresholds,
      gate_decision: gateResult.decision,
      gate_risk: gateResult.risk,
      route: routeOut
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  
  // 4) Otherwise: manual.
  const state = match && match.governance ? match.governance.state : (match ? match.status : 'unknown');
  const out = {
    decision: 'MANUAL',
    reason: match
      ? `Matched habit exists but is state=${state}.`
      : 'No matching habit and triggers not met. Keep manual until repetition/cost/friction thresholds met.',
    executor: null,
    which_met: whichMet,
    thresholds: thresholds,
    gate_decision: gateResult.decision,
    gate_risk: gateResult.risk,
    route: routeOut
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (require.main === module) main();
module.exports = { normalizeIntent };
