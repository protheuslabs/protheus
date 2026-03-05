#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { runPersonasPrimitive } = require('./personas_rust_bridge.js');

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');
const PERSONA_ORG_DIR = path.join(PERSONAS_DIR, 'organization');
const PERSONA_TELEMETRY_PATH = path.join(PERSONA_ORG_DIR, 'telemetry.jsonl');
const PERSONA_FEEDBACK_PATH = path.join(PERSONA_ORG_DIR, 'feedback.jsonl');
const PERSONA_TRIGGERS_PATH = path.join(PERSONA_ORG_DIR, 'triggers.md');
const PERSONA_ARBITRATION_RULES_PATH = path.join(PERSONA_ORG_DIR, 'arbitration_rules.json');
const PERSONA_STANCE_CACHE_PATH = path.join(PERSONA_ORG_DIR, 'stance_cache.json');
let runLocalOllamaPrompt: null | ((opts: Record<string, unknown>) => Record<string, unknown>) = null;
try {
  ({ runLocalOllamaPrompt } = require('../routing/llm_gateway.js'));
} catch {
  runLocalOllamaPrompt = null;
}

type ParsedArgs = {
  _: string[],
  [key: string]: any
};

type LensMode = 'decision' | 'strategic' | 'full';
type OutputSchema = 'markdown' | 'json';
type AlignmentMode = 'yellow_auto' | 'green_active';
type ContextBudgetMode = 'trim' | 'reject';
type LensControls = {
  gapSeconds: number,
  alignmentMode: AlignmentMode,
  interceptText: string
};
type GapSessionResult = {
  alignmentMode: AlignmentMode,
  finalOverride: string,
  approvedEarly: boolean,
  intercepted: boolean
};
type ContextBudgetPolicy = {
  maxTokens: number,
  mode: ContextBudgetMode,
  source: 'default' | 'env' | 'arg'
};
type ContextBudgetState = {
  max_tokens: number,
  mode: ContextBudgetMode,
  source: 'default' | 'env' | 'arg',
  estimated_tokens_before: number,
  estimated_tokens_after: number,
  bootstrap_tokens: number,
  dynamic_tokens_before: number,
  dynamic_tokens_after: number,
  dynamic_items_before: number,
  dynamic_items_after: number,
  over_budget_before: boolean,
  over_budget_after: boolean,
  trimmed: boolean,
  rejected: boolean,
  dropped_dynamic_items: number
};
const DEFAULT_CONTEXT_TOKEN_BUDGET = 2000;
const CONTEXT_BUDGET_DEDUP = new Set<string>();
const PERSONAS_RUST_ENABLED = String(process.env.PROTHEUS_PERSONAS_RUST_ENABLED || '1') !== '0';

function usage() {
  console.log('Usage:');
  console.log('  protheus lens <persona> "<query>"');
  console.log('  protheus lens <persona1> <persona2> [personaN...] "<query>" [--expected="<text>"]');
  console.log('  protheus lens arbitrate --between=persona1,persona2 [--between=personaN...] --issue="<query>"');
  console.log('  protheus lens <persona> <decision|strategic|full> "<query>"');
  console.log('  protheus lens <persona> [decision|strategic|full] --gap=<seconds> [--active=1] [--emotion=on|off] [--values=on|off] [--include-feed=1] [--surprise=on|off] [--schema=markdown|json] [--max-context-tokens=<n>] [--context-budget-mode=trim|reject] [--intercept="<override>"] "<query>"');
  console.log('  protheus lens trigger <pre-sprint|drift-alert|weekly-checkin> ["<query>"] [--persona=<id>] [--heartbeat=HEARTBEAT.md] [--dry-run=1]');
  console.log('  protheus lens dashboard [--window=<n>] [--json=1]');
  console.log('  protheus lens update-stream <persona> [--dry-run=1]');
  console.log('  protheus lens checkin [--persona=jay_haslam] [--heartbeat=HEARTBEAT.md] [--emotion=on|off] [--dry-run=1]');
  console.log('  protheus lens feed <persona> "<snippet>" [--source=master_llm] [--tags=tag1,tag2] [--dry-run=1]');
  console.log('  protheus lens feedback --surprising=0|1 --changed-decision=0|1 --useful=<persona> [--session-id=<id>] [--note="<text>"]');
  console.log('  protheus lens feedback-summary [--window=<n>] [--json=1]');
  console.log('  protheus lens all "<query>"');
  console.log('  protheus lens --persona=<persona> --lens=<decision|strategic|full> --query="<query>"');
  console.log('  protheus lens --list');
  console.log('');
  console.log('Examples:');
  console.log('  protheus lens vikram "Should we prioritize memory or security first?"');
  console.log('  protheus lens vikram rohan "Prioritize memory or security first?" --expected="Prioritize memory core determinism first."');
  console.log('  protheus lens arbitrate --between=vikram,priya --issue="sample vs full audit"');
  console.log('  protheus lens vikram strategic "How does this sprint support the singularity seed?"');
  console.log('  protheus lens jay_haslam "How can we reduce drift in the loops?"');
  console.log('  protheus lens trigger pre-sprint "Foundation Lock sprint planning review"');
  console.log('  protheus lens dashboard --window=20');
  console.log('  protheus lens vikram --gap=10 --active=1 --emotion=off --values=on --include-feed=1 --max-context-tokens=2000 --context-budget-mode=trim --surprise=on --schema=json --intercept="Prioritize memory first, with security gate pre-dispatch." "Prioritize memory or security?"');
  console.log('  protheus lens update-stream vikram_menon');
  console.log('  protheus lens checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md');
  console.log('  protheus lens feed vikram_menon "Cross-signal indicates rising security drift risk." --source=master_llm --tags=drift,security');
  console.log('  protheus lens feedback --surprising=1 --changed-decision=1 --useful=vikram_menon --note="Caught fail-closed gap before merge."');
  console.log('  protheus lens all "Should we prioritize memory or security first?"');
  console.log('  protheus lens --persona=vikram_menon --lens=decision --query="What is the rollback path?"');
  console.log('');
  console.log("Gap controls: while --gap is active, press 'e' + Enter to edit or 'a' + Enter to approve early.");
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
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

function cleanText(v: unknown, maxLen = 500): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeToken(v: unknown, maxLen = 120): string {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeLensMode(v: unknown): LensMode {
  const token = normalizeToken(v, 40);
  if (token === 'strategic') return 'strategic';
  if (token === 'full') return 'full';
  return 'decision';
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseEmotionEnabled(v: unknown, fallback = true) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['on', 'true', '1', 'yes'].includes(raw)) return true;
  if (['off', 'false', '0', 'no'].includes(raw)) return false;
  return fallback;
}

function parseOutputSchema(v: unknown, fallback: OutputSchema = 'markdown'): OutputSchema {
  const raw = cleanText(v, 30).toLowerCase();
  if (!raw) return fallback;
  if (raw === 'json') return 'json';
  if (raw === 'markdown' || raw === 'md') return 'markdown';
  return fallback;
}

function estimateTokenCount(input: unknown): number {
  const text = String(input == null ? '' : input);
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function defaultContextBudgetPolicy(): ContextBudgetPolicy {
  const envRaw = cleanText(process.env.PROTHEUS_PERSONA_MAX_CONTEXT_TOKENS || '', 40);
  if (envRaw) {
    return {
      maxTokens: clampInt(envRaw, 200, 12000, DEFAULT_CONTEXT_TOKEN_BUDGET),
      mode: 'trim',
      source: 'env'
    };
  }
  return {
    maxTokens: DEFAULT_CONTEXT_TOKEN_BUDGET,
    mode: 'trim',
    source: 'default'
  };
}

function parseContextBudgetPolicy(args: ParsedArgs): ContextBudgetPolicy {
  const modeRaw = normalizeToken(
    args['context-budget-mode']
      ?? args.context_budget_mode
      ?? args.contextBudgetMode
      ?? '',
    20
  );
  const mode: ContextBudgetMode = modeRaw === 'reject' ? 'reject' : 'trim';
  const argRaw = cleanText(
    args['max-context-tokens']
      ?? args.max_context_tokens
      ?? args.maxContextTokens
      ?? '',
    40
  );
  if (argRaw) {
    return {
      maxTokens: clampInt(argRaw, 200, 12000, DEFAULT_CONTEXT_TOKEN_BUDGET),
      mode,
      source: 'arg'
    };
  }
  const envRaw = cleanText(process.env.PROTHEUS_PERSONA_MAX_CONTEXT_TOKENS || '', 40);
  if (envRaw) {
    return {
      maxTokens: clampInt(envRaw, 200, 12000, DEFAULT_CONTEXT_TOKEN_BUDGET),
      mode,
      source: 'env'
    };
  }
  return {
    maxTokens: DEFAULT_CONTEXT_TOKEN_BUDGET,
    mode,
    source: 'default'
  };
}

function parseGapSeconds(v: unknown, fallback = 0) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(60, Math.floor(n)));
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseTagList(v: unknown): string[] {
  return Array.from(new Set(
    String(v == null ? '' : v)
      .split(',')
      .map((part) => normalizeToken(part, 40))
      .filter(Boolean)
  ));
}

function readLensControls(args: ParsedArgs): LensControls {
  const gapSeconds = parseGapSeconds(
    args.gap
      ?? args['cognizance-gap']
      ?? args.cognizance_gap
      ?? args.delay
      ?? 0,
    0
  );
  const alignmentMode: AlignmentMode = toBool(args.active, false) ? 'green_active' : 'yellow_auto';
  const interceptText = cleanText(args.intercept ?? args.override ?? '', 1800);
  return {
    gapSeconds,
    alignmentMode,
    interceptText
  };
}

function sleepMs(ms: number) {
  const delay = Math.max(0, Math.min(60000, Math.floor(ms)));
  if (!delay) return;
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, delay);
}

function alignmentBadge(mode: AlignmentMode) {
  return mode === 'green_active' ? '[Green] active' : '[Yellow] auto';
}

function buildStreamSteps(reasoning: string[], recommendation: string): string[] {
  const cleanRecommendation = cleanText(recommendation, 240) || 'No recommendation draft available yet.';
  const picked = (Array.isArray(reasoning) ? reasoning : [])
    .map((row) => cleanText(row, 260))
    .filter(Boolean);
  const emotion = picked.find((row) => row.toLowerCase().startsWith('emotion signal:')) || '';
  const ordered = emotion
    ? [emotion, ...picked.filter((row) => row !== emotion)]
    : picked;
  const base = picked.length
    ? ordered
    : [
        'Decision scan: no explicit lens filters parsed, defaulting to deterministic guidance.',
        'Risk scan: fail-closed posture remains mandatory before dispatch.',
        'Evidence scan: recommendation must be backed by tests and receipts.'
      ];

  const steps = [
    `Draft position: ${cleanRecommendation}`,
    ...base.slice(0, 4)
  ];
  while (steps.length < 3) {
    steps.push('Fallback reasoning: maintain deterministic and auditable behavior.');
  }
  return steps.slice(0, 5);
}

async function waitInterruptible(ms: number, shouldStop: () => boolean): Promise<void> {
  const total = Math.max(0, Math.floor(ms));
  if (!total) return;
  const tick = 100;
  let elapsed = 0;
  while (elapsed < total) {
    if (shouldStop()) return;
    const delay = Math.min(tick, total - elapsed);
    await new Promise((resolve) => setTimeout(resolve, delay));
    elapsed += delay;
  }
}

function listPersonaIds(): string[] {
  try {
    if (!fs.existsSync(PERSONAS_DIR)) return [];
    return fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
      .filter((entry: any) => entry && entry.isDirectory())
      .map((entry: any) => String(entry.name || ''))
      .filter((name: string) => fs.existsSync(path.join(PERSONAS_DIR, name, 'profile.md')))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function aliasForms(id: string): Set<string> {
  const forms = new Set<string>();
  const norm = normalizeToken(id, 140);
  const compact = norm.replace(/_/g, '');
  const parts = norm.split('_').filter(Boolean);
  forms.add(norm);
  if (compact) forms.add(compact);
  if (parts[0]) forms.add(parts[0]);
  if (parts.length >= 2) forms.add(`${parts[0]}_${parts[1]}`);
  return forms;
}

function resolvePersonaId(rawPersona: string): string | null {
  const personas = listPersonaIds();
  if (!personas.length) return null;

  const query = normalizeToken(rawPersona, 140);
  if (!query) return null;
  const queryCompact = query.replace(/_/g, '');

  for (const personaId of personas) {
    if (normalizeToken(personaId, 140) === query) {
      return personaId;
    }
  }

  const scored = personas
    .map((personaId) => {
      const forms = aliasForms(personaId);
      let score = 0;
      for (const form of forms) {
        if (form === query) score = Math.max(score, 100);
        if (form === queryCompact) score = Math.max(score, 95);
        if (form.startsWith(query)) score = Math.max(score, 80);
        if (query.startsWith(form)) score = Math.max(score, 70);
        if (form.replace(/_/g, '').startsWith(queryCompact)) score = Math.max(score, 60);
      }
      return { personaId, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.personaId.localeCompare(b.personaId));

  return scored.length ? scored[0].personaId : null;
}

function readFileRequired(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing_required_file:${path.relative(ROOT, filePath)}`);
  }
  return String(fs.readFileSync(filePath, 'utf8') || '');
}

function readFileOptional(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return String(fs.readFileSync(filePath, 'utf8') || '');
}

type PersonaContext = {
  personaId: string,
  personaName: string,
  profileMd: string,
  correspondenceMd: string,
  correspondencePath: string,
  decisionLensMd: string,
  strategicLensMd: string,
  emotionLensMd: string,
  dataStreamsMd: string,
  dataStreamsPath: string,
  soulTokenMd: string,
  soulTokenPath: string,
  decisionLensPath: string,
  strategicLensPath: string | null,
  valuesLensMd: string,
  valuesLensPath: string | null,
  llmConfigMd: string,
  llmConfigPath: string | null,
  obfuscationEncryptionMd: string,
  obfuscationEncryptionPath: string | null,
  dataPermissionsMd: string,
  dataPermissionsPath: string | null,
  feedMd: string,
  feedPath: string | null,
  memoryMd: string,
  memoryPath: string | null
};

type ArbitrationRules = {
  version: string,
  default_domain: string,
  tie_break_priority: string[],
  domain_winners: Record<string, string>,
  conflicting_rules_fail_closed: boolean
};

type StanceCacheRule = {
  id: string,
  match_all: string[],
  personas: Record<string, string>,
  default_recommendation: string,
  escalate_to: string
};

type StanceCache = {
  version: string,
  rules: StanceCacheRule[]
};

function loadPersonaContext(personaId: string): PersonaContext {
  const personaDir = path.join(PERSONAS_DIR, personaId);
  const profileMd = readFileRequired(path.join(personaDir, 'profile.md'));
  const correspondencePath = path.join(personaDir, 'correspondence.md');
  const correspondenceMd = readFileRequired(correspondencePath);
  const decisionLensPath = fs.existsSync(path.join(personaDir, 'decision_lens.md'))
    ? path.join(personaDir, 'decision_lens.md')
    : path.join(personaDir, 'lens.md');
  const strategicLensPath = fs.existsSync(path.join(personaDir, 'strategic_lens.md'))
    ? path.join(personaDir, 'strategic_lens.md')
    : null;
  const valuesLensPath = fs.existsSync(path.join(personaDir, 'values_philosophy_lens.md'))
    ? path.join(personaDir, 'values_philosophy_lens.md')
    : null;
  const llmConfigPath = fs.existsSync(path.join(personaDir, 'llm_config.md'))
    ? path.join(personaDir, 'llm_config.md')
    : null;
  const obfuscationEncryptionPath = fs.existsSync(path.join(personaDir, 'obfuscation_encryption.md'))
    ? path.join(personaDir, 'obfuscation_encryption.md')
    : null;
  const dataPermissionsPath = fs.existsSync(path.join(personaDir, 'data_permissions.md'))
    ? path.join(personaDir, 'data_permissions.md')
    : null;
  const feedPath = fs.existsSync(path.join(personaDir, 'feed.md'))
    ? path.join(personaDir, 'feed.md')
    : null;
  const memoryPath = fs.existsSync(path.join(personaDir, 'memory.md'))
    ? path.join(personaDir, 'memory.md')
    : null;
  const dataStreamsPath = path.join(personaDir, 'data_streams.md');
  const soulTokenPath = path.join(personaDir, 'soul_token.md');
  const decisionLensMd = readFileRequired(decisionLensPath);
  const strategicLensMd = strategicLensPath ? readFileOptional(strategicLensPath) : '';
  const valuesLensMd = valuesLensPath ? readFileOptional(valuesLensPath) : '';
  const llmConfigMd = llmConfigPath ? readFileOptional(llmConfigPath) : '';
  const obfuscationEncryptionMd = obfuscationEncryptionPath ? readFileOptional(obfuscationEncryptionPath) : '';
  const dataPermissionsMd = dataPermissionsPath ? readFileOptional(dataPermissionsPath) : '';
  const feedMd = feedPath ? readFileOptional(feedPath) : '';
  const memoryMd = memoryPath ? readFileOptional(memoryPath) : '';
  const emotionLensMd = readFileOptional(path.join(personaDir, 'emotion_lens.md'));
  const dataStreamsMd = readFileRequired(dataStreamsPath);
  const soulTokenMd = readFileRequired(soulTokenPath);
  const personaName = extractTitle(profileMd, personaId);
  const securityCfg = parsePersonaSecurityConfig(obfuscationEncryptionMd);
  const profileResolved = decodeProtectedContent(profileMd, securityCfg);
  const correspondenceResolved = decodeProtectedContent(correspondenceMd, securityCfg);
  const decisionResolved = decodeProtectedContent(decisionLensMd, securityCfg);
  const strategicResolved = decodeProtectedContent(strategicLensMd, securityCfg);
  const valuesResolved = decodeProtectedContent(valuesLensMd, securityCfg);
  const emotionResolved = decodeProtectedContent(emotionLensMd, securityCfg);
  const dataStreamsResolved = decodeProtectedContent(dataStreamsMd, securityCfg);
  const dataPermissionsResolved = decodeProtectedContent(dataPermissionsMd, securityCfg);
  const feedResolved = decodeProtectedContent(feedMd, securityCfg);
  const memoryResolved = decodeProtectedContent(memoryMd, securityCfg);
  return {
    personaId,
    personaName,
    profileMd: profileResolved,
    correspondenceMd: correspondenceResolved,
    correspondencePath: path.relative(ROOT, correspondencePath).replace(/\\/g, '/'),
    decisionLensMd: decisionResolved,
    strategicLensMd: strategicResolved,
    emotionLensMd: emotionResolved,
    dataStreamsMd: dataStreamsResolved,
    dataStreamsPath: path.relative(ROOT, dataStreamsPath).replace(/\\/g, '/'),
    soulTokenMd,
    soulTokenPath: path.relative(ROOT, soulTokenPath).replace(/\\/g, '/'),
    decisionLensPath: path.relative(ROOT, decisionLensPath).replace(/\\/g, '/'),
    strategicLensPath: strategicLensPath ? path.relative(ROOT, strategicLensPath).replace(/\\/g, '/') : null,
    valuesLensMd: valuesResolved,
    valuesLensPath: valuesLensPath ? path.relative(ROOT, valuesLensPath).replace(/\\/g, '/') : null,
    llmConfigMd,
    llmConfigPath: llmConfigPath ? path.relative(ROOT, llmConfigPath).replace(/\\/g, '/') : null,
    obfuscationEncryptionMd,
    obfuscationEncryptionPath: obfuscationEncryptionPath ? path.relative(ROOT, obfuscationEncryptionPath).replace(/\\/g, '/') : null,
    dataPermissionsMd: dataPermissionsResolved,
    dataPermissionsPath: dataPermissionsPath ? path.relative(ROOT, dataPermissionsPath).replace(/\\/g, '/') : null,
    feedMd: feedResolved,
    feedPath: feedPath ? path.relative(ROOT, feedPath).replace(/\\/g, '/') : null,
    memoryMd: memoryResolved,
    memoryPath: memoryPath ? path.relative(ROOT, memoryPath).replace(/\\/g, '/') : null
  };
}

function loadArbitrationRules(): ArbitrationRules {
  const fallback: ArbitrationRules = {
    version: '1.0.0',
    default_domain: 'general',
    tie_break_priority: ['vikram_menon', 'priya_venkatesh', 'rohan_kapoor', 'li_wei', 'aarav_singh', 'jay_haslam'],
    domain_winners: {
      security: 'aarav_singh',
      safety: 'vikram_menon',
      measurement: 'priya_venkatesh',
      rollout: 'rohan_kapoor',
      product: 'li_wei',
      general: 'vikram_menon'
    },
    conflicting_rules_fail_closed: true
  };
  try {
    if (!fs.existsSync(PERSONA_ARBITRATION_RULES_PATH)) return fallback;
    const payload = JSON.parse(String(fs.readFileSync(PERSONA_ARBITRATION_RULES_PATH, 'utf8') || '{}'));
    const tieBreak = Array.isArray(payload && payload.tie_break_priority)
      ? payload.tie_break_priority.map((v: unknown) => normalizeToken(v, 120)).filter(Boolean)
      : fallback.tie_break_priority.slice();
    const domainWinnersRaw = payload && typeof payload.domain_winners === 'object'
      ? payload.domain_winners
      : {};
    const domainWinners: Record<string, string> = {};
    for (const [key, value] of Object.entries(domainWinnersRaw || {})) {
      const k = normalizeToken(key, 80);
      const v = normalizeToken(value, 120);
      if (!k || !v) continue;
      domainWinners[k] = v;
    }
    return {
      version: cleanText(payload && payload.version || fallback.version, 30) || fallback.version,
      default_domain: normalizeToken(payload && payload.default_domain || fallback.default_domain, 60) || 'general',
      tie_break_priority: tieBreak.length ? tieBreak : fallback.tie_break_priority.slice(),
      domain_winners: Object.keys(domainWinners).length ? domainWinners : fallback.domain_winners,
      conflicting_rules_fail_closed: toBool(payload && payload.conflicting_rules_fail_closed, fallback.conflicting_rules_fail_closed)
    };
  } catch {
    return fallback;
  }
}

function defaultStanceCache(): StanceCache {
  return {
    version: '1.0.0',
    rules: [
      {
        id: 'rust_migration_parity',
        match_all: ['rust', 'migrat'],
        personas: {
          vikram_menon: 'Run behavior-preserving migration in thin slices with strict parity checks before any cutover.',
          priya_venkatesh: 'Measure drift and parity before each migration slice; block promotion when evidence is missing.',
          rohan_kapoor: 'Stage migration in rollout-safe waves with rollback checkpoints and parity receipts per wave.'
        },
        default_recommendation: 'Use parity-verified, behavior-preserving migration slices with deterministic rollback paths.',
        escalate_to: 'vikram_menon'
      },
      {
        id: 'external_api_integration',
        match_all: ['external', 'api'],
        personas: {
          rohan_kapoor: 'Add rollback path, timeout budgets, and staged rollout controls before enabling external API integrations.',
          aarav_singh: 'Require fail-closed security checks and contract validation before any external API dispatch.'
        },
        default_recommendation: 'External API integrations require rollback-safe rollout and fail-closed security gating before activation.',
        escalate_to: 'rohan_kapoor'
      },
      {
        id: 'memory_vs_security_priority',
        match_all: ['memory', 'security', 'first'],
        personas: {
          vikram_menon: 'Prioritize memory core determinism first, but keep security enforcement in pre-dispatch path from day one.',
          aarav_singh: 'Prioritize security invariants first: enforce fail-closed checks globally, then continue memory migration behind audited gates.',
          priya_venkatesh: 'Do not hard-order memory vs security until parity and drift evidence is current; run a measurement checkpoint before sequencing.'
        },
        default_recommendation: 'Sequence memory and security with parity proof and fail-closed gating active from the first migration slice.',
        escalate_to: 'vikram_menon'
      }
    ]
  };
}

function loadStanceCache(): StanceCache {
  const fallback = defaultStanceCache();
  try {
    if (!fs.existsSync(PERSONA_STANCE_CACHE_PATH)) return fallback;
    const payload = JSON.parse(String(fs.readFileSync(PERSONA_STANCE_CACHE_PATH, 'utf8') || '{}'));
    const rulesRaw = Array.isArray(payload && payload.rules) ? payload.rules : [];
    const rules: StanceCacheRule[] = [];
    for (const row of rulesRaw) {
      const id = normalizeToken(row && row.id || 'rule', 80) || `rule_${rules.length + 1}`;
      const matchAll = Array.isArray(row && row.match_all)
        ? row.match_all.map((v: unknown) => cleanText(v, 60).toLowerCase()).filter(Boolean)
        : [];
      const personas: Record<string, string> = {};
      const personaRows = row && typeof row.personas === 'object' ? row.personas : {};
      for (const [personaKey, recommendation] of Object.entries(personaRows || {})) {
        const key = normalizeToken(personaKey, 120);
        const value = cleanText(recommendation, 1200);
        if (!key || !value) continue;
        personas[key] = value;
      }
      rules.push({
        id,
        match_all: matchAll,
        personas,
        default_recommendation: cleanText(row && row.default_recommendation || '', 1200),
        escalate_to: normalizeToken(row && row.escalate_to || '', 120) || 'vikram_menon'
      });
    }
    return {
      version: cleanText(payload && payload.version || fallback.version, 30) || fallback.version,
      rules: rules.length ? rules : fallback.rules
    };
  } catch {
    return fallback;
  }
}

function stanceMatch(query: string, rule: StanceCacheRule) {
  const lower = String(query || '').toLowerCase();
  if (!Array.isArray(rule.match_all) || !rule.match_all.length) return false;
  return rule.match_all.every((token) => lower.includes(String(token || '').toLowerCase()));
}

function inferArbitrationDomain(query: string): string {
  const lower = String(query || '').toLowerCase();
  const map: Array<{ domain: string, terms: string[] }> = [
    { domain: 'security', terms: ['security', 'threat', 'tamper', 'vault', 'fail-closed', 'fail closed', 'covenant'] },
    { domain: 'safety', terms: ['safety', 'guardrail', 'rollback', 'risk', 'drift'] },
    { domain: 'measurement', terms: ['metric', 'measurement', 'benchmark', 'parity', 'evidence'] },
    { domain: 'rollout', terms: ['rollout', 'release', 'deploy', 'operations', 'on-call', 'schedule'] },
    { domain: 'product', terms: ['user', 'adoption', 'pmf', 'product', 'growth'] }
  ];
  for (const row of map) {
    if (row.terms.some((term) => lower.includes(term))) {
      return row.domain;
    }
  }
  return 'general';
}

function tokenSet(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
  );
}

function textDivergence(a: string, b: string): number {
  const as = tokenSet(a);
  const bs = tokenSet(b);
  if (!as.size && !bs.size) return 0;
  let intersection = 0;
  for (const token of as) {
    if (bs.has(token)) intersection += 1;
  }
  const union = new Set([...Array.from(as), ...Array.from(bs)]).size || 1;
  const similarity = intersection / union;
  return Number((1 - similarity).toFixed(4));
}

function pickArbitrationWinner(
  domain: string,
  participants: string[],
  rules: ArbitrationRules
): { winner: string | null, rule: string } {
  const participantSet = new Set((Array.isArray(participants) ? participants : []).map((v) => normalizeToken(v, 120)).filter(Boolean));
  const domainWinner = normalizeToken(rules.domain_winners && rules.domain_winners[domain] || '', 120);
  if (domainWinner && participantSet.has(domainWinner)) {
    return {
      winner: domainWinner,
      rule: `domain_winner:${domain}`
    };
  }
  for (const personaId of rules.tie_break_priority || []) {
    const normalized = normalizeToken(personaId, 120);
    if (participantSet.has(normalized)) {
      return {
        winner: normalized,
        rule: `tie_break_priority:${normalized}`
      };
    }
  }
  if (rules.conflicting_rules_fail_closed) {
    return {
      winner: null,
      rule: 'fail_closed:no_arbitration_winner'
    };
  }
  return {
    winner: participants.length ? normalizeToken(participants[0], 120) : null,
    rule: 'fallback:first_participant'
  };
}

type SoulTokenPolicy = {
  tokenId: string,
  owner: string,
  integrityMode: 'advisory' | 'enforce',
  bundleHash: string,
  usageRules: string[],
  dataPassRules: string[]
};

type PersonaLlmConfig = {
  enabled: boolean,
  model: string,
  importance: 'critical' | 'high' | 'medium' | 'low',
  autoBuildOnUpdate: boolean,
  buildTrigger: 'critical_only' | 'high_and_above' | 'all',
  temperature: number,
  maxTokens: number
};

type PersonaSecurityConfig = {
  enabled: boolean,
  mode: 'off' | 'obfuscate' | 'encrypt',
  keyEnvVar: string
};

type DataPermissionRow = {
  source: string,
  enabled: boolean,
  scope: string,
  notes: string,
  sources: string[]
};

function extractMdField(markdown: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'im');
  const m = String(markdown || '').match(re);
  return cleanText(m && m[1] ? m[1] : '', 320);
}

function computePersonaBundleHash(ctx: PersonaContext) {
  const blocks: Array<[string, string]> = [
    ['profile.md', ctx.profileMd],
    ['correspondence.md', ctx.correspondenceMd],
    ['decision_lens.md', ctx.decisionLensMd],
    ['strategic_lens.md', ctx.strategicLensMd],
    ['values_philosophy_lens.md', ctx.valuesLensMd],
    ['emotion_lens.md', ctx.emotionLensMd],
    ['data_streams.md', ctx.dataStreamsMd],
    ['data_permissions.md', ctx.dataPermissionsMd],
    ['llm_config.md', ctx.llmConfigMd],
    ['obfuscation_encryption.md', ctx.obfuscationEncryptionMd],
    ['feed.md', ctx.feedMd],
    ['memory.md', ctx.memoryMd]
  ];
  if (PERSONAS_RUST_ENABLED) {
    const rust = runPersonasPrimitive(
      'compute_persona_bundle_hash',
      { blocks },
      { allow_cli_fallback: false }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const hash = cleanText(rust.payload.payload.hash || '', 120).toLowerCase();
      if (/^[a-f0-9]{64}$/.test(hash)) {
        return hash;
      }
    }
  }
  const hasher = crypto.createHash('sha256');
  for (const [name, body] of blocks) {
    hasher.update(name, 'utf8');
    hasher.update('\n', 'utf8');
    hasher.update(String(body || ''), 'utf8');
    hasher.update('\n---\n', 'utf8');
  }
  return hasher.digest('hex');
}

function parseSoulTokenPolicy(markdown: string): SoulTokenPolicy {
  const tokenId = extractMdField(markdown, 'Token ID');
  const owner = extractMdField(markdown, 'Owner');
  const integrityModeRaw = normalizeToken(extractMdField(markdown, 'Integrity Mode'), 40);
  const integrityMode = integrityModeRaw === 'enforce' ? 'enforce' : 'advisory';
  const bundleHash = extractMdField(markdown, 'Bundle Hash').toLowerCase();
  const usageRules = extractListItems(String(markdown || '').split('## Usage Rules')[1] || '', 20)
    .map((v) => normalizeToken(v, 80))
    .filter(Boolean);
  const dataPassRules = extractListItems(String(markdown || '').split('## Data Pass Rules')[1] || '', 20)
    .map((v) => normalizeToken(v, 80))
    .filter(Boolean);
  return {
    tokenId,
    owner,
    integrityMode,
    bundleHash,
    usageRules,
    dataPassRules
  };
}

function readMdBool(markdown: string, label: string, fallback = false) {
  const raw = extractMdField(markdown, label).toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function readMdNumber(markdown: string, label: string, fallback: number, min: number, max: number) {
  const raw = extractMdField(markdown, label);
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parsePersonaLlmConfig(markdown: string): PersonaLlmConfig {
  const importanceToken = normalizeToken(extractMdField(markdown, 'Importance'), 40);
  const triggerToken = normalizeToken(extractMdField(markdown, 'Build Trigger'), 80);
  const modelRaw = cleanText(extractMdField(markdown, 'Model') || 'ollama/tinyllama:1.1b-chat-v1-q4_K_M', 160);
  const model = modelRaw.startsWith('ollama/') ? modelRaw : `ollama/${modelRaw}`;
  return {
    enabled: readMdBool(markdown, 'Enabled', false),
    model,
    importance: (['critical', 'high', 'medium', 'low'].includes(importanceToken) ? importanceToken : 'medium') as PersonaLlmConfig['importance'],
    autoBuildOnUpdate: readMdBool(markdown, 'Auto Build On Update', false),
    buildTrigger: (['critical_only', 'high_and_above', 'all'].includes(triggerToken) ? triggerToken : 'high_and_above') as PersonaLlmConfig['buildTrigger'],
    temperature: readMdNumber(markdown, 'Temperature', 0.2, 0, 1),
    maxTokens: Math.floor(readMdNumber(markdown, 'Max Tokens', 240, 40, 800))
  };
}

function parsePersonaSecurityConfig(markdown: string): PersonaSecurityConfig {
  const modeToken = normalizeToken(extractMdField(markdown, 'Mode'), 40);
  const mode = (['off', 'obfuscate', 'encrypt'].includes(modeToken) ? modeToken : 'off') as PersonaSecurityConfig['mode'];
  return {
    enabled: readMdBool(markdown, 'Enabled', false),
    mode,
    keyEnvVar: cleanText(extractMdField(markdown, 'Key Env Var') || 'PROTHEUS_PERSONA_ENCRYPTION_KEY', 120)
  };
}

function derivePersonaCipherKey(secret: string) {
  return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest();
}

function decodeProtectedContent(raw: string, cfg: PersonaSecurityConfig): string {
  const body = String(raw || '');
  if (!body) return body;
  if (body.startsWith('OBF1:')) {
    try {
      return Buffer.from(body.slice(5), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (body.startsWith('ENC1:')) {
    const parts = body.split(':');
    if (parts.length !== 4) return body;
    const ivHex = parts[1];
    const tagHex = parts[2];
    const dataHex = parts[3];
    const keyRaw = cleanText(process.env[cfg.keyEnvVar] || '', 500);
    if (!keyRaw) return body;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        derivePersonaCipherKey(keyRaw),
        Buffer.from(ivHex, 'hex')
      );
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final()
      ]);
      return plain.toString('utf8');
    } catch {
      return body;
    }
  }
  return body;
}

function encodeProtectedContent(raw: string, cfg: PersonaSecurityConfig): string {
  const body = String(raw || '');
  if (!cfg.enabled || cfg.mode === 'off') return body;
  if (cfg.mode === 'obfuscate') {
    return `OBF1:${Buffer.from(body, 'utf8').toString('base64')}`;
  }
  if (cfg.mode === 'encrypt') {
    const keyRaw = cleanText(process.env[cfg.keyEnvVar] || '', 500);
    if (!keyRaw) {
      throw new Error(`persona_encryption_key_missing:${cfg.keyEnvVar}`);
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      derivePersonaCipherKey(keyRaw),
      iv
    );
    const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `ENC1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }
  return body;
}

function parseDataPermissions(markdown: string): DataPermissionRow[] {
  const rows: DataPermissionRow[] = [];
  for (const line of String(markdown || '').split('\n')) {
    const trimmed = String(line || '').trim();
    const m = trimmed.match(/^-\s*([a-zA-Z0-9_.-]+)\s*:\s*enabled=(true|false)\s+scope=([a-zA-Z0-9_.#-]+)(?:\s+notes=(.+))?$/);
    if (m) {
      rows.push({
        source: normalizeToken(m[1], 80),
        enabled: String(m[2]).toLowerCase() === 'true',
        scope: cleanText(m[3], 120),
        notes: cleanText(m[4] || '', 200),
        sources: []
      });
      continue;
    }
    const obj = trimmed.match(/^-\s*([a-zA-Z0-9_.-]+)\s*:\s*\{\s*enabled:\s*(true|false)\s*,\s*sources:\s*\[([^\]]*)\]\s*\}\s*$/i);
    if (!obj) continue;
    const sources = String(obj[3] || '')
      .split(',')
      .map((part) => normalizeToken(part, 40))
      .filter(Boolean);
    rows.push({
      source: normalizeToken(obj[1], 80),
      enabled: String(obj[2]).toLowerCase() === 'true',
      scope: 'internal_system',
      notes: 'structured_permission',
      sources
    });
  }
  return rows;
}

function permissionEnabled(rows: DataPermissionRow[], source: string, fallback = false) {
  const token = normalizeToken(source, 80);
  const hit = rows.find((row) => row.source === token);
  if (!hit) return fallback;
  return hit.enabled === true;
}

function permissionSources(rows: DataPermissionRow[], source: string): string[] {
  const token = normalizeToken(source, 80);
  const hit = rows.find((row) => row.source === token);
  if (!hit || !Array.isArray(hit.sources)) return [];
  return hit.sources.slice(0, 8);
}

function systemPassedPayloadHash(source: string, tags: string[], snippet: string) {
  if (PERSONAS_RUST_ENABLED) {
    const rust = runPersonasPrimitive(
      'system_passed_payload_hash',
      {
        source,
        tags: Array.isArray(tags) ? tags : [],
        snippet
      },
      { allow_cli_fallback: false }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const hash = cleanText(rust.payload.payload.hash || '', 120).toLowerCase();
      if (/^[a-f0-9]{64}$/.test(hash)) {
        return hash;
      }
    }
  }
  return crypto
    .createHash('sha256')
    .update(`v1|${normalizeToken(source, 80)}|${(Array.isArray(tags) ? tags : []).join(',')}|${cleanText(snippet, 2000)}`, 'utf8')
    .digest('hex');
}

function parseSystemPassedSignals(feedMd: string, maxItems = 3) {
  const section = String(feedMd || '').split('## System Passed')[1] || '';
  const lines = section
    .split('\n')
    .map((line) => cleanText(line, 4000))
    .filter((line) => line.startsWith('- ['));
  const parsed = lines.map((line) => {
    const match = line.match(/^- \[([^\]]+)\]\s+(\{.+\})$/);
    if (!match) {
      return {
        ok: false,
        reason: 'line_parse_failed',
        line
      };
    }
    try {
      const payload = JSON.parse(match[2]);
      const source = normalizeToken(payload && payload.source || 'unknown', 80);
      const tags = Array.isArray(payload && payload.tags)
        ? payload.tags.map((v: unknown) => normalizeToken(v, 30)).filter(Boolean)
        : [];
      const snippet = cleanText(payload && payload.payload || '', 2000);
      const hash = cleanText(payload && payload.hash || '', 120);
      const expected = systemPassedPayloadHash(source, tags, snippet);
      return {
        ok: hash === expected && !!snippet,
        ts: cleanText(match[1], 80),
        source,
        tags,
        payload: snippet,
        hash,
        expected_hash: expected
      };
    } catch {
      return {
        ok: false,
        reason: 'json_parse_failed',
        line
      };
    }
  });
  const recent = parsed.slice(-Math.max(1, maxItems));
  return {
    total: parsed.length,
    verified: recent.filter((entry: any) => entry.ok).length,
    invalid: recent.filter((entry: any) => !entry.ok).length,
    signals: recent
      .filter((entry: any) => entry.ok)
      .map((entry: any) => `SystemPassed: source=${entry.source} tags=[${entry.tags.join(',')}] ${cleanText(entry.payload, 220)}`)
  };
}

function ensureSystemPassedSection(feedPlain: string) {
  const body = String(feedPlain || '').replace(/\s+$/, '');
  if (body.includes('\n## System Passed')) return body;
  return [
    body,
    '',
    '## System Passed',
    '',
    'Hash-verified system-internal payloads. Entries are appended as JSON records with deterministic payload hashes.',
    ''
  ].join('\n');
}

function appendFeedEntryToEntries(feedPlain: string, line: string) {
  const body = String(feedPlain || '').replace(/\s+$/, '');
  const marker = '\n## System Passed';
  const idx = body.indexOf(marker);
  if (idx < 0) {
    return `${body}\n${line}\n`;
  }
  const before = body.slice(0, idx).replace(/\s+$/, '');
  const after = body.slice(idx).replace(/^\s*/, '\n');
  return `${before}\n${line}${after}\n`;
}

function appendSystemPassedRecord(feedPlain: string, entry: Record<string, unknown>) {
  const body = ensureSystemPassedSection(feedPlain);
  const line = `- [${cleanText(entry.ts || nowIso(), 80)}] ${JSON.stringify(entry)}`;
  return `${body}\n${line}\n`;
}

function evaluateSystemPassedAccess(ctx: PersonaContext, includeFeed: boolean) {
  if (!includeFeed) {
    return {
      ok: true,
      include: false,
      reason: 'include_feed_disabled',
      signals: [] as string[],
      verified: 0,
      invalid: 0,
      total: 0
    };
  }
  const permissions = parseDataPermissions(ctx.dataPermissionsMd);
  if (!permissionEnabled(permissions, 'system_internal', false)) {
    return {
      ok: false,
      include: false,
      reason: 'data_permission_blocked:system_internal',
      signals: [] as string[],
      verified: 0,
      invalid: 0,
      total: 0
    };
  }
  const tokenPolicy = parseSoulTokenPolicy(ctx.soulTokenMd);
  const rules = new Set((tokenPolicy.dataPassRules || []).map((v) => normalizeToken(v, 80)));
  if (!rules.has('allow-system-internal-passed-data')) {
    return {
      ok: false,
      include: false,
      reason: 'soul_token_policy_blocked:system_pass_not_allowed',
      signals: [] as string[],
      verified: 0,
      invalid: 0,
      total: 0
    };
  }
  const parsed = parseSystemPassedSignals(ctx.feedMd, 3);
  if (rules.has('deny-unverified-system-payloads') && parsed.invalid > 0) {
    return {
      ok: false,
      include: false,
      reason: 'soul_token_policy_blocked:unverified_system_payload_detected',
      signals: [] as string[],
      verified: parsed.verified,
      invalid: parsed.invalid,
      total: parsed.total
    };
  }
  const include = rules.has('require-hash-verification') ? parsed.verified > 0 : parsed.total > 0;
  return {
    ok: true,
    include,
    reason: include ? 'system_passed_data_included' : 'no_verified_system_passed_data',
    signals: parsed.signals,
    verified: parsed.verified,
    invalid: parsed.invalid,
    total: parsed.total
  };
}

function shouldTriggerLlmBuild(cfg: PersonaLlmConfig) {
  if (!cfg.enabled || !cfg.autoBuildOnUpdate) return false;
  if (cfg.buildTrigger === 'all') return true;
  if (cfg.buildTrigger === 'high_and_above') {
    return cfg.importance === 'critical' || cfg.importance === 'high';
  }
  return cfg.importance === 'critical';
}

function buildLlmTrainPlan(personaId: string, cfg: PersonaLlmConfig) {
  const now = nowIso();
  return {
    type: 'persona_llm_train_plan',
    persona_id: personaId,
    ts: now,
    enabled: cfg.enabled,
    auto_build_on_update: cfg.autoBuildOnUpdate,
    trigger: cfg.buildTrigger,
    importance: cfg.importance,
    model: cfg.model,
    dataset_sources: [
      `personas/${personaId}/profile.md`,
      `personas/${personaId}/correspondence.md`,
      `personas/${personaId}/decision_lens.md`,
      `personas/${personaId}/strategic_lens.md`,
      `personas/${personaId}/values_philosophy_lens.md`,
      `personas/${personaId}/feed.md`,
      `personas/${personaId}/memory.md`
    ],
    status: shouldTriggerLlmBuild(cfg) ? 'queued' : 'inactive',
    reason: shouldTriggerLlmBuild(cfg) ? 'auto_build_trigger_matched' : 'llm_toggle_or_importance_gate'
  };
}

function querySeemsCommercial(query: string) {
  const lower = String(query || '').toLowerCase();
  const tokens = [
    'sell', 'sales', 'revenue', 'profit', 'monetize', 'monetise', 'ads',
    'advertis', 'commercial', 'pricing', 'go to market', 'go-to-market',
    'customer acquisition', 'lead generation', 'sponsorship', 'campaign'
  ];
  return tokens.some((token) => lower.includes(token));
}

function querySeemsImpersonation(query: string, personaName: string) {
  const lower = String(query || '').toLowerCase();
  const personaLower = String(personaName || '').toLowerCase();
  if (lower.includes('impersonat') || lower.includes('pretend to be')) return true;
  if (personaLower && lower.includes(`as ${personaLower}`) && (lower.includes('send') || lower.includes('message'))) {
    return true;
  }
  return false;
}

function querySeemsExternalPosting(query: string) {
  const lower = String(query || '').toLowerCase();
  const tokens = ['post', 'tweet', 'linkedin post', 'publish publicly', 'announce publicly', 'public statement', 'press release'];
  return tokens.some((token) => lower.includes(token));
}

function evaluateSoulTokenAccess(ctx: PersonaContext, query: string) {
  const policy = parseSoulTokenPolicy(ctx.soulTokenMd);
  if (!policy.tokenId || !policy.owner || !policy.bundleHash) {
    return {
      ok: false,
      reason: 'soul_token_invalid',
      policy
    };
  }
  if (policy.usageRules.includes('non-commercial-use-only') && querySeemsCommercial(query)) {
    return {
      ok: false,
      reason: 'soul_token_policy_blocked:non_commercial_use_only',
      policy
    };
  }
  if (policy.usageRules.includes('no-identity-impersonation') && querySeemsImpersonation(query, ctx.personaName)) {
    return {
      ok: false,
      reason: 'soul_token_policy_blocked:no_identity_impersonation',
      policy
    };
  }
  if (policy.usageRules.includes('consent-required-for-external-posting') && querySeemsExternalPosting(query)) {
    return {
      ok: false,
      reason: 'soul_token_policy_blocked:external_posting_requires_consent',
      policy
    };
  }
  const computedHash = computePersonaBundleHash(ctx);
  if (policy.integrityMode === 'enforce' && computedHash !== policy.bundleHash) {
    return {
      ok: false,
      reason: 'soul_token_policy_blocked:bundle_hash_mismatch',
      policy,
      computedHash
    };
  }
  return {
    ok: true,
    policy,
    computedHash
  };
}

function refreshSoulTokenBundleHash(ctx: PersonaContext) {
  const computedHash = computePersonaBundleHash(ctx);
  const updated = String(ctx.soulTokenMd || '').replace(
    /(\*\*Bundle Hash:\*\*\s*)([a-f0-9]{64}|[^\n]+)/i,
    `$1${computedHash}`
  );
  const abs = path.join(ROOT, ctx.soulTokenPath);
  fs.writeFileSync(abs, `${String(updated || '').replace(/\s+$/, '')}\n`, 'utf8');
  return computedHash;
}

function streamSources(dataStreamsMd: string): string[] {
  const sourceSection = String(dataStreamsMd || '').split('## Source Templates')[1] || '';
  const scoped = sourceSection ? sourceSection.split('\n## ')[0] : String(dataStreamsMd || '');
  const rows = extractListItems(scoped, 6);
  if (rows.length) return rows;
  return ['slack:unconfigured', 'linkedin:unconfigured'];
}

function personaSecurityForWrite(ctx: PersonaContext) {
  return parsePersonaSecurityConfig(ctx.obfuscationEncryptionMd);
}

function readPlainPersonaFile(absPath: string, cfg: PersonaSecurityConfig) {
  if (!fs.existsSync(absPath)) return '';
  const raw = String(fs.readFileSync(absPath, 'utf8') || '');
  return decodeProtectedContent(raw, cfg);
}

function writePersonaFile(absPath: string, plainBody: string, cfg: PersonaSecurityConfig) {
  const rendered = encodeProtectedContent(String(plainBody || ''), cfg);
  fs.writeFileSync(absPath, `${rendered.replace(/\s+$/, '')}\n`, 'utf8');
}

function appendPersonaTelemetry(row: Record<string, unknown>) {
  fs.mkdirSync(PERSONA_ORG_DIR, { recursive: true });
  const payload = {
    ts: nowIso(),
    kind: 'persona_lens',
    ...row
  };
  fs.appendFileSync(PERSONA_TELEMETRY_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

function shortQueryHash(query: string) {
  if (PERSONAS_RUST_ENABLED) {
    const rust = runPersonasPrimitive(
      'short_query_hash',
      { query },
      { allow_cli_fallback: false }
    );
    if (rust && rust.ok === true && rust.payload && rust.payload.ok === true && rust.payload.payload) {
      const value = cleanText(rust.payload.payload.value || '', 32).toLowerCase();
      if (/^[a-f0-9]{16}$/.test(value)) {
        return value;
      }
    }
  }
  return crypto.createHash('sha256').update(String(query || ''), 'utf8').digest('hex').slice(0, 16);
}

function appendContextBudgetCorrespondence(
  ctx: PersonaContext,
  query: string,
  budget: ContextBudgetState,
  invocation: string
) {
  const securityCfg = personaSecurityForWrite(ctx);
  const correspondenceAbs = path.join(ROOT, ctx.correspondencePath);
  const base = readPlainPersonaFile(correspondenceAbs, securityCfg).replace(/\s+$/, '');
  const day = nowIso().slice(0, 10);
  const entry = [
    '',
    `## ${day} - Re: context budget guard`,
    '',
    `Invocation: ${cleanText(invocation, 120) || 'lens'}`,
    `Query hash: ${shortQueryHash(query)}`,
    `Budget mode: ${budget.mode}`,
    `Max tokens: ${budget.max_tokens}`,
    `Estimated before: ${budget.estimated_tokens_before}`,
    `Estimated after: ${budget.estimated_tokens_after}`,
    `Action: ${budget.rejected ? 'rejected' : budget.trimmed ? 'trimmed' : 'allow'}`,
    `Dropped dynamic items: ${budget.dropped_dynamic_items}`,
    ''
  ].join('\n');
  writePersonaFile(correspondenceAbs, `${base}\n${entry}`, securityCfg);
}

function recordContextBudgetEvent(
  ctx: PersonaContext | null,
  query: string,
  budget: ContextBudgetState,
  invocation: string
) {
  if (!ctx || !budget.over_budget_before) return;
  const key = [
    ctx.personaId,
    shortQueryHash(query),
    invocation,
    budget.max_tokens,
    budget.mode,
    budget.rejected ? 'rejected' : 'trimmed'
  ].join('|');
  if (CONTEXT_BUDGET_DEDUP.has(key)) return;
  CONTEXT_BUDGET_DEDUP.add(key);
  appendPersonaTelemetry({
    metric: 'context_budget_guard',
    persona_id: ctx.personaId,
    invocation: cleanText(invocation, 120) || 'lens',
    query_hash: shortQueryHash(query),
    budget_mode: budget.mode,
    budget_source: budget.source,
    max_context_tokens: budget.max_tokens,
    estimated_tokens_before: budget.estimated_tokens_before,
    estimated_tokens_after: budget.estimated_tokens_after,
    bootstrap_tokens: budget.bootstrap_tokens,
    dynamic_tokens_before: budget.dynamic_tokens_before,
    dynamic_tokens_after: budget.dynamic_tokens_after,
    dynamic_items_before: budget.dynamic_items_before,
    dynamic_items_after: budget.dynamic_items_after,
    dropped_dynamic_items: budget.dropped_dynamic_items,
    trimmed: budget.trimmed ? 1 : 0,
    rejected: budget.rejected ? 1 : 0
  });
  try {
    appendContextBudgetCorrespondence(ctx, query, budget, invocation);
  } catch {
    // Correspondence logging is best-effort; telemetry remains authoritative.
  }
}

function readJsonlTail(filePath: string, maxRows = 20) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(400, Math.floor(maxRows) || 20)))
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

function summarizeCorrespondenceEvents(markdown: string, maxRows = 3) {
  const out: Array<{ date: string, topic: string }> = [];
  for (const line of String(markdown || '').split('\n')) {
    const m = String(line || '').trim().match(/^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+Re:\s+(.+)$/i);
    if (!m) continue;
    out.push({
      date: cleanText(m[1], 20),
      topic: cleanText(m[2], 120)
    });
  }
  return out.slice(-Math.max(1, maxRows));
}

type CorrespondenceEntry = {
  date: string,
  topic: string,
  body: string
};

function parseCorrespondenceEntries(markdown: string, maxRows = 5): CorrespondenceEntry[] {
  const lines = String(markdown || '').split('\n');
  const entries: CorrespondenceEntry[] = [];
  let current: CorrespondenceEntry | null = null;
  const flush = () => {
    if (!current) return;
    current.body = cleanText(current.body || '', 1500);
    entries.push(current);
    current = null;
  };
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    const m = trimmed.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+Re:\s+(.+)$/i);
    if (m) {
      flush();
      current = {
        date: cleanText(m[1], 20),
        topic: cleanText(m[2], 120),
        body: ''
      };
      continue;
    }
    if (current) {
      if (trimmed.startsWith('## ')) {
        flush();
        continue;
      }
      current.body = `${current.body}\n${trimmed}`.trim();
    }
  }
  flush();
  return entries.slice(-Math.max(1, maxRows));
}

function buildPersonaDashboard(window = 20) {
  const rows = readJsonlTail(PERSONA_TELEMETRY_PATH, window);
  const metricCounts: Record<string, number> = {};
  const personaCounts: Record<string, number> = {};
  for (const row of rows as Array<Record<string, unknown>>) {
    const metric = normalizeToken(row.metric || row.kind || 'unknown', 80) || 'unknown';
    metricCounts[metric] = (metricCounts[metric] || 0) + 1;
    const persona = normalizeToken(row.persona_id || 'unknown', 80) || 'unknown';
    personaCounts[persona] = (personaCounts[persona] || 0) + 1;
  }
  const candidatePersonas = [
    'jay_haslam',
    'vikram_menon',
    'priya_venkatesh',
    'rohan_kapoor',
    'li_wei',
    'aarav_singh'
  ];
  const available = new Set(listPersonaIds());
  const personas = candidatePersonas.filter((id) => available.has(id));
  const summaries: Array<Record<string, unknown>> = [];
  for (const personaId of personas) {
    try {
      const ctx = loadPersonaContext(personaId);
      const events = summarizeCorrespondenceEvents(ctx.correspondenceMd, 3);
      const passed = parseSystemPassedSignals(ctx.feedMd, 3);
      summaries.push({
        persona_id: personaId,
        persona_name: ctx.personaName,
        latest_events: events,
        system_passed_verified: passed.verified,
        system_passed_invalid: passed.invalid,
        system_passed_total: passed.total
      });
    } catch {
      summaries.push({
        persona_id: personaId,
        error: 'persona_context_unavailable'
      });
    }
  }
  const metricTop = Object.entries(metricCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);
  const personaTop = Object.entries(personaCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);

  const markdown: string[] = [];
  markdown.push('# Personas Dashboard');
  markdown.push('');
  markdown.push(`- Window: last ${Math.max(1, Math.min(400, Math.floor(window) || 20))} telemetry events`);
  markdown.push(`- Trigger policy doc: \`${path.relative(ROOT, PERSONA_TRIGGERS_PATH).replace(/\\/g, '/')}\``);
  markdown.push('');
  markdown.push('## Telemetry Top Metrics');
  if (!metricTop.length) {
    markdown.push('- No telemetry rows yet.');
  } else {
    for (const [metric, count] of metricTop) {
      markdown.push(`- ${metric}: ${count}`);
    }
  }
  markdown.push('');
  markdown.push('## Telemetry Top Personas');
  if (!personaTop.length) {
    markdown.push('- No persona rows yet.');
  } else {
    for (const [persona, count] of personaTop) {
      markdown.push(`- ${persona}: ${count}`);
    }
  }
  markdown.push('');
  markdown.push('## Core Persona Activity');
  if (!summaries.length) {
    markdown.push('- No core personas available.');
  } else {
    for (const row of summaries) {
      markdown.push(`### ${cleanText(row.persona_name || row.persona_id || 'unknown', 120)} (\`${cleanText(row.persona_id || 'unknown', 120)}\`)`);
      if (row.error) {
        markdown.push(`- status: ${cleanText(row.error, 120)}`);
        markdown.push('');
        continue;
      }
      markdown.push(`- System-passed verified/invalid/total: ${Number(row.system_passed_verified || 0)}/${Number(row.system_passed_invalid || 0)}/${Number(row.system_passed_total || 0)}`);
      const events = Array.isArray(row.latest_events) ? row.latest_events : [];
      if (!events.length) {
        markdown.push('- Latest correspondence: none');
      } else {
        for (const event of events) {
          const ev = event && typeof event === 'object' ? event : {};
          markdown.push(`- ${cleanText((ev as Record<string, unknown>).date || '', 20)}: ${cleanText((ev as Record<string, unknown>).topic || '', 140)}`);
        }
      }
      markdown.push('');
    }
  }
  return {
    ok: true,
    type: 'persona_dashboard',
    window: Math.max(1, Math.min(400, Math.floor(window) || 20)),
    telemetry_rows: rows.length,
    metrics: metricCounts,
    personas: personaCounts,
    summaries,
    markdown: markdown.join('\n')
  };
}

function runPersonaCheckin(
  checkinPersonaId: string,
  heartbeatInput: unknown,
  emotionEnabled: boolean,
  valuesEnabled: boolean,
  contextBudgetPolicy: ContextBudgetPolicy,
  dryRun = false
) {
  const ctx = loadPersonaContext(checkinPersonaId);
  const heartbeatPathAbs = resolveHeartbeatPath(heartbeatInput);
  const heartbeatSnapshot = readFileOptional(heartbeatPathAbs);
  const query = buildCheckinQuery(heartbeatSnapshot);
  const gate = evaluateSoulTokenAccess(ctx, query);
  if (!gate.ok) {
    throw new Error(String(gate.reason || 'soul_token_policy_blocked'));
  }
  const details = buildResponseDetails(
    ctx.personaId,
    ctx.personaName,
    query,
    ctx.profileMd,
    ctx.correspondenceMd,
    ctx.decisionLensMd,
    ctx.strategicLensMd,
    'decision',
    emotionEnabled ? ctx.emotionLensMd : '',
    valuesEnabled ? ctx.valuesLensMd : '',
    ctx.feedMd,
    ctx.memoryMd,
    false,
    false,
    '',
    contextBudgetPolicy,
    ctx,
    'checkin'
  );
  const payload: any = {
    ok: true,
    type: 'persona_checkin',
    persona_id: ctx.personaId,
    heartbeat_path: path.relative(ROOT, heartbeatPathAbs).replace(/\\/g, '/') || 'HEARTBEAT.md',
    emotion: emotionEnabled ? 'on' : 'off',
    dry_run: dryRun,
    recommendation: details.recommendation,
    reasoning: details.reasoning.slice(0, 5)
  };
  const llmCfg = parsePersonaLlmConfig(ctx.llmConfigMd);
  payload.llm_train_plan = buildLlmTrainPlan(ctx.personaId, llmCfg);
  if (!dryRun) {
    const receipt = appendCheckinToCorrespondence(
      ctx,
      heartbeatPathAbs,
      heartbeatSnapshot,
      details.recommendation,
      details.reasoning,
      emotionEnabled
    );
    payload.updated_correspondence = receipt.correspondencePath;
    payload.updated_soul_token = receipt.soulTokenPath;
    payload.bundle_hash = receipt.bundleHash;
    payload.memory_node = receipt.memoryNode;
  }
  return payload;
}

function appendPersonaNodeMemory(ctx: PersonaContext, title: string, body: string, tags: string[]) {
  if (!ctx.memoryPath) return null;
  const cfg = personaSecurityForWrite(ctx);
  const abs = path.join(ROOT, ctx.memoryPath);
  const current = readPlainPersonaFile(abs, cfg).replace(/\s+$/, '');
  const day = new Date().toISOString().slice(0, 10);
  const nodeId = normalizeToken(`${ctx.personaId}-${title}-${Date.now()}`, 120);
  const safeTags = Array.from(new Set((Array.isArray(tags) ? tags : [])
    .map((tag) => normalizeToken(tag, 40))
    .filter(Boolean)))
    .slice(0, 8);
  const node = [
    '',
    `### node:${nodeId}`,
    `- date: ${day}`,
    `- tags: [${safeTags.join(', ')}]`,
    `- title: ${cleanText(title, 120)}`,
    '',
    cleanText(body, 1800),
    ''
  ].join('\n');
  writePersonaFile(abs, `${current}\n${node}`, cfg);
  return {
    memoryPath: ctx.memoryPath,
    nodeId,
    tags: safeTags
  };
}

function extractRecentFeedSignals(feedMd: string, maxItems = 3): string[] {
  const lines = String(feedMd || '')
    .split('\n')
    .map((line) => cleanText(line, 240))
    .filter((line) => line.startsWith('- ['))
    .slice(-Math.max(1, maxItems));
  return lines.map((line) => line.replace(/^- \[[^\]]+\]\s*/, 'Feed: '));
}

function extractMemoryRecallSignals(memoryMd: string, query: string, maxItems = 3): string[] {
  const qTokens = Array.from(new Set(
    String(query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
  ));
  const rows = String(memoryMd || '')
    .split('\n')
    .map((row) => cleanText(row, 220))
    .filter(Boolean);
  const scored = rows
    .map((row) => {
      const lower = row.toLowerCase();
      const score = qTokens.reduce((acc, token) => acc + (lower.includes(token) ? 1 : 0), 0);
      return { row, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map((entry) => `Memory recall: ${entry.row}`);
  return scored;
}

function updateStreamForPersona(personaId: string, dryRun = false) {
  const ctx = loadPersonaContext(personaId);
  const permissions = parseDataPermissions(ctx.dataPermissionsMd);
  if (!permissionEnabled(permissions, 'feed', true)) {
    return {
      ok: false,
      type: 'persona_stream_update',
      persona_id: personaId,
      dry_run: dryRun,
      reason: 'data_permission_blocked:feed'
    };
  }
  const enabledExternal = permissions
    .filter((row) => row.enabled === true && row.source !== 'feed')
    .map((row) => `${row.source}:${row.scope}`);
  const sources = enabledExternal.length
    ? enabledExternal
    : ['feed:internal_master_feed', ...streamSources(ctx.dataStreamsMd)];
  const ts = new Date().toISOString().slice(0, 10);
  const streamReceiptId = normalizeToken(`stream-${personaId}-${Date.now()}`, 80);
  const entry = [
    '',
    `## ${ts} - Re: stream update`,
    '',
    `Stream sync simulated from configured sources: ${sources.join(' | ')}.`,
    '',
    `Digest: ${streamReceiptId}. Observed style deltas reviewed for decision, strategic, and emotion lenses.`,
    ''
  ].join('\n');

  if (!dryRun) {
    const abs = path.join(ROOT, ctx.correspondencePath);
    const securityCfg = personaSecurityForWrite(ctx);
    const base = readPlainPersonaFile(abs, securityCfg).replace(/\s+$/, '');
    writePersonaFile(abs, `${base}\n${entry}`, securityCfg);
    const memory = appendPersonaNodeMemory(
      ctx,
      'stream update',
      `Stream sync simulated from sources: ${sources.join(', ')}`,
      ['stream', 'sync', 'feed']
    );
    const refreshed = loadPersonaContext(personaId);
    const llmCfg = parsePersonaLlmConfig(refreshed.llmConfigMd);
    const llmPlan = buildLlmTrainPlan(personaId, llmCfg);
    const newHash = refreshSoulTokenBundleHash(refreshed);
    return {
      ok: true,
      type: 'persona_stream_update',
      persona_id: personaId,
      dry_run: false,
      updated_correspondence: refreshed.correspondencePath,
      updated_soul_token: refreshed.soulTokenPath,
      stream_sources: sources,
      bundle_hash: newHash,
      memory_node: memory,
      llm_train_plan: llmPlan
    };
  }

  return {
    ok: true,
    type: 'persona_stream_update',
    persona_id: personaId,
    dry_run: true,
    stream_sources: sources,
    preview_entry: cleanText(entry, 600)
  };
}

function appendPersonaFeed(
  personaId: string,
  snippet: string,
  opts: {
    source?: string,
    tags?: string[],
    dryRun?: boolean
  } = {}
) {
  const ctx = loadPersonaContext(personaId);
  if (!ctx.feedPath) {
    return {
      ok: false,
      type: 'persona_feed_append',
      persona_id: personaId,
      reason: 'persona_feed_file_missing'
    };
  }
  const permissions = parseDataPermissions(ctx.dataPermissionsMd);
  if (!permissionEnabled(permissions, 'feed', true)) {
    return {
      ok: false,
      type: 'persona_feed_append',
      persona_id: personaId,
      reason: 'data_permission_blocked:feed'
    };
  }
  const source = normalizeToken(opts.source || 'master_llm', 80) || 'master_llm';
  const tags = Array.from(new Set((Array.isArray(opts.tags) ? opts.tags : [])
    .map((tag) => normalizeToken(tag, 30))
    .filter(Boolean)))
    .slice(0, 8);
  const internalSources = permissionSources(permissions, 'system_internal');
  const systemInternalAllowed = permissionEnabled(permissions, 'system_internal', false);
  const systemInternalMatch = source.startsWith('master') || source.startsWith('system') || source === 'operator' || source === 'loop' || source === 'analytics';
  const cleanSnippet = cleanText(snippet, 2000);
  if (!cleanSnippet) {
    return {
      ok: false,
      type: 'persona_feed_append',
      persona_id: personaId,
      reason: 'feed_snippet_missing'
    };
  }
  const stamp = nowIso();
  const line = `- [${stamp}] source=${source} tags=[${tags.join(',')}] ${cleanSnippet}`;
  if (opts.dryRun) {
    return {
      ok: true,
      type: 'persona_feed_append',
      persona_id: personaId,
      dry_run: true,
      preview_line: line
    };
  }
  const securityCfg = personaSecurityForWrite(ctx);
  const feedAbs = path.join(ROOT, ctx.feedPath);
  const tokenPolicy = parseSoulTokenPolicy(ctx.soulTokenMd);
  const tokenRules = new Set((tokenPolicy.dataPassRules || []).map((v) => normalizeToken(v, 80)));
  const canAppendSystemPassed = systemInternalAllowed
    && systemInternalMatch
    && tokenRules.has('allow-system-internal-passed-data')
    && (internalSources.length === 0 || internalSources.some((v) => ['memory', 'loops', 'analytics'].includes(v)));
  const feedBase = readPlainPersonaFile(feedAbs, securityCfg).replace(/\s+$/, '');
  let nextFeed = appendFeedEntryToEntries(feedBase, line).replace(/\s+$/, '');
  let systemPassedRecord: Record<string, unknown> | null = null;
  if (canAppendSystemPassed) {
    const ts = nowIso();
    const hash = systemPassedPayloadHash(source, tags, cleanSnippet);
    systemPassedRecord = {
      schema: 'v1',
      source,
      tags,
      payload: cleanSnippet,
      hash,
      ts
    };
    nextFeed = appendSystemPassedRecord(nextFeed, systemPassedRecord);
  }
  writePersonaFile(feedAbs, nextFeed, securityCfg);
  const memoryNode = appendPersonaNodeMemory(
    ctx,
    'feed update',
    cleanSnippet,
    ['feed', source, ...tags]
  );

  const refreshed = loadPersonaContext(personaId);
  const llmCfg = parsePersonaLlmConfig(refreshed.llmConfigMd);
  const llmPlan = buildLlmTrainPlan(personaId, llmCfg);
  const bundleHash = refreshSoulTokenBundleHash(refreshed);
  return {
    ok: true,
    type: 'persona_feed_append',
    persona_id: personaId,
    dry_run: false,
    source,
    tags,
    updated_feed: refreshed.feedPath,
    system_passed_record: systemPassedRecord,
    memory_node: memoryNode,
    llm_train_plan: llmPlan,
    updated_soul_token: refreshed.soulTokenPath,
    bundle_hash: bundleHash
  };
}

function renderStreamPreview(
  personaName: string,
  query: string,
  reasoning: string[],
  controls: LensControls
) {
  const lines: string[] = [];
  lines.push('## Cognizance-Gap');
  lines.push(`- Persona: ${personaName}`);
  lines.push(`- Alignment Indicator: ${alignmentBadge(controls.alignmentMode)}`);
  lines.push(`- Delay: ${controls.gapSeconds}s`);
  lines.push(`- Query: ${query}`);
  lines.push('- Stream:');
  const stream = reasoning.length
    ? reasoning.slice(0, 4)
    : ['No parsed reasoning signals; fallback to deterministic + fail-closed defaults.'];
  for (const row of stream) {
    lines.push(`  - ${row}`);
  }
  if (controls.interceptText) {
    lines.push(`- Intercept override received: ${controls.interceptText}`);
  } else {
    lines.push('- Intercept: pass --intercept="<override text>" to replace final position.');
  }
  return lines.join('\n');
}

async function runCognizanceGap(
  personaName: string,
  query: string,
  reasoning: string[],
  recommendation: string,
  controls: LensControls,
  allowEdit: boolean
): Promise<GapSessionResult> {
  const preloadedOverride = cleanText(controls.interceptText, 1600);
  const result: GapSessionResult = {
    alignmentMode: controls.alignmentMode,
    finalOverride: preloadedOverride,
    approvedEarly: false,
    intercepted: Boolean(preloadedOverride)
  };
  if (result.intercepted) {
    result.alignmentMode = 'green_active';
  }

  if (controls.gapSeconds <= 0) {
    return result;
  }

  const steps = buildStreamSteps(reasoning, recommendation);
  const gapMs = controls.gapSeconds * 1000;
  const started = Date.now();
  let done = false;
  let waitingForEdit = false;

  process.stdout.write(
    `${alignmentBadge(result.alignmentMode)} Starting cognizance-gap (${controls.gapSeconds}s) for ${personaName}. `
    + `Enter 'e' then Enter to edit, 'a' then Enter to approve early.\n`
  );
  process.stdout.write(`Query: ${query}\n`);
  if (preloadedOverride) {
    process.stdout.write(`Preloaded intercept override: ${preloadedOverride}\n`);
  }

  const applyControlLine = (line: string) => {
    const raw = cleanText(line, 2000);
    if (!raw && waitingForEdit) {
      process.stdout.write('Intercept edit is empty. Enter override text and press Enter.\n');
      return;
    }
    if (waitingForEdit) {
      result.finalOverride = cleanText(raw, 1600);
      result.intercepted = true;
      result.alignmentMode = 'green_active';
      waitingForEdit = false;
      done = true;
      process.stdout.write(`Intercept captured. Alignment indicator -> ${alignmentBadge(result.alignmentMode)}\n`);
      return;
    }

    const token = normalizeToken(raw, 40);
    if (!token) return;
    if (token === 'a' || token === 'approve' || token === 'approve_early') {
      result.approvedEarly = true;
      done = true;
      process.stdout.write('Cognizance-gap approved early by operator.\n');
      return;
    }
    if (allowEdit && (token === 'e' || token === 'edit')) {
      waitingForEdit = true;
      process.stdout.write('Intercept mode active. Enter replacement position text and press Enter.\n');
      process.stdout.write(`Current draft: ${cleanText(recommendation, 280)}\n`);
      return;
    }
    process.stdout.write("Unknown control. Use 'e' (edit) or 'a' (approve early).\n");
  };

  const stdinIsTty = Boolean(process.stdin && process.stdin.isTTY);
  let rl: any = null;
  if (stdinIsTty) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });
    rl.on('line', (line: string) => applyControlLine(line));
  }

  let pipedLines: string[] = [];
  let pipedIndex = 0;
  if (!stdinIsTty) {
    try {
      const piped = String(fs.readFileSync(0, 'utf8') || '');
      pipedLines = piped.split(/\r?\n/);
    } catch {
      pipedLines = [];
    }
  }

  const pollPipedLines = () => {
    if (stdinIsTty) return;
    while (pipedIndex < pipedLines.length && !done) {
      const next = String(pipedLines[pipedIndex] || '');
      pipedIndex += 1;
      applyControlLine(next);
      if (done) break;
    }
  };

  try {
    const stepDelay = Math.max(600, Math.floor(gapMs / Math.max(steps.length, 1)));
    for (let i = 0; i < steps.length; i += 1) {
      if (done) break;
      const elapsed = Date.now() - started;
      const remainingSec = Math.max(0, Math.ceil((gapMs - elapsed) / 1000));
      process.stdout.write(`Stream step ${i + 1}/${steps.length} (${remainingSec}s left): ${steps[i]}\n`);
      pollPipedLines();
      await waitInterruptible(stepDelay, () => done);
    }

    while (!done && (Date.now() - started) < gapMs) {
      pollPipedLines();
      await waitInterruptible(120, () => done);
    }
  } finally {
    if (rl) {
      rl.removeAllListeners('line');
      rl.close();
    }
  }

  if (!done) {
    process.stdout.write('Cognizance-gap expired without intercept.\n');
  }
  return result;
}

function appendInterceptionToCorrespondence(
  ctx: PersonaContext,
  query: string,
  overrideText: string,
  controls: LensControls
) {
  const now = new Date();
  const stamp = now.toISOString();
  const date = stamp.slice(0, 10);
  const entry = [
    '',
    `## ${date} - Re: persona intercept`,
    '',
    `Intercept receipt (${controls.alignmentMode}).`,
    '',
    `Query: ${cleanText(query, 1000)}`,
    '',
    `Override: ${cleanText(overrideText, 1600)}`,
    '',
    `Source: protheus lens --intercept`,
    `Timestamp: ${stamp}`,
    ''
  ].join('\n');

  const securityCfg = personaSecurityForWrite(ctx);
  const correspondenceAbs = path.join(ROOT, ctx.correspondencePath);
  const base = readPlainPersonaFile(correspondenceAbs, securityCfg).replace(/\s+$/, '');
  writePersonaFile(correspondenceAbs, `${base}\n${entry}`, securityCfg);
  const memoryNode = appendPersonaNodeMemory(
    ctx,
    'intercept override',
    `Query: ${cleanText(query, 320)} | Override: ${cleanText(overrideText, 500)}`,
    ['intercept', 'alignment', 'override']
  );

  const refreshed = loadPersonaContext(ctx.personaId);
  const newHash = refreshSoulTokenBundleHash(refreshed);
  return {
    correspondencePath: refreshed.correspondencePath,
    soulTokenPath: refreshed.soulTokenPath,
    bundleHash: newHash,
    memoryNode
  };
}

function resolveHeartbeatPath(rawPath: unknown) {
  const token = cleanText(rawPath, 420);
  if (!token) return path.join(ROOT, 'HEARTBEAT.md');
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function buildCheckinQuery(heartbeatSnapshot: string) {
  const clipped = cleanText(heartbeatSnapshot, 900) || 'No heartbeat notes available.';
  return `Daily alignment check-in: review current heartbeat context and identify drift risks, priority actions, and one safety invariant to preserve. Heartbeat snapshot: ${clipped}`;
}

function appendCheckinToCorrespondence(
  ctx: PersonaContext,
  heartbeatPathAbs: string,
  heartbeatSnapshot: string,
  recommendation: string,
  reasoning: string[],
  emotionEnabled: boolean
) {
  const stamp = nowIso();
  const day = stamp.slice(0, 10);
  const relHeartbeat = path.relative(ROOT, heartbeatPathAbs).replace(/\\/g, '/');
  const signals = (Array.isArray(reasoning) ? reasoning : [])
    .map((row) => cleanText(row, 220))
    .filter(Boolean)
    .slice(0, 4);
  const entry = [
    '',
    `## ${day} - Re: daily checkin`,
    '',
    `Checkin source: ${relHeartbeat || 'HEARTBEAT.md'}`,
    `Emotion lens: ${emotionEnabled ? 'on' : 'off'}`,
    '',
    `Heartbeat snapshot: ${cleanText(heartbeatSnapshot || 'none', 700)}`,
    '',
    `Assessment: ${cleanText(recommendation || '', 700)}`,
    '',
    'Signals:',
    ...signals.map((row) => `- ${row}`),
    '',
    `Timestamp: ${stamp}`,
    ''
  ].join('\n');

  const securityCfg = personaSecurityForWrite(ctx);
  const correspondenceAbs = path.join(ROOT, ctx.correspondencePath);
  const base = readPlainPersonaFile(correspondenceAbs, securityCfg).replace(/\s+$/, '');
  writePersonaFile(correspondenceAbs, `${base}\n${entry}`, securityCfg);
  const memoryNode = appendPersonaNodeMemory(
    ctx,
    'daily checkin',
    `Heartbeat: ${cleanText(heartbeatSnapshot, 360)} | Assessment: ${cleanText(recommendation, 360)}`,
    ['checkin', 'drift', 'alignment']
  );

  const refreshed = loadPersonaContext(ctx.personaId);
  const newHash = refreshSoulTokenBundleHash(refreshed);
  return {
    correspondencePath: refreshed.correspondencePath,
    soulTokenPath: refreshed.soulTokenPath,
    bundleHash: newHash,
    heartbeatPath: relHeartbeat || 'HEARTBEAT.md',
    memoryNode
  };
}

function extractTitle(markdown: string, fallback: string): string {
  const lines = String(markdown || '').split('\n');
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('#')) continue;
    const title = cleanText(trimmed.replace(/^#+\s*/, ''), 120);
    if (title) return title;
  }
  return fallback;
}

function extractListItems(markdown: string, maxItems = 4): string[] {
  const out: string[] = [];
  const lines = String(markdown || '').split('\n');
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    const picked = bullet ? bullet[1] : ordered ? ordered[1] : '';
    const item = cleanText(picked, 200);
    if (!item) continue;
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function recommendFromQuery(personaRef: string, query: string): string {
  const stanceCache = loadStanceCache();
  const personaToken = normalizeToken(personaRef, 120);
  for (const rule of stanceCache.rules || []) {
    if (!stanceMatch(query, rule)) continue;
    if (rule.personas && rule.personas[personaToken]) {
      return cleanText(rule.personas[personaToken], 1200);
    }
    if (rule.default_recommendation) {
      return cleanText(rule.default_recommendation, 1200);
    }
  }
  const lower = String(query || '').toLowerCase();
  if (lower.includes('memory') && lower.includes('security') && (lower.includes('first') || lower.includes('priorit'))) {
    const persona = normalizeToken(personaRef, 80);
    if (persona.includes('rohan')) {
      return 'Prioritize security gate readiness first at rollout boundaries, then sequence memory migration in constrained, parity-verified slices.';
    }
    if (persona.includes('aarav')) {
      return 'Prioritize security invariants first: enforce fail-closed checks globally, then continue memory migration behind audited gates.';
    }
    if (persona.includes('priya')) {
      return 'Do not hard-order memory vs security until parity and drift evidence is current; run a measurement checkpoint before sequencing.';
    }
    return 'Prioritize memory core determinism first, but keep security enforcement in pre-dispatch path from day one.';
  }
  if (lower.includes('rust') && (lower.includes('migrate') || lower.includes('migration') || lower.includes('cutover'))) {
    return 'Run behavior-preserving migration in thin slices with parity tests; treat source-level Rust composition as the only valid progress metric.';
  }
  if (lower.includes('rollback') || lower.includes('revert')) {
    return 'Define rollback invariants before implementation and prove rollback with an explicit test path.';
  }
  return `Use ${personaRef}'s lens to execute the smallest reversible change that strengthens determinism, security posture, and test evidence.`;
}

function resolvePersonaLlmRecommendation(
  ctx: PersonaContext,
  query: string,
  promptTemplate: string,
  fallbackRecommendation: string
) {
  const cfg = parsePersonaLlmConfig(ctx.llmConfigMd);
  if (!cfg.enabled) {
    return {
      enabled: false,
      used: false,
      reason: 'persona_llm_disabled',
      model: cfg.model,
      recommendation: fallbackRecommendation
    };
  }
  if (typeof runLocalOllamaPrompt !== 'function') {
    return {
      enabled: true,
      used: false,
      reason: 'llm_gateway_unavailable',
      model: cfg.model,
      recommendation: fallbackRecommendation
    };
  }
  const modelName = cfg.model.startsWith('ollama/') ? cfg.model : `ollama/${cfg.model}`;
  const prompt = [
    `Persona: ${ctx.personaName} (${ctx.personaId})`,
    `Instruction: Provide one concise position (max 2 sentences) grounded in persona profile, decision lens, strategic lens, values lens, and recent feed/memory signals.`,
    `Prompt template: ${promptTemplate}`,
    `Query: ${query}`
  ].join('\n');
  const result = runLocalOllamaPrompt({
    model: modelName,
    prompt,
    temperature: cfg.temperature,
    timeout_ms: 10000
  }) || {};
  const ok = result.ok === true;
  const output = cleanText(result.output || result.stdout || '', cfg.maxTokens * 4);
  if (!ok || !output) {
    return {
      enabled: true,
      used: false,
      reason: cleanText(result.error || result.stderr || 'persona_llm_failed', 160),
      model: modelName,
      recommendation: fallbackRecommendation
    };
  }
  return {
    enabled: true,
    used: true,
    reason: 'persona_llm_applied',
    model: modelName,
    recommendation: cleanText(output, cfg.maxTokens * 4)
  };
}

function buildResponseDetails(
  personaId: string,
  personaName: string,
  query: string,
  profileMd: string,
  correspondenceMd: string,
  decisionLensMd: string,
  strategicLensMd: string,
  lensMode: LensMode,
  emotionLensMd = '',
  valuesLensMd = '',
  feedMd = '',
  memoryMd = '',
  includeSystemPassedFeed = false,
  surpriseEnabled = false,
  surpriseSeed = '',
  contextBudgetPolicy: ContextBudgetPolicy = defaultContextBudgetPolicy(),
  contextCtx: PersonaContext | null = null,
  invocation = 'lens'
) {
  const personaRef = cleanText(personaId || personaName, 120) || personaName;
  const decisionFilters = extractListItems(decisionLensMd, 4);
  const strategicFilters = extractListItems(strategicLensMd, 4);
  const valuesFilters = extractListItems(valuesLensMd, 4);
  const nonNegotiables = extractListItems(decisionLensMd.split('## Non-Negotiables')[1] || '', 4);
  const strategicAnchors = extractListItems(strategicLensMd.split('## Strategic Anchors')[1] || '', 3);
  const valuesAnchors = extractListItems(valuesLensMd.split('## Values Anchors')[1] || '', 3);
  const correspondenceHighlights = extractListItems(correspondenceMd, 3);
  const recentCorrespondence = parseCorrespondenceEntries(correspondenceMd, 5);
  const correspondenceContinuity = recentCorrespondence.map((entry) => {
    const bodySnippet = cleanText(entry.body, 180);
    return `Correspondence ${entry.date} (${entry.topic}): ${bodySnippet || 'no body recorded'}`;
  });
  const profileHighlights = extractListItems(profileMd, 3);
  const emotionSignals = extractListItems(emotionLensMd, 2);
  const feedSignals = extractRecentFeedSignals(feedMd, 3);
  const systemPassed = includeSystemPassedFeed
    ? parseSystemPassedSignals(feedMd, 3)
    : { total: 0, verified: 0, invalid: 0, signals: [] as string[] };
  const memorySignals = extractMemoryRecallSignals(memoryMd, query, 3); // query-matched recall from persona memory plane.
  const dynamicItems: Array<{
    bucket: 'memory' | 'system_passed' | 'correspondence_continuity' | 'correspondence_highlight' | 'feed';
    value: string,
    score: number,
    order: number
  }> = [];
  let order = 0;
  for (const signal of memorySignals) {
    dynamicItems.push({ bucket: 'memory', value: signal, score: 100 - order, order });
    order += 1;
  }
  for (const signal of systemPassed.signals) {
    dynamicItems.push({ bucket: 'system_passed', value: signal, score: 90 - order, order });
    order += 1;
  }
  for (const signal of correspondenceContinuity.map((v) => `Continuity recall: ${v}`)) {
    dynamicItems.push({ bucket: 'correspondence_continuity', value: signal, score: 80 - order, order });
    order += 1;
  }
  for (const signal of correspondenceHighlights.map((v) => `Prior correspondence: ${v}`)) {
    dynamicItems.push({ bucket: 'correspondence_highlight', value: signal, score: 70 - order, order });
    order += 1;
  }
  for (const signal of feedSignals) {
    dynamicItems.push({ bucket: 'feed', value: signal, score: 60 - order, order });
    order += 1;
  }

  const bootstrapItems = [
    ...(lensMode === 'strategic'
      ? strategicFilters.map((v) => `Strategic filter: ${v}`)
      : lensMode === 'full'
        ? [
            ...decisionFilters.map((v) => `Decision filter: ${v}`),
            ...strategicFilters.map((v) => `Strategic filter: ${v}`)
          ]
        : decisionFilters.map((v) => `Decision filter: ${v}`)),
    ...emotionSignals.map((v) => `Emotion signal: ${v}`),
    ...(lensMode === 'decision' ? [] : strategicAnchors.map((v) => `Strategic anchor: ${v}`)),
    ...valuesFilters.map((v) => `Values filter: ${v}`),
    ...valuesAnchors.map((v) => `Values anchor: ${v}`),
    ...nonNegotiables.map((v) => `Constraint: ${v}`),
    ...profileHighlights.map((v) => `Profile context: ${v}`)
  ];
  const bootstrapTokenEstimate = estimateTokenCount(`${query}\n${bootstrapItems.join('\n')}`);
  const dynamicTokenEstimateBefore = estimateTokenCount(dynamicItems.map((row) => row.value).join('\n'));
  const maxTokens = clampInt(contextBudgetPolicy.maxTokens, 200, 12000, DEFAULT_CONTEXT_TOKEN_BUDGET);
  const mode: ContextBudgetMode = contextBudgetPolicy.mode === 'reject' ? 'reject' : 'trim';
  let chosenDynamic = dynamicItems.slice();
  const estimatedTokensBefore = bootstrapTokenEstimate + dynamicTokenEstimateBefore;
  const overBudgetBefore = estimatedTokensBefore > maxTokens;
  let trimmed = false;
  let rejected = false;
  if (overBudgetBefore) {
    if (mode === 'reject' || bootstrapTokenEstimate >= maxTokens) {
      chosenDynamic = [];
      rejected = true;
    } else {
      trimmed = true;
      const availableDynamicTokens = Math.max(0, maxTokens - bootstrapTokenEstimate);
      const ranked = dynamicItems
        .slice()
        .sort((a, b) => b.score - a.score || a.order - b.order);
      const keepKeys = new Set<number>();
      let usedTokens = 0;
      for (const item of ranked) {
        const nextTokens = estimateTokenCount(item.value);
        if (usedTokens + nextTokens > availableDynamicTokens) continue;
        usedTokens += nextTokens;
        keepKeys.add(item.order);
      }
      chosenDynamic = dynamicItems.filter((item) => keepKeys.has(item.order));
      if (!chosenDynamic.length && dynamicItems.length) {
        chosenDynamic = [dynamicItems[0]];
      }
    }
  }
  const chosenDynamicSorted = chosenDynamic.slice().sort((a, b) => a.order - b.order);
  const chosenDynamicValues = chosenDynamicSorted.map((row) => row.value);
  const dynamicTokenEstimateAfter = estimateTokenCount(chosenDynamicValues.join('\n'));
  const estimatedTokensAfter = bootstrapTokenEstimate + dynamicTokenEstimateAfter;
  if (!rejected && estimatedTokensAfter > maxTokens) {
    rejected = true;
  }
  const contextBudget: ContextBudgetState = {
    max_tokens: maxTokens,
    mode,
    source: contextBudgetPolicy.source,
    estimated_tokens_before: estimatedTokensBefore,
    estimated_tokens_after: estimatedTokensAfter,
    bootstrap_tokens: bootstrapTokenEstimate,
    dynamic_tokens_before: dynamicTokenEstimateBefore,
    dynamic_tokens_after: dynamicTokenEstimateAfter,
    dynamic_items_before: dynamicItems.length,
    dynamic_items_after: chosenDynamicValues.length,
    over_budget_before: overBudgetBefore,
    over_budget_after: estimatedTokensAfter > maxTokens,
    trimmed,
    rejected,
    dropped_dynamic_items: Math.max(0, dynamicItems.length - chosenDynamicValues.length)
  };
  recordContextBudgetEvent(contextCtx, query, contextBudget, invocation);
  if (rejected) {
    throw new Error(
      `context_budget_exceeded:max=${contextBudget.max_tokens};estimated=${contextBudget.estimated_tokens_before};mode=${contextBudget.mode}`
    );
  }
  const chosenByBucket = {
    memory: chosenDynamicSorted.filter((row) => row.bucket === 'memory').map((row) => row.value),
    systemPassed: chosenDynamicSorted.filter((row) => row.bucket === 'system_passed').map((row) => row.value),
    correspondenceContinuity: chosenDynamicSorted.filter((row) => row.bucket === 'correspondence_continuity').map((row) => row.value),
    correspondenceHighlights: chosenDynamicSorted.filter((row) => row.bucket === 'correspondence_highlight').map((row) => row.value),
    feed: chosenDynamicSorted.filter((row) => row.bucket === 'feed').map((row) => row.value)
  };
  const modeText = lensMode === 'full' ? 'decision + strategic' : lensMode;
  const promptTemplate = [
    `As ${personaName}, using your profile, ${modeText} lens, and past correspondence, respond to: ${query}`,
    `Recent correspondence continuity (last ${chosenByBucket.correspondenceContinuity.length || 0}):`,
    ...(chosenByBucket.correspondenceContinuity.length
      ? chosenByBucket.correspondenceContinuity.map((row) => row.replace(/^Continuity recall:\s*/i, ''))
      : ['No recent correspondence entries found.'])
  ].join(' ');
  let recommendation = recommendFromQuery(personaRef, query);
  if (includeSystemPassedFeed && chosenByBucket.systemPassed.length) {
    const firstSignal = cleanText(chosenByBucket.systemPassed[0].replace(/^SystemPassed:\s*/, ''), 180);
    recommendation = `${recommendation} System-passed context: ${firstSignal}.`;
  }
  const reasoning = [
    ...bootstrapItems,
    ...chosenByBucket.feed,
    ...chosenByBucket.systemPassed,
    ...chosenByBucket.memory,
    ...chosenByBucket.correspondenceContinuity,
    ...chosenByBucket.correspondenceHighlights
  ].slice(0, 10);
  let surpriseApplied = false;
  let surpriseMode = 'none';
  let surpriseRoll = 1;
  if (surpriseEnabled) {
    const rollHex = crypto
      .createHash('sha256')
      .update(`${personaRef}|${query}|${surpriseSeed || new Date().toISOString().slice(0, 10)}`, 'utf8')
      .digest('hex')
      .slice(0, 8);
    const rollNum = parseInt(rollHex, 16) / 0xffffffff;
    surpriseRoll = Number(rollNum.toFixed(4));
    if (rollNum < 0.2) {
      surpriseApplied = true;
      const bucket = parseInt(rollHex.slice(-1), 16) % 3;
      if (bucket === 0) {
        surpriseMode = 'question_back';
        recommendation = `${recommendation} Before finalizing, what hard proof guarantees this remains behavior-preserving under the next parity run?`;
      } else if (bucket === 1 && chosenByBucket.correspondenceContinuity.length) {
        surpriseMode = 'pattern_recall';
        recommendation = `${recommendation} Pattern reminder: ${cleanText(chosenByBucket.correspondenceContinuity[0], 200)}.`;
      } else {
        surpriseMode = 'context_request';
        recommendation = `${recommendation} I need one additional context point: what is the rollback trigger threshold for this change?`;
      }
      reasoning.unshift(`Surprise injection (${surpriseMode}, roll=${surpriseRoll.toFixed(4)}): anti-puppet deviation applied.`);
    }
  }
  return {
    promptTemplate,
    recommendation,
    reasoning,
    systemPassed,
    recentCorrespondence,
    contextBudget,
    surpriseApplied,
    surpriseMode,
    surpriseRoll
  };
}

function renderMarkdownResponse(
  ctx: PersonaContext,
  query: string,
  lensMode: LensMode,
  emotionLensMd = '',
  controls: LensControls | null = null,
  overridePosition = '',
  interceptReceiptPath = '',
  emotionEnabled = true,
  valuesEnabled = true,
  includeFeed = false,
  llmMeta: { enabled: boolean, used: boolean, reason: string, model: string } | null = null,
  surpriseEnabled = false,
  surpriseSeed = '',
  contextBudgetPolicy: ContextBudgetPolicy = defaultContextBudgetPolicy(),
  invocation = 'lens'
): string {
  const {
    promptTemplate,
    recommendation,
    reasoning,
    contextBudget,
    surpriseApplied,
    surpriseMode,
    surpriseRoll
  } = buildResponseDetails(
    ctx.personaId,
    ctx.personaName,
    query,
    ctx.profileMd,
    ctx.correspondenceMd,
    ctx.decisionLensMd,
    ctx.strategicLensMd,
    lensMode,
    emotionLensMd,
    valuesEnabled ? ctx.valuesLensMd : '',
    ctx.feedMd,
    ctx.memoryMd,
    includeFeed,
    surpriseEnabled,
    surpriseSeed,
    contextBudgetPolicy,
    ctx,
    invocation
  );
  const resolvedRecommendation = cleanText(overridePosition, 1600) || recommendation;

  const lines: string[] = [];
  lines.push(`# Lens Response: ${ctx.personaName}`);
  lines.push('');
  lines.push(`**Persona ID:** \`${ctx.personaId}\``);
  lines.push(`**Lens Mode:** \`${lensMode}\``);
  lines.push(`**Emotion Lens:** \`${emotionEnabled ? 'on' : 'off'}\``);
  lines.push(`**Values Lens:** \`${valuesEnabled ? 'on' : 'off'}\``);
  lines.push(`**System Passed Feed:** \`${includeFeed ? 'on' : 'off'}\``);
  lines.push(`**Context Budget:** \`${contextBudget.estimated_tokens_after}/${contextBudget.max_tokens}\` tokens (mode \`${contextBudget.mode}\`, source \`${contextBudget.source}\`)`);
  if (contextBudget.over_budget_before) {
    lines.push(`**Context Guard Action:** \`${contextBudget.rejected ? 'rejected' : contextBudget.trimmed ? 'trimmed' : 'allow'}\` (dropped dynamic \`${contextBudget.dropped_dynamic_items}\`)`);
  }
  lines.push(`**Surprise Mode:** \`${surpriseEnabled ? 'on' : 'off'}\``);
  if (surpriseEnabled) {
    lines.push(`**Surprise Applied:** \`${surpriseApplied ? 'yes' : 'no'}\` (mode \`${cleanText(surpriseMode || 'none', 80)}\`, roll \`${Number(surpriseRoll || 0).toFixed(4)}\`)`);
  }
  if (llmMeta) {
    lines.push(`**Persona LLM:** \`${llmMeta.enabled ? (llmMeta.used ? 'on-active' : 'on-fallback') : 'off'}\``);
    lines.push(`**Persona LLM Model:** \`${cleanText(llmMeta.model || 'n/a', 120)}\``);
    lines.push(`**Persona LLM Reason:** \`${cleanText(llmMeta.reason || 'n/a', 120)}\``);
  }
  if (controls) {
    lines.push(`**Alignment Indicator:** ${alignmentBadge(controls.alignmentMode)}`);
    lines.push(`**Cognizance-Gap:** \`${controls.gapSeconds}s\``);
    if (controls.interceptText) {
      lines.push(`**Intercept:** applied`);
      if (interceptReceiptPath) {
        lines.push(`**Intercept Log:** \`${interceptReceiptPath}\``);
      }
    } else {
      lines.push('**Intercept:** not applied');
    }
  }
  lines.push(`**Query:** ${query}`);
  lines.push('');
  lines.push(`> ${promptTemplate}`);
  lines.push('');
  lines.push('## Position');
  lines.push(resolvedRecommendation);
  lines.push('');
  lines.push('## Reasoning');
  if (reasoning.length) {
    for (const row of reasoning) {
      lines.push(`- ${row}`);
    }
  } else {
    lines.push('- No structured context parsed; defaulted to deterministic and fail-closed guidance.');
  }
  lines.push('');
  lines.push('## Suggested Next Steps');
  lines.push('1. Define the invariant and expected receipt fields before implementation.');
  lines.push('2. Implement the smallest behavior-preserving slice.');
  lines.push('3. Run one regression test and one sovereignty/security check before merge.');
  lines.push('');
  lines.push('## Context Files');
  lines.push(`- \`personas/${ctx.personaId}/profile.md\``);
  lines.push(`- \`personas/${ctx.personaId}/correspondence.md\``);
  lines.push(`- \`personas/${ctx.personaId}/decision_lens.md\``);
  if (lensMode !== 'decision' && cleanText(ctx.strategicLensMd, 8)) {
    lines.push(`- \`personas/${ctx.personaId}/strategic_lens.md\``);
  }
  if (valuesEnabled && cleanText(ctx.valuesLensMd, 8)) {
    lines.push(`- \`personas/${ctx.personaId}/values_philosophy_lens.md\``);
  }
  if (cleanText(emotionLensMd, 8)) {
    lines.push(`- \`personas/${ctx.personaId}/emotion_lens.md\``);
  }
  lines.push(`- \`personas/${ctx.personaId}/data_streams.md\``);
  lines.push(`- \`personas/${ctx.personaId}/data_permissions.md\``);
  lines.push(`- \`personas/${ctx.personaId}/feed.md\``);
  lines.push(`- \`personas/${ctx.personaId}/memory.md\``);
  lines.push(`- \`personas/${ctx.personaId}/llm_config.md\``);
  lines.push(`- \`personas/${ctx.personaId}/obfuscation_encryption.md\``);
  lines.push(`- \`personas/${ctx.personaId}/soul_token.md\``);
  lines.push('');
  return lines.join('\n');
}

function renderMarkdownSection(
  ctx: PersonaContext,
  query: string,
  lensMode: LensMode,
  emotionEnabled = true,
  valuesEnabled = true,
  includeFeed = false,
  surpriseEnabled = false,
  surpriseSeed = '',
  contextBudgetPolicy: ContextBudgetPolicy = defaultContextBudgetPolicy(),
  invocation = 'lens'
): string {
  const emotionMd = emotionEnabled ? ctx.emotionLensMd : '';
  const {
    promptTemplate,
    recommendation,
    reasoning,
    contextBudget,
    surpriseApplied,
    surpriseMode,
    surpriseRoll
  } = buildResponseDetails(
    ctx.personaId,
    ctx.personaName,
    query,
    ctx.profileMd,
    ctx.correspondenceMd,
    ctx.decisionLensMd,
    ctx.strategicLensMd,
    lensMode,
    emotionMd,
    valuesEnabled ? ctx.valuesLensMd : '',
    ctx.feedMd,
    ctx.memoryMd,
    includeFeed,
    surpriseEnabled,
    surpriseSeed,
    contextBudgetPolicy,
    ctx,
    invocation
  );

  const lines: string[] = [];
  lines.push(`## ${ctx.personaName} (\`${ctx.personaId}\`)`);
  lines.push('');
  lines.push(`**Lens Mode:** \`${lensMode}\``);
  lines.push(`**Context Budget:** \`${contextBudget.estimated_tokens_after}/${contextBudget.max_tokens}\` tokens`);
  if (contextBudget.over_budget_before) {
    lines.push(`**Context Guard Action:** \`${contextBudget.rejected ? 'rejected' : contextBudget.trimmed ? 'trimmed' : 'allow'}\``);
  }
  if (surpriseEnabled) {
    lines.push(`**Surprise Applied:** \`${surpriseApplied ? 'yes' : 'no'}\` (mode \`${cleanText(surpriseMode || 'none', 80)}\`, roll \`${Number(surpriseRoll || 0).toFixed(4)}\`)`);
  }
  lines.push('');
  lines.push(`> ${promptTemplate}`);
  lines.push('');
  lines.push('### Position');
  lines.push(recommendation);
  lines.push('');
  lines.push('### Reasoning');
  if (reasoning.length) {
    for (const row of reasoning) {
      lines.push(`- ${row}`);
    }
  } else {
    lines.push('- No structured context parsed; defaulted to deterministic and fail-closed guidance.');
  }
  lines.push('');
  lines.push('### Context Files');
  lines.push(`- \`personas/${ctx.personaId}/profile.md\``);
  lines.push(`- \`personas/${ctx.personaId}/correspondence.md\``);
  lines.push(`- \`personas/${ctx.personaId}/decision_lens.md\``);
  if (lensMode !== 'decision' && cleanText(ctx.strategicLensMd, 8)) {
    lines.push(`- \`personas/${ctx.personaId}/strategic_lens.md\``);
  }
  if (valuesEnabled && cleanText(ctx.valuesLensMd, 8)) {
    lines.push(`- \`personas/${ctx.personaId}/values_philosophy_lens.md\``);
  }
  if (emotionEnabled && cleanText(ctx.emotionLensMd, 8)) {
    lines.push(`- \`personas/${ctx.personaId}/emotion_lens.md\``);
  }
  lines.push(`- \`personas/${ctx.personaId}/data_streams.md\``);
  lines.push(`- \`personas/${ctx.personaId}/data_permissions.md\``);
  lines.push(`- \`personas/${ctx.personaId}/feed.md\``);
  lines.push(`- \`personas/${ctx.personaId}/memory.md\``);
  lines.push(`- \`personas/${ctx.personaId}/llm_config.md\``);
  lines.push(`- \`personas/${ctx.personaId}/obfuscation_encryption.md\``);
  lines.push(`- \`personas/${ctx.personaId}/soul_token.md\``);
  lines.push('');
  return lines.join('\n');
}

function renderAllMarkdown(
  query: string,
  contexts: PersonaContext[],
  lensMode: LensMode,
  controls: LensControls | null = null,
  emotionEnabled = true,
  valuesEnabled = true,
  includeFeed = false,
  surpriseEnabled = false,
  surpriseSeed = '',
  contextBudgetPolicy: ContextBudgetPolicy = defaultContextBudgetPolicy(),
  invocation = 'lens'
): string {
  const lines: string[] = [];
  lines.push('# Lens Response: All Personas');
  lines.push('');
  lines.push(`**Lens Mode:** \`${lensMode}\``);
  if (controls) {
    lines.push(`**Alignment Indicator:** ${alignmentBadge(controls.alignmentMode)}`);
    lines.push(`**Cognizance-Gap:** \`${controls.gapSeconds}s\``);
  }
  lines.push('');
  lines.push(`**Query:** ${query}`);
  lines.push(`**Emotion Lens:** \`${emotionEnabled ? 'on' : 'off'}\``);
  lines.push(`**Values Lens:** \`${valuesEnabled ? 'on' : 'off'}\``);
  lines.push(`**System Passed Feed:** \`${includeFeed ? 'on' : 'off'}\``);
  lines.push(`**Context Budget Cap:** \`${contextBudgetPolicy.maxTokens}\` tokens`);
  lines.push(`**Surprise Mode:** \`${surpriseEnabled ? 'on' : 'off'}\``);
  lines.push('');
  for (const ctx of contexts) {
    lines.push(
      renderMarkdownSection(
        ctx,
        query,
        lensMode,
        emotionEnabled,
        valuesEnabled,
        includeFeed,
        surpriseEnabled,
        surpriseSeed,
        contextBudgetPolicy,
        invocation
      )
    );
  }
  return lines.join('\n');
}

function recallSignals(reasoning: string[]) {
  return (Array.isArray(reasoning) ? reasoning : [])
    .filter((row) => {
      const normalized = String(row || '').toLowerCase();
      return normalized.startsWith('memory recall:')
        || normalized.startsWith('feed:')
        || normalized.startsWith('systempassed:');
    })
    .slice(0, 3);
}

function renderMultiPersonaMarkdown(
  query: string,
  contexts: PersonaContext[],
  lensMode: LensMode,
  emotionEnabled: boolean,
  valuesEnabled: boolean,
  includeFeed: boolean,
  expected: string,
  surpriseEnabled = false,
  surpriseSeed = '',
  contextBudgetPolicy: ContextBudgetPolicy = defaultContextBudgetPolicy(),
  invocation = 'multi_persona'
) {
  const rules = loadArbitrationRules();
  const domain = inferArbitrationDomain(query);
  const details = contexts.map((ctx) => {
    const info = buildResponseDetails(
      ctx.personaId,
      ctx.personaName,
      query,
      ctx.profileMd,
      ctx.correspondenceMd,
      ctx.decisionLensMd,
      ctx.strategicLensMd,
      lensMode,
      emotionEnabled ? ctx.emotionLensMd : '',
      valuesEnabled ? ctx.valuesLensMd : '',
      ctx.feedMd,
      ctx.memoryMd,
      includeFeed,
      surpriseEnabled,
      surpriseSeed,
      contextBudgetPolicy,
      ctx,
      invocation
    );
    return {
      persona_id: ctx.personaId,
      persona_name: ctx.personaName,
      recommendation: info.recommendation,
      reasoning: info.reasoning,
      recall: recallSignals(info.reasoning),
      context_budget: info.contextBudget,
      surprise: {
        applied: Boolean(info.surpriseApplied),
        mode: cleanText(info.surpriseMode || 'none', 60),
        roll: Number((info.surpriseRoll || 0).toFixed(4))
      }
    };
  });

  let maxDivergence = 0;
  const pairwise: Array<{ pair: string, divergence: number }> = [];
  for (let i = 0; i < details.length; i += 1) {
    for (let j = i + 1; j < details.length; j += 1) {
      const d = textDivergence(details[i].recommendation, details[j].recommendation);
      if (d > maxDivergence) maxDivergence = d;
      pairwise.push({
        pair: `${details[i].persona_id}<->${details[j].persona_id}`,
        divergence: d
      });
    }
  }
  const disagreementThreshold = 0.2;
  const disagreement = maxDivergence > disagreementThreshold;
  const arbitration = pickArbitrationWinner(domain, details.map((d) => d.persona_id), rules);
  const winner = details.find((row) => row.persona_id === arbitration.winner) || null;
  const expectedText = cleanText(expected, 1200)
    || recommendFromQuery('baseline', query);
  const surpriseScore = winner
    ? textDivergence(winner.recommendation, expectedText)
    : 1;
  const surprising = surpriseScore > 0.2;

  const lines: string[] = [];
  lines.push('# Lens Response: Multi Persona');
  lines.push('');
  lines.push(`**Lens Mode:** \`${lensMode}\``);
  lines.push(`**Participants:** ${details.map((row) => `\`${row.persona_id}\``).join(', ')}`);
  lines.push(`**Query:** ${query}`);
  lines.push(`**Domain:** \`${domain}\``);
  lines.push(`**Disagreement:** \`${disagreement ? 'yes' : 'no'}\` (max divergence \`${maxDivergence.toFixed(3)}\`, threshold \`0.200\`)`);
  lines.push('');
  lines.push('## Persona Positions');
  for (const row of details) {
    lines.push(`### ${row.persona_name} (\`${row.persona_id}\`)`);
    lines.push(`- Position: ${row.recommendation}`);
    if (row.recall.length) {
      lines.push('- Recall signals:');
      for (const signal of row.recall) {
        lines.push(`  - ${signal}`);
      }
    } else {
      lines.push('- Recall signals: none');
    }
    lines.push('');
  }
  lines.push('## Arbitration');
  lines.push(`- Rule file: \`${path.relative(ROOT, PERSONA_ARBITRATION_RULES_PATH).replace(/\\/g, '/')}\``);
  lines.push(`- Rule applied: \`${arbitration.rule}\``);
  lines.push(`- Winner: ${winner ? `\`${winner.persona_id}\`` : '`none` (fail-closed)'}`);
  if (winner) {
    lines.push(`- Final position: ${winner.recommendation}`);
  } else {
    lines.push('- Final position: blocked (no deterministic winner)');
  }
  lines.push('');
  lines.push('## Surprise Check');
  lines.push(`- Expected baseline: ${expectedText}`);
  lines.push(`- Surprise score: \`${surpriseScore.toFixed(3)}\``);
  lines.push(`- Surprising: \`${surprising ? 'yes' : 'no'}\``);
  lines.push('');
  lines.push('## Pairwise Divergence');
  if (!pairwise.length) {
    lines.push('- Not enough participants for pairwise divergence.');
  } else {
    for (const row of pairwise) {
      lines.push(`- ${row.pair}: ${row.divergence.toFixed(3)}`);
    }
  }
  lines.push('');

  return {
    markdown: lines.join('\n'),
    domain,
    details,
    disagreement,
    maxDivergence,
    arbitration,
    winner: winner ? winner.persona_id : null,
    finalPosition: winner ? winner.recommendation : '',
    surpriseScore,
    surprising
  };
}

function deriveBlockers(reasoning: string[]): string[] {
  const out = new Set<string>();
  for (const row of Array.isArray(reasoning) ? reasoning : []) {
    const text = cleanText(row, 220);
    const lower = text.toLowerCase();
    if (!text) continue;
    if (lower.includes('constraint:')) out.add(text.replace(/^constraint:\s*/i, '').trim());
    if (lower.includes('fail-closed') || lower.includes('fail closed')) out.add('Fail-closed gate verification required');
    if (lower.includes('drift')) out.add('Drift threshold verification required');
    if (lower.includes('rollback')) out.add('Rollback path and proof required');
    if (lower.includes('parity')) out.add('Parity evidence required');
  }
  return Array.from(out).slice(0, 5);
}

function estimateTimeEstimate(query: string, blockers: string[]): string {
  const lower = String(query || '').toLowerCase();
  if (blockers.length >= 3) return '90-120 min';
  if (lower.includes('migration') || lower.includes('rollout') || lower.includes('security')) return '45-90 min';
  if (lower.includes('check') || lower.includes('audit') || lower.includes('verify')) return '20-45 min';
  return '30-60 min';
}

function deriveEscalateTo(query: string, fallbackPersonaId: string): string {
  const rules = loadArbitrationRules();
  const domain = inferArbitrationDomain(query);
  return normalizeToken(rules.domain_winners && rules.domain_winners[domain] || fallbackPersonaId || '', 120) || 'vikram_menon';
}

function structuredConfidence(reasoning: string[], blockers: string[]): number {
  const base = 0.55 + Math.min(0.35, (Array.isArray(reasoning) ? reasoning.length : 0) * 0.04);
  const penalty = Math.min(0.25, blockers.length * 0.05);
  return Number(Math.max(0.1, Math.min(0.99, base - penalty)).toFixed(3));
}

function buildStructuredPersonaOutput(opts: {
  personaId: string,
  recommendation: string,
  reasoning: string[],
  query: string,
  lensMode: LensMode,
  surprise: { enabled: boolean, applied: boolean, mode: string, roll: number },
  systemPassed: { total: number, verified: number, invalid: number },
  context_budget?: ContextBudgetState
}) {
  const blockers = deriveBlockers(opts.reasoning);
  return {
    schema: 'persona_lens_v1',
    persona_id: opts.personaId,
    lens_mode: opts.lensMode,
    recommendation: cleanText(opts.recommendation, 1600),
    confidence: structuredConfidence(opts.reasoning, blockers),
    time_estimate: estimateTimeEstimate(opts.query, blockers),
    blockers,
    escalate_to: deriveEscalateTo(opts.query, opts.personaId),
    reasoning: (Array.isArray(opts.reasoning) ? opts.reasoning : []).slice(0, 10),
    surprise: {
      enabled: opts.surprise.enabled,
      applied: opts.surprise.applied,
      mode: opts.surprise.mode,
      roll: Number((opts.surprise.roll || 0).toFixed(4))
    },
    system_passed: {
      total: Number(opts.systemPassed && opts.systemPassed.total || 0),
      verified: Number(opts.systemPassed && opts.systemPassed.verified || 0),
      invalid: Number(opts.systemPassed && opts.systemPassed.invalid || 0)
    },
    context_budget: opts.context_budget
      ? {
          max_tokens: Number(opts.context_budget.max_tokens || 0),
          mode: cleanText(opts.context_budget.mode || 'trim', 20),
          source: cleanText(opts.context_budget.source || 'default', 20),
          estimated_tokens_before: Number(opts.context_budget.estimated_tokens_before || 0),
          estimated_tokens_after: Number(opts.context_budget.estimated_tokens_after || 0),
          trimmed: opts.context_budget.trimmed === true,
          rejected: opts.context_budget.rejected === true,
          dropped_dynamic_items: Number(opts.context_budget.dropped_dynamic_items || 0)
        }
      : null
  };
}

function appendPersonaFeedback(entry: {
  session_id: string,
  surprising: boolean,
  changed_decision: boolean,
  useful_persona: string,
  note: string
}) {
  fs.mkdirSync(PERSONA_ORG_DIR, { recursive: true });
  const row = {
    ts: nowIso(),
    type: 'persona_meta_feedback',
    session_id: cleanText(entry.session_id, 120),
    surprising: entry.surprising ? 1 : 0,
    changed_decision: entry.changed_decision ? 1 : 0,
    useful_persona: normalizeToken(entry.useful_persona, 120),
    note: cleanText(entry.note, 600)
  };
  fs.appendFileSync(PERSONA_FEEDBACK_PATH, `${JSON.stringify(row)}\n`, 'utf8');
  appendPersonaTelemetry({
    metric: 'persona_meta_feedback',
    persona_id: row.useful_persona || 'unknown',
    surprising: row.surprising,
    changed_decision: row.changed_decision
  });
  return row;
}

function summarizePersonaFeedback(window = 100) {
  const rows = readJsonlTail(PERSONA_FEEDBACK_PATH, Math.max(1, Math.min(1000, window)));
  const total = rows.length;
  const surprising = rows.filter((row: any) => Number(row && row.surprising || 0) === 1).length;
  const changedDecision = rows.filter((row: any) => Number(row && row.changed_decision || 0) === 1).length;
  const usefulCounts: Record<string, number> = {};
  for (const row of rows as Array<Record<string, unknown>>) {
    const id = normalizeToken(row.useful_persona || 'unknown', 120) || 'unknown';
    usefulCounts[id] = (usefulCounts[id] || 0) + 1;
  }
  const usefulTop = Object.entries(usefulCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);
  const payload = {
    ok: true,
    type: 'persona_feedback_summary',
    window: Math.max(1, Math.min(1000, Math.floor(window) || 100)),
    total,
    surprising_rate: total ? Number((surprising / total).toFixed(4)) : 0,
    changed_decision_rate: total ? Number((changedDecision / total).toFixed(4)) : 0,
    useful_personas: usefulTop.map(([persona, count]) => ({ persona, count }))
  };
  const markdown = [
    '# Persona Feedback Summary',
    '',
    `- Window: ${payload.window}`,
    `- Total feedback rows: ${payload.total}`,
    `- Surprising rate: ${(payload.surprising_rate * 100).toFixed(1)}%`,
    `- Changed-decision rate: ${(payload.changed_decision_rate * 100).toFixed(1)}%`,
    '',
    '## Most Useful Personas',
    ...(payload.useful_personas.length
      ? payload.useful_personas.map((row) => `- ${row.persona}: ${row.count}`)
      : ['- no feedback rows yet'])
  ].join('\n');
  return {
    ...payload,
    markdown
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args._.includes('help') || args._.includes('--help') || args._.includes('-h')) {
    usage();
    process.exit(0);
  }

  if (args.list === true || String(args.list || '') === '1') {
    const personas = listPersonaIds();
    if (!personas.length) {
      console.log('No personas found under personas/.');
      process.exit(0);
    }
    console.log('Available personas:');
    for (const personaId of personas) {
      console.log(`- ${personaId}`);
    }
    process.exit(0);
  }

  const emotionEnabled = parseEmotionEnabled(args.emotion, true);
  const valuesEnabled = parseEmotionEnabled(args.values, true);
  const includeFeedFlag = toBool(args['include-feed'] ?? args.include_feed, false);
  const surpriseEnabled = parseEmotionEnabled(args.surprise, false);
  const surpriseSeed = cleanText(args['surprise-seed'] ?? args.surprise_seed, 120);
  const outputSchema = parseOutputSchema(args.schema ?? args.output, 'markdown');
  const contextBudgetPolicy = parseContextBudgetPolicy(args);
  const personaArg = cleanText(args.persona || args._[0] || '', 120);
  const isUpdateStream = normalizeToken(args._[0] || '', 40) === 'update_stream' || normalizeToken(args._[0] || '', 40) === 'update-stream';
  const isTrigger = normalizeToken(args._[0] || '', 40) === 'trigger';
  const isDashboard = normalizeToken(args._[0] || '', 40) === 'dashboard';
  const isCheckin = normalizeToken(args._[0] || '', 40) === 'checkin';
  const isFeed = normalizeToken(args._[0] || '', 40) === 'feed';
  const isArbitrate = normalizeToken(args._[0] || '', 40) === 'arbitrate';
  const isFeedback = normalizeToken(args._[0] || '', 40) === 'feedback';
  const isFeedbackSummary = normalizeToken(args._[0] || '', 40) === 'feedback_summary'
    || normalizeToken(args._[0] || '', 40) === 'feedback-summary';
  const updatePersonaRaw = cleanText(args.persona || args._[1] || '', 120);
  if (isUpdateStream) {
    const updatePersonaId = resolvePersonaId(updatePersonaRaw);
    if (!updatePersonaId) {
      process.stderr.write(`unknown_persona:${updatePersonaRaw}\n`);
      process.exit(1);
    }
    try {
      const payload = updateStreamForPersona(updatePersonaId, toBool(args['dry-run'], false));
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(0);
    } catch (err: any) {
      const msg = cleanText(err && err.message || 'persona_stream_update_failed', 260);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  }
  if (isDashboard) {
    const window = clampInt(args.window ?? args.n ?? 20, 1, 400, 20);
    const payload = buildPersonaDashboard(window);
    if (toBool(args.json, false)) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`${payload.markdown}\n`);
    }
    process.exit(0);
  }
  if (isTrigger) {
    const triggerName = normalizeToken(args._[1] || args.name || '', 80);
    if (!triggerName) {
      process.stderr.write('trigger_name_required\n');
      process.exit(1);
    }
    try {
      if (triggerName === 'weekly-checkin' || triggerName === 'weekly_checkin') {
        const personaRaw = cleanText(args.persona || 'jay_haslam', 120);
        const personaId = resolvePersonaId(personaRaw);
        if (!personaId) {
          process.stderr.write(`unknown_persona:${personaRaw}\n`);
          process.exit(1);
        }
        const dryRun = toBool(args['dry-run'], false);
        const payload = runPersonaCheckin(
          personaId,
          args.heartbeat || args['heartbeat-path'] || args.heartbeat_path,
          emotionEnabled,
          valuesEnabled,
          contextBudgetPolicy,
          dryRun
        );
        appendPersonaTelemetry({
          kind: 'persona_trigger',
          trigger: 'weekly_checkin',
          persona_id: personaId,
          dry_run: dryRun ? 1 : 0,
          metric: 'trigger_activation'
        });
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        process.exit(0);
      }

      if (triggerName === 'pre-sprint' || triggerName === 'pre_sprint') {
        const query = cleanText(
          args.query || args.q || args._.slice(2).join(' '),
          2000
        ) || 'Pre-sprint review: identify drift risks, sequencing blockers, and one non-negotiable safety invariant.';
        const preferred = [
          'jay_haslam',
          'vikram_menon',
          'priya_venkatesh',
          'rohan_kapoor',
          'li_wei',
          'aarav_singh'
        ];
        const available = new Set(listPersonaIds());
        const personaIds = preferred.filter((id) => available.has(id));
        if (!personaIds.length) {
          process.stderr.write('no_personas_available\n');
          process.exit(1);
        }
        const candidateContexts = personaIds.map((personaId) => loadPersonaContext(personaId));
        const contexts: PersonaContext[] = [];
        const skipped: Array<{ persona_id: string, reason: string }> = [];
        for (const ctx of candidateContexts) {
          const gate = evaluateSoulTokenAccess(ctx, query);
          if (!gate.ok) {
            skipped.push({ persona_id: ctx.personaId, reason: cleanText(gate.reason || 'soul_token_blocked', 120) });
            continue;
          }
          const feedAccess = evaluateSystemPassedAccess(ctx, true);
          if (!feedAccess.ok) {
            skipped.push({ persona_id: ctx.personaId, reason: cleanText(feedAccess.reason || 'system_pass_blocked', 120) });
            continue;
          }
          contexts.push(ctx);
        }
        const fallbackContexts = contexts.length ? contexts : candidateContexts.filter((ctx) => {
          const gate = evaluateSoulTokenAccess(ctx, query);
          return gate.ok === true;
        });
        if (!fallbackContexts.length) {
          process.stderr.write('pre_sprint_trigger_no_eligible_personas\n');
          process.exit(1);
        }
        const includeFeedForRun = contexts.length > 0;
        const markdown = [
          '# Trigger: pre-sprint',
          '',
          `- Source: \`${path.relative(ROOT, PERSONA_TRIGGERS_PATH).replace(/\\/g, '/')}\``,
          `- Query: ${query}`,
          `- System Passed Feed: \`${includeFeedForRun ? 'on' : 'off'}\``,
          skipped.length
            ? `- Skipped personas: ${skipped.map((row) => `${row.persona_id}(${row.reason})`).join(', ')}`
            : '- Skipped personas: none',
          '',
          renderAllMarkdown(
            query,
            fallbackContexts,
            'decision',
            null,
            emotionEnabled,
            valuesEnabled,
            includeFeedForRun,
            surpriseEnabled,
            surpriseSeed,
            contextBudgetPolicy,
            'trigger_pre_sprint'
          )
        ].join('\n');
        appendPersonaTelemetry({
          kind: 'persona_trigger',
          trigger: 'pre_sprint',
          persona_id: 'all_core',
          metric: 'trigger_activation',
          include_feed: includeFeedForRun ? 1 : 0,
          skipped_personas: skipped.length,
          query_hash: crypto.createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16)
        });
        process.stdout.write(`${markdown}\n`);
        process.exit(0);
      }

      if (triggerName === 'drift-alert' || triggerName === 'drift_alert') {
        const rawPersona = cleanText(args.persona || 'vikram_menon', 120);
        const personaId = resolvePersonaId(rawPersona);
        if (!personaId) {
          process.stderr.write(`unknown_persona:${rawPersona}\n`);
          process.exit(1);
        }
        const query = cleanText(
          args.query || args.q || args._.slice(2).join(' '),
          2000
        ) || 'Drift alert review: system drift pressure increased. Recommend bounded, fail-closed next actions.';
        const ctx = loadPersonaContext(personaId);
        const gate = evaluateSoulTokenAccess(ctx, query);
        if (!gate.ok) {
          process.stderr.write(`${gate.reason}\n`);
          process.stderr.write(`persona:${ctx.personaId}\n`);
          process.exit(1);
        }
        const feedAccess = evaluateSystemPassedAccess(ctx, true);
        if (!feedAccess.ok) {
          process.stderr.write(`${feedAccess.reason}\n`);
          process.stderr.write(`persona:${ctx.personaId}\n`);
          process.exit(1);
        }
        const details = buildResponseDetails(
          ctx.personaId,
          ctx.personaName,
          query,
          ctx.profileMd,
          ctx.correspondenceMd,
          ctx.decisionLensMd,
          ctx.strategicLensMd,
          'decision',
          emotionEnabled ? ctx.emotionLensMd : '',
          valuesEnabled ? ctx.valuesLensMd : '',
          ctx.feedMd,
          ctx.memoryMd,
          true,
          false,
          '',
          contextBudgetPolicy,
          ctx,
          'trigger_drift_alert'
        );
        const markdown = [
          '# Trigger: drift-alert',
          '',
          `- Source: \`${path.relative(ROOT, PERSONA_TRIGGERS_PATH).replace(/\\/g, '/')}\``,
          `- Persona: \`${ctx.personaId}\``,
          '',
          renderMarkdownResponse(
            ctx,
            query,
            'decision',
            emotionEnabled ? ctx.emotionLensMd : '',
            null,
            '',
            '',
            emotionEnabled,
            valuesEnabled,
            true,
            null,
            surpriseEnabled,
            surpriseSeed,
            contextBudgetPolicy,
            'trigger_drift_alert'
          )
        ].join('\n');
        appendPersonaTelemetry({
          kind: 'persona_trigger',
          trigger: 'drift_alert',
          persona_id: ctx.personaId,
          metric: 'trigger_activation',
          include_feed: 1,
          passed_entries_verified: Number(details.systemPassed && details.systemPassed.verified || 0),
          passed_entries_invalid: Number(details.systemPassed && details.systemPassed.invalid || 0),
          query_hash: crypto.createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16)
        });
        process.stdout.write(`${markdown}\n`);
        process.exit(0);
      }

      process.stderr.write(`unknown_trigger:${triggerName}\n`);
      process.exit(1);
    } catch (err: any) {
      const msg = cleanText(err && err.message || 'persona_trigger_failed', 260);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  }
  if (isCheckin) {
    const checkinPersonaRaw = cleanText(args.persona || 'jay_haslam', 120);
    const checkinPersonaId = resolvePersonaId(checkinPersonaRaw);
    if (!checkinPersonaId) {
      process.stderr.write(`unknown_persona:${checkinPersonaRaw}\n`);
      process.exit(1);
    }
    try {
      const dryRun = toBool(args['dry-run'], false);
      const payload = runPersonaCheckin(
        checkinPersonaId,
        args.heartbeat || args['heartbeat-path'] || args.heartbeat_path,
        emotionEnabled,
        valuesEnabled,
        contextBudgetPolicy,
        dryRun
      );
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(0);
    } catch (err: any) {
      const msg = cleanText(err && err.message || 'persona_checkin_failed', 260);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  }
  if (isFeed) {
    const feedPersonaRaw = cleanText(args.persona || args._[1] || '', 120);
    const feedPersonaId = resolvePersonaId(feedPersonaRaw);
    const feedSnippet = cleanText(
      args.snippet
      || args.message
      || args._.slice(2).join(' ')
      || '',
      2000
    );
    if (!feedPersonaId) {
      process.stderr.write(`unknown_persona:${feedPersonaRaw}\n`);
      process.exit(1);
    }
    const payload = appendPersonaFeed(feedPersonaId, feedSnippet, {
      source: cleanText(args.source || args.from || 'master_llm', 80),
      tags: parseTagList(args.tags || ''),
      dryRun: toBool(args['dry-run'], false)
    });
    if (payload.ok !== true) {
      process.stderr.write(`${payload.reason || 'persona_feed_append_failed'}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(0);
  }
  if (isFeedback) {
    const usefulRaw = cleanText(args.useful || args.persona || args['useful-persona'] || '', 120);
    const usefulPersona = resolvePersonaId(usefulRaw);
    if (!usefulPersona) {
      process.stderr.write(`unknown_persona:${usefulRaw}\n`);
      process.exit(1);
    }
    const row = appendPersonaFeedback({
      session_id: cleanText(args['session-id'] || args.session_id || `session_${Date.now()}`, 120),
      surprising: toBool(args.surprising, false),
      changed_decision: toBool(args['changed-decision'] ?? args.changed_decision, false),
      useful_persona: usefulPersona,
      note: cleanText(args.note || args._.slice(1).join(' '), 600)
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'persona_feedback_recorded',
      feedback_path: path.relative(ROOT, PERSONA_FEEDBACK_PATH).replace(/\\/g, '/'),
      row
    }, null, 2)}\n`);
    process.exit(0);
  }
  if (isFeedbackSummary) {
    const window = clampInt(args.window ?? args.n ?? 100, 1, 1000, 100);
    const payload = summarizePersonaFeedback(window);
    if (toBool(args.json, false) || outputSchema === 'json') {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`${payload.markdown}\n`);
    }
    process.exit(0);
  }
  if (isArbitrate) {
    const betweenRaw = cleanText(args.between || args.personas || args.participants || args._[1] || '', 1200);
    const betweenTokens = Array.from(new Set(
      String(betweenRaw || '')
        .split(',')
        .map((token) => cleanText(token, 120))
        .filter(Boolean)
    ));
    const personaIds = betweenTokens
      .map((token) => resolvePersonaId(token))
      .filter((id: string | null): id is string => Boolean(id));
    if (personaIds.length < 2) {
      process.stderr.write('arbitrate_requires_at_least_two_personas\n');
      process.exit(1);
    }
    const issue = cleanText(
      args.issue
      || args.query
      || args.q
      || args._.slice(2).join(' '),
      2000
    );
    if (!issue) {
      process.stderr.write('arbitrate_issue_required\n');
      process.exit(1);
    }
    const lensMode = normalizeLensMode(args.lens || args.mode || 'decision');
    const expected = cleanText(args.expected || '', 1200);
    try {
      const contexts = personaIds.map((id) => loadPersonaContext(id));
      for (const ctx of contexts) {
        const gate = evaluateSoulTokenAccess(ctx, issue);
        if (!gate.ok) {
          process.stderr.write(`${gate.reason}\n`);
          process.stderr.write(`persona:${ctx.personaId}\n`);
          process.exit(1);
        }
      }
      const rendered = renderMultiPersonaMarkdown(
        issue,
        contexts,
        lensMode,
        emotionEnabled,
        valuesEnabled,
        includeFeedFlag,
        expected,
        surpriseEnabled,
        surpriseSeed,
        contextBudgetPolicy,
        'arbitrate'
      );
      appendPersonaTelemetry({
        metric: 'persona_arbitration_resolution',
        persona_id: personaIds.join(','),
        issue_hash: crypto.createHash('sha256').update(issue, 'utf8').digest('hex').slice(0, 16),
        arbitration_winner: rendered.winner || 'none',
        arbitration_rule: cleanText(rendered.arbitration.rule || 'unknown', 120),
        disagreement: rendered.disagreement ? 1 : 0,
        max_divergence: Number(rendered.maxDivergence.toFixed(4)),
        surprising: rendered.surprising ? 1 : 0
      });
      const suggestedResolution = rendered.winner
        ? cleanText(rendered.finalPosition || '', 1600)
        : 'blocked: no deterministic arbitration winner';
      const report = {
        ok: Boolean(rendered.winner),
        type: 'persona_arbitration',
        issue,
        participants: personaIds,
        domain: rendered.domain,
        disagreement: rendered.disagreement,
        max_divergence: Number(rendered.maxDivergence.toFixed(4)),
        arbitration: rendered.arbitration,
        winner: rendered.winner,
        suggested_resolution: suggestedResolution,
        persona_positions: (rendered.details || []).map((row: any) => ({
          persona_id: row.persona_id,
          recommendation: cleanText(row.recommendation, 1400),
          recall: Array.isArray(row.recall) ? row.recall.slice(0, 3) : []
        }))
      };
      if (toBool(args.json, false) || outputSchema === 'json') {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        const lines = [
          `Consulting personas: ${personaIds.join(', ')}`,
          `Consulting arbitration priority stack from ${path.relative(ROOT, PERSONA_ARBITRATION_RULES_PATH).replace(/\\/g, '/')}`,
          rendered.winner
            ? `${rendered.winner} wins (${rendered.arbitration.rule})`
            : `No winner (${rendered.arbitration.rule})`,
          `Suggested resolution: ${suggestedResolution}`,
          '',
          rendered.markdown
        ];
        process.stdout.write(`${lines.join('\n')}\n`);
      }
      if (!rendered.winner && loadArbitrationRules().conflicting_rules_fail_closed) {
        process.stderr.write('persona_arbitration_fail_closed\n');
        process.exit(1);
      }
      process.exit(0);
    } catch (err: any) {
      const msg = cleanText(err && err.message || 'persona_arbitration_failed', 260);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  }

  if (!args.persona) {
    const tokens = Array.isArray(args._) ? args._.map((row) => cleanText(row, 120)).filter(Boolean) : [];
    const multiPersonaIds: string[] = [];
    let tokenIdx = 0;
    while (tokenIdx < tokens.length) {
      const token = tokens[tokenIdx];
      const normalized = normalizeToken(token, 80);
      if (['decision', 'strategic', 'full'].includes(normalized)) break;
      const resolved = resolvePersonaId(token);
      if (!resolved) break;
      if (!multiPersonaIds.includes(resolved)) {
        multiPersonaIds.push(resolved);
      }
      tokenIdx += 1;
    }

    if (multiPersonaIds.length >= 2) {
      const modeToken = normalizeToken(tokens[tokenIdx] || '', 40);
      const modeFromPositional = ['decision', 'strategic', 'full'].includes(modeToken);
      const multiLensMode = normalizeLensMode(args.lens || args.mode || (modeFromPositional ? modeToken : 'decision'));
      const queryArg = cleanText(
        args.query
          || args.q
          || (modeFromPositional ? tokens.slice(tokenIdx + 1).join(' ') : tokens.slice(tokenIdx).join(' ')),
        2000
      );
      if (!queryArg) {
        usage();
        process.exit(1);
      }
      const expected = cleanText(args.expected || '', 1200);
      const includeFeedRequested = (args['include-feed'] != null || args.include_feed != null)
        ? includeFeedFlag
        : true;
      try {
        const contexts = multiPersonaIds.map((id) => loadPersonaContext(id));
        for (const ctx of contexts) {
          const gate = evaluateSoulTokenAccess(ctx, queryArg);
          if (!gate.ok) {
            process.stderr.write(`${gate.reason}\n`);
            process.stderr.write(`persona:${ctx.personaId}\n`);
            process.exit(1);
          }
        }
        let includeSystemPassed = includeFeedRequested;
        const includeFailures: Array<{ persona_id: string, reason: string }> = [];
        if (includeSystemPassed) {
          for (const ctx of contexts) {
            const access = evaluateSystemPassedAccess(ctx, true);
            if (!access.ok) {
              includeSystemPassed = false;
              includeFailures.push({
                persona_id: ctx.personaId,
                reason: cleanText(access.reason || 'system_pass_blocked', 120)
              });
            }
          }
        }
        const rendered = renderMultiPersonaMarkdown(
          queryArg,
          contexts,
          multiLensMode,
          emotionEnabled,
          valuesEnabled,
          includeSystemPassed,
          expected,
          surpriseEnabled,
          surpriseSeed,
          contextBudgetPolicy,
          'multi_persona'
        );
        const prelude: string[] = [];
        if (includeFailures.length) {
          prelude.push(`> System-passed feed auto-disabled for this run: ${includeFailures.map((row) => `${row.persona_id}(${row.reason})`).join(', ')}`);
          prelude.push('');
        }
        const markdown = `${prelude.join('\n')}${rendered.markdown}`;
        appendPersonaTelemetry({
          metric: 'multi_persona_disagreement_rate',
          persona_id: multiPersonaIds.join(','),
          disagreement: rendered.disagreement ? 1 : 0,
          max_divergence: Number(rendered.maxDivergence.toFixed(4)),
          arbitration_winner: rendered.winner || 'none',
          arbitration_rule: cleanText(rendered.arbitration.rule || 'unknown', 120),
          surprise_score: Number(rendered.surpriseScore.toFixed(4)),
          surprising: rendered.surprising ? 1 : 0,
          include_feed: includeSystemPassed ? 1 : 0,
          query_hash: crypto.createHash('sha256').update(queryArg, 'utf8').digest('hex').slice(0, 16)
        });
        if (outputSchema === 'json' || toBool(args.json, false)) {
          const payload = {
            ok: Boolean(rendered.winner),
            schema: 'persona_multi_lens_v1',
            query: queryArg,
            lens_mode: multiLensMode,
            participants: multiPersonaIds,
            disagreement: rendered.disagreement,
            max_divergence: Number(rendered.maxDivergence.toFixed(4)),
            domain: rendered.domain,
            arbitration: rendered.arbitration,
            winner: rendered.winner,
            suggested_resolution: cleanText(rendered.finalPosition || '', 1600),
            surprise: {
              score: Number(rendered.surpriseScore.toFixed(4)),
              surprising: rendered.surprising
            },
            persona_outputs: (rendered.details || []).map((row: any) => buildStructuredPersonaOutput({
              personaId: cleanText(row.persona_id || 'unknown', 120),
              recommendation: cleanText(row.recommendation || '', 1600),
              reasoning: Array.isArray(row.reasoning) ? row.reasoning : [],
              query: queryArg,
              lensMode: multiLensMode,
              surprise: {
                enabled: surpriseEnabled,
                applied: Boolean(row && row.surprise && row.surprise.applied),
                mode: cleanText(row && row.surprise && row.surprise.mode || 'none', 80),
                roll: Number(row && row.surprise && row.surprise.roll || 0)
              },
              systemPassed: {
                total: includeSystemPassed ? 1 : 0,
                verified: includeSystemPassed ? 1 : 0,
                invalid: 0
              },
              context_budget: row && row.context_budget ? row.context_budget : undefined
            }))
          };
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          process.stdout.write(`${markdown}\n`);
        }
        if (!rendered.winner && loadArbitrationRules().conflicting_rules_fail_closed) {
          process.stderr.write('multi_persona_arbitration_fail_closed\n');
          process.exit(1);
        }
        process.exit(0);
      } catch (err: any) {
        const msg = cleanText(err && err.message || 'persona_lens_multi_failed', 260);
        process.stderr.write(`${msg}\n`);
        process.exit(1);
      }
    }
  }

  const positionalLens = normalizeToken(args._[1] || '', 40);
  const positionalHasLens = ['decision', 'strategic', 'full'].includes(positionalLens);
  const lensMode = normalizeLensMode(args.lens || args.mode || (positionalHasLens ? positionalLens : 'decision'));
  const controls = readLensControls(args);
  const queryArg = cleanText(
    args.query
      || args.q
      || (positionalHasLens ? args._.slice(2).join(' ') : (args._.length > 1 ? args._.slice(1).join(' ') : '')),
    2000
  );
  if (!personaArg || !queryArg) {
    usage();
    process.exit(1);
  }

  if (normalizeToken(personaArg, 120) === 'all') {
    if (controls.interceptText) {
      process.stderr.write('intercept_not_supported_for_all_personas\n');
      process.exit(1);
    }
    const personaIds = listPersonaIds();
    if (!personaIds.length) {
      process.stderr.write('no_personas_available\n');
      process.exit(1);
    }
    try {
      const contexts = personaIds.map((personaId) => loadPersonaContext(personaId));
      let verifiedTotal = 0;
      let invalidTotal = 0;
      for (const ctx of contexts) {
        const feedAccess = evaluateSystemPassedAccess(ctx, includeFeedFlag);
        if (!feedAccess.ok) {
          process.stderr.write(`${feedAccess.reason}\n`);
          process.stderr.write(`persona:${ctx.personaId}\n`);
          process.exit(1);
        }
        verifiedTotal += Number(feedAccess.verified || 0);
        invalidTotal += Number(feedAccess.invalid || 0);
      }
      for (const ctx of contexts) {
        const gate = evaluateSoulTokenAccess(ctx, queryArg);
        if (!gate.ok) {
          process.stderr.write(`${gate.reason}\n`);
          process.stderr.write(`persona:${ctx.personaId}\n`);
          process.exit(1);
        }
      }
      if (controls.gapSeconds > 0) {
        const probe = contexts[0];
        const details = buildResponseDetails(
          probe.personaId,
          probe.personaName,
          queryArg,
          probe.profileMd,
          probe.correspondenceMd,
          probe.decisionLensMd,
          probe.strategicLensMd,
          lensMode,
        emotionEnabled ? probe.emotionLensMd : '',
          valuesEnabled ? probe.valuesLensMd : '',
          probe.feedMd,
          probe.memoryMd,
          includeFeedFlag,
          surpriseEnabled,
          surpriseSeed,
          contextBudgetPolicy,
          probe,
          'all_preview'
        );
        const preview = renderStreamPreview('All Personas', queryArg, details.reasoning, controls);
        process.stdout.write(`${preview}\n\n`);
        sleepMs(controls.gapSeconds * 1000);
      }
      const markdown = renderAllMarkdown(
        queryArg,
        contexts,
        lensMode,
        controls,
        emotionEnabled,
        valuesEnabled,
        includeFeedFlag,
        surpriseEnabled,
        surpriseSeed,
        contextBudgetPolicy,
        'all_personas'
      );
      const utilityRate = includeFeedFlag
        ? Number((verifiedTotal / Math.max(1, contexts.length * 3)).toFixed(4))
        : 0;
      appendPersonaTelemetry({
        metric: 'passed_data_utility_rate',
        persona_id: 'all',
        include_feed: includeFeedFlag,
        passed_entries_verified: verifiedTotal,
        passed_entries_invalid: invalidTotal,
        passed_data_utility_rate: utilityRate,
        query_hash: crypto.createHash('sha256').update(queryArg, 'utf8').digest('hex').slice(0, 16)
      });
      if (outputSchema === 'json' || toBool(args.json, false)) {
        const personaOutputs = contexts.map((ctx) => {
          const info = buildResponseDetails(
            ctx.personaId,
            ctx.personaName,
            queryArg,
            ctx.profileMd,
            ctx.correspondenceMd,
            ctx.decisionLensMd,
            ctx.strategicLensMd,
            lensMode,
            emotionEnabled ? ctx.emotionLensMd : '',
            valuesEnabled ? ctx.valuesLensMd : '',
            ctx.feedMd,
            ctx.memoryMd,
            includeFeedFlag,
            surpriseEnabled,
            surpriseSeed,
            contextBudgetPolicy,
            ctx,
            'all_json'
          );
          return buildStructuredPersonaOutput({
            personaId: ctx.personaId,
            recommendation: info.recommendation,
            reasoning: info.reasoning,
            query: queryArg,
            lensMode,
            surprise: {
              enabled: surpriseEnabled,
              applied: Boolean(info.surpriseApplied),
              mode: cleanText(info.surpriseMode || 'none', 80),
              roll: Number(info.surpriseRoll || 0)
            },
            systemPassed: info.systemPassed,
            context_budget: info.contextBudget
          });
        });
        process.stdout.write(`${JSON.stringify({
          ok: true,
          schema: 'persona_lens_all_v1',
          query: queryArg,
          lens_mode: lensMode,
          include_feed: includeFeedFlag,
          surprise_mode: surpriseEnabled ? 'on' : 'off',
          persona_outputs: personaOutputs
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`${markdown}\n`);
      }
      process.exit(0);
    } catch (err: any) {
      const msg = cleanText(err && err.message || 'persona_lens_all_failed', 260);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  }

  const personaId = resolvePersonaId(personaArg);
  if (!personaId) {
    const known = listPersonaIds();
    process.stderr.write(`unknown_persona:${personaArg}\n`);
    if (known.length) {
      process.stderr.write(`known_personas:${known.join(', ')}\n`);
    }
    process.exit(1);
  }

  try {
    let ctx = loadPersonaContext(personaId);
    const gate = evaluateSoulTokenAccess(ctx, queryArg);
    if (!gate.ok) {
      process.stderr.write(`${gate.reason}\n`);
      process.stderr.write(`persona:${ctx.personaId}\n`);
      process.exit(1);
    }
    const feedAccess = evaluateSystemPassedAccess(ctx, includeFeedFlag);
    if (!feedAccess.ok) {
      process.stderr.write(`${feedAccess.reason}\n`);
      process.stderr.write(`persona:${ctx.personaId}\n`);
      process.exit(1);
    }
    const includeFeedActive = includeFeedFlag && feedAccess.include;

    const details = buildResponseDetails(
      ctx.personaId,
      ctx.personaName,
      queryArg,
      ctx.profileMd,
      ctx.correspondenceMd,
      ctx.decisionLensMd,
      ctx.strategicLensMd,
      lensMode,
      emotionEnabled ? ctx.emotionLensMd : '',
      valuesEnabled ? ctx.valuesLensMd : '',
      ctx.feedMd,
      ctx.memoryMd,
      includeFeedActive,
      surpriseEnabled,
      surpriseSeed,
      contextBudgetPolicy,
      ctx,
      'single_persona'
    );
    const llmResult = resolvePersonaLlmRecommendation(
      ctx,
      queryArg,
      details.promptTemplate,
      details.recommendation
    );
    if (llmResult.recommendation) {
      details.recommendation = llmResult.recommendation;
    }

    const gapResult = await runCognizanceGap(
      ctx.personaName,
      queryArg,
      details.reasoning,
      details.recommendation,
      controls,
      true
    );
    const renderControls: LensControls = {
      ...controls,
      alignmentMode: gapResult.alignmentMode,
      interceptText: gapResult.finalOverride
    };

    let interceptLogPath = '';
    if (gapResult.intercepted && cleanText(gapResult.finalOverride, 10)) {
      const receipt = appendInterceptionToCorrespondence(ctx, queryArg, gapResult.finalOverride, renderControls);
      interceptLogPath = receipt.correspondencePath;
      ctx = loadPersonaContext(personaId);
    }

    const markdown = renderMarkdownResponse(
      ctx,
      queryArg,
      lensMode,
      emotionEnabled ? ctx.emotionLensMd : '',
      renderControls,
      gapResult.finalOverride,
      interceptLogPath,
      emotionEnabled,
      valuesEnabled,
      includeFeedActive,
      llmResult,
      surpriseEnabled,
      surpriseSeed,
      contextBudgetPolicy,
      'single_persona'
    );
    const utilityRate = includeFeedActive
      ? Number((Number(details.systemPassed && details.systemPassed.verified || 0) / Math.max(1, details.reasoning.length)).toFixed(4))
      : 0;
    appendPersonaTelemetry({
      metric: 'passed_data_utility_rate',
      persona_id: ctx.personaId,
      include_feed: includeFeedActive,
      passed_entries_verified: Number(details.systemPassed && details.systemPassed.verified || 0),
      passed_entries_invalid: Number(details.systemPassed && details.systemPassed.invalid || 0),
      passed_data_utility_rate: utilityRate,
      recommendation_impacted: includeFeedActive && String(details.recommendation || '').includes('System-passed context:') ? 1 : 0,
      query_hash: crypto.createHash('sha256').update(queryArg, 'utf8').digest('hex').slice(0, 16)
    });
    if (outputSchema === 'json' || toBool(args.json, false)) {
      const structured = buildStructuredPersonaOutput({
        personaId: ctx.personaId,
        recommendation: cleanText(gapResult.finalOverride, 1600) || cleanText(details.recommendation, 1600),
        reasoning: details.reasoning,
        query: queryArg,
        lensMode,
        surprise: {
          enabled: surpriseEnabled,
          applied: Boolean(details.surpriseApplied),
          mode: cleanText(details.surpriseMode || 'none', 80),
          roll: Number(details.surpriseRoll || 0)
        },
        systemPassed: details.systemPassed,
        context_budget: details.contextBudget
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        ...structured,
        prompt_template: details.promptTemplate,
        recent_correspondence: (details.recentCorrespondence || []).map((row: any) => ({
          date: cleanText(row && row.date || '', 20),
          topic: cleanText(row && row.topic || '', 120),
          body: cleanText(row && row.body || '', 240)
        })),
        llm: {
          enabled: Boolean(llmResult && llmResult.enabled),
          used: Boolean(llmResult && llmResult.used),
          reason: cleanText(llmResult && llmResult.reason || 'none', 160),
          model: cleanText(llmResult && llmResult.model || 'n/a', 120)
        },
        intercept: {
          applied: Boolean(gapResult.intercepted),
          approved_early: Boolean(gapResult.approvedEarly),
          log_path: interceptLogPath || null
        }
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${markdown}\n`);
    }
    process.exit(0);
  } catch (err: any) {
    const msg = cleanText(err && err.message || 'persona_lens_failed', 260);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}

main().catch((err: any) => {
  const msg = cleanText(err && err.message || 'persona_lens_unhandled_error', 260);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
