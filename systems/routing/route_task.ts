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
const { spawnSync } = require('child_process');

// v1.1: Import directive gate for T0/T1 enforcement
const { evaluateTask, logGateDecision } = require('../security/directive_gate');
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'habits', 'registry.json');
const TRUSTED_HABITS_PATH = path.join(REPO_ROOT, 'config', 'trusted_habits.json');
const REFLEX_ROUTINES_PATH = process.env.REFLEX_ROUTINES_PATH
  ? path.resolve(process.env.REFLEX_ROUTINES_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'reflex', 'routines.json');

function parseJsonPayload(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function isTsFallbackEnabled() {
  const raw = String(process.env.ROUTE_TASK_TS_FALLBACK || '0').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function executionBinaryCandidates() {
  const explicit = String(process.env.PROTHEUS_EXECUTION_RUST_BIN || '').trim();
  const binOnly = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.PROTHEUS_EXECUTION_RUST_BIN_ONLY || '0').trim().toLowerCase()
  );
  if (binOnly) {
    return explicit ? [explicit] : [];
  }
  return Array.from(new Set([
    explicit,
    path.join(REPO_ROOT, 'target', 'release', 'execution_core'),
    path.join(REPO_ROOT, 'target', 'debug', 'execution_core'),
    path.join(REPO_ROOT, 'crates', 'execution', 'target', 'release', 'execution_core'),
    path.join(REPO_ROOT, 'crates', 'execution', 'target', 'debug', 'execution_core')
  ].filter(Boolean)));
}

function runRoutePrimitivesViaRust(task, tokensEst, repeats14d, errors30d) {
  const payload = JSON.stringify({
    task_text: String(task || ''),
    tokens_est: Number(tokensEst || 0),
    repeats_14d: Number(repeats14d || 0),
    errors_30d: Number(errors30d || 0)
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  for (const candidate of executionBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, ['route-primitives', `--payload-base64=${payloadB64}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) === 0 && parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function runRouteMatchViaRust(intentKey, habits, skipHabitId) {
  const payload = JSON.stringify({
    intent_key: String(intentKey || ''),
    skip_habit_id: String(skipHabitId || ''),
    habits: Array.isArray(habits)
      ? habits.map((h) => ({ id: String(h && h.id || '') }))
      : []
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  let sawBinary = false;
  for (const candidate of executionBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      sawBinary = true;
      const out = spawnSync(candidate, ['route-match', `--payload-base64=${payloadB64}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') continue;
      const matchedId = String(parsed.matched_habit_id || '').trim();
      return { ok: true, matchedId: matchedId || null };
    } catch {
      // try next candidate
    }
  }
  return {
    ok: false,
    error: sawBinary ? 'route_match_invalid_output' : 'route_match_rust_unavailable',
    matchedId: null
  };
}

function runRouteReflexMatchViaRust(intentKey, task, routinesMap) {
  const routines = Array.isArray(Object.values(routinesMap || {}))
    ? Object.values(routinesMap || {})
    : [];
  const payload = JSON.stringify({
    intent_key: String(intentKey || ''),
    task_text: String(task || ''),
    routines: routines.map((r) => ({
      id: String(r && r.id || ''),
      status: String(r && r.status || ''),
      tags: Array.isArray(r && r.tags) ? r.tags.map((t) => String(t || '')) : []
    }))
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  let sawBinary = false;
  for (const candidate of executionBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      sawBinary = true;
      const out = spawnSync(candidate, ['route-reflex-match', `--payload-base64=${payloadB64}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') continue;
      const matchedId = String(parsed.matched_reflex_id || '').trim();
      return {
        ok: true,
        matchedRoutine: matchedId
          ? (routines.find((r) => String(r && r.id || '') === matchedId) || null)
          : null
      };
    } catch {
      // try next candidate
    }
  }
  return {
    ok: false,
    error: sawBinary ? 'route_reflex_match_invalid_output' : 'route_reflex_match_rust_unavailable',
    matchedRoutine: null
  };
}

function runRouteComplexityViaRust(task, tokensEst, hasMatch, anyTrigger) {
  const payload = JSON.stringify({
    task_text: String(task || ''),
    tokens_est: Number(tokensEst || 0),
    has_match: hasMatch === true,
    any_trigger: anyTrigger === true
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  let sawBinary = false;
  for (const candidate of executionBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      sawBinary = true;
      const out = spawnSync(candidate, ['route-complexity', `--payload-base64=${payloadB64}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') continue;
      const complexity = String(parsed.complexity || '').trim().toLowerCase();
      if (!['low', 'medium', 'high'].includes(complexity)) continue;
      return { ok: true, complexity };
    } catch {
      // try next candidate
    }
  }
  return {
    ok: false,
    error: sawBinary ? 'route_complexity_invalid_output' : 'route_complexity_rust_unavailable',
    complexity: null
  };
}

function runRouteEvaluateViaRust(task, tokensEst, repeats14d, errors30d, skipHabitId, habits, reflexRoutines) {
  const routines = Array.isArray(Object.values(reflexRoutines || {}))
    ? Object.values(reflexRoutines || {})
    : [];
  const payload = JSON.stringify({
    task_text: String(task || ''),
    tokens_est: Number(tokensEst || 0),
    repeats_14d: Number(repeats14d || 0),
    errors_30d: Number(errors30d || 0),
    skip_habit_id: String(skipHabitId || ''),
    habits: Array.isArray(habits)
      ? habits.map((h) => ({ id: String(h && h.id || '') }))
      : [],
    reflex_routines: routines.map((r) => ({
      id: String(r && r.id || ''),
      status: String(r && r.status || ''),
      tags: Array.isArray(r && r.tags) ? r.tags.map((t) => String(t || '')) : []
    }))
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  let sawBinary = false;
  for (const candidate of executionBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      sawBinary = true;
      const out = spawnSync(candidate, ['route-evaluate', `--payload-base64=${payloadB64}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') continue;
      return { ok: true, payload: parsed, routines };
    } catch {
      // try next candidate
    }
  }
  return {
    ok: false,
    error: sawBinary ? 'route_evaluate_invalid_output' : 'route_evaluate_rust_unavailable',
    payload: null,
    routines
  };
}

function runRouteDecisionViaRust(payloadObj) {
  const payload = JSON.stringify(payloadObj || {});
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  let sawBinary = false;
  for (const candidate of executionBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      sawBinary = true;
      const out = spawnSync(candidate, ['route-decision', `--payload-base64=${payloadB64}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) !== 0 || !parsed || typeof parsed !== 'object') continue;
      const decision = String(parsed.decision || '').trim();
      if (!['RUN_REFLEX', 'RUN_HABIT', 'RUN_CANDIDATE_FOR_VERIFICATION', 'MANUAL'].includes(decision)) {
        continue;
      }
      return { ok: true, payload: parsed };
    } catch {
      // try next candidate
    }
  }
  return {
    ok: false,
    error: sawBinary ? 'route_decision_invalid_output' : 'route_decision_rust_unavailable',
    payload: null
  };
}

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

function loadReflexRoutines() {
  if (!fs.existsSync(REFLEX_ROUTINES_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(REFLEX_ROUTINES_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed.routines && typeof parsed.routines === 'object' ? parsed.routines : {};
  } catch {
    return {};
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

function resolveHabitMatch(habits, intentKey, skipHabitId = '') {
  const rustOut = runRouteMatchViaRust(intentKey, habits, skipHabitId);
  if (rustOut && rustOut.ok === true) {
    if (!rustOut.matchedId) return { ok: true, match: null };
    const found = habits.find((h) => String(h && h.id || '') === rustOut.matchedId) || null;
    return { ok: true, match: found };
  }
  if (isTsFallbackEnabled()) {
    return { ok: true, match: pickBestMatch(habits, intentKey, skipHabitId) };
  }
  return {
    ok: false,
    error: rustOut && rustOut.error ? rustOut.error : 'route_match_rust_unavailable',
    match: null
  };
}

function pickReflexMatch(routinesMap, intentKey, task) {
  const rows = Object.values(routinesMap || {}) as Array<Record<string, any>>;
  if (!rows.length) return null;
  const direct = rows.find((r) => {
    if (!r || String(r.status || '').toLowerCase() !== 'enabled') return false;
    const id = String(r.id || '').trim().toLowerCase();
    return id && (id === String(intentKey || '').toLowerCase() || String(intentKey || '').includes(id));
  });
  if (direct) return direct;
  const text = String(task || '').toLowerCase();
  return rows.find((r) => {
    if (!r || String(r.status || '').toLowerCase() !== 'enabled') return false;
    const tags = Array.isArray(r.tags) ? r.tags.map((t) => String(t || '').toLowerCase()) : [];
    return tags.some((t) => t && text.includes(t));
  }) || null;
}

function resolveReflexMatch(routinesMap, intentKey, task) {
  const rustOut = runRouteReflexMatchViaRust(intentKey, task, routinesMap);
  if (rustOut && rustOut.ok === true) {
    return { ok: true, match: rustOut.matchedRoutine || null };
  }
  if (isTsFallbackEnabled()) {
    return { ok: true, match: pickReflexMatch(routinesMap, intentKey, task) };
  }
  return {
    ok: false,
    error: rustOut && rustOut.error ? rustOut.error : 'route_reflex_match_rust_unavailable',
    match: null
  };
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

function computeRouteComplexity(task, tokensEst, match, anyTrigger) {
  const rustComplexity = runRouteComplexityViaRust(task, tokensEst, Boolean(match), Boolean(anyTrigger));
  if (rustComplexity && rustComplexity.ok === true && rustComplexity.complexity) {
    return { ok: true, complexity: rustComplexity.complexity };
  }
  if (isTsFallbackEnabled()) {
    return { ok: true, complexity: estimateComplexity(tokensEst, task, match, anyTrigger) };
  }
  return {
    ok: false,
    error: rustComplexity && rustComplexity.error ? rustComplexity.error : 'route_complexity_rust_unavailable',
    complexity: estimateComplexity(tokensEst, task, match, anyTrigger)
  };
}

function computeRoutePrimitivesFallback(task, tokensEst, repeats14d, errors30d) {
  const intentKey = normalizeIntent(task);
  const triggerA = repeats14d >= 3 && tokensEst >= 500;
  const triggerB = tokensEst >= 2000;
  const triggerC = errors30d >= 2;
  const whichMet = [
    triggerA ? 'A' : null,
    triggerB ? 'B' : null,
    triggerC ? 'C' : null
  ].filter(Boolean);
  return {
    intent_key: intentKey,
    intent: task ? task.split(/\s+/).slice(0, 6).join('_').toLowerCase() : 'task',
    predicted_habit_id: predictHabitId(intentKey, task),
    trigger_a: triggerA,
    trigger_b: triggerB,
    trigger_c: triggerC,
    any_trigger: triggerA || triggerB || triggerC,
    which_met: whichMet,
    thresholds: {
      A: { repeats_14d_min: 3, tokens_min: 500, met: triggerA },
      B: { tokens_min: 2000, met: triggerB },
      C: { errors_30d_min: 2, met: triggerC }
    }
  };
}

function computeRoutePrimitives(task, tokensEst, repeats14d, errors30d) {
  const fallback = computeRoutePrimitivesFallback(task, tokensEst, repeats14d, errors30d);
  const rustOut = runRoutePrimitivesViaRust(task, tokensEst, repeats14d, errors30d);
  if (!rustOut || typeof rustOut !== 'object') {
    if (isTsFallbackEnabled()) return { ok: true, ...fallback };
    return { ok: false, error: 'route_primitives_rust_unavailable', ...fallback };
  }
  const thresholds = rustOut.thresholds && typeof rustOut.thresholds === 'object'
    ? rustOut.thresholds
    : fallback.thresholds;
  const whichMet = Array.isArray(rustOut.which_met)
    ? rustOut.which_met.map((x) => String(x || '')).filter(Boolean)
    : fallback.which_met;
  return {
    ok: true,
    intent_key: String(rustOut.intent_key || fallback.intent_key),
    intent: String(rustOut.intent || fallback.intent),
    predicted_habit_id: String(rustOut.predicted_habit_id || fallback.predicted_habit_id),
    trigger_a: typeof rustOut.trigger_a === 'boolean' ? rustOut.trigger_a : fallback.trigger_a,
    trigger_b: typeof rustOut.trigger_b === 'boolean' ? rustOut.trigger_b : fallback.trigger_b,
    trigger_c: typeof rustOut.trigger_c === 'boolean' ? rustOut.trigger_c : fallback.trigger_c,
    any_trigger: typeof rustOut.any_trigger === 'boolean' ? rustOut.any_trigger : fallback.any_trigger,
    which_met: whichMet,
    thresholds
  };
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
    source_eye: routeMeta.source_eye || null,
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

function tryRouteModel({ gateRisk, complexity, intent, task, mode, forceModel, sourceEye, tokensEst, executionIntent = false }) {
  try {
    // Lazy require keeps route_task resilient if router file is missing.
    const { routeDecision } = require('../../systems/routing/model_router');
    const risk = gateRisk || 'medium';
    return routeDecision({
      risk,
      complexity,
      intent,
      task,
      mode,
      forceModel,
      sourceEye,
      tokensEst,
      executionIntent
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
  const sourceEye = getArg('--source_eye', '') || getArg('--source-eye', '');
  const executionIntent = String(getArg('--execution_intent', process.env.ROUTER_EXECUTION_INTENT || '0')).trim() === '1';

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
  
  const registry = loadRegistry();
  const habits = registry.habits || [];
  const trusted = loadTrustedHabits();
  const reflexRoutines = loadReflexRoutines();
  const routeEval = runRouteEvaluateViaRust(
    task,
    tokensEst,
    repeats14d,
    errors30d,
    skipHabitId,
    habits,
    reflexRoutines
  );
  if (routeEval.ok !== true || !routeEval.payload || typeof routeEval.payload !== 'object') {
    const out = {
      decision: 'MANUAL',
      reason: `Rust route evaluate unavailable: ${String(routeEval.error || 'unknown')}`,
      executor: null,
      route_error: String(routeEval.error || 'route_evaluate_rust_unavailable'),
      gate_decision: gateResult.decision,
      gate_risk: gateResult.risk,
      gate_reasons: gateResult.reasons,
      gate_event: gateEvent,
      route: {
        type: 'route_blocked',
        reason: 'route_evaluate_rust_unavailable'
      }
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }
  const routePrimitives = routeEval.payload;
  const intentKey = String(routePrimitives.intent_key || '');
  const matchedHabitId = String(routePrimitives.matched_habit_id || '');
  const match = matchedHabitId
    ? (habits.find((h) => String(h && h.id || '') === matchedHabitId) || null)
    : null;
  
  // A/B/C triggers per Governance v1.0
  const triggerA = routePrimitives.trigger_a === true;
  const triggerB = routePrimitives.trigger_b === true;
  const triggerC = routePrimitives.trigger_c === true;
  const anyTrigger = routePrimitives.any_trigger === true;
  const intent = String(routePrimitives.intent || 'task');
  const complexity = ['low', 'medium', 'high'].includes(String(routePrimitives.complexity || '').toLowerCase())
    ? String(routePrimitives.complexity).toLowerCase()
    : 'medium';

  // Optional router annotation (feature-flagged). Does not alter decision logic.
  const routeMeta = shouldUseRouter()
    ? tryRouteModel({
        gateRisk: gateResult.risk,
      complexity,
      intent,
      task,
      mode,
      forceModel,
      sourceEye,
      tokensEst,
      executionIntent
    })
    : null;
  const routeOut = compactRouteMeta(routeMeta);
  const routeBudgetBlocked = !!(
    routeMeta &&
    routeMeta.budget_enforcement &&
    routeMeta.budget_enforcement.blocked === true
  );
  const routeGlobalBudgetBlocked = !!(
    routeMeta &&
    routeMeta.budget_global_guard &&
    routeMeta.budget_global_guard.blocked === true
  );
  const reflexPreferred = String(process.env.ROUTE_TASK_REFLEX_PREFERRED || '1') !== '0';
  const reflexMaxTokens = Number(process.env.ROUTE_TASK_REFLEX_MAX_TOKENS || 420);
  const matchedReflexId = String(routePrimitives.matched_reflex_id || '');
  const reflexMatch = reflexPreferred && gateResult.risk === 'low' && tokensEst <= reflexMaxTokens && matchedReflexId
    ? (routeEval.routines.find((r) => String(r && r.id || '') === matchedReflexId) || null)
    : null;
  
  // Build triggers_met array
  const whichMet = routePrimitives.which_met;
  
  // Thresholds object for transparency
  const thresholds = routePrimitives.thresholds;
  if (routeBudgetBlocked || routeGlobalBudgetBlocked) {
    const blockReason = String(
      routeMeta && routeMeta.budget_enforcement && routeMeta.budget_enforcement.reason
        || routeMeta && routeMeta.budget_global_guard && routeMeta.budget_global_guard.reason
        || 'router_budget_blocked'
    ).slice(0, 120);
    const out = {
      decision: 'MANUAL',
      reason: `Router budget guard blocked execution: ${blockReason}`,
      executor: null,
      route_budget_blocked: true,
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
  
  const matchState = match && match.governance ? match.governance.state : (match ? match.status : '');
  const requiredInputs = match ? requiredInputKeys(match) : [];
  const trustedEntrypoint = match ? isTrustedEntrypoint(match, trusted) : false;
  const routeDecision = runRouteDecisionViaRust({
    matched_habit_id: match ? String(match.id || '') : '',
    matched_habit_state: String(matchState || ''),
    matched_reflex_id: reflexMatch ? String(reflexMatch.id || '') : '',
    reflex_eligible: !!reflexMatch,
    has_required_inputs: requiredInputs.length > 0,
    required_input_count: requiredInputs.length,
    trusted_entrypoint: trustedEntrypoint,
    any_trigger: anyTrigger === true,
    predicted_habit_id: String(routePrimitives.predicted_habit_id || '')
  });
  if (routeDecision.ok !== true || !routeDecision.payload || typeof routeDecision.payload !== 'object') {
    const out = {
      decision: 'MANUAL',
      reason: `Rust route decision unavailable: ${String(routeDecision.error || 'unknown')}`,
      executor: null,
      route_error: String(routeDecision.error || 'route_decision_rust_unavailable'),
      gate_decision: gateResult.decision,
      gate_risk: gateResult.risk,
      gate_reasons: gateResult.reasons,
      gate_event: gateEvent,
      route: {
        type: 'route_blocked',
        reason: 'route_decision_rust_unavailable'
      }
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const routeDecisionPayload = routeDecision.payload || {};
  const decision = String(routeDecisionPayload.decision || 'MANUAL');
  const reasonCode = String(routeDecisionPayload.reason_code || '');
  const suggestedHabitId = String(routeDecisionPayload.suggested_habit_id || '').trim();

  if (decision === 'RUN_REFLEX') {
    if (!reflexMatch || !String(reflexMatch.id || '').trim()) {
      const out = {
        decision: 'MANUAL',
        reason: 'Rust route decision requested reflex without eligible routine.',
        executor: null,
        route_error: 'route_decision_inconsistent_reflex',
        gate_decision: gateResult.decision,
        gate_risk: gateResult.risk,
        gate_reasons: gateResult.reasons,
        gate_event: gateEvent,
        route: routeOut
      };
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }
    const reflexId = String(reflexMatch.id || '').trim();
    const runArgs = [
      'systems/reflex/reflex_dispatcher.js',
      'routine-run',
      '--id', reflexId,
      '--task', String(task || '').slice(0, 1000),
      '--intent', intentKey,
      '--tokens_est', String(tokensEst || 0)
    ];
    const out = {
      decision: 'RUN_REFLEX',
      suggested_reflex_id: reflexId,
      reason: `Matched enabled reflex routine: ${reflexId}`,
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

  if (decision === 'RUN_HABIT') {
    if (!match) {
      const out = {
        decision: 'MANUAL',
        reason: 'Rust route decision requested habit run without match context.',
        executor: null,
        route_error: 'route_decision_inconsistent_habit',
        gate_decision: gateResult.decision,
        gate_risk: gateResult.risk,
        gate_reasons: gateResult.reasons,
        gate_event: gateEvent,
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

  if (decision === 'RUN_CANDIDATE_FOR_VERIFICATION') {
    const autoHabitFlow = routeDecisionPayload.auto_habit_flow === true;
    if (autoHabitFlow) {
      const escapedTask = task.replace(/"/g, '\\"');
      const crystallizerPath = path.join(REPO_ROOT, 'habits', 'scripts', 'habit_crystallizer.js');
      const proposeScript = fs.existsSync(crystallizerPath)
        ? 'habits/scripts/habit_crystallizer.js'
        : 'habits/scripts/propose_habit.js';
      const autoTrust = String(process.env.ROUTE_TASK_AUTO_TRUST_CANDIDATE || '1') !== '0';
      const predictedHabitId = suggestedHabitId || String(routePrimitives.predicted_habit_id || '');
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

    if (!match) {
      const out = {
        decision: 'MANUAL',
        reason: 'Rust route decision requested candidate run without match context.',
        executor: null,
        route_error: 'route_decision_inconsistent_candidate',
        gate_decision: gateResult.decision,
        gate_risk: gateResult.risk,
        gate_reasons: gateResult.reasons,
        gate_event: gateEvent,
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

  const state = matchState || 'unknown';
  if (reasonCode === 'required_inputs' && match) {
    const stateLower = String(state).toLowerCase();
    const reason = stateLower === 'active'
      ? `Matched active habit requires explicit inputs: ${requiredInputs.join(', ')}`
      : `Matched candidate habit requires explicit inputs: ${requiredInputs.join(', ')}`;
    const out = {
      decision: 'MANUAL',
      suggested_habit_id: match.id,
      reason,
      required_inputs: requiredInputs,
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
  if (reasonCode === 'untrusted_entrypoint' && match) {
    const stateLower = String(state).toLowerCase();
    const reason = stateLower === 'active'
      ? `Matched active habit is not trusted: ${match.entrypoint}`
      : `Matched candidate habit is not trusted yet: ${match.entrypoint}`;
    const out = {
      decision: 'MANUAL',
      suggested_habit_id: match.id,
      reason,
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
export {};
