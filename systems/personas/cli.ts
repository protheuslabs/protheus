#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');
const PERSONA_ORG_DIR = path.join(PERSONAS_DIR, 'organization');
const PERSONA_TELEMETRY_PATH = path.join(PERSONA_ORG_DIR, 'telemetry.jsonl');
const PERSONA_TRIGGERS_PATH = path.join(PERSONA_ORG_DIR, 'triggers.md');
const PERSONA_ARBITRATION_RULES_PATH = path.join(PERSONA_ORG_DIR, 'arbitration_rules.json');
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
type AlignmentMode = 'yellow_auto' | 'green_active';
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

function usage() {
  console.log('Usage:');
  console.log('  protheus lens <persona> "<query>"');
  console.log('  protheus lens <persona1> <persona2> [personaN...] "<query>" [--expected="<text>"]');
  console.log('  protheus lens <persona> <decision|strategic|full> "<query>"');
  console.log('  protheus lens <persona> [decision|strategic|full] --gap=<seconds> [--active=1] [--emotion=on|off] [--values=on|off] [--include-feed=1] [--intercept="<override>"] "<query>"');
  console.log('  protheus lens trigger <pre-sprint|drift-alert|weekly-checkin> ["<query>"] [--persona=<id>] [--heartbeat=HEARTBEAT.md] [--dry-run=1]');
  console.log('  protheus lens dashboard [--window=<n>] [--json=1]');
  console.log('  protheus lens update-stream <persona> [--dry-run=1]');
  console.log('  protheus lens checkin [--persona=jay_haslam] [--heartbeat=HEARTBEAT.md] [--emotion=on|off] [--dry-run=1]');
  console.log('  protheus lens feed <persona> "<snippet>" [--source=master_llm] [--tags=tag1,tag2] [--dry-run=1]');
  console.log('  protheus lens all "<query>"');
  console.log('  protheus lens --persona=<persona> --lens=<decision|strategic|full> --query="<query>"');
  console.log('  protheus lens --list');
  console.log('');
  console.log('Examples:');
  console.log('  protheus lens vikram "Should we prioritize memory or security first?"');
  console.log('  protheus lens vikram rohan "Prioritize memory or security first?" --expected="Prioritize memory core determinism first."');
  console.log('  protheus lens vikram strategic "How does this sprint support the singularity seed?"');
  console.log('  protheus lens jay_haslam "How can we reduce drift in the loops?"');
  console.log('  protheus lens trigger pre-sprint "Foundation Lock sprint planning review"');
  console.log('  protheus lens dashboard --window=20');
  console.log('  protheus lens vikram --gap=10 --active=1 --emotion=off --values=on --include-feed=1 --intercept="Prioritize memory first, with security gate pre-dispatch." "Prioritize memory or security?"');
  console.log('  protheus lens update-stream vikram_menon');
  console.log('  protheus lens checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md');
  console.log('  protheus lens feed vikram_menon "Cross-signal indicates rising security drift risk." --source=master_llm --tags=drift,security');
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
  const hasher = crypto.createHash('sha256');
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
    false
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

function recommendFromQuery(personaName: string, query: string): string {
  const lower = String(query || '').toLowerCase();
  if (lower.includes('memory') && lower.includes('security') && (lower.includes('first') || lower.includes('priorit'))) {
    const persona = normalizeToken(personaName, 80);
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
  return `Use ${personaName}'s lens to execute the smallest reversible change that strengthens determinism, security posture, and test evidence.`;
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
  includeSystemPassedFeed = false
) {
  const decisionFilters = extractListItems(decisionLensMd, 4);
  const strategicFilters = extractListItems(strategicLensMd, 4);
  const valuesFilters = extractListItems(valuesLensMd, 4);
  const nonNegotiables = extractListItems(decisionLensMd.split('## Non-Negotiables')[1] || '', 4);
  const strategicAnchors = extractListItems(strategicLensMd.split('## Strategic Anchors')[1] || '', 3);
  const valuesAnchors = extractListItems(valuesLensMd.split('## Values Anchors')[1] || '', 3);
  const correspondenceHighlights = extractListItems(correspondenceMd, 3);
  const profileHighlights = extractListItems(profileMd, 3);
  const emotionSignals = extractListItems(emotionLensMd, 2);
  const feedSignals = extractRecentFeedSignals(feedMd, 3);
  const systemPassed = includeSystemPassedFeed
    ? parseSystemPassedSignals(feedMd, 3)
    : { total: 0, verified: 0, invalid: 0, signals: [] as string[] };
  const memorySignals = extractMemoryRecallSignals(memoryMd, query, 3);
  const modeText = lensMode === 'full' ? 'decision + strategic' : lensMode;
  const promptTemplate = `As ${personaName}, using your profile, ${modeText} lens, and past correspondence, respond to: ${query}`;
  let recommendation = recommendFromQuery(personaName, query);
  if (includeSystemPassedFeed && systemPassed.signals.length) {
    const firstSignal = cleanText(systemPassed.signals[0].replace(/^SystemPassed:\s*/, ''), 180);
    recommendation = `${recommendation} System-passed context: ${firstSignal}.`;
  }
  const lensReasoning = lensMode === 'strategic'
    ? strategicFilters.map((v) => `Strategic filter: ${v}`)
    : lensMode === 'full'
      ? [
          ...decisionFilters.map((v) => `Decision filter: ${v}`),
          ...strategicFilters.map((v) => `Strategic filter: ${v}`)
        ]
      : decisionFilters.map((v) => `Decision filter: ${v}`);
  const strategicReasoning = lensMode === 'decision'
    ? []
    : strategicAnchors.map((v) => `Strategic anchor: ${v}`);
  const reasoning = [
    ...lensReasoning,
    ...emotionSignals.map((v) => `Emotion signal: ${v}`),
    ...strategicReasoning,
    ...valuesFilters.map((v) => `Values filter: ${v}`),
    ...valuesAnchors.map((v) => `Values anchor: ${v}`),
    ...feedSignals,
    ...systemPassed.signals,
    ...memorySignals,
    ...nonNegotiables.map((v) => `Constraint: ${v}`),
    ...correspondenceHighlights.map((v) => `Prior correspondence: ${v}`),
    ...profileHighlights.map((v) => `Profile context: ${v}`)
  ].slice(0, 10);
  return {
    promptTemplate,
    recommendation,
    reasoning,
    systemPassed
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
  llmMeta: { enabled: boolean, used: boolean, reason: string, model: string } | null = null
): string {
  const {
    promptTemplate,
    recommendation,
    reasoning
  } = buildResponseDetails(
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
    includeFeed
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
  includeFeed = false
): string {
  const emotionMd = emotionEnabled ? ctx.emotionLensMd : '';
  const {
    promptTemplate,
    recommendation,
    reasoning
  } = buildResponseDetails(
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
    includeFeed
  );

  const lines: string[] = [];
  lines.push(`## ${ctx.personaName} (\`${ctx.personaId}\`)`);
  lines.push('');
  lines.push(`**Lens Mode:** \`${lensMode}\``);
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
  includeFeed = false
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
  lines.push('');
  for (const ctx of contexts) {
    lines.push(renderMarkdownSection(ctx, query, lensMode, emotionEnabled, valuesEnabled, includeFeed));
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
  expected: string
) {
  const rules = loadArbitrationRules();
  const domain = inferArbitrationDomain(query);
  const details = contexts.map((ctx) => {
    const info = buildResponseDetails(
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
      includeFeed
    );
    return {
      persona_id: ctx.personaId,
      persona_name: ctx.personaName,
      recommendation: info.recommendation,
      reasoning: info.reasoning,
      recall: recallSignals(info.reasoning)
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
    disagreement,
    maxDivergence,
    arbitration,
    winner: winner ? winner.persona_id : null,
    surpriseScore,
    surprising
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
  const personaArg = cleanText(args.persona || args._[0] || '', 120);
  const isUpdateStream = normalizeToken(args._[0] || '', 40) === 'update_stream' || normalizeToken(args._[0] || '', 40) === 'update-stream';
  const isTrigger = normalizeToken(args._[0] || '', 40) === 'trigger';
  const isDashboard = normalizeToken(args._[0] || '', 40) === 'dashboard';
  const isCheckin = normalizeToken(args._[0] || '', 40) === 'checkin';
  const isFeed = normalizeToken(args._[0] || '', 40) === 'feed';
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
          renderAllMarkdown(query, fallbackContexts, 'decision', null, emotionEnabled, valuesEnabled, includeFeedForRun)
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
          true
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
            null
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
          expected
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
        process.stdout.write(`${markdown}\n`);
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
        includeFeedFlag
      );
        const preview = renderStreamPreview('All Personas', queryArg, details.reasoning, controls);
        process.stdout.write(`${preview}\n\n`);
        sleepMs(controls.gapSeconds * 1000);
      }
      const markdown = renderAllMarkdown(queryArg, contexts, lensMode, controls, emotionEnabled, valuesEnabled, includeFeedFlag);
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
      process.stdout.write(`${markdown}\n`);
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
      includeFeedActive
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
      llmResult
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
    process.stdout.write(`${markdown}\n`);
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
