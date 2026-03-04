#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const { createSpinner } = require('../ops/cli_ui.js');

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.PROTHEUS_ASSIMILATE_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_ASSIMILATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'assimilate_policy.json');
const STATE_DIR = process.env.PROTHEUS_ASSIMILATE_STATE_DIR
  ? path.resolve(process.env.PROTHEUS_ASSIMILATE_STATE_DIR)
  : path.join(ROOT, 'state', 'tools', 'assimilate');
const RUNS_DIR = path.join(STATE_DIR, 'runs');
const RECEIPTS_PATH = path.join(STATE_DIR, 'receipts.jsonl');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const PERSONA_CLI = path.join(ROOT, 'systems', 'personas', 'cli.js');
const RESEARCH_ORGAN_CLI = path.join(ROOT, 'systems', 'research', 'research_organ.js');
const PERSONA_TELEMETRY_PATH = path.join(ROOT, 'personas', 'organization', 'telemetry.jsonl');

const CORE_FIVE = ['vikram_menon', 'rohan_kapoor', 'priya_venkatesh', 'aarav_singh', 'li_wei'];

type AnyObj = Record<string, any>;

type AssimilatePolicy = {
  version: string,
  enabled: boolean,
  proposal_only: boolean,
  require_human_confirmation_for_execute: boolean,
  targets: {
    allow_local_paths: boolean,
    allow_web_urls: boolean,
    allowed_domains: string[],
    blocked_domains: string[],
    max_fetch_bytes: number,
    fetch_timeout_ms: number
  },
  extraction: {
    max_requirements: number,
    min_requirement_len: number,
    max_requirement_len: number
  },
  logging: {
    append_to_persona_correspondence: boolean,
    append_to_persona_feed: boolean,
    write_state_receipts: boolean
  }
};

function usage() {
  console.log('Usage:');
  console.log('  protheus assimilate <path|url> [--dry-run=1] [--format=json|markdown]');
  console.log('  protheus assimilate <path|url> --apply=1 --confirm-execution=1');
  console.log('');
  console.log('Examples:');
  console.log('  protheus assimilate ./docs/cognitive_toolkit.md');
  console.log('  protheus assimilate https://github.com/example/repo');
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 500) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
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

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sha256Hex(input: string | Buffer) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function parseJsonText(raw: unknown): AnyObj | null {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function prepareDryRunPersonaWorkspace() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-assimilate-personas-'));
  const srcPersonasDir = path.join(ROOT, 'personas');
  const dstPersonasDir = path.join(tmpRoot, 'personas');
  fs.mkdirSync(dstPersonasDir, { recursive: true });
  if (fs.existsSync(path.join(srcPersonasDir, 'organization'))) {
    fs.cpSync(path.join(srcPersonasDir, 'organization'), path.join(dstPersonasDir, 'organization'), { recursive: true });
  }
  for (const personaId of CORE_FIVE) {
    const src = path.join(srcPersonasDir, personaId);
    const dst = path.join(dstPersonasDir, personaId);
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }
  return tmpRoot;
}

function defaultPolicy(): AssimilatePolicy {
  return {
    version: '1.0',
    enabled: true,
    proposal_only: true,
    require_human_confirmation_for_execute: true,
    targets: {
      allow_local_paths: true,
      allow_web_urls: true,
      allowed_domains: [
        'github.com',
        'raw.githubusercontent.com',
        'x.com',
        'news.ycombinator.com',
        'example.com'
      ],
      blocked_domains: ['localhost', '127.0.0.1', '0.0.0.0', '::1'],
      max_fetch_bytes: 220000,
      fetch_timeout_ms: 12000
    },
    extraction: {
      max_requirements: 10,
      min_requirement_len: 16,
      max_requirement_len: 320
    },
    logging: {
      append_to_persona_correspondence: true,
      append_to_persona_feed: true,
      write_state_receipts: true
    }
  };
}

function normalizeDomainList(src: unknown, fallback: string[]) {
  if (!Array.isArray(src)) return fallback;
  return Array.from(new Set(src
    .map((v) => cleanText(v, 200).toLowerCase())
    .filter(Boolean)));
}

function loadPolicy(): AssimilatePolicy {
  const raw = readJson(POLICY_PATH, {});
  const base = defaultPolicy();
  const targets = raw.targets && typeof raw.targets === 'object' ? raw.targets : {};
  const extraction = raw.extraction && typeof raw.extraction === 'object' ? raw.extraction : {};
  const logging = raw.logging && typeof raw.logging === 'object' ? raw.logging : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    proposal_only: raw.proposal_only !== false,
    require_human_confirmation_for_execute: raw.require_human_confirmation_for_execute !== false,
    targets: {
      allow_local_paths: targets.allow_local_paths !== false,
      allow_web_urls: targets.allow_web_urls !== false,
      allowed_domains: normalizeDomainList(targets.allowed_domains, base.targets.allowed_domains),
      blocked_domains: normalizeDomainList(targets.blocked_domains, base.targets.blocked_domains),
      max_fetch_bytes: clampInt(targets.max_fetch_bytes, 1000, 5000000, base.targets.max_fetch_bytes),
      fetch_timeout_ms: clampInt(targets.fetch_timeout_ms, 500, 60000, base.targets.fetch_timeout_ms)
    },
    extraction: {
      max_requirements: clampInt(extraction.max_requirements, 1, 50, base.extraction.max_requirements),
      min_requirement_len: clampInt(extraction.min_requirement_len, 4, 120, base.extraction.min_requirement_len),
      max_requirement_len: clampInt(extraction.max_requirement_len, 20, 1200, base.extraction.max_requirement_len)
    },
    logging: {
      append_to_persona_correspondence: logging.append_to_persona_correspondence !== false,
      append_to_persona_feed: logging.append_to_persona_feed !== false,
      write_state_receipts: logging.write_state_receipts !== false
    }
  };
}

function isLikelyUrl(input: string) {
  return /^https?:\/\//i.test(input);
}

function isBlockedHost(hostname: string, blockedDomains: string[]) {
  const host = cleanText(hostname, 280).toLowerCase();
  if (!host) return true;
  if (blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^0\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

function isAllowedHost(hostname: string, allowedDomains: string[]) {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) return true;
  const host = cleanText(hostname, 280).toLowerCase();
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

function stripHtmlToText(raw: string) {
  const noScript = String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const titleMatch = noScript.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1], 240) : '';
  const text = noScript
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title,
    text
  };
}

function loadLocalTarget(targetInput: string, policy: AssimilatePolicy) {
  if (!policy.targets.allow_local_paths) {
    throw new Error('local_paths_disabled_by_policy');
  }
  const resolved = path.isAbsolute(targetInput)
    ? path.resolve(targetInput)
    : path.resolve(ROOT, targetInput);
  if (!fs.existsSync(resolved)) {
    throw new Error(`local_target_not_found:${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error('local_target_not_file');
  }
  const maxBytes = Number(policy.targets.max_fetch_bytes || 220000);
  const rawBuf = fs.readFileSync(resolved);
  const clipped = rawBuf.length > maxBytes ? rawBuf.subarray(0, maxBytes) : rawBuf;
  const raw = clipped.toString('utf8');
  const ext = path.extname(resolved).toLowerCase();
  const maybeHtml = ['.html', '.htm'].includes(ext);
  const parsed = maybeHtml ? stripHtmlToText(raw) : { title: '', text: raw };
  return {
    source_type: 'local_path',
    source: resolved,
    source_display: relPath(resolved),
    domain: null,
    title: parsed.title || path.basename(resolved),
    content_text: parsed.text,
    bytes: clipped.length,
    truncated: rawBuf.length > clipped.length,
    content_hash: sha256Hex(clipped)
  };
}

async function fetchWebTarget(targetInput: string, policy: AssimilatePolicy) {
  if (!policy.targets.allow_web_urls) {
    throw new Error('web_urls_disabled_by_policy');
  }
  let urlObj: URL;
  try {
    urlObj = new URL(targetInput);
  } catch {
    throw new Error('invalid_url');
  }
  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    throw new Error('unsupported_url_protocol');
  }
  const host = cleanText(urlObj.hostname, 280).toLowerCase();
  if (isBlockedHost(host, policy.targets.blocked_domains)) {
    throw new Error(`blocked_domain:${host}`);
  }
  if (!isAllowedHost(host, policy.targets.allowed_domains)) {
    throw new Error(`domain_not_allowlisted:${host}`);
  }

  const controller = new AbortController();
  const timeoutMs = Number(policy.targets.fetch_timeout_ms || 12000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(urlObj.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'protheus-assimilate/1.0 (+local)'
      }
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`fetch_failed:${response.status}`);
  }

  const maxBytes = Number(policy.targets.max_fetch_bytes || 220000);
  const rawText = await response.text();
  const rawBuf = Buffer.from(rawText, 'utf8');
  const clipped = rawBuf.length > maxBytes ? rawBuf.subarray(0, maxBytes) : rawBuf;
  const contentType = cleanText(response.headers.get('content-type') || '', 200).toLowerCase();
  const maybeHtml = contentType.includes('html') || /<html/i.test(rawText);
  const parsed = maybeHtml
    ? stripHtmlToText(clipped.toString('utf8'))
    : { title: '', text: clipped.toString('utf8') };

  return {
    source_type: 'web_url',
    source: urlObj.toString(),
    source_display: urlObj.toString(),
    domain: host,
    title: parsed.title || host,
    content_text: parsed.text,
    bytes: clipped.length,
    truncated: rawBuf.length > clipped.length,
    content_type: contentType,
    content_hash: sha256Hex(clipped)
  };
}

function extractRequirements(content: string, policy: AssimilatePolicy) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  const minLen = Number(policy.extraction.min_requirement_len || 16);
  const maxLen = Number(policy.extraction.max_requirement_len || 320);

  function push(line: string) {
    const trimmed = cleanText(line, maxLen);
    if (!trimmed || trimmed.length < minLen) return;
    const canonical = trimmed.toLowerCase();
    if (seen.has(canonical)) return;
    seen.add(canonical);
    out.push(trimmed);
  }

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    if (/^(?:[-*]|\d+[.)])\s+/.test(line)) {
      push(line.replace(/^(?:[-*]|\d+[.)])\s+/, ''));
      continue;
    }
    if (/^(?:requirement|requirements|task|tasks|acceptance criteria|deliverables?)\s*:/i.test(line)) {
      push(line.replace(/^[^:]+:\s*/, ''));
      continue;
    }
    if (/\b(?:must|should|need to|required to|do not|never)\b/i.test(line) && line.length <= maxLen) {
      push(line);
    }
  }

  if (out.length === 0) {
    const fallbackSentences = String(content || '')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => cleanText(s, maxLen))
      .filter((s) => s.length >= minLen)
      .slice(0, 6);
    for (const sentence of fallbackSentences) push(sentence);
  }

  return out.slice(0, Number(policy.extraction.max_requirements || 10));
}

function runResearchOrgan(target: AnyObj, requirements: string[]) {
  if (!fs.existsSync(RESEARCH_ORGAN_CLI)) {
    return {
      ok: false,
      error: 'research_organ_missing'
    };
  }

  const objective = cleanText(`Assimilate source ${target.source_display}`, 220);
  const capabilityId = normalizeToken(`assimilate_${target.content_hash.slice(0, 12)}`, 80);
  const metadata = {
    docs_urls: target.source_type === 'web_url' ? [target.source] : [],
    edge_cases: requirements.slice(0, 6),
    auth_model: 'unknown',
    rate_limits: []
  };

  const run = spawnSync(process.execPath, [
    RESEARCH_ORGAN_CLI,
    'run',
    `--objective=${objective}`,
    `--capability-id=${capabilityId}`,
    `--metadata-json=${JSON.stringify(metadata)}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });

  const payload = parseJsonText(run.stdout);
  if (Number.isFinite(run.status) && Number(run.status) === 0 && payload) {
    return {
      ok: true,
      probe_confidence: Number(payload?.probe?.confidence || 0),
      proposal_count: Array.isArray(payload?.proposals) ? payload.proposals.length : 0,
      blocked_count: Array.isArray(payload?.blocked) ? payload.blocked.length : 0,
      run_id: cleanText(payload?.run_id || '', 120),
      runs_path: cleanText(payload?.runs_path || '', 220),
      receipts_path: cleanText(payload?.receipts_path || '', 220)
    };
  }

  return {
    ok: false,
    error: cleanText(run.stderr || run.stdout || 'research_organ_failed', 400)
  };
}

function runCoreFiveReview(target: AnyObj, requirements: string[], dryRun = false) {
  if (!fs.existsSync(PERSONA_CLI)) {
    return {
      ok: false,
      error: 'persona_cli_missing'
    };
  }
  const reqPreview = requirements.slice(0, 8).map((row, idx) => `${idx + 1}. ${row}`).join('\n');
  const query = [
    `Review this proposed assimilation for safety, ops, measurement, security, and product impact.`,
    `Source: ${target.source_display}`,
    `Digest: ${target.content_hash.slice(0, 12)}`,
    'Extracted requirements:',
    reqPreview || 'No explicit requirements extracted.',
    'Return deterministic recommendation and escalation path.'
  ].join('\n');

  let sandboxRoot: string | null = null;
  const env = { ...process.env };
  if (dryRun) {
    sandboxRoot = prepareDryRunPersonaWorkspace();
    env.OPENCLAW_WORKSPACE = sandboxRoot;
  }

  const run = spawnSync(process.execPath, [
    PERSONA_CLI,
    'all',
    query,
    '--schema=json',
    '--context-budget-mode=trim',
    '--max-context-tokens=2000'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
    env
  });

  if (sandboxRoot) {
    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    } catch {}
  }

  const payload = parseJsonText(run.stdout);
  if (Number.isFinite(run.status) && Number(run.status) === 0 && payload) {
    return {
      ok: true,
      winner: cleanText(payload.winner || payload?.arbitration?.winner || '', 120),
      disagreement: payload.disagreement === true,
      arbitration_rule: cleanText(payload?.arbitration?.rule || '', 220),
      suggested_resolution: cleanText(payload.suggested_resolution || '', 500),
      domain: cleanText(payload.domain || '', 120),
      confidence: Number(payload?.persona_outputs?.[0]?.confidence || 0),
      raw: payload
    };
  }

  return {
    ok: false,
    error: cleanText(run.stderr || run.stdout || 'core5_review_failed', 400)
  };
}

function estimateDiff(requirements: string[], target: AnyObj) {
  const reqCount = requirements.length;
  const filesTouched = clampInt((reqCount * 2) + (target.source_type === 'web_url' ? 3 : 2), 3, 50, 6);
  const insertionsMin = clampInt(filesTouched * 20, 30, 5000, 120);
  const insertionsMax = clampInt(filesTouched * 90, 100, 15000, 700);
  return {
    files_touched_estimate: filesTouched,
    insertions_estimate: {
      min: insertionsMin,
      max: insertionsMax
    },
    deletions_estimate: {
      min: clampInt(Math.floor(insertionsMin * 0.1), 0, 3000, 10),
      max: clampInt(Math.floor(insertionsMax * 0.4), 0, 8000, 240)
    }
  };
}

function composeRiskSummary(target: AnyObj, requirements: string[], review: AnyObj) {
  const factors: string[] = [];
  if (target.source_type === 'web_url') factors.push('external_source_input');
  if (target.truncated === true) factors.push('source_truncated');
  if ((requirements || []).length >= 8) factors.push('high_requirement_volume');
  if (review && review.disagreement === true) factors.push('core5_disagreement');
  if (review && !review.ok) factors.push('core5_review_unavailable');

  let level = 'low';
  if (factors.includes('core5_disagreement') || factors.includes('core5_review_unavailable')) level = 'high';
  else if (factors.length >= 2) level = 'medium';

  return {
    level,
    factors,
    fail_closed: level === 'high'
  };
}

function composeSprintPrompt(input: {
  target: AnyObj,
  requirements: string[],
  review: AnyObj,
  estimatedDiff: AnyObj,
  riskSummary: AnyObj
}) {
  const reqLines = input.requirements.length
    ? input.requirements.map((row, idx) => `${idx + 1}. ${row}`).join('\n')
    : '1. Review source and produce deterministic requirement extraction.';
  const winner = cleanText(input.review?.winner || 'core5', 80) || 'core5';
  const resolution = cleanText(input.review?.suggested_resolution || 'No additional resolution provided.', 300);

  return [
    'STRICT EXECUTION RULES ACTIVE — READ codex_enforcer.md FIRST.',
    '',
    'Sprint: Assimilation Intake Execution',
    '',
    `Goal: Safely integrate actionable requirements from \`${input.target.source_display}\` with covenant-first governance.`,
    '',
    'Tasks:',
    reqLines,
    '',
    'Safety and Governance:',
    `- Core 5 arbitration winner: ${winner}`,
    `- Suggested resolution: ${resolution}`,
    `- Risk level: ${input.riskSummary.level}`,
    '- Keep behavior-preserving migration; fail-closed on covenant/security violation.',
    '- Human confirmation required before any apply/execute path.',
    '',
    'Deliverables:',
    '- Full git diff',
    '- Regression test output + sovereignty/security check output',
    '- Example runtime output and receipts path',
    `- Estimated diff scope: ${input.estimatedDiff.files_touched_estimate} files`,
    '',
    'Do NOT mark anything done until I approve the proof.',
    '',
    'Begin NOW.',
    '',
    'End with:',
    '--- REAL PROGRESS ---',
    'Files changed:',
    'Assimilation completed? (yes/no)',
    'Next task:'
  ].join('\n');
}

function appendCorrespondenceLog(personaId: string, entry: string) {
  const filePath = path.join(ROOT, 'personas', personaId, 'correspondence.md');
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      persona_id: personaId,
      reason: 'correspondence_file_missing'
    };
  }
  const body = fs.readFileSync(filePath, 'utf8').replace(/\s+$/, '');
  fs.writeFileSync(filePath, `${body}\n${entry}\n`, 'utf8');
  return {
    ok: true,
    persona_id: personaId,
    correspondence_path: relPath(filePath)
  };
}

function appendPersonaFeed(personaId: string, snippet: string, dryRun = false) {
  if (!fs.existsSync(PERSONA_CLI)) {
    return {
      ok: false,
      persona_id: personaId,
      reason: 'persona_cli_missing'
    };
  }
  const args = [
    PERSONA_CLI,
    'feed',
    personaId,
    snippet,
    '--source=system_assimilate',
    '--tags=assimilate,source-intake'
  ];
  if (dryRun) args.push('--dry-run=1');

  let sandboxRoot: string | null = null;
  const env = { ...process.env };
  if (dryRun) {
    sandboxRoot = prepareDryRunPersonaWorkspace();
    env.OPENCLAW_WORKSPACE = sandboxRoot;
  }

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env
  });

  if (sandboxRoot) {
    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    } catch {}
  }

  const payload = parseJsonText(run.stdout);
  if (Number.isFinite(run.status) && Number(run.status) === 0) {
    return {
      ok: true,
      persona_id: personaId,
      payload
    };
  }
  return {
    ok: false,
    persona_id: personaId,
    reason: cleanText(run.stderr || run.stdout || 'feed_append_failed', 300)
  };
}

function logTelemetry(metric: string, value: number, extra: AnyObj = {}) {
  appendJsonl(PERSONA_TELEMETRY_PATH, {
    ts: nowIso(),
    type: 'persona_metric',
    metric: cleanText(metric, 80),
    value: Number(value),
    source: 'systems/tools/assimilate',
    ...extra
  });
}

function renderMarkdownResult(result: AnyObj) {
  const lines: string[] = [];
  lines.push('# Assimilation Result');
  lines.push('');
  lines.push(`- Source: \`${result.source.source_display}\``);
  lines.push(`- Source Type: \`${result.source.source_type}\``);
  lines.push(`- Risk Level: \`${result.risk_summary.level}\``);
  lines.push(`- Core-5 Winner: \`${result.core5_review.winner || 'n/a'}\``);
  lines.push(`- Requirements Extracted: \`${result.requirements.length}\``);
  lines.push('');
  lines.push('## Sprint Prompt');
  lines.push('```text');
  lines.push(result.sprint_prompt);
  lines.push('```');
  lines.push('');
  lines.push('## Estimated Diff');
  lines.push('```json');
  lines.push(JSON.stringify(result.estimated_diff, null, 2));
  lines.push('```');
  return lines.join('\n');
}

function failClosed(errorCode: string, context: AnyObj = {}) {
  const payload = {
    ok: false,
    type: 'assimilate_result',
    error: cleanText(errorCode, 160),
    fail_closed: true,
    ts: nowIso(),
    ...context
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const policy = loadPolicy();
  const dryRun = toBool(args['dry-run'] ?? args.dry_run, false);
  const outputFormat = normalizeToken(args.format || args.output || 'json', 16) || 'json';
  const progressEnabled = Boolean(process.stderr && process.stderr.isTTY)
    && (outputFormat !== 'json' || toBool(args.progress, false) || toBool(process.env.PROTHEUS_PROGRESS, false));
  const spinner = createSpinner('Assimilation intake...', progressEnabled);
  const targetInput = cleanText(args._[0], 2000);

  if (!policy.enabled) {
    failClosed('assimilate_disabled_by_policy', { policy_path: relPath(POLICY_PATH) });
  }

  if (toBool(process.env.PROTHEUS_ASSIMILATE_FORCE_COVENANT_VIOLATION, false)) {
    failClosed('covenant_violation_detected_for_assimilation');
  }

  const applyRequested = toBool(args.apply ?? args.execute ?? false, false);
  const executionConfirmed = toBool(args['confirm-execution'] ?? args.confirm_execution ?? false, false);
  if (applyRequested && policy.require_human_confirmation_for_execute && !executionConfirmed) {
    spinner.stop(false, 'Assimilation blocked by confirmation gate');
    failClosed('human_confirmation_required_before_execution', {
      hint: 'rerun with --confirm-execution=1 after operator approval'
    });
  }

  let target: AnyObj;
  try {
    spinner.update('Loading source target...');
    target = isLikelyUrl(targetInput)
      ? await fetchWebTarget(targetInput, policy)
      : loadLocalTarget(targetInput, policy);
  } catch (err: any) {
    spinner.stop(false, 'Assimilation source load failed');
    failClosed(`source_load_failed:${cleanText(err && err.message, 220)}`, {
      source: targetInput
    });
  }

  spinner.update('Extracting requirements...');
  const requirements = extractRequirements(target.content_text, policy);
  spinner.update('Running research organ + Core-5 review...');
  const research = runResearchOrgan(target, requirements);
  const core5Review = runCoreFiveReview(target, requirements, dryRun);
  const estimatedDiff = estimateDiff(requirements, target);
  const riskSummary = composeRiskSummary(target, requirements, core5Review);
  const sprintPrompt = composeSprintPrompt({
    target,
    requirements,
    review: core5Review,
    estimatedDiff,
    riskSummary
  });

  const runId = normalizeToken(`assimilate_${Date.now()}_${target.content_hash.slice(0, 10)}`, 120);
  const ts = nowIso();
  const correspondenceEntry = [
    '',
    `## ${ts.slice(0, 10)} - Re: assimilation intake`,
    '',
    `Assimilated source: ${target.source_display} (digest ${target.content_hash.slice(0, 12)}).`,
    `Generated sprint run: ${runId}. Requirements extracted: ${requirements.length}.`,
    `Core-5 arbitration winner: ${core5Review.winner || 'n/a'}. Risk level: ${riskSummary.level}.`,
    `Receipt: ${relPath(LATEST_PATH)}`,
    ''
  ].join('\n');

  const feedSnippet = cleanText(
    `Assimilation ${runId}: source=${target.source_display}; requirements=${requirements.length}; winner=${core5Review.winner || 'n/a'}; risk=${riskSummary.level}`,
    500
  );

  const correspondenceLogs: AnyObj[] = [];
  const feedLogs: AnyObj[] = [];

  if (!dryRun && policy.logging.append_to_persona_correspondence) {
    for (const personaId of CORE_FIVE) {
      try {
        correspondenceLogs.push(appendCorrespondenceLog(personaId, correspondenceEntry));
      } catch (err: any) {
        correspondenceLogs.push({
          ok: false,
          persona_id: personaId,
          reason: cleanText(err && err.message, 220)
        });
      }
    }
  }

  if (policy.logging.append_to_persona_feed) {
    for (const personaId of CORE_FIVE) {
      feedLogs.push(appendPersonaFeed(personaId, feedSnippet, dryRun));
    }
  }

  const payload = {
    ok: true,
    type: 'assimilate_result',
    ts,
    run_id: runId,
    policy_path: relPath(POLICY_PATH),
    dry_run: dryRun,
    execution_mode: policy.proposal_only ? 'proposal_only' : 'execution_capable',
    human_confirmation_required: policy.require_human_confirmation_for_execute,
    source: {
      source_type: target.source_type,
      source_display: target.source_display,
      domain: target.domain,
      title: cleanText(target.title || '', 240),
      bytes: Number(target.bytes || 0),
      truncated: target.truncated === true,
      content_hash: target.content_hash
    },
    extracted_summary: cleanText(target.content_text, 500),
    requirements,
    research_organ: research,
    core5_review: {
      ok: core5Review.ok === true,
      winner: core5Review.winner || null,
      disagreement: core5Review.disagreement === true,
      arbitration_rule: core5Review.arbitration_rule || null,
      suggested_resolution: core5Review.suggested_resolution || null,
      confidence: Number(core5Review.confidence || 0)
    },
    estimated_diff: estimatedDiff,
    risk_summary: riskSummary,
    sprint_prompt: sprintPrompt,
    logs: {
      correspondence: correspondenceLogs,
      feed: feedLogs
    },
    artifacts: {
      latest_path: relPath(LATEST_PATH),
      receipts_path: relPath(RECEIPTS_PATH)
    }
  };

  if (policy.logging.write_state_receipts) {
    const runPath = path.join(RUNS_DIR, `${runId}.json`);
    writeJsonAtomic(runPath, payload);
    writeJsonAtomic(LATEST_PATH, payload);
    appendJsonl(RECEIPTS_PATH, {
      ts,
      type: 'assimilate_run',
      run_id: runId,
      source: target.source_display,
      source_type: target.source_type,
      requirements: requirements.length,
      core5_winner: core5Review.winner || null,
      risk_level: riskSummary.level,
      dry_run: dryRun
    });
  }

  if (!dryRun) {
    const utilityValue = requirements.length > 0 && core5Review.ok === true ? 1 : 0;
    logTelemetry('passed_data_utility_rate', utilityValue, {
      run_id: runId,
      source_type: target.source_type,
      requirements_count: requirements.length,
      risk_level: riskSummary.level
    });
  }

  if (outputFormat === 'markdown' || outputFormat === 'md') {
    spinner.stop(true, 'Assimilation completed');
    process.stdout.write(`${renderMarkdownResult(payload)}\n`);
    return;
  }

  spinner.stop(true, 'Assimilation completed');
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    failClosed(`unhandled_assimilate_error:${cleanText(err && err.message, 220)}`);
  });
}
