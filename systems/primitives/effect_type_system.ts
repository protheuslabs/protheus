#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { previewCommandPrimitive } = require('./primitive_runtime.js');
const { compileActuationToGrammar } = require('./action_grammar.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.EFFECT_TYPE_POLICY_PATH
  ? path.resolve(process.env.EFFECT_TYPE_POLICY_PATH)
  : path.join(ROOT, 'config', 'effect_type_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeEffect(v: unknown) {
  return normalizeToken(v, 80);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/effect_type_system.js evaluate --workflow-json=<json|@file> [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/primitives/effect_type_system.js status [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonArg(raw: unknown, fallback: AnyObj = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  const payload = text.startsWith('@')
    ? fs.readFileSync(path.resolve(text.slice(1)), 'utf8')
    : text;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    schema_id: 'effect_type_policy',
    schema_version: '1.0',
    enabled: true,
    mode: 'enforce',
    deny_unknown_effects: true,
    default_effect: 'compute',
    step_type_effects: {
      receipt: 'filesystem_read',
      gate: 'governance',
      command: 'compute'
    },
    allowed_effects: [
      'compute',
      'filesystem',
      'filesystem_read',
      'network',
      'shell',
      'money',
      'comms',
      'identity',
      'governance',
      'actuation'
    ],
    forbidden_transitions: [
      'money->shell',
      'money->network',
      'money->filesystem',
      'identity->shell'
    ],
    forbidden_cooccurrence_sets: [
      ['money', 'shell']
    ],
    effect_shadow_weights: {
      governance: 0.6,
      identity: 0.7,
      money: 1,
      network: 0.5,
      shell: 0.8,
      filesystem: 0.4,
      filesystem_read: 0.2,
      comms: 0.4,
      actuation: 0.5,
      compute: 0.1
    },
    max_transition_shadow: 0.85,
    max_total_shadow_per_workflow: 8,
    emit_audit: true,
    audit_path: 'state/runtime/effect_type/decisions.jsonl'
  };
}

function toSet(rows: unknown) {
  const src = Array.isArray(rows) ? rows : [];
  const out = new Set<string>();
  for (const row of src) {
    const token = normalizeToken(row, 120);
    if (token) out.add(token);
  }
  return out;
}

function toPairSet(rows: unknown) {
  const src = Array.isArray(rows) ? rows : [];
  const out = new Set<string>();
  for (const row of src) {
    const text = cleanText(row, 200).toLowerCase();
    const parts = text.split('->').map((part) => normalizeEffect(part));
    if (parts.length !== 2) continue;
    if (!parts[0] || !parts[1]) continue;
    out.add(`${parts[0]}->${parts[1]}`);
  }
  return out;
}

function toCooccurrenceSets(rows: unknown) {
  const src = Array.isArray(rows) ? rows : [];
  const out: string[][] = [];
  for (const row of src) {
    const set = Array.isArray(row)
      ? Array.from(new Set(row.map((part) => normalizeEffect(part)).filter(Boolean)))
      : [];
    if (set.length >= 2) out.push(set);
  }
  return out;
}

function loadEffectTypePolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const src = readJson(policyPath, {});
  const stepTypeEffectsRaw = src.step_type_effects && typeof src.step_type_effects === 'object'
    ? src.step_type_effects
    : base.step_type_effects;
  const stepTypeEffects: AnyObj = {};
  for (const [k, v] of Object.entries(stepTypeEffectsRaw || {})) {
    const key = normalizeToken(k, 40);
    const value = normalizeEffect(v);
    if (key && value) stepTypeEffects[key] = value;
  }
  const allowedEffects = toSet(src.allowed_effects != null ? src.allowed_effects : base.allowed_effects);
  const forbiddenTransitions = toPairSet(src.forbidden_transitions != null ? src.forbidden_transitions : base.forbidden_transitions);
  const forbiddenCooccurrenceSets = toCooccurrenceSets(
    src.forbidden_cooccurrence_sets != null
      ? src.forbidden_cooccurrence_sets
      : base.forbidden_cooccurrence_sets
  );
  const shadowWeightsRaw = src.effect_shadow_weights && typeof src.effect_shadow_weights === 'object'
    ? src.effect_shadow_weights
    : base.effect_shadow_weights;
  const effectShadowWeights: AnyObj = {};
  for (const [effectRaw, weightRaw] of Object.entries(shadowWeightsRaw || {})) {
    const effect = normalizeEffect(effectRaw);
    if (!effect) continue;
    effectShadowWeights[effect] = Number(clampNumber(weightRaw, 0, 5, 0));
  }
  const mode = normalizeToken(src.mode || base.mode, 24);
  return {
    schema_id: 'effect_type_policy',
    schema_version: cleanText(src.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: src.enabled !== false,
    mode: mode === 'advisory' ? 'advisory' : 'enforce',
    deny_unknown_effects: src.deny_unknown_effects !== false,
    default_effect: normalizeEffect(src.default_effect || base.default_effect) || 'compute',
    step_type_effects: {
      ...base.step_type_effects,
      ...stepTypeEffects
    },
    allowed_effects: Array.from(allowedEffects),
    allowed_effect_set: allowedEffects,
    forbidden_transitions: Array.from(forbiddenTransitions),
    forbidden_transition_set: forbiddenTransitions,
    forbidden_cooccurrence_sets: forbiddenCooccurrenceSets,
    effect_shadow_weights: effectShadowWeights,
    max_transition_shadow: clampNumber(
      src.max_transition_shadow,
      0,
      5,
      Number(base.max_transition_shadow)
    ),
    max_total_shadow_per_workflow: clampNumber(
      src.max_total_shadow_per_workflow,
      0,
      10_000,
      Number(base.max_total_shadow_per_workflow)
    ),
    emit_audit: src.emit_audit !== false,
    audit_path: path.isAbsolute(cleanText(src.audit_path || base.audit_path, 260))
      ? cleanText(src.audit_path || base.audit_path, 260)
      : path.join(ROOT, cleanText(src.audit_path || base.audit_path, 260)),
    policy_path: path.resolve(policyPath)
  };
}

function inferStepEffect(step: AnyObj, context: AnyObj = {}, opts: AnyObj = {}) {
  const stepType = normalizeToken(step && step.type ? step.type : 'command', 40) || 'command';
  const adapter = normalizeToken(step && step.adapter ? step.adapter : context.adapter || '', 80);
  const command = cleanText(step && step.command ? step.command : '', 4000);
  const params = step && step.params && typeof step.params === 'object' ? step.params : {};

  if (adapter) {
    const primitive = compileActuationToGrammar(adapter, params, {
      workflow_id: context.workflow_id || null,
      run_id: context.run_id || null,
      objective_id: context.objective_id || null,
      dry_run: opts.dry_run === true
    });
    return {
      effect: normalizeEffect(primitive && primitive.effect ? primitive.effect : ''),
      opcode: cleanText(primitive && primitive.opcode ? primitive.opcode : '', 80).toUpperCase() || null,
      source: 'adapter_profile',
      primitive
    };
  }

  if (command) {
    const primitive = previewCommandPrimitive(command, step, context, {
      dry_run: opts.dry_run === true
    });
    const stepPrimitive = primitive && primitive.primitive && typeof primitive.primitive === 'object'
      ? primitive.primitive
      : {};
    return {
      effect: normalizeEffect(stepPrimitive.effect || ''),
      opcode: cleanText(stepPrimitive.opcode || '', 80).toUpperCase() || null,
      source: 'command_preview',
      primitive: stepPrimitive
    };
  }

  const fallbackEffect = normalizeEffect(opts.step_type_effects && opts.step_type_effects[stepType]
    ? opts.step_type_effects[stepType]
    : opts.default_effect || 'compute');
  return {
    effect: fallbackEffect,
    opcode: null,
    source: 'step_type_fallback',
    primitive: null
  };
}

function addError(errors: AnyObj[], code: string, detail: string, extra: AnyObj = {}) {
  errors.push({
    code: normalizeToken(code, 80) || 'effect_type_error',
    detail: cleanText(detail, 280) || code,
    ...extra
  });
}

function evaluateWorkflowEffectPlan(workflow: AnyObj, context: AnyObj = {}, opts: AnyObj = {}) {
  const policy = loadEffectTypePolicy(opts.policy_path ? path.resolve(String(opts.policy_path)) : DEFAULT_POLICY_PATH);
  const workflowId = cleanText(workflow && workflow.id ? workflow.id : context.workflow_id || '', 120) || null;
  const objectiveId = cleanText(workflow && workflow.objective_id ? workflow.objective_id : context.objective_id || '', 120) || null;
  const dryRun = opts.dry_run === true;
  const rows = Array.isArray(opts.steps)
    ? opts.steps
    : Array.isArray(workflow && workflow.steps) ? workflow.steps : [];

  if (policy.enabled !== true) {
    return {
      ok: true,
      decision: 'disabled',
      workflow_id: workflowId,
      objective_id: objectiveId,
      step_effects: [],
      transitions: [],
      total_shadow: 0,
      errors: [],
      warnings: [],
      policy_version: policy.schema_version,
      policy_path: path.relative(ROOT, policy.policy_path) || policy.policy_path
    };
  }

  const errors: AnyObj[] = [];
  const warnings: AnyObj[] = [];
  const stepEffects: AnyObj[] = [];
  const transitions: AnyObj[] = [];
  const presentEffects = new Set<string>();

  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i] && typeof rows[i] === 'object' ? rows[i] : {};
    const stepId = cleanText(raw.id || `step_${i + 1}`, 120) || `step_${i + 1}`;
    const inferred = inferStepEffect(raw, context, {
      dry_run: dryRun,
      step_type_effects: policy.step_type_effects,
      default_effect: policy.default_effect
    });
    const effect = normalizeEffect(inferred.effect || policy.default_effect) || policy.default_effect;
    const opcode = cleanText(inferred.opcode || '', 80).toUpperCase() || null;
    const shadowWeight = Number(clampNumber(policy.effect_shadow_weights[effect], 0, 5, 0));
    presentEffects.add(effect);

    if (!policy.allowed_effect_set.has(effect) && policy.deny_unknown_effects === true) {
      addError(errors, 'effect_not_allowed', `step ${stepId} resolved to effect ${effect} outside allowed set`, {
        step_id: stepId,
        step_index: i,
        effect,
        opcode
      });
    }

    stepEffects.push({
      step_id: stepId,
      step_index: i,
      step_type: normalizeToken(raw.type || 'command', 40) || 'command',
      effect,
      opcode,
      source: inferred.source,
      shadow_weight: Number(shadowWeight.toFixed(4))
    });

    if (i === 0) continue;
    const prev = stepEffects[i - 1];
    const transitionKey = `${prev.effect}->${effect}`;
    const transitionShadow = Number(Math.max(prev.shadow_weight, shadowWeight).toFixed(4));
    const transition = {
      from_step_id: prev.step_id,
      from_step_index: prev.step_index,
      from_effect: prev.effect,
      to_step_id: stepId,
      to_step_index: i,
      to_effect: effect,
      transition_key: transitionKey,
      shadow_score: transitionShadow,
      shadow_limit: Number(policy.max_transition_shadow)
    };
    transitions.push(transition);

    if (policy.forbidden_transition_set.has(transitionKey)) {
      addError(errors, 'forbidden_transition', `transition ${transitionKey} is blocked by policy`, transition);
    }
    if (transitionShadow > Number(policy.max_transition_shadow)) {
      addError(
        errors,
        'transition_shadow_exceeded',
        `transition ${transitionKey} shadow ${transitionShadow} exceeds cap ${policy.max_transition_shadow}`,
        transition
      );
    }
  }

  for (const combo of policy.forbidden_cooccurrence_sets) {
    const present = combo.every((effect) => presentEffects.has(effect));
    if (present) {
      addError(
        errors,
        'forbidden_cooccurrence',
        `effect set ${combo.join('+')} cannot coexist in one workflow`,
        { effects: combo }
      );
    }
  }

  const totalShadow = Number(stepEffects
    .reduce((sum, row) => sum + Number(row.shadow_weight || 0), 0)
    .toFixed(4));
  if (totalShadow > Number(policy.max_total_shadow_per_workflow)) {
    addError(
      errors,
      'total_shadow_exceeded',
      `total effect shadow ${totalShadow} exceeds cap ${policy.max_total_shadow_per_workflow}`,
      {
        total_shadow: totalShadow,
        total_shadow_cap: Number(policy.max_total_shadow_per_workflow)
      }
    );
  }

  const enforce = policy.mode === 'enforce';
  const denied = enforce && errors.length > 0;
  if (!enforce && errors.length > 0) {
    warnings.push({
      code: 'advisory_effect_policy_violation',
      detail: `advisory mode observed ${errors.length} effect-policy violations`
    });
  }

  const payload = {
    ok: !denied,
    decision: denied ? 'deny' : (errors.length ? 'advisory_allow' : 'allow'),
    mode: policy.mode,
    workflow_id: workflowId,
    objective_id: objectiveId,
    total_steps: stepEffects.length,
    step_effects: stepEffects,
    transitions,
    present_effects: Array.from(presentEffects).sort(),
    total_shadow: totalShadow,
    total_shadow_cap: Number(policy.max_total_shadow_per_workflow),
    errors,
    warnings,
    policy_version: policy.schema_version,
    policy_path: path.relative(ROOT, policy.policy_path) || policy.policy_path,
    dry_run: dryRun
  };

  if (policy.emit_audit === true) {
    appendJsonl(policy.audit_path, {
      ts: nowIso(),
      type: 'effect_type_plan',
      workflow_id: workflowId,
      objective_id: objectiveId,
      ok: payload.ok,
      decision: payload.decision,
      mode: payload.mode,
      total_steps: payload.total_steps,
      total_shadow: payload.total_shadow,
      total_shadow_cap: payload.total_shadow_cap,
      errors_count: payload.errors.length,
      warnings_count: payload.warnings.length,
      present_effects: payload.present_effects,
      denied_transition_count: payload.errors.filter((row: AnyObj) => row.code === 'forbidden_transition').length,
      policy_version: payload.policy_version,
      dry_run: dryRun
    });
  }

  return payload;
}

function cmdEvaluate(args: AnyObj) {
  const workflow = parseJsonArg(args.workflow_json || args['workflow-json'], null);
  if (!workflow || typeof workflow !== 'object') {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'workflow_json_required' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, false);
  const payload = evaluateWorkflowEffectPlan(workflow, {
    workflow_id: cleanText(args.workflow_id || args['workflow-id'] || '', 120) || null,
    objective_id: cleanText(args.objective_id || args['objective-id'] || '', 120) || null,
    run_id: cleanText(args.run_id || args['run-id'] || '', 120) || null,
    adapter: cleanText(args.adapter || '', 80) || null
  }, {
    policy_path: args.policy ? path.resolve(String(args.policy)) : undefined,
    dry_run: toBool(args['dry-run'], false)
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadEffectTypePolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const rows = readJsonl(policy.audit_path);
  const latest = rows.length ? rows[rows.length - 1] : null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'effect_type_system_status',
    mode: policy.mode,
    enabled: policy.enabled === true,
    allowed_effects: policy.allowed_effects,
    forbidden_transition_count: policy.forbidden_transitions.length,
    forbidden_cooccurrence_count: policy.forbidden_cooccurrence_sets.length,
    max_transition_shadow: policy.max_transition_shadow,
    max_total_shadow_per_workflow: policy.max_total_shadow_per_workflow,
    audit_path: path.relative(ROOT, policy.audit_path) || policy.audit_path,
    latest
  })}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || 'evaluate').toLowerCase();
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(1);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  DEFAULT_POLICY_PATH,
  loadEffectTypePolicy,
  inferStepEffect,
  evaluateWorkflowEffectPlan
};
