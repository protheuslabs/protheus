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
const { isEmergencyStopEngaged } = require('../../lib/emergency_stop.js');

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
  console.log('  node systems/routing/route_execute.js --task "..." [--tokens_est N] [--repeats_14d N] [--errors_30d N] [--skip-habit-id ID] [--mode normal|narrative|creative|hyper-creative|deep-thinker] [--dry-run]');
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function runRouteTask({ task, tokensEst, repeats14d, errors30d, skipHabitId, mode, forceModel }) {
  const script = path.join(repoRoot(), 'systems', 'routing', 'route_task.js');
  const args = [
    script,
    '--task', task,
    '--tokens_est', String(tokensEst),
    '--repeats_14d', String(repeats14d),
    '--errors_30d', String(errors30d)
  ];
  if (skipHabitId) args.push('--skip_habit_id', String(skipHabitId));
  if (mode) args.push('--mode', String(mode));
  if (forceModel) args.push('--force_model', String(forceModel));
  const r = spawnSync('node', args, {
    cwd: repoRoot(),
    encoding: 'utf8',
    env: process.env
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
  return d === 'RUN_HABIT' || d === 'RUN_CANDIDATE_FOR_VERIFICATION' || d === 'PROPOSE_HABIT';
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
  const dryRun = hasFlag('--dry-run');
  const routerRequired = String(process.env.ROUTER_REQUIRED || '0') === '1';

  if (!task) {
    usage();
    process.exit(2);
  }

  const emergency = isEmergencyStopEngaged('routing');
  if (emergency.engaged) {
    const summary = {
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

  const routed = runRouteTask({ task, tokensEst, repeats14d, errors30d, skipHabitId, mode });
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
  const budgetBlocked = !!(budgetEnforcement && budgetEnforcement.blocked === true);
  const execSpec = out.executor;
  const autoHabitFlow = isAutoHabitFlow(out);
  const summaryDecision = out.decision;
  const canExec = isExecutableDecision(out.decision) && execSpec && execSpec.cmd && Array.isArray(execSpec.args);
  const routerMissingModel = routerRequired && canExec && !selectedModel;

  const summary = {
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
    budget_blocked: budgetBlocked,
    needs_manual_review: budgetBlocked,
    router_required: routerRequired,
    router_missing_model: routerMissingModel,
    auto_habit_flow: autoHabitFlow,
    executable: !!canExec && !budgetBlocked,
    dry_run: !!dryRun
  };

  if (summary.mode === 'deep-thinker' && summary.deep_thinker && summary.deep_thinker.enabled === true) {
    const secondaryModel = summary.deep_thinker.secondary_model || null;
    let secondary = null;
    let disagreement = null;

    if (secondaryModel && secondaryModel !== summary.selected_model) {
      const routedSecondary = runRouteTask({
        task,
        tokensEst,
        repeats14d,
        errors30d,
        skipHabitId,
        mode,
        forceModel: secondaryModel
      });
      const parsedSecondary = parseRouteTaskOutput(routedSecondary);
      if (!parsedSecondary.ok) {
        disagreement = 'secondary_route_failed';
      } else {
        secondary = parsedSecondary.out;
      }
    } else {
      disagreement = 'secondary_model_missing_or_same';
    }

    const consensus = evaluateDeepThinkerConsensus(out, secondary);
    if (!disagreement && !consensus.agreed) {
      disagreement = consensus.disagreement ? consensus.disagreement.reason : 'consensus_failed';
    }

    summary.deep_thinker_passes = {
      primary: { model: summary.selected_model, ...consensus.primary },
      secondary: { model: secondary ? (secondary?.route?.selected_model || secondaryModel) : secondaryModel, ...consensus.secondary },
      agreed: !disagreement,
      disagreement_reason: disagreement,
      disagreement_class: consensus.disagreement ? consensus.disagreement.class : null
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
        secondary_model: secondaryModel,
        primary_decision: consensus.primary.decision,
        secondary_decision: consensus.secondary.decision,
        agreed: false,
        disagreement_reason: disagreement,
        disagreement_class: consensus.disagreement ? consensus.disagreement.class : null,
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
        exit_code: finalExitCode
      };
    }

    process.stdout.write(JSON.stringify({
      type: 'route_execute_metrics',
      execution_metrics: {
        exit_code: finalExitCode,
        duration_ms: Math.max(0, Date.now() - execStartedMs),
        token_usage: null,
        token_usage_available: false
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
  process.stdout.write(JSON.stringify({
    type: 'route_execute_metrics',
    execution_metrics: {
      exit_code: child.status || 0,
      duration_ms: execDurationMs,
      token_usage: tokenUsage,
      token_usage_available: !!tokenUsage
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
