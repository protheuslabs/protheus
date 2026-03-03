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
  console.log('  protheus lens <persona> <decision|strategic|full> "<query>"');
  console.log('  protheus lens <persona> [decision|strategic|full] --gap=<seconds> [--active=1] [--emotion=on|off] [--intercept="<override>"] "<query>"');
  console.log('  protheus lens update-stream <persona> [--dry-run=1]');
  console.log('  protheus lens checkin [--persona=jay_haslam] [--heartbeat=HEARTBEAT.md] [--emotion=on|off] [--dry-run=1]');
  console.log('  protheus lens all "<query>"');
  console.log('  protheus lens --persona=<persona> --lens=<decision|strategic|full> --query="<query>"');
  console.log('  protheus lens --list');
  console.log('');
  console.log('Examples:');
  console.log('  protheus lens vikram "Should we prioritize memory or security first?"');
  console.log('  protheus lens vikram strategic "How does this sprint support the singularity seed?"');
  console.log('  protheus lens jay_haslam "How can we reduce drift in the loops?"');
  console.log('  protheus lens vikram --gap=10 --active=1 --emotion=off --intercept="Prioritize memory first, with security gate pre-dispatch." "Prioritize memory or security?"');
  console.log('  protheus lens update-stream vikram_menon');
  console.log('  protheus lens checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md');
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
  strategicLensPath: string | null
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
  const dataStreamsPath = path.join(personaDir, 'data_streams.md');
  const soulTokenPath = path.join(personaDir, 'soul_token.md');
  const decisionLensMd = readFileRequired(decisionLensPath);
  const strategicLensMd = strategicLensPath ? readFileOptional(strategicLensPath) : '';
  const emotionLensMd = readFileOptional(path.join(personaDir, 'emotion_lens.md'));
  const dataStreamsMd = readFileRequired(dataStreamsPath);
  const soulTokenMd = readFileRequired(soulTokenPath);
  const personaName = extractTitle(profileMd, personaId);
  return {
    personaId,
    personaName,
    profileMd,
    correspondenceMd,
    correspondencePath: path.relative(ROOT, correspondencePath).replace(/\\/g, '/'),
    decisionLensMd,
    strategicLensMd,
    emotionLensMd,
    dataStreamsMd,
    dataStreamsPath: path.relative(ROOT, dataStreamsPath).replace(/\\/g, '/'),
    soulTokenMd,
    soulTokenPath: path.relative(ROOT, soulTokenPath).replace(/\\/g, '/'),
    decisionLensPath: path.relative(ROOT, decisionLensPath).replace(/\\/g, '/'),
    strategicLensPath: strategicLensPath ? path.relative(ROOT, strategicLensPath).replace(/\\/g, '/') : null
  };
}

type SoulTokenPolicy = {
  tokenId: string,
  owner: string,
  integrityMode: 'advisory' | 'enforce',
  bundleHash: string,
  usageRules: string[]
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
    ['emotion_lens.md', ctx.emotionLensMd],
    ['data_streams.md', ctx.dataStreamsMd]
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
  return {
    tokenId,
    owner,
    integrityMode,
    bundleHash,
    usageRules
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

function updateStreamForPersona(personaId: string, dryRun = false) {
  const ctx = loadPersonaContext(personaId);
  const sources = streamSources(ctx.dataStreamsMd);
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
    const base = String(fs.readFileSync(abs, 'utf8') || '').replace(/\s+$/, '');
    fs.writeFileSync(abs, `${base}\n${entry}`, 'utf8');
    const refreshed = loadPersonaContext(personaId);
    const newHash = refreshSoulTokenBundleHash(refreshed);
    return {
      ok: true,
      type: 'persona_stream_update',
      persona_id: personaId,
      dry_run: false,
      updated_correspondence: refreshed.correspondencePath,
      updated_soul_token: refreshed.soulTokenPath,
      stream_sources: sources,
      bundle_hash: newHash
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

  const correspondenceAbs = path.join(ROOT, ctx.correspondencePath);
  const base = String(fs.readFileSync(correspondenceAbs, 'utf8') || '').replace(/\s+$/, '');
  fs.writeFileSync(correspondenceAbs, `${base}\n${entry}`, 'utf8');

  const refreshed = loadPersonaContext(ctx.personaId);
  const newHash = refreshSoulTokenBundleHash(refreshed);
  return {
    correspondencePath: refreshed.correspondencePath,
    soulTokenPath: refreshed.soulTokenPath,
    bundleHash: newHash
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

  const correspondenceAbs = path.join(ROOT, ctx.correspondencePath);
  const base = String(fs.readFileSync(correspondenceAbs, 'utf8') || '').replace(/\s+$/, '');
  fs.writeFileSync(correspondenceAbs, `${base}\n${entry}`, 'utf8');

  const refreshed = loadPersonaContext(ctx.personaId);
  const newHash = refreshSoulTokenBundleHash(refreshed);
  return {
    correspondencePath: refreshed.correspondencePath,
    soulTokenPath: refreshed.soulTokenPath,
    bundleHash: newHash,
    heartbeatPath: relHeartbeat || 'HEARTBEAT.md'
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

function buildResponseDetails(
  personaName: string,
  query: string,
  profileMd: string,
  correspondenceMd: string,
  decisionLensMd: string,
  strategicLensMd: string,
  lensMode: LensMode,
  emotionLensMd = ''
) {
  const decisionFilters = extractListItems(decisionLensMd, 4);
  const strategicFilters = extractListItems(strategicLensMd, 4);
  const nonNegotiables = extractListItems(decisionLensMd.split('## Non-Negotiables')[1] || '', 4);
  const strategicAnchors = extractListItems(strategicLensMd.split('## Strategic Anchors')[1] || '', 3);
  const correspondenceHighlights = extractListItems(correspondenceMd, 3);
  const profileHighlights = extractListItems(profileMd, 3);
  const emotionSignals = extractListItems(emotionLensMd, 2);
  const modeText = lensMode === 'full' ? 'decision + strategic' : lensMode;
  const promptTemplate = `As ${personaName}, using your profile, ${modeText} lens, and past correspondence, respond to: ${query}`;
  const recommendation = recommendFromQuery(personaName, query);
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
    ...nonNegotiables.map((v) => `Constraint: ${v}`),
    ...correspondenceHighlights.map((v) => `Prior correspondence: ${v}`),
    ...profileHighlights.map((v) => `Profile context: ${v}`)
  ].slice(0, 10);
  return {
    promptTemplate,
    recommendation,
    reasoning
  };
}

function renderMarkdownResponse(
  personaId: string,
  personaName: string,
  query: string,
  profileMd: string,
  correspondenceMd: string,
  decisionLensMd: string,
  strategicLensMd: string,
  lensMode: LensMode,
  emotionLensMd = '',
  controls: LensControls | null = null,
  overridePosition = '',
  interceptReceiptPath = '',
  emotionEnabled = true
): string {
  const {
    promptTemplate,
    recommendation,
    reasoning
  } = buildResponseDetails(
    personaName,
    query,
    profileMd,
    correspondenceMd,
    decisionLensMd,
    strategicLensMd,
    lensMode,
    emotionLensMd
  );
  const resolvedRecommendation = cleanText(overridePosition, 1600) || recommendation;

  const lines: string[] = [];
  lines.push(`# Lens Response: ${personaName}`);
  lines.push('');
  lines.push(`**Persona ID:** \`${personaId}\``);
  lines.push(`**Lens Mode:** \`${lensMode}\``);
  lines.push(`**Emotion Lens:** \`${emotionEnabled ? 'on' : 'off'}\``);
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
  lines.push(`- \`personas/${personaId}/profile.md\``);
  lines.push(`- \`personas/${personaId}/correspondence.md\``);
  lines.push(`- \`personas/${personaId}/decision_lens.md\``);
  if (lensMode !== 'decision' && cleanText(strategicLensMd, 8)) {
    lines.push(`- \`personas/${personaId}/strategic_lens.md\``);
  }
  if (cleanText(emotionLensMd, 8)) {
    lines.push(`- \`personas/${personaId}/emotion_lens.md\``);
  }
  lines.push(`- \`personas/${personaId}/data_streams.md\``);
  lines.push(`- \`personas/${personaId}/soul_token.md\``);
  lines.push('');
  return lines.join('\n');
}

function renderMarkdownSection(ctx: PersonaContext, query: string, lensMode: LensMode, emotionEnabled = true): string {
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
    emotionMd
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
  if (emotionEnabled && cleanText(ctx.emotionLensMd, 8)) {
    lines.push(`- \`personas/${ctx.personaId}/emotion_lens.md\``);
  }
  lines.push(`- \`personas/${ctx.personaId}/data_streams.md\``);
  lines.push(`- \`personas/${ctx.personaId}/soul_token.md\``);
  lines.push('');
  return lines.join('\n');
}

function renderAllMarkdown(
  query: string,
  contexts: PersonaContext[],
  lensMode: LensMode,
  controls: LensControls | null = null,
  emotionEnabled = true
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
  lines.push('');
  for (const ctx of contexts) {
    lines.push(renderMarkdownSection(ctx, query, lensMode, emotionEnabled));
  }
  return lines.join('\n');
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
  const personaArg = cleanText(args.persona || args._[0] || '', 120);
  const isUpdateStream = normalizeToken(args._[0] || '', 40) === 'update_stream' || normalizeToken(args._[0] || '', 40) === 'update-stream';
  const isCheckin = normalizeToken(args._[0] || '', 40) === 'checkin';
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
  if (isCheckin) {
    const checkinPersonaRaw = cleanText(args.persona || 'jay_haslam', 120);
    const checkinPersonaId = resolvePersonaId(checkinPersonaRaw);
    if (!checkinPersonaId) {
      process.stderr.write(`unknown_persona:${checkinPersonaRaw}\n`);
      process.exit(1);
    }
    try {
      const ctx = loadPersonaContext(checkinPersonaId);
      const heartbeatPathAbs = resolveHeartbeatPath(args.heartbeat || args['heartbeat-path'] || args.heartbeat_path);
      const heartbeatSnapshot = readFileOptional(heartbeatPathAbs);
      const query = buildCheckinQuery(heartbeatSnapshot);
      const gate = evaluateSoulTokenAccess(ctx, query);
      if (!gate.ok) {
        process.stderr.write(`${gate.reason}\n`);
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
        emotionEnabled ? ctx.emotionLensMd : ''
      );
      const dryRun = toBool(args['dry-run'], false);
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
      }
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(0);
    } catch (err: any) {
      const msg = cleanText(err && err.message || 'persona_checkin_failed', 260);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
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
          emotionEnabled ? probe.emotionLensMd : ''
        );
        const preview = renderStreamPreview('All Personas', queryArg, details.reasoning, controls);
        process.stdout.write(`${preview}\n\n`);
        sleepMs(controls.gapSeconds * 1000);
      }
      const markdown = renderAllMarkdown(queryArg, contexts, lensMode, controls, emotionEnabled);
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

    const details = buildResponseDetails(
      ctx.personaName,
      queryArg,
      ctx.profileMd,
      ctx.correspondenceMd,
      ctx.decisionLensMd,
      ctx.strategicLensMd,
      lensMode,
      emotionEnabled ? ctx.emotionLensMd : ''
    );

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
      ctx.personaId,
      ctx.personaName,
      queryArg,
      ctx.profileMd,
      ctx.correspondenceMd,
      ctx.decisionLensMd,
      ctx.strategicLensMd,
      lensMode,
      emotionEnabled ? ctx.emotionLensMd : '',
      renderControls,
      gapResult.finalOverride,
      interceptLogPath,
      emotionEnabled
    );
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
