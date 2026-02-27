#!/usr/bin/env node
/**
 * route_execute.js — route_task executor with optional model routing consumption
 *
 * Purpose:
 * - Run route_task
 * - Execute suggested command when decision is executable
 * - If route.selected_model is present, inject it into execution env automatically
 *
 * Usage:
 *   node systems/routing/route_execute.js --task "..." [--tokens_est N] [--repeats_14d N] [--errors_30d N] [--skip-habit-id ID] [--dry-run]
 *
 * Notes:
 * - ROUTER_ENABLED=1 enables route_task model selection.
 * - This script does not change route_task decision logic; it only executes returned executor payload.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop');
const {
  GLOBAL_BUDGET_DEFAULT_DIR,
  DEFAULT_EVENTS_PATH,
  DEFAULT_AUTOPAUSE_PATH,
  evaluateSystemBudgetGuard,
  loadSystemBudgetAutopauseState,
  writeSystemBudgetDecision,
  setSystemBudgetAutopause
} = require('../budget/system_budget');

const ROUTE_EXECUTE_BUDGET_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.ROUTE_EXECUTE_BUDGET_ENABLED || '1').trim().toLowerCase()
);
const ROUTE_EXECUTE_BUDGET_MODULE = String(process.env.ROUTE_EXECUTE_BUDGET_MODULE || 'route_execute').trim() || 'route_execute';
const ROUTE_EXECUTE_BUDGET_STATE_DIR = process.env.ROUTE_EXECUTE_BUDGET_STATE_DIR
  ? path.resolve(process.env.ROUTE_EXECUTE_BUDGET_STATE_DIR)
  : GLOBAL_BUDGET_DEFAULT_DIR;
const ROUTE_EXECUTE_BUDGET_EVENTS_PATH = process.env.ROUTE_EXECUTE_BUDGET_EVENTS_PATH
  ? path.resolve(process.env.ROUTE_EXECUTE_BUDGET_EVENTS_PATH)
  : DEFAULT_EVENTS_PATH;
const ROUTE_EXECUTE_BUDGET_AUTOPAUSE_PATH = process.env.ROUTE_EXECUTE_BUDGET_AUTOPAUSE_PATH
  ? path.resolve(process.env.ROUTE_EXECUTE_BUDGET_AUTOPAUSE_PATH)
  : DEFAULT_AUTOPAUSE_PATH;
const ROUTE_EXECUTE_DEFAULT_TOKENS_EST = Number(process.env.ROUTE_EXECUTE_DEFAULT_TOKENS_EST || 260);

function getArg(name, def = null) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  return (v === undefined || String(v).startsWith('--')) ? def : v;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/route_execute.js --task "..." [--tokens_est N] [--repeats_14d N] [--errors_30d N] [--skip-habit-id ID] [--source_eye ID] [--mode normal|narrative|creative|hyper-creative|deep-thinker] [--dry-run]');
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

const ROUTE_TASK_SCRIPT = process.env.ROUTE_EXECUTE_ROUTE_TASK_SCRIPT
  ? path.resolve(process.env.ROUTE_EXECUTE_ROUTE_TASK_SCRIPT)
  : path.join(repoRoot(), 'systems', 'routing', 'route_task.js');

function runRouteTask({ task, tokensEst, repeats14d, errors30d, skipHabitId, mode, sourceEye = "", forceModel = null, dryRun = false }) {
  const args = [
    ROUTE_TASK_SCRIPT,
    '--task', task,
    '--tokens_est', String(tokensEst),
    '--repeats_14d', String(repeats14d),
    '--errors_30d', String(errors30d),
    '--execution_intent', '1'
  ];
  if (skipHabitId) args.push('--skip_habit_id', String(skipHabitId));
  if (mode) args.push('--mode', String(mode));
  if (sourceEye) args.push('--source_eye', String(sourceEye));
  if (forceModel) args.push('--force_model', String(forceModel));
  const env = { ...process.env } as Record<string, any>;
  env.ROUTER_BUDGET_DRY_RUN = dryRun ? '1' : '0';
  const r = spawnSync('node', args, {
    cwd: repoRoot(),
    encoding: 'utf8',
    env
  });
  return r;
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function writeDeepThinkerReceipt(receipt) {
  const day = nowIso().slice(0, 10);
  const fp = path.join(repoRoot(), 'state', 'routing', 'deep_thinker_receipts', `${day}.jsonl`);
  appendJsonl(fp, receipt);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeIntent(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g, '')
    .replace(/["'][^"']*["']/g, '<str>')
    .replace(/[^a-z0-9_\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join('_');
}

function parseJsonObjects(text) {
  const out = [];
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    const obj = parseJson(line);
    if (obj && typeof obj === 'object') out.push(obj);
  }
  return out;
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function evaluateRouteExecuteBudgetGate(tokensEst, decision, opts: { dry_run?: boolean } = {}) {
  const dryRun = !!(opts && opts.dry_run === true);
  const requestTokens = Number.isFinite(Number(tokensEst)) && Number(tokensEst) > 0
    ? Math.max(1, Math.min(12000, Math.round(Number(tokensEst))))
    : Math.max(1, Math.min(12000, Math.round(Number(ROUTE_EXECUTE_DEFAULT_TOKENS_EST || 260))));
  if (!ROUTE_EXECUTE_BUDGET_ENABLED) {
    return {
      enabled: false,
      blocked: false,
      reason: 'budget_disabled',
      deferred: false,
      deferred_reason: null,
      request_tokens_est: requestTokens,
      autopause: null,
      guard: null
    };
  }

  const date = nowIso().slice(0, 10);
  const capability = `route_execute:${String(decision || 'unknown').slice(0, 80)}`;
  const budgetOpts = {
    state_dir: ROUTE_EXECUTE_BUDGET_STATE_DIR,
    events_path: ROUTE_EXECUTE_BUDGET_EVENTS_PATH,
    autopause_path: ROUTE_EXECUTE_BUDGET_AUTOPAUSE_PATH
  };
  const autopause = loadSystemBudgetAutopauseState(budgetOpts);
  if (autopause.active === true) {
    if (dryRun) {
      return {
        enabled: true,
        blocked: false,
        reason: 'budget_deferred_preview',
        deferred: true,
        deferred_reason: 'budget_autopause_active',
        request_tokens_est: requestTokens,
        autopause: {
          active: true,
          source: autopause.source || null,
          reason: autopause.reason || null,
          until: autopause.until || null
        },
        guard: null
      };
    }
    writeSystemBudgetDecision({
      date,
      module: ROUTE_EXECUTE_BUDGET_MODULE,
      capability,
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: 'budget_autopause_active'
    }, budgetOpts);
    return {
      enabled: true,
      blocked: true,
      reason: 'budget_autopause_active',
      deferred: false,
      deferred_reason: null,
      request_tokens_est: requestTokens,
      autopause: {
        active: true,
        source: autopause.source || null,
        reason: autopause.reason || null,
        until: autopause.until || null
      },
      guard: null
    };
  }

  const guard = evaluateSystemBudgetGuard({
    date,
    request_tokens_est: requestTokens,
    attempts_today: 1
  }, budgetOpts);
  if (guard.hard_stop === true) {
    const hardReason = String((guard.hard_stop_reasons && guard.hard_stop_reasons[0]) || 'budget_guard_hard_stop');
    if (dryRun) {
      return {
        enabled: true,
        blocked: false,
        reason: 'budget_deferred_preview',
        deferred: true,
        deferred_reason: hardReason,
        request_tokens_est: requestTokens,
        autopause: {
          active: autopause.active === true,
          source: autopause.source || null,
          reason: autopause.reason || null,
          until: autopause.until || null
        },
        guard
      };
    }
    writeSystemBudgetDecision({
      date,
      module: ROUTE_EXECUTE_BUDGET_MODULE,
      capability,
      request_tokens_est: requestTokens,
      decision: 'deny',
      reason: hardReason
    }, budgetOpts);
    const nextAutopause = setSystemBudgetAutopause({
      source: 'route_execute',
      reason: hardReason,
      pressure: 'hard',
      date,
      minutes: 60
    }, budgetOpts);
    return {
      enabled: true,
      blocked: true,
      reason: hardReason,
      deferred: false,
      deferred_reason: null,
      request_tokens_est: requestTokens,
      autopause: {
        active: nextAutopause.active === true,
        source: nextAutopause.source || null,
        reason: nextAutopause.reason || null,
        until: nextAutopause.until || null
      },
      guard
    };
  }

  return {
    enabled: true,
    blocked: false,
    reason: null,
    deferred: false,
    deferred_reason: null,
    request_tokens_est: requestTokens,
    autopause: {
      active: false,
      source: autopause.source || null,
      reason: autopause.reason || null,
      until: autopause.until || null
    },
    guard
  };
}

function normalizeTokenUsage(raw, source = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = toNumberOrNull(raw.prompt_tokens != null ? raw.prompt_tokens : raw.input_tokens);
  const completion = toNumberOrNull(raw.completion_tokens != null ? raw.completion_tokens : raw.output_tokens);
  const totalDirect = toNumberOrNull(raw.total_tokens != null ? raw.total_tokens : raw.tokens_used);
  const total = totalDirect != null
    ? totalDirect
    : (prompt != null || completion != null ? Number((prompt || 0) + (completion || 0)) : null);
  if (total == null && prompt == null && completion == null) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    source
  };
}

function extractTokenUsageFromObject(obj, source = 'object') {
  if (!obj || typeof obj !== 'object') return null;
  const direct = normalizeTokenUsage(obj, source);
  if (direct) return direct;
  if (obj.usage && typeof obj.usage === 'object') {
    const nested = normalizeTokenUsage(obj.usage, `${source}.usage`);
    if (nested) return nested;
  }
  if (obj.token_usage && typeof obj.token_usage === 'object') {
    const nested = normalizeTokenUsage(obj.token_usage, `${source}.token_usage`);
    if (nested) return nested;
  }
  return null;
}

function extractTokenUsageFromText(text, source = 'text') {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    const parsed = parseJson(line);
    if (!parsed) continue;
    const usage = extractTokenUsageFromObject(parsed, `${source}.line_json`);
    if (usage) return usage;
  }
  return null;
}

function collectModelCandidatesFromValue(value, outSet) {
  const set = outSet instanceof Set ? outSet : new Set();
  if (value == null) return set;
  if (Array.isArray(value)) {
    for (const item of value) collectModelCandidatesFromValue(item, set);
    return set;
  }
  if (typeof value === 'object') {
    const obj: Record<string, any> = value as Record<string, any>;
    const directKeys = [
      'selected_model',
      'model',
      'model_id',
      'resolved_model',
      'routed_model',
      'ROUTED_MODEL'
    ];
    for (const key of directKeys) {
      const raw = String(obj[key] == null ? '' : obj[key]).trim();
      if (raw) set.add(raw);
    }
    const nested = [obj.route, obj.summary, obj.execution_metrics, obj.route_model_attestation];
    for (const child of nested) collectModelCandidatesFromValue(child, set);
    return set;
  }
  const raw = String(value || '').trim();
  if (raw && /[a-z0-9]/i.test(raw) && (raw.includes('/') || raw.includes(':'))) set.add(raw);
  return set;
}

function extractObservedModels(stdout, stderr) {
  const seen = new Set();
  const rows = [...parseJsonObjects(stdout), ...parseJsonObjects(stderr)];
  for (const row of rows) collectModelCandidatesFromValue(row, seen);
  return Array.from(seen).slice(0, 12);
}

function verifyRouteModelAttestation(expectedModel, stdout, stderr) {
  const expected = String(expectedModel || '').trim();
  const observedModels = extractObservedModels(stdout, stderr);
  if (!expected) {
    return {
      enabled: true,
      status: 'no_expected_model',
      expected_model: null,
      observed_models: observedModels
    };
  }
  if (!observedModels.length) {
    return {
      enabled: true,
      status: 'unobserved',
      expected_model: expected,
      observed_models: []
    };
  }
  const verified = observedModels.includes(expected);
  return {
    enabled: true,
    status: verified ? 'verified' : 'mismatch',
    expected_model: expected,
    observed_models: observedModels
  };
}

function modelEnv(baseEnv, modelId) {
  if (!modelId) return baseEnv;
  return {
    ...baseEnv,
    ROUTED_MODEL: modelId,
    OPENCLAW_MODEL: modelId,
    SPAWN_MODEL: modelId,
    MODEL_OVERRIDE: modelId
  };
}

function isExecutableDecision(d) {
  return d === 'RUN_HABIT' || d === 'RUN_REFLEX' || d === 'RUN_CANDIDATE_FOR_VERIFICATION' || d === 'PROPOSE_HABIT';
}

function isAutoHabitFlow(out) {
  if (!out || typeof out !== 'object') return false;
  if (out.auto_habit_flow === true) return true;
  const execSpec = out.executor;
  if (!execSpec || !Array.isArray(execSpec.args)) return false;
  return execSpec.args.some((a) => {
    const s = String(a || '');
    return s.includes('habits/scripts/habit_crystallizer.js') || s.includes('habits/scripts/propose_habit.js');
  });
}

function executorSig(out) {
  const ex = out && out.executor ? out.executor : null;
  if (!ex || !ex.cmd || !Array.isArray(ex.args)) return null;
  return JSON.stringify({ cmd: ex.cmd, args: ex.args });
}

function evaluateDeepThinkerConsensus(primaryOut, secondaryOut) {
  const primaryDecision = primaryOut ? primaryOut.decision : null;
  const secondaryDecision = secondaryOut ? secondaryOut.decision : null;
  const primaryGate = primaryOut ? (primaryOut.gate_decision || null) : null;
  const secondaryGate = secondaryOut ? (secondaryOut.gate_decision || null) : null;
  const primaryExec = executorSig(primaryOut);
  const secondaryExec = executorSig(secondaryOut);

  let agreed = true;
  let className = null;
  let reason = null;

  if (!secondaryOut) {
    agreed = false;
    className = 'execution';
    reason = 'secondary_route_missing';
  } else if (primaryGate !== secondaryGate) {
    agreed = false;
    className = 'policy';
    reason = 'gate_decision_mismatch';
  } else if (primaryDecision !== secondaryDecision) {
    agreed = false;
    className = 'risk';
    reason = 'decision_mismatch';
  } else if (primaryExec !== secondaryExec) {
    agreed = false;
    className = 'execution';
    reason = 'executor_mismatch';
  }

  if (!className && !agreed) className = 'uncertain';

  return {
    agreed,
    disagreement: agreed ? null : { class: className || 'uncertain', reason: reason || 'unknown' },
    primary: {
      decision: primaryDecision,
      gate_decision: primaryGate,
      executor_sig: primaryExec
    },
    secondary: {
      decision: secondaryDecision,
      gate_decision: secondaryGate,
      executor_sig: secondaryExec
    }
  };
}

function parseRouteTaskOutput(routed) {
  if (routed.stderr) process.stderr.write(routed.stderr);
  if (!routed.stdout) return { ok: false, error: 'route_task returned no stdout', out: null };
  const out = parseJson(routed.stdout);
  if (!out) return { ok: false, error: 'failed to parse route_task JSON output', out: null };
  return { ok: true, out };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || hasFlag('--help') || hasFlag('-h') || hasFlag('help')) {
    usage();
    process.exit(0);
  }

  const task = getArg('--task', '');
  const tokensEst = Number(getArg('--tokens_est', '0')) || 0;
  const repeats14d = Number(getArg('--repeats_14d', '0')) || 0;
  const errors30d = Number(getArg('--errors_30d', '0')) || 0;
  const skipHabitId = getArg('--skip-habit-id', '') || getArg('--skip_habit_id', '');
  const mode = getArg('--mode', process.env.AGENT_MODE || 'normal');
  const sourceEye = getArg('--source-eye', '') || getArg('--source_eye', '');
  const dryRun = hasFlag('--dry-run');
  const routerRequired = String(process.env.ROUTER_REQUIRED || '0') === '1';

  if (!task) {
    usage();
    process.exit(2);
  }

  const emergency = isEmergencyStopEngaged('routing');
  if (emergency.engaged) {
    const summary: Record<string, any> = {
      decision: 'MANUAL',
      reason: 'emergency_stop_engaged',
      gate_decision: 'DENY',
      gate_risk: 'high',
      selected_model: null,
      anchor_model: null,
      should_return_to_anchor: false,
      previous_model: null,
      model_changed: false,
      route_role: null,
      route_tier: null,
      mode,
      deep_thinker: null,
      escalation_chain: [],
      router_required: routerRequired,
      router_missing_model: false,
      executable: false,
      dry_run: !!dryRun,
      emergency_stop: emergency.state || null
    };
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.exit(0);
  }

  const routed = runRouteTask({ task, tokensEst, repeats14d, errors30d, skipHabitId, mode, sourceEye, dryRun });
  const parsedPrimary = parseRouteTaskOutput(routed);
  if (!parsedPrimary.ok) {
    console.error(`route_execute: ${parsedPrimary.error}`);
    process.exit(routed.status || 1);
  }
  const out = parsedPrimary.out;

  const selectedModel = out?.route?.selected_model || null;
  const budgetEnforcement = out?.route?.budget_enforcement && typeof out.route.budget_enforcement === 'object'
    ? out.route.budget_enforcement
    : null;
  const routeBudgetBlocked = !!(budgetEnforcement && budgetEnforcement.blocked === true);
  const globalBudgetGuard = evaluateRouteExecuteBudgetGate(tokensEst, out.decision, { dry_run: dryRun });
  const budgetDeferred = !!(
    dryRun
    && (
      routeBudgetBlocked
      || globalBudgetGuard.deferred === true
    )
  );
  const budgetBlocked = budgetDeferred
    ? false
    : (routeBudgetBlocked || globalBudgetGuard.blocked === true);
  const execSpec = out.executor;
  const autoHabitFlow = isAutoHabitFlow(out);
  const summaryDecision = out.decision;
  const canExec = isExecutableDecision(out.decision) && execSpec && execSpec.cmd && Array.isArray(execSpec.args);
  const routerMissingModel = routerRequired && canExec && !selectedModel;

  const summary: Record<string, any> = {
    decision: summaryDecision,
    route_decision_raw: out.decision,
    reason: autoHabitFlow
      ? `Auto-crystallize candidate habit and run verification. ${String(out.reason || '').slice(0, 180)}`
      : out.reason,
    suggested_habit_id: out.suggested_habit_id || null,
    gate_decision: out.gate_decision || null,
    gate_risk: out.gate_risk || null,
    selected_model: selectedModel,
    anchor_model: out?.route?.anchor_model || null,
    should_return_to_anchor: out?.route?.should_return_to_anchor === true,
    previous_model: out?.route?.previous_model || null,
    model_changed: out?.route?.model_changed === true,
    route_role: out?.route?.role || null,
    route_tier: out?.route?.tier || null,
    route_class: out?.route?.route_class || null,
    task_type: out?.route?.task_type || null,
    mode: out?.route?.mode || mode,
    deep_thinker: out?.route?.deep_thinker || null,
    escalation_chain: Array.isArray(out?.route?.escalation_chain) ? out.route.escalation_chain : [],
    route_budget: out?.route?.budget || null,
    cost_estimate: out?.route?.cost_estimate || null,
    budget_enforcement: budgetEnforcement || null,
    budget_global_guard: globalBudgetGuard,
    budget_deferred: budgetDeferred,
    budget_deferred_reason: budgetDeferred
      ? (routeBudgetBlocked
        ? String(budgetEnforcement && budgetEnforcement.reason || 'route_budget_blocked')
        : String(globalBudgetGuard.deferred_reason || globalBudgetGuard.reason || 'budget_deferred_preview'))
      : null,
    budget_blocked: budgetBlocked,
    budget_block_reason: routeBudgetBlocked
      ? String(budgetEnforcement && budgetEnforcement.reason || 'route_budget_blocked')
      : String(globalBudgetGuard.reason || ''),
    needs_manual_review: budgetBlocked && !budgetDeferred,
    router_required: routerRequired,
    router_missing_model: routerMissingModel,
    auto_habit_flow: autoHabitFlow,
    executable: !!canExec && !budgetBlocked,
    dry_run: !!dryRun
  };

  if (!budgetBlocked && summary.mode === 'deep-thinker' && summary.deep_thinker && summary.deep_thinker.enabled === true) {
    const declaredSwarm = Array.isArray(summary.deep_thinker.swarm_models)
      ? summary.deep_thinker.swarm_models.map((m) => String(m || '').trim()).filter(Boolean)
      : [];
    const quorumMinAgreementRaw = Number(summary.deep_thinker.quorum_min_agreement || 2);
    const verificationModels = declaredSwarm.length
      ? declaredSwarm
      : [summary.selected_model, summary.deep_thinker.secondary_model].filter(Boolean);
    const secondaryModels = verificationModels.filter((m) => m && m !== summary.selected_model);

    const primarySig = JSON.stringify({
      decision: out ? out.decision : null,
      gate_decision: out ? (out.gate_decision || null) : null,
      executor_sig: executorSig(out)
    });
    const passes = [{
      model: summary.selected_model,
      decision: out ? out.decision : null,
      gate_decision: out ? (out.gate_decision || null) : null,
      executor_sig: executorSig(out),
      signature: primarySig,
      ok: true,
      error: null
    }];

    const routeFailures = [];
    for (const modelId of secondaryModels) {
      const routedSecondary = runRouteTask({
        task,
        tokensEst,
        repeats14d,
        errors30d,
        skipHabitId,
        mode,
        sourceEye,
        forceModel: modelId,
        dryRun
      });
      const parsedSecondary = parseRouteTaskOutput(routedSecondary);
      if (!parsedSecondary.ok) {
        routeFailures.push({ model: modelId, error: parsedSecondary.error || 'secondary_route_failed' });
        passes.push({
          model: modelId,
          decision: null,
          gate_decision: null,
          executor_sig: null,
          signature: null,
          ok: false,
          error: parsedSecondary.error || 'secondary_route_failed'
        });
        continue;
      }
      const sec = parsedSecondary.out;
      const sig = JSON.stringify({
        decision: sec ? sec.decision : null,
        gate_decision: sec ? (sec.gate_decision || null) : null,
        executor_sig: executorSig(sec)
      });
      passes.push({
        model: modelId,
        decision: sec ? sec.decision : null,
        gate_decision: sec ? (sec.gate_decision || null) : null,
        executor_sig: executorSig(sec),
        signature: sig,
        ok: true,
        error: null
      });
    }

    const counts = {};
    for (const row of passes) {
      if (!row || row.ok !== true || !row.signature) continue;
      counts[row.signature] = Number(counts[row.signature] || 0) + 1;
    }
    const primaryAgreementCount = Number(counts[primarySig] || 0);
    const quorumMinAgreement = Number.isFinite(quorumMinAgreementRaw)
      ? Math.max(2, Math.min(passes.length, Math.round(quorumMinAgreementRaw)))
      : 2;

    let disagreement = null;
    let disagreementClass = null;
    if (!secondaryModels.length) {
      disagreement = 'secondary_model_missing_or_same';
      disagreementClass = 'execution';
    } else if (routeFailures.length > 0) {
      disagreement = 'secondary_route_failed';
      disagreementClass = 'execution';
    } else if (primaryAgreementCount < quorumMinAgreement) {
      disagreement = 'quorum_not_met';
      disagreementClass = 'policy';
    }

    summary.deep_thinker_passes = {
      primary: passes[0],
      secondaries: passes.slice(1),
      verification_models: verificationModels,
      quorum_min_agreement: quorumMinAgreement,
      primary_agreement_count: primaryAgreementCount,
      agreed: !disagreement,
      disagreement_reason: disagreement,
      disagreement_class: disagreementClass
    };

    if (disagreement) {
      summary.needs_manual_review = true;
      summary.executable = false;
      summary.deep_thinker_blocked = true;
      process.stdout.write(JSON.stringify(summary) + '\n');
      writeDeepThinkerReceipt({
        ts: nowIso(),
        type: 'deep_thinker_receipt',
        task: String(task).slice(0, 200),
        mode: summary.mode,
        primary_model: summary.selected_model,
        secondary_model: summary.deep_thinker.secondary_model || null,
        verification_models: verificationModels,
        quorum_min_agreement: quorumMinAgreement,
        primary_decision: passes[0].decision,
        secondary_decision: passes.length > 1 ? passes[1].decision : null,
        agreed: false,
        disagreement_reason: disagreement,
        disagreement_class: disagreementClass,
        final_decision: 'manual_review'
      });
      process.exit(0);
    }
  }

  process.stdout.write(JSON.stringify(summary) + '\n');

  if (summary.model_changed) {
    process.stderr.write(
      `ROUTER_SWITCH: ${summary.previous_model || 'none'} -> ${summary.selected_model || 'none'} ` +
      `(tier=${summary.route_tier || 'n/a'} role=${summary.route_role || 'n/a'})\n`
    );
  }

  if (routerMissingModel) {
    console.error('route_execute: ROUTER_REQUIRED=1 but no selected_model was returned');
    process.exit(3);
  }

  if (budgetBlocked) {
    process.exit(0);
  }

  if (!canExec) {
    if (summary.mode === 'deep-thinker') {
      writeDeepThinkerReceipt({
        ts: nowIso(),
        type: 'deep_thinker_receipt',
        task: String(task).slice(0, 200),
        mode: summary.mode,
        primary_model: summary.selected_model,
        secondary_model: summary?.deep_thinker?.secondary_model || null,
        agreed: !(summary.deep_thinker_passes && summary.deep_thinker_passes.disagreement_reason),
        disagreement_reason: summary.deep_thinker_passes ? summary.deep_thinker_passes.disagreement_reason : null,
        final_decision: 'non_executable',
        route_decision: summary.decision
      });
    }
    process.exit(routed.status || 0);
  }

  if (dryRun) {
    if (autoHabitFlow) {
      const habitId = String(summary.suggested_habit_id || '').trim() || null;
      const inputs = {
        task: String(task || '').slice(0, 1000),
        intent_key: String(normalizeIntent(task) || '').slice(0, 120),
        source: 'route_execute_auto_habit',
        ts: nowIso()
      };
      process.stdout.write(JSON.stringify({
        exec: { cmd: execSpec.cmd, args: execSpec.args },
        exec_followup: habitId
          ? { cmd: 'node', args: ['habits/scripts/run_habit.js', '--id', habitId, '--json', JSON.stringify(inputs)] }
          : null
      }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ exec: { cmd: execSpec.cmd, args: execSpec.args } }) + '\n');
    }
    if (summary.mode === 'deep-thinker') {
      writeDeepThinkerReceipt({
        ts: nowIso(),
        type: 'deep_thinker_receipt',
        task: String(task).slice(0, 200),
        mode: summary.mode,
        primary_model: summary.selected_model,
        secondary_model: summary?.deep_thinker?.secondary_model || null,
        agreed: !(summary.deep_thinker_passes && summary.deep_thinker_passes.disagreement_reason),
        disagreement_reason: summary.deep_thinker_passes ? summary.deep_thinker_passes.disagreement_reason : null,
        final_decision: 'dry_run'
      });
    }
    process.exit(0);
  }

  if (autoHabitFlow) {
    const env = modelEnv(process.env, selectedModel);
    const execStartedMs = Date.now();
    const crystallizeChild = spawnSync(execSpec.cmd, execSpec.args, {
      cwd: repoRoot(),
      encoding: 'utf8',
      env
    });
    const crystallizeStdout = String(crystallizeChild.stdout || '');
    const crystallizeStderr = String(crystallizeChild.stderr || '');
    if (crystallizeStdout) process.stdout.write(crystallizeStdout);
    if (crystallizeStderr) process.stderr.write(crystallizeStderr);

    let finalExitCode = crystallizeChild.status || 0;
    const crystalObjects = parseJsonObjects(crystallizeStdout);
    const crystalSummary = crystalObjects.length ? crystalObjects[crystalObjects.length - 1] : null;
    const crystallizedHabitId = String(
      (crystalSummary && crystalSummary.habit_id) || summary.suggested_habit_id || ''
    ).trim();
    if (crystallizedHabitId) summary.suggested_habit_id = crystallizedHabitId;

    let habitRun = null;
    if (finalExitCode === 0 && crystallizedHabitId) {
      const habitInputs = {
        task: String(task || '').slice(0, 1000),
        intent_key: String(normalizeIntent(task) || '').slice(0, 120),
        source: 'route_execute_auto_habit',
        ts: nowIso()
      };
      const runArgs = ['habits/scripts/run_habit.js', '--id', crystallizedHabitId, '--json', JSON.stringify(habitInputs)];
      const runChild = spawnSync('node', runArgs, {
        cwd: repoRoot(),
        encoding: 'utf8',
        env
      });
      const runStdout = String(runChild.stdout || '');
      const runStderr = String(runChild.stderr || '');
      if (runStdout) process.stdout.write(runStdout);
      if (runStderr) process.stderr.write(runStderr);
      finalExitCode = runChild.status || 0;
      habitRun = {
        attempted: true,
        habit_id: crystallizedHabitId,
        exit_code: finalExitCode,
        stdout: runStdout,
        stderr: runStderr
      };
    }

    process.stdout.write(JSON.stringify({
      type: 'route_execute_metrics',
      execution_metrics: {
        exit_code: finalExitCode,
        duration_ms: Math.max(0, Date.now() - execStartedMs),
        token_usage: null,
        token_usage_available: false,
        route_model_attestation: verifyRouteModelAttestation(
          selectedModel,
          `${crystallizeStdout}\n${habitRun ? String(habitRun.stdout || '') : ''}`,
          `${crystallizeStderr}\n${habitRun ? String(habitRun.stderr || '') : ''}`
        )
      },
      auto_habit_flow: {
        crystallizer_decision: crystalSummary && crystalSummary.decision ? String(crystalSummary.decision) : null,
        habit_id: crystallizedHabitId || null,
        habit_run: habitRun
      }
    }) + '\n');

    if (summary.mode === 'deep-thinker') {
      writeDeepThinkerReceipt({
        ts: nowIso(),
        type: 'deep_thinker_receipt',
        task: String(task).slice(0, 200),
        mode: summary.mode,
        primary_model: summary.selected_model,
        secondary_model: summary?.deep_thinker?.secondary_model || null,
        agreed: !(summary.deep_thinker_passes && summary.deep_thinker_passes.disagreement_reason),
        disagreement_reason: summary.deep_thinker_passes ? summary.deep_thinker_passes.disagreement_reason : null,
        final_decision: finalExitCode === 0 ? 'executed' : 'exec_failed',
        exit_code: finalExitCode
      });
    }

    process.exit(finalExitCode);
  }

  const env = modelEnv(process.env, selectedModel);
  const execStartedMs = Date.now();
  const child = spawnSync(execSpec.cmd, execSpec.args, {
    cwd: repoRoot(),
    encoding: 'utf8',
    env
  });
  const execDurationMs = Math.max(0, Date.now() - execStartedMs);
  const childStdout = String(child.stdout || '');
  const childStderr = String(child.stderr || '');
  if (childStdout) process.stdout.write(childStdout);
  if (childStderr) process.stderr.write(childStderr);

  const usageFromStdout = extractTokenUsageFromText(childStdout, 'stdout');
  const usageFromStderr = extractTokenUsageFromText(childStderr, 'stderr');
  const tokenUsage = usageFromStdout || usageFromStderr || null;
  const routeModelAttestation = verifyRouteModelAttestation(selectedModel, childStdout, childStderr);
  process.stdout.write(JSON.stringify({
    type: 'route_execute_metrics',
    execution_metrics: {
      exit_code: child.status || 0,
      duration_ms: execDurationMs,
      token_usage: tokenUsage,
      token_usage_available: !!tokenUsage,
      route_model_attestation: routeModelAttestation
    }
  }) + '\n');

  if (summary.mode === 'deep-thinker') {
    writeDeepThinkerReceipt({
      ts: nowIso(),
      type: 'deep_thinker_receipt',
      task: String(task).slice(0, 200),
      mode: summary.mode,
      primary_model: summary.selected_model,
      secondary_model: summary?.deep_thinker?.secondary_model || null,
      agreed: !(summary.deep_thinker_passes && summary.deep_thinker_passes.disagreement_reason),
      disagreement_reason: summary.deep_thinker_passes ? summary.deep_thinker_passes.disagreement_reason : null,
      final_decision: child.status === 0 ? 'executed' : 'exec_failed',
      exit_code: child.status || 0
    });
  }

  process.exit(child.status || 0);
}

if (require.main === module) main();
module.exports = { runRouteTask, modelEnv };
export {};
