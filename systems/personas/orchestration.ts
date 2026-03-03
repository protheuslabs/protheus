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
const PERSONAS_DIR = path.join(ROOT, 'personas');
const MEETINGS_DIR = path.join(ORG_DIR, 'meetings');
const PROJECTS_DIR = path.join(ORG_DIR, 'projects');
const LOCKS_DIR = path.join(ORG_DIR, '.locks');
const TELEMETRY_PATH = path.join(ORG_DIR, 'telemetry.jsonl');
const SHADOW_STATE_PATH = path.join(ORG_DIR, 'shadow_mode_state.json');
const MEETINGS_LEDGER = path.join(MEETINGS_DIR, 'ledger.jsonl');
const PROJECTS_LEDGER = path.join(PROJECTS_DIR, 'ledger.jsonl');

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
  console.log('  protheus orchestrate meeting "<topic>" [--approval-note="..."] [--override-reason=...] [--override-actor=...] [--override-expiry=ISO8601]');
  console.log('  protheus orchestrate project "<name>" "<goal>" [--approval-note="..."] [--override-reason=...] [--override-actor=...] [--override-expiry=ISO8601]');
  console.log('  protheus orchestrate project --id=<project_id> --transition=<active|blocked|completed|cancelled> [--approval-note="..."] [--override-reason=...] [--override-actor=...] [--override-expiry=ISO8601]');
  console.log('  protheus orchestrate status');
}

function schemaPaths() {
  return {
    arbitrationRules: path.join(ORG_DIR, 'arbitration_rules.schema.json'),
    routingRules: path.join(ORG_DIR, 'routing_rules.schema.json'),
    meetingArtifact: path.join(ORG_DIR, 'meeting_artifact.schema.json'),
    projectArtifact: path.join(ORG_DIR, 'project_artifact.schema.json')
  };
}

function policyPaths() {
  return {
    arbitrationRules: path.join(ORG_DIR, 'arbitration_rules.json'),
    routingRules: path.join(ORG_DIR, 'routing_rules.json'),
    riskPolicy: path.join(ORG_DIR, 'risk_policy.json'),
    telemetryPolicy: path.join(ORG_DIR, 'telemetry_policy.json'),
    retentionPolicy: path.join(ORG_DIR, 'retention_policy.json')
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
      telemetryPolicy: readJson(pPaths.telemetryPolicy),
      retentionPolicy: readJson(pPaths.retentionPolicy)
    };
  } catch (err: any) {
    return {
      ok: false,
      failures: [`policy_malformed:${cleanText(err && err.message || '', 240)}`]
    };
  }

  const policyValidations = [
    ['arbitration_rules.json', policies.arbitrationRules, schemas.arbitrationRules],
    ['routing_rules.json', policies.routingRules, schemas.routingRules]
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
      for (const key of ['latency_ms', 'disagreement_rate', 'arbitration_overrides', 'adoption_rate', 'post_outcome_success']) {
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
  const personas = allPersonaIds();
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

function buildPersonaResponses(topic: string, participants: string[]) {
  return participants.map((personaId) => {
    const signals = loadPersonaSignals(personaId);
    return {
      persona_id: personaId,
      recommendation: recommendationForPersona(personaId, topic),
      tone_context: summarizeTone(signals.emotionLens),
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
    post_outcome_success: cleanText(formulas.post_outcome_success || 'post_outcome_success = successful_outcomes/max(1,tracked_outcomes)', 220)
  };
}

function evaluateShadowMode(kind: 'meeting' | 'project', policyValidationFailures: number, riskPolicy: any) {
  const state = readShadowState();
  const lane = state[kind] && typeof state[kind] === 'object'
    ? state[kind]
    : { shadow_active: true, policy_validation_failures: 0, cycles: 0 };
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

  lane.policy_validation_failures = Number(lane.policy_validation_failures || 0) + Number(policyValidationFailures || 0);
  lane.cycles = Number(lane.cycles || 0) + 1;

  const disagreementLimit = Number.isFinite(Number(metricsExit.disagreement_rate_lte))
    ? Number(metricsExit.disagreement_rate_lte)
    : 0.35;
  const overridesLimit = Number.isFinite(Number(metricsExit.arbitration_overrides_lte))
    ? Number(metricsExit.arbitration_overrides_lte)
    : 0.2;
  const policyRequired = Number.isFinite(Number(metricsExit.policy_validation_failures_eq))
    ? Number(metricsExit.policy_validation_failures_eq)
    : 0;

  const exitQualified = telemetry.length >= minSamples
    && disagreementAvg <= disagreementLimit
    && overridesAvg <= overridesLimit
    && Number(lane.policy_validation_failures || 0) === policyRequired;

  lane.shadow_active = !exitQualified;
  state[kind] = lane;
  writeShadowState(state);

  return {
    shadow_active: lane.shadow_active === true,
    samples: telemetry.length,
    disagreement_rate_avg: Number(disagreementAvg.toFixed(4)),
    arbitration_overrides_avg: Number(overridesAvg.toFixed(4)),
    policy_validation_failures: Number(lane.policy_validation_failures || 0),
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
  const telemetryPolicy = policies.telemetryPolicy;

  const selection = applyBudgetControls(topic, selectAttendees(topic, routingRules, riskPolicy), riskPolicy);
  if (!selection.selected.length) {
    throw new Error('no_eligible_personas');
  }
  if (selection.runtime_budget_exceeded) {
    throw new Error(`budget_runtime_exceeded:max_runtime_ms=${selection.max_runtime_ms},estimated_runtime_ms=${selection.estimated_runtime_ms}`);
  }

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
      persona_snapshot_hash: sha256Hex(selection.selected.join('|')).slice(0, 16),
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1'
    });

    const responses = buildPersonaResponses(topic, selection.selected);
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

    const confidence = Number(Math.max(0.2, 1 - disagreement * 0.6).toFixed(4));
    const endMs = Date.now();
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
      persona_snapshot_hash: sha256Hex(stableStringify(responses)).slice(0, 16),
      selection_seed: selection.selection_seed,
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1',
      latency_ms: Math.max(0, endMs - startMs),
      disagreement_rate: disagreement,
      arbitration_overrides: overrideReason ? 1 : 0,
      adoption_rate: shadow.shadow_active ? 0 : 1,
      post_outcome_success: 0,
      gate_engine: sec.gate_engine
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
  active: ['blocked', 'completed', 'cancelled'],
  blocked: ['active', 'cancelled'],
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
  const telemetryPolicy = policies.telemetryPolicy;
  const rawId = cleanText(args.id || '', 120);

  const transition = normalizeToken(args.transition || '', 40);
  const isTransition = !!rawId && !!transition;
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 300);
  const overrideReason = cleanText(args['override-reason'] || '', 300);
  const overrideActor = cleanText(args['override-actor'] || '', 120);
  const overrideExpiry = cleanText(args['override-expiry'] || '', 120);

  if (isTransition) {
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
    const sec = enforceSecurityGate('orchestrate_project_transition', riskTier, sha256Hex(`${rawId}|${transition}`));
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
      post_outcome_success: transition === 'completed' ? 1 : 0
    }, telemetryPolicy);
    return { ok: true, artifact };
  }

  const selection = applyBudgetControls(`${name} ${goal}`, selectAttendees(`${name} ${goal}`, routingRules, riskPolicy), riskPolicy);
  if (!selection.selected.length) throw new Error('no_eligible_personas');
  if (selection.runtime_budget_exceeded) {
    throw new Error(`budget_runtime_exceeded:max_runtime_ms=${selection.max_runtime_ms},estimated_runtime_ms=${selection.estimated_runtime_ms}`);
  }
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
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1'
    });

    const winner = pickWinnerPersona(selection.domain, selection.selected, arbitrationRules);
    const arbitrationReceipt = appendJsonlHashChained(PROJECTS_LEDGER, {
      type: 'arbitration_receipt',
      project_id: id,
      domain: selection.domain,
      winning_persona: winner,
      rule_applied: `domain_winner:${selection.domain}`,
      timestamp: new Date().toISOString(),
      engine_version: 'persona_orchestration_v1'
    });

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
      estimated_tokens: selection.estimated_tokens,
      estimated_runtime_ms: selection.estimated_runtime_ms,
      max_tokens_estimate: selection.max_tokens_estimate,
      max_runtime_ms: selection.max_runtime_ms,
      shadow_mode_active: shadow.shadow_active,
      selection_receipt_hash: cleanText(selectionReceipt.hash || '', 90),
      arbitration_receipt_hash: cleanText(arbitrationReceipt.hash || '', 90),
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
      adoption_rate: 0,
      post_outcome_success: 0
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
  return {
    ok: validation.ok,
    policy_validation_failures: validation.ok ? [] : validation.failures,
    counts: {
      meetings: meetings.length,
      projects: projects.length,
      telemetry: telemetry.length
    },
    retention_policy: retention
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
    if (cmd === 'meeting') {
      const topic = cleanText(args._.slice(1).join(' ') || args.topic || '', 1000);
      if (!topic) {
        throw new Error('meeting_topic_required');
      }
      const result = runMeeting(topic, args);
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
  status
};
