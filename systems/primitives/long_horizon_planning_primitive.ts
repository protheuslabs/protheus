#!/usr/bin/env node
'use strict';
export {};

/**
 * long_horizon_planning_primitive.js
 *
 * V3-LHP-001:
 * - Test-time planning budget scaler for complex objectives.
 * - Emits structured intermediate planning steps ("thinking tokens").
 * - Advisory-first integration lane for Weaver/routing.
 *
 * Usage:
 *   node systems/primitives/long_horizon_planning_primitive.js run --objective-id=<id> --objective="..." [--complexity=0.0..1.0] [--risk=low|medium|high]
 *   node systems/primitives/long_horizon_planning_primitive.js status [latest|YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.LONG_HORIZON_PLANNING_POLICY_PATH
  ? path.resolve(process.env.LONG_HORIZON_PLANNING_POLICY_PATH)
  : path.join(ROOT, 'config', 'long_horizon_planning_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/long_horizon_planning_primitive.js run --objective-id=<id> --objective="..." [--complexity=0.0..1.0] [--risk=low|medium|high]');
  console.log('  node systems/primitives/long_horizon_planning_primitive.js status [latest|YYYY-MM-DD]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || fallbackRel, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    token_budget: {
      min_thinking_tokens: 256,
      max_thinking_tokens: 4096,
      low_complexity_threshold: 0.35,
      high_complexity_threshold: 0.72
    },
    structured_thinking: {
      enabled: true,
      max_steps: 12,
      include_risk_checks: true
    },
    test_time_scaling: {
      enabled: true,
      self_critique_enabled: true,
      max_revision_loops: 3,
      confidence_floor: 0.72,
      confidence_ceiling: 0.98,
      deep_mode_threshold: 0.55,
      debate_mode_threshold: 0.8
    },
    state: {
      latest_path: 'state/primitives/long_horizon_planning/latest.json',
      history_path: 'state/primitives/long_horizon_planning/history.jsonl',
      receipts_path: 'state/primitives/long_horizon_planning/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const tokenBudget = raw.token_budget && typeof raw.token_budget === 'object' ? raw.token_budget : {};
  const structured = raw.structured_thinking && typeof raw.structured_thinking === 'object' ? raw.structured_thinking : {};
  const testTimeScaling = raw.test_time_scaling && typeof raw.test_time_scaling === 'object' ? raw.test_time_scaling : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    token_budget: {
      min_thinking_tokens: clampInt(tokenBudget.min_thinking_tokens, 64, 1_000_000, base.token_budget.min_thinking_tokens),
      max_thinking_tokens: clampInt(tokenBudget.max_thinking_tokens, 64, 1_000_000, base.token_budget.max_thinking_tokens),
      low_complexity_threshold: clampNumber(tokenBudget.low_complexity_threshold, 0, 1, base.token_budget.low_complexity_threshold),
      high_complexity_threshold: clampNumber(tokenBudget.high_complexity_threshold, 0, 1, base.token_budget.high_complexity_threshold)
    },
    structured_thinking: {
      enabled: structured.enabled !== false,
      max_steps: clampInt(structured.max_steps, 3, 32, base.structured_thinking.max_steps),
      include_risk_checks: toBool(structured.include_risk_checks, base.structured_thinking.include_risk_checks)
    },
    test_time_scaling: {
      enabled: toBool(testTimeScaling.enabled, base.test_time_scaling.enabled),
      self_critique_enabled: toBool(testTimeScaling.self_critique_enabled, base.test_time_scaling.self_critique_enabled),
      max_revision_loops: clampInt(testTimeScaling.max_revision_loops, 0, 10, base.test_time_scaling.max_revision_loops),
      confidence_floor: clampNumber(testTimeScaling.confidence_floor, 0, 1, base.test_time_scaling.confidence_floor),
      confidence_ceiling: clampNumber(testTimeScaling.confidence_ceiling, 0, 1, base.test_time_scaling.confidence_ceiling),
      deep_mode_threshold: clampNumber(testTimeScaling.deep_mode_threshold, 0, 1, base.test_time_scaling.deep_mode_threshold),
      debate_mode_threshold: clampNumber(testTimeScaling.debate_mode_threshold, 0, 1, base.test_time_scaling.debate_mode_threshold)
    },
    state: {
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      history_path: resolvePath(state.history_path || base.state.history_path, base.state.history_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function inferComplexity(objectiveText: string) {
  const text = String(objectiveText || '').toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  const keywordHits = [
    /multi[- ]?step/,
    /parallel/,
    /long[- ]?horizon/,
    /risk/,
    /compliance/,
    /federation/,
    /migration/,
    /rollout/,
    /debug/,
    /optimi[sz]/
  ].filter((re) => re.test(text)).length;
  return clampNumber((Math.min(words, 120) / 120) * 0.65 + Math.min(keywordHits, 8) / 8 * 0.35, 0, 1, 0.4);
}

function thinkingBudget(policy: AnyObj, complexity: number) {
  const lo = Number(policy.token_budget.min_thinking_tokens || 256);
  const hi = Math.max(lo, Number(policy.token_budget.max_thinking_tokens || 4096));
  return Math.round(lo + (hi - lo) * complexity);
}

function computeTestTimeScaling(policy: AnyObj, riskTier: string, complexity: number) {
  const cfg = policy.test_time_scaling && typeof policy.test_time_scaling === 'object'
    ? policy.test_time_scaling
    : {};
  const enabled = cfg.enabled === true;
  const selfCritique = cfg.self_critique_enabled === true;
  const confidenceFloor = Number(cfg.confidence_floor || 0.72);
  const confidenceCeiling = Number(cfg.confidence_ceiling || 0.98);
  const riskPenalty = riskTier === 'critical'
    ? 0.2
    : (riskTier === 'high' ? 0.16 : (riskTier === 'medium' ? 0.08 : 0.03));
  const initialConfidence = Number(clampNumber(0.93 - (complexity * 0.34) - riskPenalty, 0.2, 0.95, 0.6).toFixed(6));
  const revisionNeed = Math.max(0, confidenceFloor - initialConfidence);
  const complexityLoops = complexity >= 0.85 ? 2 : (complexity >= 0.65 ? 1 : 0);
  const revisionLoops = enabled
    ? clampInt(Math.ceil(revisionNeed / 0.06) + complexityLoops, 0, Number(cfg.max_revision_loops || 3), 0)
    : 0;
  const gainPerLoop = selfCritique ? 0.055 : 0.04;
  const finalConfidence = Number(
    clampNumber(
      initialConfidence + (revisionLoops * gainPerLoop),
      0,
      confidenceCeiling,
      initialConfidence
    ).toFixed(6)
  );
  const deepThreshold = Number(cfg.deep_mode_threshold || 0.55);
  const debateThreshold = Number(cfg.debate_mode_threshold || 0.8);
  const strategyMode = complexity >= debateThreshold
    ? 'multi_agent_debate'
    : (complexity >= deepThreshold ? 'deep_thinking' : 'fast_reflex');

  const thinkingChain: AnyObj[] = [{
    phase: 'initial_plan',
    confidence_before: null,
    confidence_after: initialConfidence,
    note: 'initial objective decomposition and constraint framing'
  }];
  if (selfCritique) {
    thinkingChain.push({
      phase: 'self_critique',
      confidence_before: initialConfidence,
      confidence_after: initialConfidence,
      note: 'identify weak assumptions and unresolved failure modes'
    });
  }
  let rolling = initialConfidence;
  for (let i = 0; i < revisionLoops; i += 1) {
    const next = Number(clampNumber(rolling + gainPerLoop, 0, confidenceCeiling, rolling).toFixed(6));
    thinkingChain.push({
      phase: `revision_loop_${i + 1}`,
      confidence_before: rolling,
      confidence_after: next,
      note: `revise plan against critique and policy constraints (loop ${i + 1})`
    });
    rolling = next;
  }
  thinkingChain.push({
    phase: 'final_validation',
    confidence_before: rolling,
    confidence_after: finalConfidence,
    note: 'final consistency check before execution contract handoff'
  });

  return {
    enabled,
    self_critique_enabled: selfCritique,
    revision_loops: revisionLoops,
    confidence_floor: confidenceFloor,
    confidence_ceiling: confidenceCeiling,
    initial_confidence: initialConfidence,
    final_confidence: finalConfidence,
    confidence_floor_met: finalConfidence >= confidenceFloor,
    strategy_mode: strategyMode,
    thinking_chain: thinkingChain
  };
}

function buildStructuredSteps(
  policy: AnyObj,
  objectiveId: string,
  objectiveText: string,
  riskTier: string,
  complexity: number,
  scaling: AnyObj
) {
  const steps: AnyObj[] = [];
  const maxSteps = Number(policy.structured_thinking.max_steps || 12);
  const push = (stage: string, task: string, expectedReceipt: string) => {
    if (steps.length >= maxSteps) return;
    steps.push({
      step_id: `lhp_${steps.length + 1}`,
      stage,
      task,
      expected_receipt: expectedReceipt
    });
  };
  push('frame_problem', `Define constraints and success invariants for ${objectiveId}`, 'planning_constraints_receipt');
  push('decompose_path', `Break objective into parallelizable lanes for "${objectiveText.slice(0, 120)}"`, 'planning_decomposition_receipt');
  push('simulate_outcomes', 'Run bounded what-if simulation for top execution branches', 'planning_simulation_receipt');
  if (scaling && scaling.enabled === true && scaling.self_critique_enabled === true) {
    push('self_critique', 'Critique the initial plan and enumerate highest-risk failure assumptions', 'planning_self_critique_receipt');
  }
  const revisionLoops = Math.max(0, Number(scaling && scaling.revision_loops || 0));
  for (let i = 0; i < revisionLoops; i += 1) {
    push(
      'revise_plan',
      `Apply critique-informed revision loop ${i + 1} with bounded scope`,
      'planning_revision_receipt'
    );
  }
  if (policy.structured_thinking.include_risk_checks !== false || ['medium', 'high', 'critical'].includes(riskTier)) {
    push('risk_checks', `Run policy and failure-mode checks at ${riskTier} risk`, 'planning_risk_gate_receipt');
  }
  if (complexity >= 0.6) {
    push('checkpoint_plan', 'Define stage checkpoints and rollback strategy', 'planning_checkpoint_receipt');
  }
  push('execution_contract', 'Emit execution-ready plan contract for Weaver routing', 'planning_contract_receipt');
  return steps;
}

function runLongHorizonPlanning(input: AnyObj = {}, opts: AnyObj = {}) {
  const policy = opts.policy && typeof opts.policy === 'object'
    ? opts.policy
    : loadPolicy(opts.policyPath || opts.policy_path || DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'long_horizon_planning',
      error: 'policy_disabled'
    };
  }
  const ts = nowIso();
  const date = toDate(opts.date || input.date || ts.slice(0, 10));
  const objectiveId = normalizeToken(input.objective_id || input.objectiveId || 'generic_objective', 160) || 'generic_objective';
  const objectiveText = cleanText(input.objective || input.objective_text || objectiveId, 400) || objectiveId;
  const riskTier = normalizeToken(input.risk || input.risk_tier || 'medium', 32) || 'medium';
  const complexityInput = Number(input.complexity);
  const complexity = Number.isFinite(complexityInput)
    ? clampNumber(complexityInput, 0, 1, 0.5)
    : inferComplexity(objectiveText);
  const budget = thinkingBudget(policy, complexity);
  const lowCut = Number(policy.token_budget.low_complexity_threshold || 0.35);
  const highCut = Number(policy.token_budget.high_complexity_threshold || 0.72);
  const tier = complexity < lowCut ? 'low' : (complexity < highCut ? 'medium' : 'high');
  const scaling = computeTestTimeScaling(policy, riskTier, complexity);
  const steps = policy.structured_thinking.enabled === true
    ? buildStructuredSteps(policy, objectiveId, objectiveText, riskTier, complexity, scaling)
    : [];

  const out = {
    ok: true,
    type: 'long_horizon_planning',
    ts,
    date,
    shadow_only: policy.shadow_only === true,
    objective_id: objectiveId,
    objective_text: objectiveText,
    risk_tier: riskTier,
    complexity_score: Number(complexity.toFixed(6)),
    complexity_tier: tier,
    recommended_reasoning_strategy: scaling.strategy_mode,
    thinking_token_budget: budget,
    structured_thinking: {
      enabled: policy.structured_thinking.enabled === true,
      step_count: steps.length,
      steps
    },
    test_time_scaling: {
      enabled: scaling.enabled === true,
      self_critique_enabled: scaling.self_critique_enabled === true,
      revision_loops: Number(scaling.revision_loops || 0),
      confidence_floor: Number(scaling.confidence_floor || 0),
      confidence_ceiling: Number(scaling.confidence_ceiling || 0),
      initial_confidence: Number(scaling.initial_confidence || 0),
      final_confidence: Number(scaling.final_confidence || 0),
      confidence_floor_met: scaling.confidence_floor_met === true,
      thinking_chain: Array.isArray(scaling.thinking_chain) ? scaling.thinking_chain : []
    },
    reason_codes: [
      `planning_complexity_${tier}`,
      `thinking_budget_${budget}`,
      'structured_thinking_tokens_enabled',
      `test_time_scaling_${scaling.enabled === true ? 'enabled' : 'disabled'}`,
      `test_time_scaling_revision_loops_${Number(scaling.revision_loops || 0)}`,
      `reasoning_strategy_${scaling.strategy_mode}`
    ]
  };
  if (opts.persist !== false) {
    writeJsonAtomic(policy.state.latest_path, out);
    appendJsonl(policy.state.history_path, out);
    appendJsonl(policy.state.receipts_path, out);
  }
  return out;
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const out = runLongHorizonPlanning({
    date: args._[1] || args.date,
    objective_id: args.objective_id || args['objective-id'],
    objective: args.objective || args['objective-text'] || args['objective_text'],
    risk: args.risk || args.risk_tier || args['risk-tier'],
    complexity: args.complexity
  }, {
    policyPath,
    persist: true
  });
  process.stdout.write(`${JSON.stringify({
    ...out,
    policy: {
      path: relPath(policyPath),
      version: loadPolicy(policyPath).version
    }
  })}\n`);
  if (out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const key = cleanText(args._[1] || args.date || 'latest', 40);
  let payload = null;
  if (key === 'latest') payload = readJson(policy.state.latest_path, null);
  else {
    const day = toDate(key);
    const rows = readJsonl(policy.state.history_path).filter((row: AnyObj) => String(row && row.date || '') === day);
    payload = rows.length ? rows[rows.length - 1] : null;
  }
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'long_horizon_planning_status',
      error: 'snapshot_missing',
      date: key
    })}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'long_horizon_planning_status',
    ts: payload.ts || null,
    date: payload.date || null,
    objective_id: payload.objective_id || null,
    complexity_score: payload.complexity_score || 0,
    recommended_reasoning_strategy: payload.recommended_reasoning_strategy || null,
    thinking_token_budget: payload.thinking_token_budget || 0,
    structured_step_count: payload.structured_thinking && payload.structured_thinking.step_count != null
      ? Number(payload.structured_thinking.step_count)
      : 0,
    revision_loops: payload.test_time_scaling && payload.test_time_scaling.revision_loops != null
      ? Number(payload.test_time_scaling.revision_loops)
      : 0,
    final_confidence: payload.test_time_scaling && payload.test_time_scaling.final_confidence != null
      ? Number(payload.test_time_scaling.final_confidence)
      : 0,
    shadow_only: payload.shadow_only === true
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
    return;
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runLongHorizonPlanning
};
