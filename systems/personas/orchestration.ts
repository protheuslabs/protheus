#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { evaluateSecurityGate } = require('../security/rust_security_gate.js');

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_ORG_DIR = path.join(ROOT, 'personas', 'organization');
const ORG_DIR = process.env.PROTHEUS_PERSONA_ORG_DIR
  ? path.resolve(process.env.PROTHEUS_PERSONA_ORG_DIR)
  : DEFAULT_ORG_DIR;
const DEFAULT_PERSONAS_DIR = path.join(ROOT, 'personas');
const PERSONAS_DIR = process.env.PROTHEUS_PERSONA_DIR
  ? path.resolve(process.env.PROTHEUS_PERSONA_DIR)
  : DEFAULT_PERSONAS_DIR;
const MEETINGS_DIR = path.join(ORG_DIR, 'meetings');
const PROJECTS_DIR = path.join(ORG_DIR, 'projects');
const LOCKS_DIR = path.join(ORG_DIR, '.locks');
const TELEMETRY_PATH = path.join(ORG_DIR, 'telemetry.jsonl');
const SHADOW_STATE_PATH = path.join(ORG_DIR, 'shadow_mode_state.json');
const SHADOW_DEPLOYMENT_POLICY_PATH = path.join(ORG_DIR, 'shadow_deployment_policy.json');
const MEETINGS_LEDGER = path.join(MEETINGS_DIR, 'ledger.jsonl');
const PROJECTS_LEDGER = path.join(PROJECTS_DIR, 'ledger.jsonl');
const HARD_RETENTION_TTL_DAYS = 90;

function cleanText(v: unknown, maxLen = 800) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function sha256Hex(text: string) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string) {
  return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || '{}'));
}

function readJsonOptional(filePath: string, fallback: any) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return readJson(filePath);
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendJsonlHashChained(filePath: string, row: Record<string, unknown>) {
  const rows = readJsonl(filePath);
  const prevHash = rows.length ? cleanText(rows[rows.length - 1].hash || '', 200) : '';
  const base = {
    ...row,
    prev_hash: prevHash || null
  };
  const hash = sha256Hex(stableStringify(base));
  const chained = {
    ...base,
    hash
  };
  fs.appendFileSync(filePath, `${JSON.stringify(chained)}\n`, 'utf8');
  return chained;
}

function lockPath(kind: 'meeting' | 'project', id: string) {
  return path.join(LOCKS_DIR, `${kind}_${normalizeToken(id, 120)}.lock`);
}

function withLock(kind: 'meeting' | 'project', id: string, fn: () => any) {
  ensureDir(LOCKS_DIR);
  const fp = lockPath(kind, id);
  let handle: number | null = null;
  try {
    handle = fs.openSync(fp, 'wx');
  } catch (err: any) {
    throw new Error(`idempotency_lock_exists:${cleanText(err && err.message || '', 240)}`);
  }
  try {
    return fn();
  } finally {
    try {
      if (handle != null) fs.closeSync(handle);
    } catch {}
    try {
      fs.unlinkSync(fp);
    } catch {}
  }
}

function usage() {
  console.log('Usage:');
  console.log('  protheus orchestrate meeting "<topic>" [--approval-note="..."] [--emotion=on|off] [--override-reason=...] [--override-actor=...] [--override-expiry=ISO8601] [--monarch-token=...]');
  console.log('  protheus orchestrate project "<name>" "<goal>" [--approval-note="..."] [--emotion=on|off] [--override-reason=...] [--override-actor=...] [--override-expiry=ISO8601] [--monarch-token=...]');
  console.log('  protheus orchestrate project --id=<project_id> --transition=<active|blocked|completed|cancelled|paused_on_breaker|reviewed|resumed|rolled_back> [--approval-note="..."] [--drift-rate=0.0] [--override-reason=...] [--override-actor=...] [--override-expiry=ISO8601] [--monarch-token=...]');
  console.log('  protheus orchestrate status');
  console.log('  protheus orchestrate telemetry [--window=20]');
  console.log('  protheus orchestrate audit "<artifact_id>"');
  console.log('  protheus orchestrate prune [--ttl-days=90]');
}

function schemaPaths() {
  return {
    arbitrationRules: path.join(ORG_DIR, 'arbitration_rules.schema.json'),
    routingRules: path.join(ORG_DIR, 'routing_rules.schema.json'),
    breakerPolicy: path.join(ORG_DIR, 'breaker_policy.schema.json'),
    soulTokenPolicy: path.join(ORG_DIR, 'soul_token_policy.schema.json'),
    meetingArtifact: path.join(ORG_DIR, 'meeting_artifact.schema.json'),
    projectArtifact: path.join(ORG_DIR, 'project_artifact.schema.json')
  };
}

function policyPaths() {
  return {
    arbitrationRules: path.join(ORG_DIR, 'arbitration_rules.json'),
    routingRules: path.join(ORG_DIR, 'routing_rules.json'),
    riskPolicy: path.join(ORG_DIR, 'risk_policy.json'),
    breakerPolicy: path.join(ORG_DIR, 'breaker_policy.json'),
    soulTokenPolicy: path.join(ORG_DIR, 'soul_token_policy.json'),
    telemetryPolicy: path.join(ORG_DIR, 'telemetry_policy.json'),
    retentionPolicy: path.join(ORG_DIR, 'retention_policy.json'),
    shadowDeploymentPolicy: SHADOW_DEPLOYMENT_POLICY_PATH
  };
}

function validateType(value: unknown, expected: string) {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return Number.isFinite(Number(value));
  if (expected === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'string') return typeof value === 'string';
  return true;
}

function validateAgainstSchema(value: any, schema: any, pointer = '$'): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== 'object') {
    errors.push(`${pointer}:schema_missing`);
    return errors;
  }
  if (schema.type && !validateType(value, schema.type)) {
    errors.push(`${pointer}:type_expected_${schema.type}`);
    return errors;
  }
  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pointer}:enum_mismatch`);
  }
  if (schema.type === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value || {}, key)) {
        errors.push(`${pointer}.${key}:required_missing`);
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value || {}, key)) continue;
      errors.push(...validateAgainstSchema((value || {})[key], propSchema, `${pointer}.${key}`));
    }
  }
  if (schema.type === 'array' && schema.items) {
    const arr = Array.isArray(value) ? value : [];
    for (let i = 0; i < arr.length; i += 1) {
      errors.push(...validateAgainstSchema(arr[i], schema.items, `${pointer}[${i}]`));
    }
  }
  return errors;
}

function validatePoliciesAndSchemas() {
  const sPaths = schemaPaths();
  const pPaths = policyPaths();
  const failures: string[] = [];
  for (const filePath of Object.values(sPaths)) {
    if (!fs.existsSync(filePath)) failures.push(`schema_missing:${path.basename(filePath)}`);
  }
  for (const filePath of Object.values(pPaths)) {
    if (!fs.existsSync(filePath)) failures.push(`policy_missing:${path.basename(filePath)}`);
  }
  if (failures.length) {
    return {
      ok: false,
      failures
    };
  }
  let schemas: any = null;
  let policies: any = null;
  try {
    schemas = {
      arbitrationRules: readJson(sPaths.arbitrationRules),
      routingRules: readJson(sPaths.routingRules),
      breakerPolicy: readJson(sPaths.breakerPolicy),
      soulTokenPolicy: readJson(sPaths.soulTokenPolicy),
      meetingArtifact: readJson(sPaths.meetingArtifact),
      projectArtifact: readJson(sPaths.projectArtifact)
    };
  } catch (err: any) {
    return {
      ok: false,
      failures: [`schema_malformed:${cleanText(err && err.message || '', 240)}`]
    };
  }
  try {
    policies = {
      arbitrationRules: readJson(pPaths.arbitrationRules),
      routingRules: readJson(pPaths.routingRules),
      riskPolicy: readJson(pPaths.riskPolicy),
      breakerPolicy: readJson(pPaths.breakerPolicy),
      soulTokenPolicy: readJson(pPaths.soulTokenPolicy),
      telemetryPolicy: readJson(pPaths.telemetryPolicy),
      retentionPolicy: readJson(pPaths.retentionPolicy),
      shadowDeploymentPolicy: readJson(pPaths.shadowDeploymentPolicy)
    };
  } catch (err: any) {
    return {
      ok: false,
      failures: [`policy_malformed:${cleanText(err && err.message || '', 240)}`]
    };
  }

  const policyValidations = [
    ['arbitration_rules.json', policies.arbitrationRules, schemas.arbitrationRules],
    ['routing_rules.json', policies.routingRules, schemas.routingRules],
    ['breaker_policy.json', policies.breakerPolicy, schemas.breakerPolicy],
    ['soul_token_policy.json', policies.soulTokenPolicy, schemas.soulTokenPolicy]
  ] as Array<[string, any, any]>;
  for (const [name, payload, schema] of policyValidations) {
    const errs = validateAgainstSchema(payload, schema);
    if (errs.length) failures.push(`${name}_invalid:${errs.slice(0, 4).join('|')}`);
  }

  const priority = Array.isArray(policies.arbitrationRules.tie_break_priority)
    ? policies.arbitrationRules.tie_break_priority.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : [];
  const uniq = new Set(priority);
  if (priority.length !== uniq.size) {
    failures.push('arbitration_rules_conflict:duplicate_tie_break_priority_entries');
  }

  const riskPolicy = policies.riskPolicy && typeof policies.riskPolicy === 'object'
    ? policies.riskPolicy
    : null;
  if (!riskPolicy) {
    failures.push('risk_policy_invalid:not_an_object');
  } else {
    const budgets = riskPolicy.budgets && typeof riskPolicy.budgets === 'object'
      ? riskPolicy.budgets
      : null;
    if (!Array.isArray(riskPolicy.approval_required_tiers)) {
      failures.push('risk_policy_invalid:approval_required_tiers_missing');
    }
    if (!budgets) {
      failures.push('risk_policy_invalid:budgets_missing');
    } else {
      const maxPersonas = Number(budgets.max_personas);
      const maxTokens = Number(budgets.max_tokens_estimate);
      const maxRuntimeMs = Number(budgets.max_runtime_ms);
      if (!Number.isFinite(maxPersonas) || maxPersonas < 1) {
        failures.push('risk_policy_invalid:max_personas');
      }
      if (!Number.isFinite(maxTokens) || maxTokens < 1) {
        failures.push('risk_policy_invalid:max_tokens_estimate');
      }
      if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 1) {
        failures.push('risk_policy_invalid:max_runtime_ms');
      }
    }
  }

  const breakerPolicy = policies.breakerPolicy && typeof policies.breakerPolicy === 'object'
    ? policies.breakerPolicy
    : null;
  if (!breakerPolicy) {
    failures.push('breaker_policy_invalid:not_an_object');
  } else {
    const thresholds = breakerPolicy.thresholds && typeof breakerPolicy.thresholds === 'object'
      ? breakerPolicy.thresholds
      : null;
    if (!thresholds) {
      failures.push('breaker_policy_invalid:thresholds_missing');
    } else {
      const requiredThresholds = [
        'intent_drift_max',
        'budget_overrun_max',
        'runtime_overrun_max',
        'escalation_rate_max'
      ];
      for (const key of requiredThresholds) {
        const value = Number((thresholds as Record<string, unknown>)[key]);
        if (!Number.isFinite(value) || value < 0) {
          failures.push(`breaker_policy_invalid:${key}`);
        }
      }
      const sovereigntyViolation = cleanText((thresholds as Record<string, unknown>).sovereignty_violation, 120).toLowerCase();
      if (sovereigntyViolation !== 'fail_closed') {
        failures.push('breaker_policy_invalid:sovereignty_violation_must_fail_closed');
      }
    }
  }

  const telemetryPolicy = policies.telemetryPolicy && typeof policies.telemetryPolicy === 'object'
    ? policies.telemetryPolicy
    : null;
  if (!telemetryPolicy) {
    failures.push('telemetry_policy_invalid:not_an_object');
  } else {
    const formulas = telemetryPolicy.formulas && typeof telemetryPolicy.formulas === 'object'
      ? telemetryPolicy.formulas
      : null;
    if (!formulas) {
      failures.push('telemetry_policy_invalid:formulas_missing');
    } else {
      for (const key of [
        'latency_ms',
        'disagreement_rate',
        'arbitration_overrides',
        'adoption_rate',
        'post_outcome_success',
        'breaker_trip_rate',
        'mttr_ms',
        'auto_rollback_rate',
        'escalation_burst_count'
      ]) {
        if (!cleanText((formulas as Record<string, unknown>)[key], 300)) {
          failures.push(`telemetry_policy_invalid:formula_missing_${key}`);
        }
      }
    }
  }

  const retentionPolicy = policies.retentionPolicy && typeof policies.retentionPolicy === 'object'
    ? policies.retentionPolicy
    : null;
  if (!retentionPolicy) {
    failures.push('retention_policy_invalid:not_an_object');
  } else {
    const ttlDays = Number(retentionPolicy.ttl_days);
    if (!Number.isFinite(ttlDays) || ttlDays < 1) {
      failures.push('retention_policy_invalid:ttl_days');
    }
    const externalSyncEnabled = Boolean(
      retentionPolicy.external_sync
      && typeof retentionPolicy.external_sync === 'object'
      && retentionPolicy.external_sync.enabled === true
    );
    if (externalSyncEnabled) {
      failures.push('retention_policy_invalid:external_sync_must_be_disabled');
    }
  }

  const soulTokenPolicy = policies.soulTokenPolicy && typeof policies.soulTokenPolicy === 'object'
    ? policies.soulTokenPolicy
    : null;
  if (!soulTokenPolicy) {
    failures.push('soul_token_policy_invalid:not_an_object');
  } else {
    const highRisk = soulTokenPolicy.high_risk && typeof soulTokenPolicy.high_risk === 'object'
      ? soulTokenPolicy.high_risk
      : null;
    const overrides = soulTokenPolicy.overrides && typeof soulTokenPolicy.overrides === 'object'
      ? soulTokenPolicy.overrides
      : null;
    if (!highRisk) {
      failures.push('soul_token_policy_invalid:high_risk_missing');
    } else if (!cleanText(highRisk.actor || '', 120)) {
      failures.push('soul_token_policy_invalid:high_risk_actor');
    }
    if (!overrides) {
      failures.push('soul_token_policy_invalid:overrides_missing');
    } else if (!cleanText(overrides.actor || '', 120)) {
      failures.push('soul_token_policy_invalid:overrides_actor');
    }
  }

  const shadowDeploymentPolicy = policies.shadowDeploymentPolicy && typeof policies.shadowDeploymentPolicy === 'object'
    ? policies.shadowDeploymentPolicy
    : null;
  if (!shadowDeploymentPolicy) {
    failures.push('shadow_deployment_policy_invalid:not_an_object');
  } else {
    const featureFlags = shadowDeploymentPolicy.feature_flags && typeof shadowDeploymentPolicy.feature_flags === 'object'
      ? shadowDeploymentPolicy.feature_flags
      : null;
    const killSwitch = shadowDeploymentPolicy.kill_switch && typeof shadowDeploymentPolicy.kill_switch === 'object'
      ? shadowDeploymentPolicy.kill_switch
      : null;
    const resourceIsolation = shadowDeploymentPolicy.resource_isolation && typeof shadowDeploymentPolicy.resource_isolation === 'object'
      ? shadowDeploymentPolicy.resource_isolation
      : null;
    if (!featureFlags) {
      failures.push('shadow_deployment_policy_invalid:feature_flags_missing');
    }
    if (!killSwitch) {
      failures.push('shadow_deployment_policy_invalid:kill_switch_missing');
    }
    if (!resourceIsolation) {
      failures.push('shadow_deployment_policy_invalid:resource_isolation_missing');
    } else {
      const maxMeeting = Number(resourceIsolation.max_concurrent_meetings);
      const maxProject = Number(resourceIsolation.max_concurrent_projects);
      if (!Number.isFinite(maxMeeting) || maxMeeting < 1) {
        failures.push('shadow_deployment_policy_invalid:max_concurrent_meetings');
      }
      if (!Number.isFinite(maxProject) || maxProject < 1) {
        failures.push('shadow_deployment_policy_invalid:max_concurrent_projects');
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    schemas,
    policies
  };
}

function allPersonaIds() {
  if (!fs.existsSync(PERSONAS_DIR)) return [];
  return fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
    .filter((entry: any) => entry && entry.isDirectory())
    .map((entry: any) => String(entry.name || ''))
    .filter((name: string) => fs.existsSync(path.join(PERSONAS_DIR, name, 'profile.md')))
    .sort();
}

function policyPersonaIds(routingRules: any) {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const token = normalizeToken(value, 80);
    if (token) ids.add(token);
  };
  const core = Array.isArray(routingRules && routingRules.core_personas)
    ? routingRules.core_personas
    : [];
  for (const item of core) add(item);
  const routes = Array.isArray(routingRules && routingRules.topic_routes)
    ? routingRules.topic_routes
    : [];
  for (const route of routes) {
    const specs = Array.isArray(route && route.specialists) ? route.specialists : [];
    for (const item of specs) add(item);
  }
  return Array.from(ids).sort();
}

function detectDomain(topic: string, routingRules: any) {
  const lower = String(topic || '').toLowerCase();
  const routes = Array.isArray(routingRules.topic_routes) ? routingRules.topic_routes : [];
  for (const route of routes) {
    const keys = Array.isArray(route.match_any) ? route.match_any : [];
    if (keys.some((k: unknown) => lower.includes(String(k || '').toLowerCase()))) {
      return {
        domain: normalizeToken(route.domain || 'general', 80) || 'general',
        route
      };
    }
  }
  return {
    domain: normalizeToken(routingRules.default_domain || 'general', 80) || 'general',
    route: null
  };
}

function selectAttendees(topic: string, routingRules: any, riskPolicy: any) {
  const localPersonas = allPersonaIds();
  const personas = localPersonas.length ? localPersonas : policyPersonaIds(routingRules);
  const personaSet = new Set(personas);
  const core = Array.isArray(routingRules.core_personas)
    ? routingRules.core_personas.map((v: unknown) => normalizeToken(v, 80)).filter((v: string) => personaSet.has(v))
    : [];
  const { domain, route } = detectDomain(topic, routingRules);
  const specialists = route && Array.isArray(route.specialists)
    ? route.specialists.map((v: unknown) => normalizeToken(v, 80)).filter((v: string) => personaSet.has(v))
    : [];

  const ordered = Array.from(new Set([...core, ...specialists])).filter(Boolean);
  const budget = riskPolicy && riskPolicy.budgets && typeof riskPolicy.budgets === 'object' ? riskPolicy.budgets : {};
  const maxPersonas = Number.isFinite(Number(budget.max_personas)) ? Math.max(1, Number(budget.max_personas)) : 5;
  const coreFallbackCount = Number.isFinite(Number(budget.core_fallback_personas))
    ? Math.max(1, Number(budget.core_fallback_personas))
    : Math.min(3, core.length || 3);

  let selected = ordered.slice(0, maxPersonas);
  let fallbackCoreOnly = false;
  if (ordered.length > maxPersonas) {
    fallbackCoreOnly = true;
    selected = core.slice(0, Math.min(maxPersonas, coreFallbackCount));
  }

  return {
    domain,
    selected,
    core,
    specialists,
    fallback_core_only: fallbackCoreOnly,
    selection_seed: sha256Hex(`${new Date().toISOString().slice(0, 10)}|${topic}|${domain}`).slice(0, 16)
  };
}

function applyBudgetControls(topic: string, selection: any, riskPolicy: any) {
  const budget = riskPolicy && riskPolicy.budgets && typeof riskPolicy.budgets === 'object'
    ? riskPolicy.budgets
    : {};
  const maxTokens = Number.isFinite(Number(budget.max_tokens_estimate))
    ? Math.max(120, Number(budget.max_tokens_estimate))
    : 1600;
  const maxRuntimeMs = Number.isFinite(Number(budget.max_runtime_ms))
    ? Math.max(1000, Number(budget.max_runtime_ms))
    : 12000;
  const coreFallbackCount = Number.isFinite(Number(budget.core_fallback_personas))
    ? Math.max(1, Number(budget.core_fallback_personas))
    : Math.min(3, selection.core.length || 3);

  const estimate = (personaCount: number) => {
    const baseTokens = Math.max(60, Math.ceil(String(topic || '').length / 3));
    const estimated_tokens = baseTokens + personaCount * 220;
    const estimated_runtime_ms = 600 + personaCount * 850 + Math.ceil(String(topic || '').length * 0.8);
    return { estimated_tokens, estimated_runtime_ms };
  };

  let selected = Array.isArray(selection.selected) ? selection.selected.slice() : [];
  let budgetFallbackCoreOnly = Boolean(selection.fallback_core_only);
  let fallbackReason = budgetFallbackCoreOnly ? 'max_personas' : '';
  let estimates = estimate(selected.length);

  if (estimates.estimated_tokens > maxTokens) {
    selected = (Array.isArray(selection.core) ? selection.core : []).slice(0, Math.min(coreFallbackCount, selected.length || coreFallbackCount));
    budgetFallbackCoreOnly = true;
    fallbackReason = fallbackReason || 'token_budget';
    estimates = estimate(selected.length);
  }

  const runtimeBudgetExceeded = estimates.estimated_runtime_ms > maxRuntimeMs;
  return {
    ...selection,
    selected,
    fallback_core_only: budgetFallbackCoreOnly,
    budget_fallback_core_only: budgetFallbackCoreOnly,
    budget_fallback_reason: fallbackReason || null,
    estimated_tokens: estimates.estimated_tokens,
    estimated_runtime_ms: estimates.estimated_runtime_ms,
    max_tokens_estimate: maxTokens,
    max_runtime_ms: maxRuntimeMs,
    runtime_budget_exceeded: runtimeBudgetExceeded
  };
}

function classifyRiskTier(text: string, riskPolicy: any) {
  const lower = String(text || '').toLowerCase();
  const tiers = riskPolicy && riskPolicy.tier_keywords && typeof riskPolicy.tier_keywords === 'object'
    ? riskPolicy.tier_keywords
    : {};
  const has = (arr: unknown) => Array.isArray(arr) && arr.some((v: unknown) => lower.includes(String(v || '').toLowerCase()));
  if (has(tiers.high)) return 'high';
  if (has(tiers.medium)) return 'medium';
  return 'low';
}

function loadPersonaSignals(personaId: string) {
  const personaDir = path.join(PERSONAS_DIR, personaId);
  const read = (name: string) => {
    const fp = path.join(personaDir, name);
    if (!fs.existsSync(fp)) return '';
    return String(fs.readFileSync(fp, 'utf8') || '');
  };
  return {
    profile: read('profile.md'),
    decisionLens: read('decision_lens.md') || read('lens.md'),
    strategicLens: read('strategic_lens.md'),
    valuesLens: read('values_philosophy_lens.md'),
    emotionLens: read('emotion_lens.md')
  };
}

function recommendationForPersona(personaId: string, topic: string) {
  const lower = String(topic || '').toLowerCase();
  const securityLeads = new Set(['vikram_menon', 'aarav_singh', 'kavya_reddy', 'wu_jie']);
  const measurementLeads = new Set(['priya_venkatesh', 'li_ming', 'riya_mittal', 'liu_ying']);
  const opsLeads = new Set(['rohan_kapoor', 'wang_jun', 'gao_yang', 'zhao_ming']);
  const productLeads = new Set(['li_wei', 'priyanka_singh', 'zhang_hao', 'isha_das']);

  if (lower.includes('memory') && lower.includes('security')) {
    if (securityLeads.has(personaId)) {
      return 'Security gate first, then memory rollout behind parity and fail-closed checks.';
    }
    if (measurementLeads.has(personaId)) {
      return 'Memory determinism first, with strict drift measurements before widening security scope.';
    }
    return 'Sequence memory core stability first, then enforce security dispatch gates before broader rollout.';
  }
  if (lower.includes('drift')) {
    if (measurementLeads.has(personaId)) return 'Prioritize measurable drift controls and publish explicit guard thresholds.';
    return 'Pair any change with a measurable drift guard and rollback trigger.';
  }
  if (lower.includes('security') || lower.includes('covenant')) {
    if (securityLeads.has(personaId)) return 'Fail closed first, prove safety invariants, then consider velocity.';
    return 'Keep delivery moving, but only through explicit security gate approvals.';
  }
  if (lower.includes('product') || lower.includes('adoption') || lower.includes('growth')) {
    if (productLeads.has(personaId)) return 'Optimize for adoption with guard-railed rollout and measurable user outcomes.';
    return 'Tie scope to measurable product impact before scaling effort.';
  }
  if (opsLeads.has(personaId)) {
    return 'Prioritize staged rollout with deterministic fallback and ops visibility.';
  }
  return 'Execute the smallest reversible change with explicit tests, receipts, and fallback.';
}

function summarizeTone(emotionLens: string) {
  const lines = String(emotionLens || '')
    .split('\n')
    .map((line) => cleanText(line, 220))
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- /, ''));
  return lines.length ? lines[0] : 'neutral-operational';
}

function buildPersonaResponses(topic: string, participants: string[], includeEmotion: boolean) {
  return participants.map((personaId) => {
    const signals = loadPersonaSignals(personaId);
    return {
      persona_id: personaId,
      recommendation: recommendationForPersona(personaId, topic),
      tone_context: includeEmotion ? summarizeTone(signals.emotionLens) : 'neutral-operational',
      // Emotion is explicitly context-only; not used in arbitration logic.
      decision_basis: [
        cleanText(signals.decisionLens.split('\n')[0] || 'decision_lens'),
        cleanText(signals.strategicLens.split('\n')[0] || 'strategic_lens'),
        cleanText(signals.valuesLens.split('\n')[0] || 'values_lens')
      ].filter(Boolean)
    };
  });
}

function disagreementRate(responses: any[]) {
  const n = responses.length;
  if (n <= 1) return 0;
  const unique = new Set(responses.map((row) => cleanText(row.recommendation || '', 400))).size;
  return Number(((unique - 1) / (n - 1)).toFixed(4));
}

function enforceSecurityGate(action: string, riskTier: string, topicHash: string) {
  const request = {
    operation_id: `persona_orch_${action}_${Date.now()}`,
    subsystem: 'personas',
    action,
    actor: 'systems/personas/orchestration',
    risk_class: riskTier,
    payload_digest: `sha256:${topicHash}`,
    tags: ['personas', 'orchestration', action],
    covenant_violation: String(process.env.PERSONA_ORCH_FORCE_COVENANT_VIOLATION || '') === '1',
    tamper_signal: false,
    key_age_hours: 1,
    operator_quorum: 2,
    audit_receipt_nonce: `nonce-${topicHash.slice(0, 12)}-${Date.now()}`,
    zk_proof: 'zk-persona-orchestration',
    ciphertext_digest: `sha256:${topicHash.slice(0, 32)}`
  };
  const gate = evaluateSecurityGate(request, {
    enforce: true,
    state_root: path.join(ROOT, 'state'),
    allow_fallback: true
  });
  if (!gate || gate.ok !== true) {
    throw new Error(`sovereignty_gate_unavailable:${cleanText(gate && gate.error || '', 220)}`);
  }
  const decision = gate.payload && gate.payload.decision && typeof gate.payload.decision === 'object'
    ? gate.payload.decision
    : null;
  if (!decision || decision.ok !== true || decision.fail_closed === true) {
    const reason = Array.isArray(decision && decision.reasons) && decision.reasons.length
      ? cleanText(decision.reasons[0], 220)
      : 'security_gate_blocked';
    throw new Error(`sovereignty_gate_blocked:${reason}`);
  }
  return {
    gate_engine: gate.engine || 'unknown',
    gate_decision: decision
  };
}

function pickWinnerPersona(domain: string, participants: string[], arbitrationRules: any) {
  const winners = arbitrationRules && arbitrationRules.domain_winners && typeof arbitrationRules.domain_winners === 'object'
    ? arbitrationRules.domain_winners
    : {};
  const desired = normalizeToken(winners[domain] || '', 80);
  if (desired && participants.includes(desired)) return desired;
  const priority = Array.isArray(arbitrationRules.tie_break_priority)
    ? arbitrationRules.tie_break_priority.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean)
    : [];
  for (const p of priority) {
    if (participants.includes(p)) return p;
  }
  return participants.length ? participants[0] : '';
}

function readShadowState() {
  return readJsonOptional(SHADOW_STATE_PATH, {
    meeting: { shadow_active: true, policy_validation_failures: 0, cycles: 0 },
    project: { shadow_active: true, policy_validation_failures: 0, cycles: 0 }
  });
}

function writeShadowState(state: any) {
  fs.writeFileSync(SHADOW_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function parseFormulaPolicy(telemetryPolicy: any) {
  const formulas = telemetryPolicy && telemetryPolicy.formulas && typeof telemetryPolicy.formulas === 'object'
    ? telemetryPolicy.formulas
    : {};
  return {
    latency_ms: cleanText(formulas.latency_ms || 'latency_ms = end_ms - start_ms', 220),
    disagreement_rate: cleanText(formulas.disagreement_rate || 'disagreement_rate = (unique_positions-1)/max(1,participants-1)', 220),
    arbitration_overrides: cleanText(formulas.arbitration_overrides || 'arbitration_overrides = overrides_count/max(1,meetings)', 220),
    adoption_rate: cleanText(formulas.adoption_rate || 'adoption_rate = adopted_decisions/max(1,total_decisions)', 220),
    post_outcome_success: cleanText(formulas.post_outcome_success || 'post_outcome_success = successful_outcomes/max(1,tracked_outcomes)', 220),
    breaker_trip_rate: cleanText(formulas.breaker_trip_rate || 'breaker_trip_rate = breaker_trips/max(1,orchestration_events)', 220),
    mttr_ms: cleanText(formulas.mttr_ms || 'mttr_ms = sum(recovery_time_ms)/max(1,breaker_trips)', 220),
    auto_rollback_rate: cleanText(formulas.auto_rollback_rate || 'auto_rollback_rate = auto_rollbacks/max(1,breaker_trips)', 220),
    escalation_burst_count: cleanText(formulas.escalation_burst_count || 'escalation_burst_count = escalations_in_window', 220)
  };
}

function parseSoulTokenId(filePath: string) {
  if (!fs.existsSync(filePath)) return '';
  const body = String(fs.readFileSync(filePath, 'utf8') || '').replace(/\*\*/g, '');
  const match = body.match(/token[\s_]*id\s*:\s*([A-Za-z0-9._:-]+)/i);
  return cleanText(match ? match[1] : '', 160);
}

function boolFlag(value: unknown, fallback = false) {
  if (value == null || value === '') return fallback;
  const raw = cleanText(value, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fallback;
}

function emotionEnabled(args: Record<string, any>) {
  return boolFlag(args.emotion, false);
}

function defaultShadowDeploymentPolicy() {
  return {
    version: '1.0.0',
    enabled: true,
    feature_flags: {
      meeting: true,
      project: true,
      telemetry: true
    },
    kill_switch: {
      enabled: false,
      reason: ''
    },
    resource_isolation: {
      enforce: true,
      max_concurrent_meetings: 2,
      max_concurrent_projects: 2,
      max_estimated_tokens: 1800,
      max_estimated_runtime_ms: 15000
    }
  };
}

function loadShadowDeploymentPolicy(policies: any) {
  const merged = {
    ...defaultShadowDeploymentPolicy(),
    ...(policies && policies.shadowDeploymentPolicy && typeof policies.shadowDeploymentPolicy === 'object'
      ? policies.shadowDeploymentPolicy
      : {})
  };
  const featureFlags = merged.feature_flags && typeof merged.feature_flags === 'object'
    ? merged.feature_flags
    : {};
  const killSwitch = merged.kill_switch && typeof merged.kill_switch === 'object'
    ? merged.kill_switch
    : {};
  const resourceIsolation = merged.resource_isolation && typeof merged.resource_isolation === 'object'
    ? merged.resource_isolation
    : {};
  return {
    version: cleanText(merged.version || '1.0.0', 30) || '1.0.0',
    enabled: merged.enabled !== false,
    feature_flags: {
      meeting: boolFlag(featureFlags.meeting, true),
      project: boolFlag(featureFlags.project, true),
      telemetry: boolFlag(featureFlags.telemetry, true)
    },
    kill_switch: {
      enabled: boolFlag(killSwitch.enabled, false) || boolFlag(process.env.PROTHEUS_SHADOW_KILL_SWITCH, false),
      reason: cleanText(killSwitch.reason || process.env.PROTHEUS_SHADOW_KILL_SWITCH_REASON || '', 200)
    },
    resource_isolation: {
      enforce: boolFlag(resourceIsolation.enforce, true),
      max_concurrent_meetings: Number.isFinite(Number(resourceIsolation.max_concurrent_meetings))
        ? Math.max(1, Math.floor(Number(resourceIsolation.max_concurrent_meetings)))
        : 2,
      max_concurrent_projects: Number.isFinite(Number(resourceIsolation.max_concurrent_projects))
        ? Math.max(1, Math.floor(Number(resourceIsolation.max_concurrent_projects)))
        : 2,
      max_estimated_tokens: Number.isFinite(Number(resourceIsolation.max_estimated_tokens))
        ? Math.max(60, Math.floor(Number(resourceIsolation.max_estimated_tokens)))
        : 1800,
      max_estimated_runtime_ms: Number.isFinite(Number(resourceIsolation.max_estimated_runtime_ms))
        ? Math.max(500, Math.floor(Number(resourceIsolation.max_estimated_runtime_ms)))
        : 15000
    }
  };
}

function countActiveLocks(kind: 'meeting' | 'project') {
  if (!fs.existsSync(LOCKS_DIR)) return 0;
  const prefix = `${kind}_`;
  const lockFiles = fs.readdirSync(LOCKS_DIR, { withFileTypes: true })
    .filter((entry: any) => entry && entry.isFile() && String(entry.name || '').startsWith(prefix))
    .map((entry: any) => path.join(LOCKS_DIR, String(entry.name || '')));
  const now = Date.now();
  let active = 0;
  for (const lockPathFile of lockFiles) {
    try {
      const stat = fs.statSync(lockPathFile);
      // Treat stale lock files older than 15 minutes as dead.
      if ((now - Number(stat.mtimeMs || now)) > 15 * 60 * 1000) {
        try { fs.unlinkSync(lockPathFile); } catch {}
        continue;
      }
      active += 1;
    } catch {}
  }
  return active;
}

function enforceShadowDeploymentPolicy(
  kind: 'meeting' | 'project',
  deployment: any,
  selection: any | null
) {
  if (!deployment.enabled) {
    throw new Error(`shadow_deployment_disabled:${kind}`);
  }
  if (deployment.kill_switch && deployment.kill_switch.enabled) {
    const reason = cleanText(deployment.kill_switch.reason || 'manual_fail_closed', 200) || 'manual_fail_closed';
    throw new Error(`shadow_kill_switch_engaged:${reason}`);
  }
  const featureEnabled = deployment.feature_flags && deployment.feature_flags[kind] === true;
  if (!featureEnabled) {
    throw new Error(`shadow_feature_disabled:${kind}`);
  }

  const isolation = deployment.resource_isolation && typeof deployment.resource_isolation === 'object'
    ? deployment.resource_isolation
    : null;
  if (!isolation || isolation.enforce !== true) {
    return {
      policy_version: deployment.version,
      kill_switch: false,
      isolation_enforced: false,
      active_locks: 0
    };
  }

  const activeLocks = countActiveLocks(kind);
  const maxConcurrent = kind === 'meeting'
    ? Number(isolation.max_concurrent_meetings || 2)
    : Number(isolation.max_concurrent_projects || 2);
  if (activeLocks >= maxConcurrent) {
    throw new Error(`resource_isolation_concurrency_exceeded:${kind}:${activeLocks}/${maxConcurrent}`);
  }

  if (selection && typeof selection === 'object') {
    const estimatedTokens = Number(selection.estimated_tokens || 0);
    const estimatedRuntimeMs = Number(selection.estimated_runtime_ms || 0);
    if (estimatedTokens > Number(isolation.max_estimated_tokens || 1800)) {
      throw new Error(`resource_isolation_tokens_exceeded:${estimatedTokens}/${Number(isolation.max_estimated_tokens || 1800)}`);
    }
    if (estimatedRuntimeMs > Number(isolation.max_estimated_runtime_ms || 15000)) {
      throw new Error(`resource_isolation_runtime_exceeded:${estimatedRuntimeMs}/${Number(isolation.max_estimated_runtime_ms || 15000)}`);
    }
  }

  return {
    policy_version: deployment.version,
    kill_switch: false,
    isolation_enforced: true,
    max_concurrent: maxConcurrent,
    active_locks: activeLocks
  };
}

function driftRateFromArgs(args: Record<string, any>) {
  if (args['drift-rate'] == null && args.drift_rate == null) return NaN;
  const parsed = Number(args['drift-rate'] != null ? args['drift-rate'] : args.drift_rate);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function loadSoulTokenPolicy(policies: any) {
  return policies && policies.soulTokenPolicy && typeof policies.soulTokenPolicy === 'object'
    ? policies.soulTokenPolicy
    : {};
}

function soulTokenRule(
  soulTokenPolicy: any,
  section: 'high_risk' | 'overrides',
  fallbackActor = 'jay_haslam'
) {
  const scoped = soulTokenPolicy && soulTokenPolicy[section] && typeof soulTokenPolicy[section] === 'object'
    ? soulTokenPolicy[section]
    : {};
  const actor = normalizeToken(scoped.actor || fallbackActor, 80) || fallbackActor;
  const tokenPathRaw = cleanText(scoped.token_path || path.join(PERSONAS_DIR, actor, 'soul_token.md'), 500);
  const tokenPath = path.isAbsolute(tokenPathRaw) ? tokenPathRaw : path.join(ROOT, tokenPathRaw);
  const expectedToken = parseSoulTokenId(tokenPath);
  return {
    required: boolFlag(scoped.required, false),
    actor,
    expected_token: expectedToken
  };
}

function enforceSoulToken(
  args: Record<string, any>,
  soulTokenPolicy: any,
  reason: string,
  section: 'high_risk' | 'overrides'
) {
  const rule = soulTokenRule(soulTokenPolicy, section);
  if (!rule.required) return { verified: false, required: false, actor: rule.actor };
  const provided = cleanText(args['monarch-token'] || args.monarch_token || '', 200);
  if (!provided) {
    throw new Error(`monarch_token_required:${reason}`);
  }
  if (!rule.expected_token || provided !== rule.expected_token) {
    throw new Error(`monarch_token_invalid:${reason}`);
  }
  return { verified: true, required: true, actor: rule.actor };
}

function buildEmotionEnrichment(responses: any[], enabled: boolean) {
  if (!enabled) return [];
  return responses
    .map((row: any) => `${cleanText(row.persona_id, 80)}: ${cleanText(row.tone_context || 'neutral-operational', 200)}`)
    .filter(Boolean);
}

function resolveBreakerThresholds(breakerPolicy: any, args: Record<string, any>) {
  const thresholds = breakerPolicy && breakerPolicy.thresholds && typeof breakerPolicy.thresholds === 'object'
    ? breakerPolicy.thresholds
    : {};
  const base = {
    intent_drift_max: Number.isFinite(Number(thresholds.intent_drift_max)) ? Number(thresholds.intent_drift_max) : 0.55,
    budget_overrun_max: Number.isFinite(Number(thresholds.budget_overrun_max)) ? Number(thresholds.budget_overrun_max) : 0.0,
    runtime_overrun_max: Number.isFinite(Number(thresholds.runtime_overrun_max)) ? Number(thresholds.runtime_overrun_max) : 0.0,
    escalation_rate_max: Number.isFinite(Number(thresholds.escalation_rate_max)) ? Number(thresholds.escalation_rate_max) : 0.5,
    sovereignty_violation: cleanText(thresholds.sovereignty_violation || 'fail_closed', 80).toLowerCase()
  };

  const overrideCfg = breakerPolicy && breakerPolicy.monarch_override && typeof breakerPolicy.monarch_override === 'object'
    ? breakerPolicy.monarch_override
    : {};
  const enabled = overrideCfg.enabled === true;
  if (!enabled) return { ...base, override_active: false };

  const actorExpected = normalizeToken(overrideCfg.actor || 'jay_haslam', 80) || 'jay_haslam';
  const actorProvided = normalizeToken(args['override-actor'] || '', 80);
  const tokenPath = cleanText(overrideCfg.token_path || path.join(PERSONAS_DIR, actorExpected, 'soul_token.md'), 400);
  const expectedToken = parseSoulTokenId(path.isAbsolute(tokenPath) ? tokenPath : path.join(ROOT, tokenPath));
  const providedToken = cleanText(args['monarch-token'] || args.monarch_token || '', 180);
  const allowWithoutToken = overrideCfg.allow_without_token === true;

  const tokenOk = allowWithoutToken || (!!expectedToken && providedToken === expectedToken);
  if (actorProvided !== actorExpected || !tokenOk) {
    return { ...base, override_active: false };
  }

  const driftMultiplier = Number.isFinite(Number(overrideCfg.drift_multiplier))
    ? Math.max(1, Number(overrideCfg.drift_multiplier))
    : 1.3;
  const budgetMultiplier = Number.isFinite(Number(overrideCfg.budget_multiplier))
    ? Math.max(1, Number(overrideCfg.budget_multiplier))
    : 1.2;
  const runtimeMultiplier = Number.isFinite(Number(overrideCfg.runtime_multiplier))
    ? Math.max(1, Number(overrideCfg.runtime_multiplier))
    : 1.2;
  const escalationMultiplier = Number.isFinite(Number(overrideCfg.escalation_multiplier))
    ? Math.max(1, Number(overrideCfg.escalation_multiplier))
    : 1.2;

  return {
    ...base,
    intent_drift_max: Number((base.intent_drift_max * driftMultiplier).toFixed(4)),
    budget_overrun_max: Number((base.budget_overrun_max * budgetMultiplier).toFixed(4)),
    runtime_overrun_max: Number((base.runtime_overrun_max * runtimeMultiplier).toFixed(4)),
    escalation_rate_max: Number((base.escalation_rate_max * escalationMultiplier).toFixed(4)),
    override_active: true,
    override_actor: actorExpected
  };
}

function recentTelemetry(kind: 'meeting' | 'project', windowSize = 20) {
  const rows = readJsonl(TELEMETRY_PATH)
    .filter((row: any) => row && row.kind === kind);
  return rows.slice(-Math.max(1, windowSize));
}

function computeEscalationRate(kind: 'meeting' | 'project', windowSize = 20) {
  const rows = recentTelemetry(kind, windowSize);
  if (!rows.length) {
    return { rate: 0, burst_count: 0, count: 0 };
  }
  let escalations = 0;
  let burst = 0;
  let streak = 0;
  for (const row of rows) {
    const signal = Number(row.escalation_signal || 0) > 0 ? 1 : 0;
    if (signal) {
      escalations += 1;
      streak += 1;
      if (streak >= 2) burst += 1;
    } else {
      streak = 0;
    }
  }
  return {
    rate: Number((escalations / rows.length).toFixed(4)),
    burst_count: burst,
    count: rows.length
  };
}

function breakerRecoveryAction(riskTier: string, reasonCode: string, breakerPolicy: any) {
  const recovery = breakerPolicy && breakerPolicy.recovery && typeof breakerPolicy.recovery === 'object'
    ? breakerPolicy.recovery
    : {};
  if (reasonCode === 'sovereignty_violation') {
    return cleanText(recovery.sovereignty || 'fail_closed', 80) || 'fail_closed';
  }
  if (riskTier === 'low') {
    return cleanText(recovery.low || 'auto_rollback', 80) || 'auto_rollback';
  }
  if (riskTier === 'medium') {
    return cleanText(recovery.medium || 'pause_and_escalate', 80) || 'pause_and_escalate';
  }
  return cleanText(recovery.high || 'pause_and_escalate', 80) || 'pause_and_escalate';
}

function evaluateBreaker(kind: 'meeting' | 'project', context: any, breakerPolicy: any, args: Record<string, any>) {
  const thresholds = resolveBreakerThresholds(breakerPolicy, args);
  const reasons: string[] = [];
  const forced = normalizeToken(args['force-breaker'] || process.env.PROTHEUS_ORCH_FORCE_BREAKER || '', 80);
  if (forced === 'sovereignty') {
    reasons.push('sovereignty_violation');
  }
  if (forced === 'drift') {
    reasons.push('intent_drift');
  }

  const drift = Number(context.disagreement_rate || 0);
  if (drift > thresholds.intent_drift_max) {
    reasons.push('intent_drift');
  }

  const tokenBudget = Number(context.max_tokens_estimate || 0) || 1;
  const runtimeBudget = Number(context.max_runtime_ms || 0) || 1;
  const budgetOverrun = Math.max(0, Number(context.estimated_tokens || 0) / tokenBudget - 1);
  const runtimeOverrun = Math.max(0, Number(context.estimated_runtime_ms || 0) / runtimeBudget - 1);
  if (budgetOverrun > thresholds.budget_overrun_max) {
    reasons.push('budget_overrun');
  }
  if (runtimeOverrun > thresholds.runtime_overrun_max) {
    reasons.push('runtime_overrun');
  }

  const escalation = computeEscalationRate(kind, 20);
  if (escalation.rate > thresholds.escalation_rate_max) {
    reasons.push('escalation_rate');
  }

  const uniqueReasons = Array.from(new Set(reasons));
  if (!uniqueReasons.length) {
    return {
      tripped: false,
      reason_code: '',
      reason: '',
      recovery_action: '',
      metrics: {
        intent_drift: drift,
        budget_overrun: Number(budgetOverrun.toFixed(4)),
        runtime_overrun: Number(runtimeOverrun.toFixed(4)),
        escalation_rate: escalation.rate,
        escalation_burst_count: escalation.burst_count
      },
      thresholds
    };
  }

  const reasonCode = uniqueReasons[0];
  const recoveryAction = breakerRecoveryAction(String(context.risk_tier || 'low'), reasonCode, breakerPolicy);
  return {
    tripped: true,
    reason_code: reasonCode,
    reason: uniqueReasons.join(','),
    recovery_action: recoveryAction,
    metrics: {
      intent_drift: drift,
      budget_overrun: Number(budgetOverrun.toFixed(4)),
      runtime_overrun: Number(runtimeOverrun.toFixed(4)),
      escalation_rate: escalation.rate,
      escalation_burst_count: escalation.burst_count
    },
    thresholds
  };
}

function evaluateShadowMode(kind: 'meeting' | 'project', policyValidationFailures: number, riskPolicy: any) {
  const state = readShadowState();
  const lane = state[kind] && typeof state[kind] === 'object'
    ? state[kind]
    : { shadow_active: true, policy_validation_failures: 0, cycles: 0, confidence_decay_cycles: 0 };
  const settings = riskPolicy && riskPolicy.shadow_mode && typeof riskPolicy.shadow_mode === 'object'
    ? riskPolicy.shadow_mode
    : {};
  const metricsExit = settings.metrics_exit && typeof settings.metrics_exit === 'object'
    ? settings.metrics_exit
    : {};
  const minSamples = Number.isFinite(Number(metricsExit.min_samples)) ? Math.max(1, Number(metricsExit.min_samples)) : 3;
  const telemetry = readJsonl(TELEMETRY_PATH)
    .filter((row: any) => row && row.kind === kind)
    .slice(-Math.max(20, minSamples));
  const disagreementAvg = telemetry.length
    ? telemetry.reduce((acc: number, row: any) => acc + Number(row.disagreement_rate || 0), 0) / telemetry.length
    : 1;
  const overridesAvg = telemetry.length
    ? telemetry.reduce((acc: number, row: any) => acc + Number(row.arbitration_overrides || 0), 0) / telemetry.length
    : 1;
  const breakerTripAvg = telemetry.length
    ? telemetry.reduce((acc: number, row: any) => acc + Number(row.breaker_trip || 0), 0) / telemetry.length
    : 1;

  lane.policy_validation_failures = Number(lane.policy_validation_failures || 0) + Number(policyValidationFailures || 0);
  lane.cycles = Number(lane.cycles || 0) + 1;

  const disagreementLimit = Number.isFinite(Number(metricsExit.disagreement_rate_lte))
    ? Number(metricsExit.disagreement_rate_lte)
    : 0.35;
  const overridesLimit = Number.isFinite(Number(metricsExit.arbitration_overrides_lte))
    ? Number(metricsExit.arbitration_overrides_lte)
    : 0.2;
  const breakerTripLimit = Number.isFinite(Number(metricsExit.breaker_trip_rate_lte))
    ? Number(metricsExit.breaker_trip_rate_lte)
    : 0.15;
  const policyRequired = Number.isFinite(Number(metricsExit.policy_validation_failures_eq))
    ? Number(metricsExit.policy_validation_failures_eq)
    : 0;
  const decayCycles = Number.isFinite(Number(metricsExit.confidence_decay_cycles))
    ? Math.max(1, Number(metricsExit.confidence_decay_cycles))
    : 2;

  const degraded = disagreementAvg > disagreementLimit
    || overridesAvg > overridesLimit
    || breakerTripAvg > breakerTripLimit
    || Number(lane.policy_validation_failures || 0) !== policyRequired;
  lane.confidence_decay_cycles = degraded
    ? Number(lane.confidence_decay_cycles || 0) + 1
    : 0;

  const exitQualified = telemetry.length >= minSamples
    && disagreementAvg <= disagreementLimit
    && overridesAvg <= overridesLimit
    && breakerTripAvg <= breakerTripLimit
    && Number(lane.policy_validation_failures || 0) === policyRequired;

  const forcedShadow = Number(lane.confidence_decay_cycles || 0) >= decayCycles;
  lane.shadow_active = forcedShadow ? true : !exitQualified;
  state[kind] = lane;
  writeShadowState(state);

  return {
    shadow_active: lane.shadow_active === true,
    samples: telemetry.length,
    disagreement_rate_avg: Number(disagreementAvg.toFixed(4)),
    arbitration_overrides_avg: Number(overridesAvg.toFixed(4)),
    breaker_trip_rate_avg: Number(breakerTripAvg.toFixed(4)),
    policy_validation_failures: Number(lane.policy_validation_failures || 0),
    confidence_decay_cycles: Number(lane.confidence_decay_cycles || 0),
    forced_shadow: forcedShadow,
    exit_qualified: exitQualified
  };
}

function renderMeetingMarkdown(summary: any) {
  const lines = [
    `# Orchestration Meeting: ${summary.topic}`,
    '',
    `- meeting_id: \`${summary.meeting_id}\``,
    `- domain: \`${summary.domain}\``,
    `- risk_tier: \`${summary.risk_tier}\``,
    `- shadow_mode: \`${summary.shadow_mode_active ? 'active' : 'inactive'}\``,
    `- winning_persona: \`${summary.winning_persona}\``,
    `- confidence: \`${summary.confidence}\``,
    '',
    '## Decision',
    summary.decision,
    '',
    '## Rejected Options',
    ...(summary.rejected_options || []).map((entry: string) => `- ${entry}`),
    '',
    '## Attendees',
    ...(summary.participants || []).map((entry: string) => `- ${entry}`),
    ''
  ];
  return lines.join('\n');
}

function writeTelemetry(kind: 'meeting' | 'project', row: any, telemetryPolicy: any) {
  ensureDir(ORG_DIR);
  const formulas = parseFormulaPolicy(telemetryPolicy);
  const payload = {
    ts: new Date().toISOString(),
    kind,
    latency_ms: Number(row.latency_ms || 0),
    disagreement_rate: Number(row.disagreement_rate || 0),
    arbitration_overrides: Number(row.arbitration_overrides || 0),
    adoption_rate: Number(row.adoption_rate || 0),
    post_outcome_success: Number(row.post_outcome_success || 0),
    breaker_trip: Number(row.breaker_trip || 0),
    breaker_trip_rate: Number(row.breaker_trip_rate || 0),
    mttr_ms: Number(row.mttr_ms || 0),
    auto_rollback_rate: Number(row.auto_rollback_rate || 0),
    escalation_burst_count: Number(row.escalation_burst_count || 0),
    escalation_signal: Number(row.escalation_signal || 0),
    formulas
  };
  appendJsonlHashChained(TELEMETRY_PATH, payload);
  return payload;
}

function ensureOrgFolders() {
  ensureDir(ORG_DIR);
  ensureDir(MEETINGS_DIR);
  ensureDir(PROJECTS_DIR);
  ensureDir(LOCKS_DIR);
}

function avg(rows: any[], key: string) {
  if (!rows.length) return 0;
  const total = rows.reduce((acc: number, row: any) => acc + Number(row && row[key] || 0), 0);
  return Number((total / rows.length).toFixed(4));
}

function renderTelemetryMarkdown(windowSize: number) {
  const rows = readJsonl(TELEMETRY_PATH).slice(-Math.max(1, windowSize));
  const byKind = {
    meeting: rows.filter((row: any) => row && row.kind === 'meeting'),
    project: rows.filter((row: any) => row && row.kind === 'project')
  };
  const lines = [
    '# Orchestration Telemetry',
    '',
    `Window: last ${Math.max(1, windowSize)} rows`,
    '',
    '| kind | count | latency_ms(avg) | disagreement(avg) | breaker_trip_rate(avg) | mttr_ms(avg) | auto_rollback_rate(avg) | escalation_burst_count(avg) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const kind of ['meeting', 'project']) {
    const rowsForKind = (byKind as Record<string, any[]>)[kind];
    lines.push(`| ${kind} | ${rowsForKind.length} | ${avg(rowsForKind, 'latency_ms')} | ${avg(rowsForKind, 'disagreement_rate')} | ${avg(rowsForKind, 'breaker_trip_rate')} | ${avg(rowsForKind, 'mttr_ms')} | ${avg(rowsForKind, 'auto_rollback_rate')} | ${avg(rowsForKind, 'escalation_burst_count')} |`);
  }
  return lines.join('\n');
}

function telemetry(windowSize: number) {
  ensureOrgFolders();
  const deployment = loadShadowDeploymentPolicy({
    shadowDeploymentPolicy: readJsonOptional(SHADOW_DEPLOYMENT_POLICY_PATH, defaultShadowDeploymentPolicy())
  });
  if (!deployment.enabled || deployment.feature_flags.telemetry !== true) {
    throw new Error('shadow_feature_disabled:telemetry');
  }
  const rows = readJsonl(TELEMETRY_PATH).slice(-Math.max(1, windowSize));
  return {
    ok: true,
    window: Math.max(1, windowSize),
    rows,
    markdown: renderTelemetryMarkdown(windowSize)
  };
}

function effectiveRetentionDays(retentionPolicy: any, requestedTtlDays: unknown) {
  const policyDays = Number.isFinite(Number(retentionPolicy && retentionPolicy.ttl_days))
    ? Math.max(1, Math.floor(Number(retentionPolicy.ttl_days)))
    : HARD_RETENTION_TTL_DAYS;
  const requestDays = Number.isFinite(Number(requestedTtlDays))
    ? Math.max(1, Math.floor(Number(requestedTtlDays)))
    : policyDays;
  return Math.min(HARD_RETENTION_TTL_DAYS, requestDays, policyDays);
}

function rowTimestampMs(row: any) {
  const ts = cleanText((row && (row.timestamp || row.ts)) || '', 120);
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function chainRows(rows: any[]) {
  const out: any[] = [];
  let prevHash = '';
  for (const raw of rows) {
    const row = raw && typeof raw === 'object' ? { ...raw } : {};
    delete (row as any).hash;
    delete (row as any).prev_hash;
    const base = {
      ...row,
      prev_hash: prevHash || null
    };
    const hash = sha256Hex(stableStringify(base));
    const chained = { ...base, hash };
    out.push(chained);
    prevHash = hash;
  }
  return out;
}

function rewriteJsonl(filePath: string, rows: any[]) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function pruneFileWithTtl(filePath: string, cutoffMs: number) {
  const rows = readJsonl(filePath);
  const keptRaw = rows.filter((row: any) => {
    const tsMs = rowTimestampMs(row);
    if (!Number.isFinite(tsMs)) return true;
    return tsMs >= cutoffMs;
  });
  const kept = chainRows(keptRaw);
  rewriteJsonl(filePath, kept);
  return {
    total: rows.length,
    kept: kept.length,
    pruned: Math.max(0, rows.length - kept.length)
  };
}

function verifyHashChain(rows: any[]) {
  const issues: string[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const actualPrev = row.prev_hash == null ? null : cleanText(row.prev_hash, 200);
    const expectedPrev = prevHash;
    if (actualPrev !== expectedPrev) {
      issues.push(`prev_hash_mismatch:index=${i}`);
    }
    const rowCopy = { ...row };
    delete (rowCopy as any).hash;
    const expectedHash = sha256Hex(stableStringify(rowCopy));
    const actualHash = cleanText(row.hash || '', 200);
    if (!actualHash || actualHash !== expectedHash) {
      issues.push(`hash_mismatch:index=${i}`);
    }
    prevHash = actualHash || null;
  }
  return {
    ok: issues.length === 0,
    issues
  };
}

function policyChecksForArtifactRows(rows: any[], policies: any) {
  const issues: string[] = [];
  const riskPolicy = policies && policies.riskPolicy && typeof policies.riskPolicy === 'object'
    ? policies.riskPolicy
    : {};
  const soulTokenPolicy = loadSoulTokenPolicy(policies);
  const approvalRequired = Array.isArray(riskPolicy.approval_required_tiers)
    ? riskPolicy.approval_required_tiers.map((v: unknown) => normalizeToken(v, 40))
    : ['medium', 'high'];
  const overrideRule = soulTokenRule(soulTokenPolicy, 'overrides');
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const type = normalizeToken(row.type || '', 80);
    if (type !== 'meeting_result' && type !== 'project_state') continue;
    const tier = normalizeToken(row.risk_tier || '', 40);
    const approvalNote = cleanText(row.approval_note || '', 240);
    const overrideReason = cleanText(row.override_reason || '', 240);
    const overrideActor = normalizeToken(row.override_actor || '', 80);
    if (approvalRequired.includes(tier) && !approvalNote && !overrideReason) {
      issues.push(`approval_missing:${type}:${cleanText(row.meeting_id || row.project_id || '', 120)}`);
    }
    if (overrideReason && overrideRule.required && overrideActor !== overrideRule.actor) {
      issues.push(`override_actor_mismatch:${type}:${cleanText(row.meeting_id || row.project_id || '', 120)}`);
    }
    if (Object.prototype.hasOwnProperty.call(row, 'emotion_enrichment') && !Array.isArray(row.emotion_enrichment)) {
      issues.push(`emotion_enrichment_invalid:${type}`);
    }
  }
  return {
    ok: issues.length === 0,
    issues
  };
}

function pruneArtifacts(args: Record<string, any>) {
  ensureOrgFolders();
  const validation = validatePoliciesAndSchemas();
  if (!validation.ok) {
    throw new Error(`policy_validation_failed:${validation.failures.join(',')}`);
  }
  const retentionPolicy = (validation as any).policies.retentionPolicy;
  const ttlDays = effectiveRetentionDays(retentionPolicy, args['ttl-days'] || args.ttl_days);
  const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const meetings = pruneFileWithTtl(MEETINGS_LEDGER, cutoffMs);
  const projects = pruneFileWithTtl(PROJECTS_LEDGER, cutoffMs);
  const telemetry = pruneFileWithTtl(TELEMETRY_PATH, cutoffMs);
  return {
    ok: true,
    ttl_days: ttlDays,
    hard_ttl_days: HARD_RETENTION_TTL_DAYS,
    cutoff_iso: new Date(cutoffMs).toISOString(),
    files: {
      meetings,
      projects,
      telemetry
    }
  };
}

function auditArtifact(artifactId: string) {
  ensureOrgFolders();
  const validation = validatePoliciesAndSchemas();
  if (!validation.ok) {
    throw new Error(`policy_validation_failed:${validation.failures.join(',')}`);
  }
  const { policies, schemas } = validation as any;
  const meetings = readJsonl(MEETINGS_LEDGER);
  const projects = readJsonl(PROJECTS_LEDGER);
  const id = cleanText(artifactId, 160);

  const meetingRows = meetings.filter((row: any) => row && (row.meeting_id === id || row.hash === id));
  const projectRows = projects.filter((row: any) => row && (row.project_id === id || row.hash === id));
  let scope: 'meetings' | 'projects' = 'meetings';
  let scopeRows = meetingRows;
  let ledgerRows = meetings;

  if (!meetingRows.length && projectRows.length) {
    scope = 'projects';
    scopeRows = projectRows;
    ledgerRows = projects;
  } else if (meetingRows.length && projectRows.length) {
    throw new Error(`audit_ambiguous_artifact_id:${id}`);
  } else if (!meetingRows.length && !projectRows.length) {
    throw new Error(`artifact_not_found:${id}`);
  }

  // If called by row hash, expand to all rows in the same artifact group.
  const groupId = cleanText(
    scopeRows[0] && (scope === 'meetings' ? scopeRows[0].meeting_id : scopeRows[0].project_id) || '',
    160
  );
  if (groupId) {
    scopeRows = ledgerRows.filter((row: any) =>
      row && (scope === 'meetings' ? row.meeting_id === groupId : row.project_id === groupId)
    );
  }

  const hashChain = verifyHashChain(ledgerRows);
  const schemaIssues: string[] = [];
  for (const row of scopeRows) {
    const type = normalizeToken(row && row.type || '', 80);
    if (type === 'meeting_result') {
      const errs = validateAgainstSchema(row, schemas.meetingArtifact);
      for (const err of errs) schemaIssues.push(`meeting_schema:${err}`);
    } else if (type === 'project_state') {
      const errs = validateAgainstSchema(row, schemas.projectArtifact);
      for (const err of errs) schemaIssues.push(`project_schema:${err}`);
    }
  }
  const policyCheck = policyChecksForArtifactRows(scopeRows, policies);
  return {
    ok: hashChain.ok && schemaIssues.length === 0 && policyCheck.ok,
    artifact_id: id,
    scope,
    group_id: groupId || id,
    checks: {
      hash_chain_ok: hashChain.ok,
      schema_ok: schemaIssues.length === 0,
      policy_ok: policyCheck.ok
    },
    findings: {
      hash_chain: hashChain.issues,
      schema: schemaIssues,
      policy: policyCheck.issues
    },
    rows_checked: scopeRows.length
  };
}

function meetingId(topic: string, participants: string[]) {
  const date = new Date().toISOString().slice(0, 10);
  return `meet_${sha256Hex(`${topic}|${participants.join(',')}|${date}`).slice(0, 16)}`;
}

function runMeeting(topic: string, args: Record<string, any>) {
  ensureOrgFolders();
  const startMs = Date.now();
  const validation = validatePoliciesAndSchemas();
  if (!validation.ok) {
    throw new Error(`policy_validation_failed:${validation.failures.join(',')}`);
  }
  const { policies, schemas } = validation as any;
  const routingRules = policies.routingRules;
  const arbitrationRules = policies.arbitrationRules;
  const riskPolicy = policies.riskPolicy;
  const breakerPolicy = policies.breakerPolicy;
  const soulTokenPolicy = loadSoulTokenPolicy(policies);
  const telemetryPolicy = policies.telemetryPolicy;
  const shadowDeployment = loadShadowDeploymentPolicy(policies);
  const includeEmotion = emotionEnabled(args);

  const selection = applyBudgetControls(topic, selectAttendees(topic, routingRules, riskPolicy), riskPolicy);
  if (!selection.selected.length) {
    throw new Error('no_eligible_personas');
  }
  if (selection.runtime_budget_exceeded) {
    throw new Error(`budget_runtime_exceeded:max_runtime_ms=${selection.max_runtime_ms},estimated_runtime_ms=${selection.estimated_runtime_ms}`);
  }
  const deploymentGuard = enforceShadowDeploymentPolicy('meeting', shadowDeployment, selection);

  const id = meetingId(topic, selection.selected);
  const existing = readJsonl(MEETINGS_LEDGER).find((row: any) => row && row.type === 'meeting_result' && row.meeting_id === id);
  if (existing) {
    return {
      ok: true,
      idempotent: true,
      artifact: existing,
      markdown_summary: renderMeetingMarkdown(existing)
    };
  }

  const riskTier = classifyRiskTier(topic, riskPolicy);
  const approvalRequiredTiers = Array.isArray(riskPolicy && riskPolicy.approval_required_tiers)
    ? riskPolicy.approval_required_tiers.map((v: unknown) => normalizeToken(v, 40))
    : ['medium', 'high'];
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 300);
  const overrideReason = cleanText(args['override-reason'] || '', 300);
  const overrideActor = cleanText(args['override-actor'] || '', 120);
  const overrideExpiry = cleanText(args['override-expiry'] || '', 120);

  if (approvalRequiredTiers.includes(riskTier) && !approvalNote && !overrideReason) {
    throw new Error(`approval_required_for_risk_tier:${riskTier}`);
  }
  if (riskTier === 'high') {
    enforceSoulToken(args, soulTokenPolicy, 'high_risk_meeting', 'high_risk');
  }
  if (overrideReason) {
    enforceSoulToken(args, soulTokenPolicy, 'override_meeting', 'overrides');
  }

  return withLock('meeting', id, () => {
    const sec = enforceSecurityGate('orchestrate_meeting', riskTier, sha256Hex(topic));
    const selectionReceipt = appendJsonlHashChained(MEETINGS_LEDGER, {
      type: 'selection_receipt',
      meeting_id: id,
      topic,
      domain: selection.domain,
      participants: selection.selected,
      core_personas: selection.core,
      specialists: selection.specialists,
      fallback_core_only: selection.fallback_core_only,
      budget_fallback_core_only: selection.budget_fallback_core_only,
      budget_fallback_reason: selection.budget_fallback_reason,
      estimated_tokens: selection.estimated_tokens,
      estimated_runtime_ms: selection.estimated_runtime_ms,
      max_tokens_estimate: selection.max_tokens_estimate,
      max_runtime_ms: selection.max_runtime_ms,
      selection_seed: selection.selection_seed,
      policy_version: cleanText(routingRules.version || '1.0', 80),
      deployment_policy_version: cleanText(deploymentGuard.policy_version || '', 40) || null,
      deployment_isolation_enforced: deploymentGuard.isolation_enforced === true,
      deployment_active_locks: Number(deploymentGuard.active_locks || 0),
      persona_snapshot_hash: sha256Hex(selection.selected.join('|')).slice(0, 16),
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1'
    });

    const responses = buildPersonaResponses(topic, selection.selected, includeEmotion);
    const emotionEnrichment = buildEmotionEnrichment(responses, includeEmotion);
    const disagreement = disagreementRate(responses);
    const winner = pickWinnerPersona(selection.domain, selection.selected, arbitrationRules);
    const winnerResponse = responses.find((row) => row.persona_id === winner) || responses[0];
    const rejected = Array.from(new Set(
      responses
        .filter((row) => row.persona_id !== winner)
        .map((row) => cleanText(row.recommendation, 500))
    ));

    const arbitrationReceipt = appendJsonlHashChained(MEETINGS_LEDGER, {
      type: 'arbitration_receipt',
      meeting_id: id,
      domain: selection.domain,
      rule_applied: `domain_winner:${selection.domain}`,
      winning_persona: winner,
      candidate_count: responses.length,
      disagreement_rate: disagreement,
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1'
    });

    const endMs = Date.now();
    const escalationSignal = riskTier === 'high' || riskTier === 'medium' ? 1 : 0;
    const breaker = evaluateBreaker('meeting', {
      disagreement_rate: disagreement,
      estimated_tokens: selection.estimated_tokens,
      max_tokens_estimate: selection.max_tokens_estimate,
      estimated_runtime_ms: selection.estimated_runtime_ms,
      max_runtime_ms: selection.max_runtime_ms,
      risk_tier: riskTier
    }, breakerPolicy, args);

    if (breaker.tripped) {
      const breakerReceipt = appendJsonlHashChained(MEETINGS_LEDGER, {
        type: 'breaker_trip_receipt',
        meeting_id: id,
        reason_code: breaker.reason_code,
        reason: breaker.reason,
        recovery_action: breaker.recovery_action,
        metrics: breaker.metrics,
        thresholds: breaker.thresholds,
        timestamp: new Date().toISOString(),
        engine_version: 'persona_orchestration_v1'
      });
      writeTelemetry('meeting', {
        latency_ms: Math.max(0, endMs - startMs),
        disagreement_rate: disagreement,
        arbitration_overrides: overrideReason ? 1 : 0,
        adoption_rate: 0,
        post_outcome_success: 0,
        breaker_trip: 1,
        breaker_trip_rate: 1,
        mttr_ms: 0,
        auto_rollback_rate: breaker.recovery_action === 'auto_rollback' ? 1 : 0,
        escalation_burst_count: Number(breaker.metrics && breaker.metrics.escalation_burst_count || 0),
        escalation_signal: escalationSignal
      }, telemetryPolicy);

      if (breaker.recovery_action === 'auto_rollback') {
        const rolledBack = appendJsonlHashChained(MEETINGS_LEDGER, {
          type: 'meeting_result',
          meeting_id: id,
          topic,
          domain: selection.domain,
          participants: selection.selected,
          decision: '',
          winning_persona: winner,
          rejected_options: rejected,
          rule_applied: cleanText(`domain:${selection.domain}|winner:${winner}`, 200),
          confidence: 0,
          fail_closed_reason: `breaker_auto_rollback:${breaker.reason}`,
          risk_tier: riskTier,
          approval_note: approvalNote || '',
          override_reason: overrideReason || '',
          override_actor: overrideActor || '',
          override_expiry: overrideExpiry || '',
          estimated_tokens: selection.estimated_tokens,
          estimated_runtime_ms: selection.estimated_runtime_ms,
          max_tokens_estimate: selection.max_tokens_estimate,
          max_runtime_ms: selection.max_runtime_ms,
          shadow_mode_active: true,
          selection_receipt_hash: cleanText(selectionReceipt.hash || '', 90),
          arbitration_receipt_hash: cleanText(arbitrationReceipt.hash || '', 90),
          policy_version: cleanText(`${routingRules.version || '1.0'}|${arbitrationRules.version || '1.0'}`, 120),
          deployment_policy_version: cleanText(deploymentGuard.policy_version || '', 40) || null,
          deployment_isolation_enforced: deploymentGuard.isolation_enforced === true,
          deployment_active_locks: Number(deploymentGuard.active_locks || 0),
          persona_snapshot_hash: sha256Hex(stableStringify(responses)).slice(0, 16),
          selection_seed: selection.selection_seed,
          timestamp: new Date().toISOString(),
          engine_version: 'persona_orchestration_v1',
          latency_ms: Math.max(0, endMs - startMs),
          disagreement_rate: disagreement,
          arbitration_overrides: overrideReason ? 1 : 0,
          adoption_rate: 0,
          post_outcome_success: 0,
          gate_engine: sec.gate_engine,
          breaker_receipt_hash: cleanText(breakerReceipt.hash || '', 90),
          emotion_enrichment: emotionEnrichment
        });
        return {
          ok: false,
          idempotent: false,
          breaker_tripped: true,
          artifact: rolledBack,
          markdown_summary: renderMeetingMarkdown(rolledBack)
        };
      }

      throw new Error(`breaker_trip_escalated:${breaker.reason}`);
    }

    const confidence = Number(Math.max(0.2, 1 - disagreement * 0.6).toFixed(4));
    const shadow = evaluateShadowMode('meeting', 0, riskPolicy);

    const artifactBase = {
      type: 'meeting_result',
      meeting_id: id,
      topic,
      domain: selection.domain,
      participants: selection.selected,
      decision: cleanText(winnerResponse && winnerResponse.recommendation || '', 900),
      winning_persona: winner,
      rejected_options: rejected,
      rule_applied: cleanText(`domain:${selection.domain}|winner:${winner}`, 200),
      confidence,
      fail_closed_reason: '',
      risk_tier: riskTier,
      approval_note: approvalNote || '',
      override_reason: overrideReason || '',
      override_actor: overrideActor || '',
      override_expiry: overrideExpiry || '',
      estimated_tokens: selection.estimated_tokens,
      estimated_runtime_ms: selection.estimated_runtime_ms,
      max_tokens_estimate: selection.max_tokens_estimate,
      max_runtime_ms: selection.max_runtime_ms,
      shadow_mode_active: shadow.shadow_active,
      selection_receipt_hash: cleanText(selectionReceipt.hash || '', 90),
      arbitration_receipt_hash: cleanText(arbitrationReceipt.hash || '', 90),
      policy_version: cleanText(`${routingRules.version || '1.0'}|${arbitrationRules.version || '1.0'}`, 120),
      deployment_policy_version: cleanText(deploymentGuard.policy_version || '', 40) || null,
      deployment_isolation_enforced: deploymentGuard.isolation_enforced === true,
      deployment_active_locks: Number(deploymentGuard.active_locks || 0),
      persona_snapshot_hash: sha256Hex(stableStringify(responses)).slice(0, 16),
      selection_seed: selection.selection_seed,
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1',
      latency_ms: Math.max(0, endMs - startMs),
      disagreement_rate: disagreement,
      arbitration_overrides: overrideReason ? 1 : 0,
      adoption_rate: shadow.shadow_active ? 0 : 1,
      post_outcome_success: 0,
      gate_engine: sec.gate_engine,
      breaker_trip: 0,
      breaker_trip_rate: 0,
      mttr_ms: 0,
      auto_rollback_rate: 0,
      escalation_burst_count: Number(breaker.metrics && breaker.metrics.escalation_burst_count || 0),
      escalation_signal: escalationSignal,
      emotion_enrichment: emotionEnrichment
    };
    const schemaErrors = validateAgainstSchema(artifactBase, schemas.meetingArtifact);
    if (schemaErrors.length) {
      throw new Error(`meeting_artifact_schema_failed:${schemaErrors.slice(0, 6).join('|')}`);
    }
    const artifact = appendJsonlHashChained(MEETINGS_LEDGER, artifactBase);
    writeTelemetry('meeting', artifactBase, telemetryPolicy);

    return {
      ok: true,
      idempotent: false,
      artifact,
      markdown_summary: renderMeetingMarkdown(artifact)
    };
  });
}

const PROJECT_TRANSITIONS: Record<string, string[]> = {
  proposed: ['active', 'cancelled'],
  active: ['blocked', 'completed', 'cancelled', 'paused_on_breaker'],
  blocked: ['active', 'cancelled'],
  paused_on_breaker: ['reviewed', 'cancelled', 'rolled_back'],
  reviewed: ['resumed', 'rolled_back', 'cancelled'],
  resumed: ['blocked', 'completed', 'cancelled', 'paused_on_breaker'],
  rolled_back: ['cancelled', 'active'],
  completed: [],
  cancelled: []
};

function latestProjectState(projectId: string) {
  const rows = readJsonl(PROJECTS_LEDGER).filter((row: any) => row && row.project_id === projectId && row.type === 'project_state');
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

function projectId(name: string, goal: string) {
  return `prj_${sha256Hex(`${name}|${goal}`).slice(0, 16)}`;
}

function runProject(name: string, goal: string, args: Record<string, any>) {
  ensureOrgFolders();
  const validation = validatePoliciesAndSchemas();
  if (!validation.ok) {
    throw new Error(`policy_validation_failed:${validation.failures.join(',')}`);
  }
  const { policies, schemas } = validation as any;
  const routingRules = policies.routingRules;
  const arbitrationRules = policies.arbitrationRules;
  const riskPolicy = policies.riskPolicy;
  const breakerPolicy = policies.breakerPolicy;
  const soulTokenPolicy = loadSoulTokenPolicy(policies);
  const telemetryPolicy = policies.telemetryPolicy;
  const shadowDeployment = loadShadowDeploymentPolicy(policies);
  const rawId = cleanText(args.id || '', 120);
  const includeEmotion = emotionEnabled(args);

  const transition = normalizeToken(args.transition || '', 40);
  const isTransition = !!rawId && !!transition;
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 300);
  const overrideReason = cleanText(args['override-reason'] || '', 300);
  const overrideActor = cleanText(args['override-actor'] || '', 120);
  const overrideExpiry = cleanText(args['override-expiry'] || '', 120);

  if (isTransition) {
    const transitionDeploymentGuard = enforceShadowDeploymentPolicy('project', shadowDeployment, null);
    const current = latestProjectState(rawId);
    if (!current) throw new Error(`project_not_found:${rawId}`);
    const from = normalizeToken(current.status || 'proposed', 40) || 'proposed';
    const allowed = PROJECT_TRANSITIONS[from] || [];
    if (!allowed.includes(transition)) {
      throw new Error(`invalid_project_transition:${from}->${transition}`);
    }
    const riskTier = classifyRiskTier(`${cleanText(current.project_name || '', 120)} ${cleanText(current.goal || '', 220)} ${transition}`, riskPolicy);
    const approvalRequiredTiers = Array.isArray(riskPolicy && riskPolicy.approval_required_tiers)
      ? riskPolicy.approval_required_tiers.map((v: unknown) => normalizeToken(v, 40))
      : ['medium', 'high'];
    if (approvalRequiredTiers.includes(riskTier) && !approvalNote && !overrideReason) {
      throw new Error(`approval_required_for_risk_tier:${riskTier}`);
    }
    if (riskTier === 'high') {
      enforceSoulToken(args, soulTokenPolicy, 'high_risk_project_transition', 'high_risk');
    }
    if (overrideReason) {
      enforceSoulToken(args, soulTokenPolicy, 'override_project_transition', 'overrides');
    }
    const sec = enforceSecurityGate('orchestrate_project_transition', riskTier, sha256Hex(`${rawId}|${transition}`));
    const previousTimestamps = current.status_timestamps && typeof current.status_timestamps === 'object'
      ? { ...current.status_timestamps }
      : {};
    const nextTimestamps = {
      ...previousTimestamps,
      [transition]: new Date().toISOString()
    };
    const pausedAt = cleanText(nextTimestamps.paused_on_breaker || '', 80);
    const mttrMs = pausedAt && (transition === 'reviewed' || transition === 'resumed' || transition === 'rolled_back')
      ? Math.max(0, Date.now() - Date.parse(pausedAt))
      : 0;
    const driftRate = driftRateFromArgs(args);
    const needsDriftGate = transition === 'resumed' || transition === 'rolled_back';
    if (needsDriftGate && !Number.isFinite(driftRate)) {
      throw new Error(`drift_rate_required_for_transition:${transition}`);
    }
    if (needsDriftGate && Number(driftRate) > 0.02) {
      const nowIso = new Date().toISOString();
      const escalatedReview = appendJsonlHashChained(PROJECTS_LEDGER, {
        type: 'project_state',
        project_id: rawId,
        project_name: cleanText(current.project_name || name, 200),
        goal: cleanText(current.goal || goal, 800),
        previous_status: from,
        status: 'reviewed',
        transition: `${from}->reviewed:auto_escalated_drift`,
        approval_note: approvalNote || '',
        override_reason: overrideReason || '',
        override_actor: overrideActor || '',
        override_expiry: overrideExpiry || '',
        drift_rate: Number(Number(driftRate).toFixed(4)),
        core5_review_required: true,
        fail_closed_reason: `drift_rate_exceeded:${Number(Number(driftRate).toFixed(4))}`,
        status_timestamps: {
          ...nextTimestamps,
          reviewed: nowIso
        },
        deployment_policy_version: cleanText(transitionDeploymentGuard.policy_version || '', 40) || null,
        deployment_isolation_enforced: transitionDeploymentGuard.isolation_enforced === true,
        deployment_active_locks: Number(transitionDeploymentGuard.active_locks || 0),
        timestamp: nowIso,
        engine_version: 'persona_orchestration_v1',
        gate_engine: sec.gate_engine
      });
      writeTelemetry('project', {
        latency_ms: 0,
        disagreement_rate: Number(Number(driftRate).toFixed(4)),
        arbitration_overrides: overrideReason ? 1 : 0,
        adoption_rate: 0,
        post_outcome_success: 0,
        breaker_trip: 1,
        breaker_trip_rate: 1,
        mttr_ms: mttrMs,
        auto_rollback_rate: transition === 'rolled_back' ? 1 : 0,
        escalation_burst_count: 1,
        escalation_signal: 1
      }, telemetryPolicy);
      return {
        ok: false,
        drift_escalated: true,
        artifact: escalatedReview
      };
    }
    const transitionEmotion = includeEmotion
      ? buildEmotionEnrichment(
        buildPersonaResponses(
          `${cleanText(current.project_name || name, 120)} ${cleanText(current.goal || goal, 220)} ${transition}`,
          [cleanText(current.owner || '', 80), ...(Array.isArray(current.escalation_chain) ? current.escalation_chain : [])]
            .map((v: unknown) => normalizeToken(v, 80))
            .filter(Boolean),
          true
        ),
        true
      )
      : [];
    const stateRow = {
      type: 'project_state',
      project_id: rawId,
      project_name: cleanText(current.project_name || name, 200),
      goal: cleanText(current.goal || goal, 800),
      previous_status: from,
      status: transition,
      transition: `${from}->${transition}`,
      approval_note: approvalNote || '',
      override_reason: overrideReason || '',
      override_actor: overrideActor || '',
      override_expiry: overrideExpiry || '',
      drift_rate: Number.isFinite(driftRate) ? Number(Number(driftRate).toFixed(4)) : null,
      status_timestamps: nextTimestamps,
      deployment_policy_version: cleanText(transitionDeploymentGuard.policy_version || '', 40) || null,
      deployment_isolation_enforced: transitionDeploymentGuard.isolation_enforced === true,
      deployment_active_locks: Number(transitionDeploymentGuard.active_locks || 0),
      emotion_enrichment: transitionEmotion,
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1',
      gate_engine: sec.gate_engine
    };
    const schemaErrors = validateAgainstSchema(stateRow, schemas.projectArtifact);
    if (schemaErrors.length) {
      throw new Error(`project_artifact_schema_failed:${schemaErrors.slice(0, 6).join('|')}`);
    }
    const artifact = appendJsonlHashChained(PROJECTS_LEDGER, stateRow);
    writeTelemetry('project', {
      latency_ms: 0,
      disagreement_rate: 0,
      arbitration_overrides: overrideReason ? 1 : 0,
      adoption_rate: transition === 'completed' ? 1 : 0,
      post_outcome_success: transition === 'completed' ? 1 : 0,
      breaker_trip: transition === 'paused_on_breaker' ? 1 : 0,
      breaker_trip_rate: transition === 'paused_on_breaker' ? 1 : 0,
      mttr_ms: mttrMs,
      auto_rollback_rate: transition === 'rolled_back' ? 1 : 0,
      escalation_burst_count: 0,
      escalation_signal: riskTier === 'high' || riskTier === 'medium' ? 1 : 0
    }, telemetryPolicy);
    return { ok: true, artifact };
  }

  const selection = applyBudgetControls(`${name} ${goal}`, selectAttendees(`${name} ${goal}`, routingRules, riskPolicy), riskPolicy);
  if (!selection.selected.length) throw new Error('no_eligible_personas');
  if (selection.runtime_budget_exceeded) {
    throw new Error(`budget_runtime_exceeded:max_runtime_ms=${selection.max_runtime_ms},estimated_runtime_ms=${selection.estimated_runtime_ms}`);
  }
  const deploymentGuard = enforceShadowDeploymentPolicy('project', shadowDeployment, selection);
  const id = projectId(name, goal);
  const current = latestProjectState(id);
  if (current) {
    return { ok: true, idempotent: true, artifact: current };
  }
  const riskTier = classifyRiskTier(`${name} ${goal}`, riskPolicy);
  const approvalRequiredTiers = Array.isArray(riskPolicy && riskPolicy.approval_required_tiers)
    ? riskPolicy.approval_required_tiers.map((v: unknown) => normalizeToken(v, 40))
    : ['medium', 'high'];
  if (approvalRequiredTiers.includes(riskTier) && !approvalNote && !overrideReason) {
    throw new Error(`approval_required_for_risk_tier:${riskTier}`);
  }
  if (riskTier === 'high') {
    enforceSoulToken(args, soulTokenPolicy, 'high_risk_project', 'high_risk');
  }
  if (overrideReason) {
    enforceSoulToken(args, soulTokenPolicy, 'override_project', 'overrides');
  }

  return withLock('project', id, () => {
    const sec = enforceSecurityGate('orchestrate_project', riskTier, sha256Hex(`${name}|${goal}`));
    const owner = selection.selected[0];
    const escalation = selection.selected.slice(1, 3);

    const selectionReceipt = appendJsonlHashChained(PROJECTS_LEDGER, {
      type: 'selection_receipt',
      project_id: id,
      project_name: name,
      goal,
      participants: selection.selected,
      owner,
      escalation_chain: escalation,
      domain: selection.domain,
      fallback_core_only: selection.fallback_core_only,
      budget_fallback_core_only: selection.budget_fallback_core_only,
      budget_fallback_reason: selection.budget_fallback_reason,
      estimated_tokens: selection.estimated_tokens,
      estimated_runtime_ms: selection.estimated_runtime_ms,
      max_tokens_estimate: selection.max_tokens_estimate,
      max_runtime_ms: selection.max_runtime_ms,
      selection_seed: selection.selection_seed,
      policy_version: cleanText(routingRules.version || '1.0', 80),
      deployment_policy_version: cleanText(deploymentGuard.policy_version || '', 40) || null,
      deployment_isolation_enforced: deploymentGuard.isolation_enforced === true,
      deployment_active_locks: Number(deploymentGuard.active_locks || 0),
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1'
    });

    const winner = pickWinnerPersona(selection.domain, selection.selected, arbitrationRules);
    const responses = buildPersonaResponses(`${name} ${goal}`, selection.selected, includeEmotion);
    const emotionEnrichment = buildEmotionEnrichment(responses, includeEmotion);
    const arbitrationReceipt = appendJsonlHashChained(PROJECTS_LEDGER, {
      type: 'arbitration_receipt',
      project_id: id,
      domain: selection.domain,
      winning_persona: winner,
      rule_applied: `domain_winner:${selection.domain}`,
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1'
    });

    const escalationSignal = riskTier === 'high' || riskTier === 'medium' ? 1 : 0;
    const breaker = evaluateBreaker('project', {
      disagreement_rate: 0,
      estimated_tokens: selection.estimated_tokens,
      max_tokens_estimate: selection.max_tokens_estimate,
      estimated_runtime_ms: selection.estimated_runtime_ms,
      max_runtime_ms: selection.max_runtime_ms,
      risk_tier: riskTier
    }, breakerPolicy, args);

    if (breaker.tripped) {
      const breakerReceipt = appendJsonlHashChained(PROJECTS_LEDGER, {
        type: 'breaker_trip_receipt',
        project_id: id,
        reason_code: breaker.reason_code,
        reason: breaker.reason,
        recovery_action: breaker.recovery_action,
        metrics: breaker.metrics,
        thresholds: breaker.thresholds,
        timestamp: new Date().toISOString(),
        engine_version: 'persona_orchestration_v1'
      });
      const fallbackStatus = breaker.recovery_action === 'auto_rollback' ? 'rolled_back' : 'paused_on_breaker';
      const breakerState = appendJsonlHashChained(PROJECTS_LEDGER, {
        type: 'project_state',
        project_id: id,
        project_name: cleanText(name, 200),
        goal: cleanText(goal, 800),
        status: fallbackStatus,
        previous_status: 'proposed',
        transition: `proposed->${fallbackStatus}`,
        owner,
        escalation_chain: escalation,
        risk_tier: riskTier,
        approval_note: approvalNote || '',
        override_reason: overrideReason || '',
        override_actor: overrideActor || '',
        override_expiry: overrideExpiry || '',
        emotion_enrichment: emotionEnrichment,
        status_timestamps: {
          proposed: new Date().toISOString(),
          [fallbackStatus]: new Date().toISOString()
        },
        estimated_tokens: selection.estimated_tokens,
        estimated_runtime_ms: selection.estimated_runtime_ms,
        max_tokens_estimate: selection.max_tokens_estimate,
        max_runtime_ms: selection.max_runtime_ms,
        shadow_mode_active: true,
        selection_receipt_hash: cleanText(selectionReceipt.hash || '', 90),
        arbitration_receipt_hash: cleanText(arbitrationReceipt.hash || '', 90),
        breaker_receipt_hash: cleanText(breakerReceipt.hash || '', 90),
        deployment_policy_version: cleanText(deploymentGuard.policy_version || '', 40) || null,
        deployment_isolation_enforced: deploymentGuard.isolation_enforced === true,
        deployment_active_locks: Number(deploymentGuard.active_locks || 0),
        timestamp: new Date().toISOString(),
        engine_version: 'persona_orchestration_v1',
        gate_engine: sec.gate_engine
      });
      writeTelemetry('project', {
        latency_ms: 0,
        disagreement_rate: 0,
        arbitration_overrides: overrideReason ? 1 : 0,
        adoption_rate: 0,
        post_outcome_success: 0,
        breaker_trip: 1,
        breaker_trip_rate: 1,
        mttr_ms: 0,
        auto_rollback_rate: breaker.recovery_action === 'auto_rollback' ? 1 : 0,
        escalation_burst_count: Number(breaker.metrics && breaker.metrics.escalation_burst_count || 0),
        escalation_signal: escalationSignal
      }, telemetryPolicy);
      if (breaker.recovery_action === 'auto_rollback') {
        return { ok: false, idempotent: false, breaker_tripped: true, artifact: breakerState };
      }
      throw new Error(`breaker_trip_escalated:${breaker.reason}`);
    }

    const shadow = evaluateShadowMode('project', 0, riskPolicy);
    const stateRow = {
      type: 'project_state',
      project_id: id,
      project_name: cleanText(name, 200),
      goal: cleanText(goal, 800),
      status: 'proposed',
      previous_status: '',
      transition: 'init->proposed',
      owner,
      escalation_chain: escalation,
      risk_tier: riskTier,
      approval_note: approvalNote || '',
      override_reason: overrideReason || '',
      override_actor: overrideActor || '',
      override_expiry: overrideExpiry || '',
      emotion_enrichment: emotionEnrichment,
      estimated_tokens: selection.estimated_tokens,
      estimated_runtime_ms: selection.estimated_runtime_ms,
      max_tokens_estimate: selection.max_tokens_estimate,
      max_runtime_ms: selection.max_runtime_ms,
      shadow_mode_active: shadow.shadow_active,
      selection_receipt_hash: cleanText(selectionReceipt.hash || '', 90),
      arbitration_receipt_hash: cleanText(arbitrationReceipt.hash || '', 90),
      deployment_policy_version: cleanText(deploymentGuard.policy_version || '', 40) || null,
      deployment_isolation_enforced: deploymentGuard.isolation_enforced === true,
      deployment_active_locks: Number(deploymentGuard.active_locks || 0),
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1',
      status_timestamps: {
        proposed: new Date().toISOString()
      },
      gate_engine: sec.gate_engine
    };
    const schemaErrors = validateAgainstSchema(stateRow, schemas.projectArtifact);
    if (schemaErrors.length) {
      throw new Error(`project_artifact_schema_failed:${schemaErrors.slice(0, 6).join('|')}`);
    }
    const artifact = appendJsonlHashChained(PROJECTS_LEDGER, stateRow);
    writeTelemetry('project', {
      latency_ms: 0,
      disagreement_rate: 0,
      arbitration_overrides: overrideReason ? 1 : 0,
      adoption_rate: 0,
      post_outcome_success: 0,
      breaker_trip: 0,
      breaker_trip_rate: 0,
      mttr_ms: 0,
      auto_rollback_rate: 0,
      escalation_burst_count: Number(breaker.metrics && breaker.metrics.escalation_burst_count || 0),
      escalation_signal: escalationSignal
    }, telemetryPolicy);
    return { ok: true, idempotent: false, artifact };
  });
}

function status() {
  ensureOrgFolders();
  const validation = validatePoliciesAndSchemas();
  const meetings = readJsonl(MEETINGS_LEDGER);
  const projects = readJsonl(PROJECTS_LEDGER);
  const telemetry = readJsonl(TELEMETRY_PATH);
  const retention = readJsonOptional(path.join(ORG_DIR, 'retention_policy.json'), {});
  const breaker = readJsonOptional(path.join(ORG_DIR, 'breaker_policy.json'), {});
  const deployment = readJsonOptional(SHADOW_DEPLOYMENT_POLICY_PATH, defaultShadowDeploymentPolicy());
  return {
    ok: validation.ok,
    policy_validation_failures: validation.ok ? [] : validation.failures,
    counts: {
      meetings: meetings.length,
      projects: projects.length,
      telemetry: telemetry.length
    },
    retention_policy: retention,
    hard_retention_ttl_days: HARD_RETENTION_TTL_DAYS,
    breaker_policy: {
      enabled: breaker && breaker.enabled === true,
      thresholds: breaker && breaker.thresholds ? breaker.thresholds : {}
    },
    shadow_deployment_policy: deployment
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  try {
    if (cmd === 'status') {
      process.stdout.write(`${JSON.stringify(status(), null, 2)}\n`);
      process.exit(0);
    }
    if (cmd === 'telemetry') {
      const windowSize = Number.isFinite(Number(args.window))
        ? Math.max(1, Number(args.window))
        : 20;
      process.stdout.write(`${JSON.stringify(telemetry(windowSize), null, 2)}\n`);
      process.exit(0);
    }
    if (cmd === 'meeting') {
      const topic = cleanText(args._.slice(1).join(' ') || args.topic || '', 1000);
      if (!topic) {
        throw new Error('meeting_topic_required');
      }
      const result = runMeeting(topic, args);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    }
    if (cmd === 'audit') {
      const artifactId = cleanText(args._.slice(1).join(' ') || args.id || '', 200);
      if (!artifactId) {
        throw new Error('audit_artifact_id_required');
      }
      const result = auditArtifact(artifactId);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    }
    if (cmd === 'prune') {
      const result = pruneArtifacts(args);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    }
    if (cmd === 'project') {
      const id = cleanText(args.id || '', 120);
      const transition = cleanText(args.transition || '', 40);
      if (id && transition) {
        const result = runProject('', '', args);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exit(0);
      }
      const name = cleanText(args._[1] || args.name || '', 200);
      const goal = cleanText(args._.slice(2).join(' ') || args.goal || '', 1200);
      if (!name || !goal) {
        throw new Error('project_name_goal_required');
      }
      const result = runProject(name, goal, args);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    }
    usage();
    process.exit(2);
  } catch (err: any) {
    process.stderr.write(`${cleanText(err && err.message || 'orchestration_failed', 500)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  validatePoliciesAndSchemas,
  runMeeting,
  runProject,
  auditArtifact,
  pruneArtifacts,
  status,
  telemetry
};
