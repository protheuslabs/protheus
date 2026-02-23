#!/usr/bin/env node
/**
 * sensory_queue.js - Sensory Layer v1.2.3 (PROPOSAL QUEUE)
 * 
 * Proposal lifecycle logging + dispositions.
 * Reads ONLY proposals JSON, NEVER raw JSONL.
 * Append-only logs, deterministic, NO LLM calls.
 * 
 * Commands:
 *   node habits/scripts/sensory_queue.js ingest [YYYY-MM-DD]
 *   node habits/scripts/sensory_queue.js list [--status=X] [--days=N]
 *   node habits/scripts/sensory_queue.js accept <ID> [--note="..."]
 *   node habits/scripts/sensory_queue.js reject <ID> --reason="..."
 *   node habits/scripts/sensory_queue.js done <ID> [--note="..."]
 *   node habits/scripts/sensory_queue.js snooze <ID> --until=YYYY-MM-DD
 *   node habits/scripts/sensory_queue.js stats [--days=N]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SENSORY_QUEUE_MIN_SIGNAL_SCORE = Number(process.env.SENSORY_QUEUE_MIN_SIGNAL_SCORE || 40);
const SENSORY_QUEUE_MIN_RELEVANCE_SCORE = Number(process.env.SENSORY_QUEUE_MIN_RELEVANCE_SCORE || 42);
const SENSORY_QUEUE_MIN_DIRECTIVE_FIT_SCORE = Number(process.env.SENSORY_QUEUE_MIN_DIRECTIVE_FIT_SCORE || 25);
const SENSORY_QUEUE_MIN_ACTIONABILITY_SCORE = Number(process.env.SENSORY_QUEUE_MIN_ACTIONABILITY_SCORE || 45);
const SENSORY_QUEUE_MIN_COMPOSITE_SCORE = Number(process.env.SENSORY_QUEUE_MIN_COMPOSITE_SCORE || 62);
const SENSORY_QUEUE_MIN_EXECUTION_WORTHINESS_SCORE = Number(process.env.SENSORY_QUEUE_MIN_EXECUTION_WORTHINESS_SCORE || 62);
const SENSORY_QUEUE_DISALLOW_STUB_TITLE = String(process.env.SENSORY_QUEUE_DISALLOW_STUB_TITLE || '1') !== '0';
const SENSORY_QUEUE_DISALLOW_UNKNOWN_EYE = String(process.env.SENSORY_QUEUE_DISALLOW_UNKNOWN_EYE || '1') !== '0';
const SENSORY_QUEUE_ALLOW_TERMINAL_REOPEN = String(process.env.SENSORY_QUEUE_ALLOW_TERMINAL_REOPEN || '0') === '1';
const SENSORY_QUEUE_STALE_OPEN_HOURS = Math.max(1, Number(process.env.SENSORY_QUEUE_STALE_OPEN_HOURS || 96));
const EXECUTION_ACTION_RE = /\b(fix|stabilize|reduce|increase|ship|deliver|implement|optimi[sz]e|triage|repair|harden|verify|measure|enforce|prevent)\b/i;
const EXECUTION_METRIC_RE = /(\d+(\.\d+)?\s*(%|ms|s|sec|seconds|min|minutes|h|hr|hours|day|days|week|weeks|tokens?))|([<>]=?)|\b(pass|fail|rate|latency|error|count|budget|receipt|verified?)\b/i;
const EXECUTION_COMMAND_RE = /^(node|npm|npx|pnpm|yarn|python|python3|bash|sh|curl|git|make|uv)\b/i;
const EXECUTION_COMMAND_PLACEHOLDER_RE = /(\.\.\.|<[^>]+>|\bTODO\b|\bTBD\b)/i;
const ROLLBACK_VERB_RE = /\b(revert|rollback|restore|undo|remove|reset|disable)\b/i;
const ROLLBACK_SCOPE_RE = /\b(file|config|state|policy|baseline|commit|snapshot|registry|queue|route|collector)\b/i;

// Paths - can be overridden for testing
let SENSORY_DIR = path.join(__dirname, '..', '..', 'state', 'sensory');
let PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');
let QUEUE_LOG = path.join(SENSORY_DIR, 'queue_log.jsonl');

// Allow test override via env
if (process.env.SENSORY_QUEUE_TEST_DIR) {
  const testDir = process.env.SENSORY_QUEUE_TEST_DIR;
  SENSORY_DIR = path.join(testDir, 'state', 'sensory');
  PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');
  QUEUE_LOG = path.join(SENSORY_DIR, 'queue_log.jsonl');
}

// Ensure directory exists
function ensureDir() {
  if (!fs.existsSync(SENSORY_DIR)) {
    fs.mkdirSync(SENSORY_DIR, { recursive: true });
  }
}

// Compute SHA256 hash of proposal content
function computeProposalHash(proposal) {
  // Normalize: sort keys, stringify consistently
  const normalized = JSON.stringify(proposal, Object.keys(proposal).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Append event to queue log
function appendEvent(event) {
  ensureDir();
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(QUEUE_LOG, line, 'utf8');
}

// Load all events from queue log
function loadEvents() {
  if (!fs.existsSync(QUEUE_LOG)) {
    return [];
  }
  const content = fs.readFileSync(QUEUE_LOG, 'utf8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(e => e !== null);
}

// Get generated hashes to check for duplicates
function getLoggedHashesByType(types = []) {
  const wanted = new Set(Array.isArray(types) ? types.map(t => String(t)) : []);
  if (!wanted.size) return new Set();
  const events = loadEvents();
  const hashes = new Set();
  for (const event of events) {
    if (wanted.has(String(event.type || '')) && event.proposal_hash) {
      hashes.add(event.proposal_hash);
    }
  }
  return hashes;
}

function getLoggedProposalIdsByType(types = []) {
  const wanted = new Set(Array.isArray(types) ? types.map(t => String(t)) : []);
  if (!wanted.size) return new Set();
  const events = loadEvents();
  const ids = new Set();
  for (const event of events) {
    const id = String(event && event.proposal_id || '').trim();
    if (!id || id === 'UNKNOWN') continue;
    if (wanted.has(String(event.type || ''))) ids.add(id);
  }
  return ids;
}

function getLatestProposalHashById(types = []) {
  const wanted = new Set(Array.isArray(types) ? types.map(t => String(t)) : []);
  if (!wanted.size) return new Map();
  const events = loadEvents().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const latest = new Map();
  for (const event of events) {
    const id = String(event && event.proposal_id || '').trim();
    if (!id || id === 'UNKNOWN') continue;
    if (!wanted.has(String(event.type || ''))) continue;
    const hash = String(event.proposal_hash || '').trim();
    if (hash) latest.set(id, hash);
  }
  return latest;
}

function normalizeProposalId(proposal) {
  const raw = String(proposal && proposal.id || '').trim();
  return raw || null;
}

function extractProposalEyeId(proposal) {
  const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : null;
  const fromMeta = String(meta && meta.source_eye || '').trim();
  if (fromMeta) return fromMeta;
  const evidence = Array.isArray(proposal && proposal.evidence) ? proposal.evidence : [];
  for (const ev of evidence) {
    const ref = String(ev && ev.evidence_ref || '').trim();
    const m = ref.match(/^eye:([a-z0-9_.:-]+)$/i);
    if (m && m[1]) return String(m[1]);
  }
  return '';
}

function crossSignalSweepKeyFromTitle(titleRaw) {
  const title = String(titleRaw || '');
  if (!/^\[cross-signal\]/i.test(title)) return '';
  const topicMatch = title.match(/topic\s+"([^"]+)"/i);
  const topic = String(topicMatch && topicMatch[1] || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!topic) return '';
  let family = 'generic';
  if (/\bconverging\b/i.test(title)) family = 'converging';
  else if (/\bdiverging\b/i.test(title)) family = 'diverging';
  else if (/\bappears first\b/i.test(title) || /\bthen\b/i.test(title)) family = 'lead_lag';
  return `${family}:${topic}`;
}

function isEyeDerivedProposal(proposal) {
  const type = String(proposal && proposal.type || '').toLowerCase();
  const id = String(proposal && proposal.id || '').toUpperCase();
  if (type === 'external_intel') return true;
  if (id.startsWith('EYE-')) return true;
  const eyeId = extractProposalEyeId(proposal);
  return !!String(eyeId || '').trim();
}

function hasExplicitEyeAttribution(proposal) {
  const id = String(proposal && proposal.id || '').toUpperCase();
  if (id.startsWith('EYE-')) return true;
  const eyeId = String(extractProposalEyeId(proposal) || '').trim();
  return !!eyeId;
}

function evaluateStaticQueueGate(proposal) {
  const title = String(proposal && proposal.title || '');
  if (SENSORY_QUEUE_DISALLOW_STUB_TITLE && /\[stub\]/i.test(title)) {
    return { allow: false, reason: 'stub_title', gated: true };
  }

  const eyeId = String(extractProposalEyeId(proposal) || '').trim().toLowerCase();
  if (
    SENSORY_QUEUE_DISALLOW_UNKNOWN_EYE &&
    isEyeDerivedProposal(proposal) &&
    hasExplicitEyeAttribution(proposal) &&
    (!eyeId || eyeId === 'unknown_eye' || eyeId === 'unknown')
  ) {
    return { allow: false, reason: 'unknown_eye', gated: true };
  }

  return { allow: true, reason: null, gated: false };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function metaHasQualitySignals(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const keys = [
    'signal_quality_score',
    'relevance_score',
    'directive_fit_score',
    'actionability_score',
    'composite_eligibility_score',
    'admission_preview',
    'composite_eligibility_pass',
    'actionability_pass'
  ];
  return keys.some((k) => Object.prototype.hasOwnProperty.call(meta, k));
}

function extractActionSpec(proposal) {
  const direct = proposal && proposal.action_spec;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : null;
  const nested = meta && meta.action_spec;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
  return null;
}

function requiresActionSpecContract(proposal) {
  if (!proposal || typeof proposal !== 'object') return false;
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : null;
  const hasQualitySignals = metaHasQualitySignals(meta);
  const hasSuggestedCommand = !!String(proposal.suggested_next_command || '').trim();
  const hasValidation = Array.isArray(proposal.validation) && proposal.validation.length > 0;
  const id = String(proposal.id || '').trim().toUpperCase();
  const hasInsightPrefix = /^((PRP|EYE|CSG)-)/.test(id);
  return hasQualitySignals || hasSuggestedCommand || hasValidation || hasInsightPrefix;
}

function validateActionSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['not_object'] };
  }
  const errors = [];
  const objective = String(spec.objective || '').trim();
  const target = String(spec.target || '').trim();
  const nextCommand = String(spec.next_command || '').trim();
  const rollback = String(spec.rollback || '').trim();
  const verify = Array.isArray(spec.verify) ? spec.verify : [];

  if (!objective || objective.length < 12) errors.push('objective_missing_or_short');
  if (!target || target.length < 3) errors.push('target_missing_or_short');
  if (!nextCommand || nextCommand.length < 8) errors.push('next_command_missing_or_short');
  if (!rollback || rollback.length < 12) errors.push('rollback_missing_or_short');
  if (!verify.length) errors.push('verify_missing');
  if (verify.length && verify.some((v) => String(v || '').trim().length < 8)) {
    errors.push('verify_item_short');
  }

  return { ok: errors.length === 0, errors };
}

function clampScore(n, min, max) {
  return Math.max(min, Math.min(max, Number(n) || 0));
}

function extractExecutionContract(proposal) {
  const spec = extractActionSpec(proposal) || {};
  const objective = String(spec.objective || proposal && proposal.title || '').trim();
  const target = String(spec.target || '').trim();
  const nextCommand = String(spec.next_command || proposal && proposal.suggested_next_command || '').trim();
  let verify = Array.isArray(spec.verify) ? spec.verify.slice() : [];
  if (!verify.length && Array.isArray(proposal && proposal.validation)) {
    verify = proposal.validation.slice();
  }
  verify = verify.map((v) => String(v || '').trim()).filter(Boolean);
  const rollback = String(spec.rollback || '').trim();
  const applies = requiresActionSpecContract(proposal)
    || !!nextCommand
    || verify.length > 0
    || !!target
    || !!rollback;
  return {
    applies,
    objective,
    target,
    next_command: nextCommand,
    verify,
    rollback
  };
}

function scoreObjectiveClarity(contract) {
  const objective = String(contract && contract.objective || '');
  const target = String(contract && contract.target || '');
  const verifyText = Array.isArray(contract && contract.verify) ? contract.verify.join(' ') : '';
  let score = 0;
  if (objective.length >= 20) score += 8;
  if (objective.length >= 40) score += 4;
  if (target.length >= 3) score += 5;
  if (EXECUTION_ACTION_RE.test(objective)) score += 4;
  if (EXECUTION_METRIC_RE.test(`${objective} ${verifyText}`)) score += 4;
  return clampScore(score, 0, 25);
}

function scoreCommandConcreteness(contract) {
  const command = String(contract && contract.next_command || '');
  let score = 0;
  if (command.length >= 12) score += 8;
  if (command.length >= 32) score += 4;
  if (EXECUTION_COMMAND_RE.test(command)) score += 7;
  if (/(--[a-z0-9_-]+=)|\b(node|python)\s+\S+/i.test(command)) score += 4;
  if (/(systems\/|habits\/|state\/|config\/|\.js\b|\.sh\b|\.py\b)/i.test(command)) score += 2;
  if (EXECUTION_COMMAND_PLACEHOLDER_RE.test(command)) score -= 8;
  return clampScore(score, 0, 25);
}

function scoreVerificationStrength(contract) {
  const verify = Array.isArray(contract && contract.verify) ? contract.verify : [];
  let score = 0;
  if (verify.length >= 1) score += 6;
  if (verify.length >= 2) score += 4;
  if (verify.length >= 3) score += 2;
  let detailed = 0;
  let measurable = 0;
  for (const itemRaw of verify) {
    const item = String(itemRaw || '').trim();
    if (item.length >= 16) detailed++;
    if (EXECUTION_METRIC_RE.test(item)) measurable++;
  }
  score += Math.min(6, detailed * 2);
  score += Math.min(7, measurable * 3);
  return clampScore(score, 0, 25);
}

function scoreRollbackQuality(contract) {
  const rollback = String(contract && contract.rollback || '');
  let score = 0;
  if (rollback.length >= 14) score += 8;
  if (rollback.length >= 40) score += 4;
  if (ROLLBACK_VERB_RE.test(rollback)) score += 8;
  if (ROLLBACK_SCOPE_RE.test(rollback)) score += 5;
  return clampScore(score, 0, 25);
}

function computeExecutionWorthiness(proposal) {
  const contract = extractExecutionContract(proposal);
  const threshold = SENSORY_QUEUE_MIN_EXECUTION_WORTHINESS_SCORE;
  if (!contract.applies) {
    return {
      applies: false,
      threshold,
      total: null,
      components: null
    };
  }
  const components = {
    objective_clarity: scoreObjectiveClarity(contract),
    command_concreteness: scoreCommandConcreteness(contract),
    verification_strength: scoreVerificationStrength(contract),
    rollback_quality: scoreRollbackQuality(contract)
  };
  const total = clampScore(
    components.objective_clarity
      + components.command_concreteness
      + components.verification_strength
      + components.rollback_quality,
    0,
    100
  );
  return {
    applies: true,
    threshold,
    total,
    components
  };
}

function evaluateExecutionWorthinessGate(proposal) {
  const worthiness = computeExecutionWorthiness(proposal);
  if (!worthiness.applies) {
    return {
      allow: true,
      reason: null,
      gated: false,
      execution_worthiness: worthiness
    };
  }
  if (Number(worthiness.total || 0) < Number(worthiness.threshold || 0)) {
    return {
      allow: false,
      reason: 'execution_worthiness_low',
      gated: true,
      execution_worthiness: worthiness,
      details: [
        `score=${worthiness.total}`,
        `threshold=${worthiness.threshold}`,
        `objective=${worthiness.components.objective_clarity}`,
        `command=${worthiness.components.command_concreteness}`,
        `verify=${worthiness.components.verification_strength}`,
        `rollback=${worthiness.components.rollback_quality}`
      ]
    };
  }
  return {
    allow: true,
    reason: null,
    gated: true,
    execution_worthiness: worthiness
  };
}

function evaluateActionSpecGate(proposal) {
  if (!requiresActionSpecContract(proposal)) {
    return { allow: true, reason: null, gated: false };
  }
  const spec = extractActionSpec(proposal);
  if (!spec) {
    return { allow: false, reason: 'action_spec_missing', gated: true };
  }
  const validated = validateActionSpec(spec);
  if (!validated.ok) {
    return {
      allow: false,
      reason: 'action_spec_invalid',
      gated: true,
      details: validated.errors.slice(0, 6)
    };
  }
  return { allow: true, reason: null, gated: true };
}

function normalizeBlockedReason(admissionPreview) {
  const blocked = admissionPreview && Array.isArray(admissionPreview.blocked_by)
    ? admissionPreview.blocked_by
    : [];
  return blocked.length ? String(blocked[0] || 'admission_blocked') : 'admission_blocked';
}

function evaluateQueueQualityGate(proposal) {
  const staticGate = evaluateStaticQueueGate(proposal);
  if (!staticGate.allow) return staticGate;

  const actionSpecGate = evaluateActionSpecGate(proposal);
  if (!actionSpecGate.allow) return actionSpecGate;

  const executionWorthinessGate = evaluateExecutionWorthinessGate(proposal);
  if (!executionWorthinessGate.allow) return executionWorthinessGate;

  const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : null;
  if (!metaHasQualitySignals(meta)) {
    return {
      allow: true,
      reason: null,
      gated: !!(executionWorthinessGate.execution_worthiness && executionWorthinessGate.execution_worthiness.applies),
      execution_worthiness: executionWorthinessGate.execution_worthiness
    };
  }

  const admission = meta && meta.admission_preview && typeof meta.admission_preview === 'object'
    ? meta.admission_preview
    : null;
  if (admission && admission.eligible === false) {
    return { allow: false, reason: normalizeBlockedReason(admission), gated: true };
  }

  if (meta.actionability_pass === false) {
    return { allow: false, reason: 'actionability_low', gated: true };
  }
  if (meta.composite_eligibility_pass === false) {
    return { allow: false, reason: 'composite_low', gated: true };
  }

  const signal = numOrNull(meta.signal_quality_score);
  if (signal != null && signal < SENSORY_QUEUE_MIN_SIGNAL_SCORE) {
    return { allow: false, reason: 'signal_quality_low', gated: true };
  }
  const relevance = numOrNull(meta.relevance_score);
  if (relevance != null && relevance < SENSORY_QUEUE_MIN_RELEVANCE_SCORE) {
    return { allow: false, reason: 'relevance_low', gated: true };
  }
  const directiveFit = numOrNull(meta.directive_fit_score);
  if (directiveFit != null && directiveFit < SENSORY_QUEUE_MIN_DIRECTIVE_FIT_SCORE) {
    return { allow: false, reason: 'directive_fit_low', gated: true };
  }
  const actionability = numOrNull(meta.actionability_score);
  if (actionability != null && actionability < SENSORY_QUEUE_MIN_ACTIONABILITY_SCORE) {
    return { allow: false, reason: 'actionability_low', gated: true };
  }
  const composite = numOrNull(meta.composite_eligibility_score);
  if (composite != null && composite < SENSORY_QUEUE_MIN_COMPOSITE_SCORE) {
    return { allow: false, reason: 'composite_low', gated: true };
  }

  return {
    allow: true,
    reason: null,
    gated: true,
    execution_worthiness: executionWorthinessGate.execution_worthiness
  };
}

function proposalEventKey(event) {
  const id = String(event && event.proposal_id || '').trim();
  if (id && id !== 'UNKNOWN') return `id:${id}`;
  const hash = String(event && event.proposal_hash || '').trim();
  return hash ? `hash:${hash}` : '';
}

function ageHoursFromTs(tsRaw) {
  const tsMs = Date.parse(String(tsRaw || ''));
  if (!Number.isFinite(tsMs)) return null;
  const deltaMs = Date.now() - tsMs;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 0;
  return Number((deltaMs / (1000 * 60 * 60)).toFixed(3));
}

// Get current status of a proposal by hash or id
function getProposalStatus(proposalHash, proposalId) {
  const events = loadEvents();
  // Sort by timestamp
  events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  
  let status = 'open';
  let snoozeUntil = null;
  
  for (const event of events) {
    const matches = event.proposal_hash === proposalHash || 
                    event.proposal_id === proposalId;
    if (!matches) continue;
    
    switch (event.type) {
      case 'proposal_accepted':
        status = 'accepted';
        break;
      case 'proposal_rejected':
        status = 'rejected';
        break;
      case 'proposal_done':
        status = 'done';
        break;
      case 'proposal_snoozed':
        status = 'snoozed';
        snoozeUntil = event.snooze_until;
        // Check if snooze expired
        if (snoozeUntil && new Date(snoozeUntil) < new Date()) {
          status = 'open';
          snoozeUntil = null;
        }
        break;
    }
  }
  
  return { status, snoozeUntil };
}

function getLatestRejectEvent(events, proposalId) {
  const rows = Array.isArray(events) ? events : [];
  const id = String(proposalId || '').trim();
  if (!id) return null;
  return rows
    .filter((e) => e && e.type === 'proposal_rejected' && String(e.proposal_id || '') === id)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0] || null;
}

/**
 * Normalize proposals file formats into an array.
 * Accepts:
 * 1) Array: [ {..proposal..}, ... ]
 * 2) Wrapper: { proposals: [ ... ], ...meta }
 * 3) Single proposal object: { id, title, ... }
 */
function normalizeProposalsJson(parsed, filePath) {
  if (!parsed) return [];

  // Already an array of proposals
  if (Array.isArray(parsed)) return parsed;

  // Wrapper object with proposals array
  if (typeof parsed === 'object' && Array.isArray(parsed.proposals)) {
    return parsed.proposals;
  }

  // Some variants might use "items"
  if (typeof parsed === 'object' && Array.isArray(parsed.items)) {
    return parsed.items;
  }

  // Single proposal object → wrap
  if (typeof parsed === 'object' && parsed.id && (parsed.title || parsed.type)) {
    return [parsed];
  }

  console.error(`Proposals must be an array (or {proposals:[...]}) in: ${filePath}`);
  return [];
}

// INGEST: Read proposals JSON and generate proposal_generated events
function ingest(dateStr) {
  const date = dateStr || getToday();
  const proposalsPath = path.join(PROPOSALS_DIR, `${date}.json`);
  
  if (!fs.existsSync(proposalsPath)) {
    console.log(`No proposals found for ${date} at ${proposalsPath}`);
    return { ingested: 0, duplicates: 0 };
  }
  
  let proposals;
  try {
    proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse proposals JSON: ${e.message}`);
    return { ingested: 0, duplicates: 0, error: e.message };
  }
  
  // Normalize proposals format (handles array, wrapper object, or single object)
  proposals = normalizeProposalsJson(proposals, proposalsPath);
  if (!proposals.length) {
    return { ok: true, ingested: 0, skipped: 0 };
  }
  
  const existingGeneratedHashes = getLoggedHashesByType(['proposal_generated']);
  const existingFilteredHashes = getLoggedHashesByType(['proposal_filtered']);
  const existingGeneratedIds = getLoggedProposalIdsByType(['proposal_generated']);
  const existingFilteredIds = getLoggedProposalIdsByType(['proposal_filtered']);
  const latestGeneratedHashById = getLatestProposalHashById(['proposal_generated']);
  const latestFilteredHashById = getLatestProposalHashById(['proposal_filtered']);
  const seenRunGeneratedIds = new Set();
  let ingested = 0;
  let duplicates = 0;
  let filtered = 0;
  let filteredDuplicates = 0;
  const filteredByReason = {};
  
  for (const proposal of proposals) {
    const proposalId = normalizeProposalId(proposal) || 'UNKNOWN';
    const hash = computeProposalHash(proposal);
    const gate = evaluateQueueQualityGate(proposal);

    if (!gate.allow) {
      const current = getProposalStatus(hash, proposalId);
      const currentStatus = String(current && current.status || 'open').toLowerCase();
      if (currentStatus === 'filtered' || currentStatus === 'rejected' || currentStatus === 'done') {
        filteredDuplicates++;
        continue;
      }
      if (proposalId !== 'UNKNOWN' && existingFilteredIds.has(proposalId)) {
        const latestHash = latestFilteredHashById.get(proposalId);
        if (!latestHash || latestHash === hash) {
          filteredDuplicates++;
          continue;
        }
      }
      if (existingFilteredHashes.has(hash)) {
        filteredDuplicates++;
        continue;
      }
      const reason = String(gate.reason || 'filtered');
      const filterEvent = {
        ts: new Date().toISOString(),
        type: 'proposal_filtered',
        date,
        proposal_id: proposalId,
        title: proposal.title || 'Untitled',
        proposal_hash: hash,
        status_after: 'filtered',
        filter_reason: reason,
        quality_gate: 'ingest_v1',
        source: 'sensory_queue'
      };
      if (gate.execution_worthiness && gate.execution_worthiness.applies) {
        filterEvent.execution_worthiness_score = gate.execution_worthiness.total;
        filterEvent.execution_worthiness_threshold = gate.execution_worthiness.threshold;
        filterEvent.execution_worthiness_components = gate.execution_worthiness.components;
      }
      if (Array.isArray(gate.details) && gate.details.length > 0) {
        filterEvent.filter_details = gate.details.slice(0, 6);
      }
      appendEvent(filterEvent);
      existingFilteredHashes.add(hash);
      if (proposalId !== 'UNKNOWN') existingFilteredIds.add(proposalId);
      filtered++;
      filteredByReason[reason] = Number(filteredByReason[reason] || 0) + 1;
      continue;
    }

    if (proposalId !== 'UNKNOWN' && !SENSORY_QUEUE_ALLOW_TERMINAL_REOPEN) {
      const current = getProposalStatus('', proposalId);
      const currentStatus = String(current && current.status || 'open').toLowerCase();
      if (currentStatus === 'filtered' || currentStatus === 'rejected' || currentStatus === 'done') {
        duplicates++;
        continue;
      }
    }

    if (
      proposalId !== 'UNKNOWN' &&
      (existingGeneratedIds.has(proposalId) || seenRunGeneratedIds.has(proposalId))
    ) {
      const latestHash = latestGeneratedHashById.get(proposalId);
      if (!latestHash || latestHash === hash || seenRunGeneratedIds.has(proposalId)) {
        duplicates++;
        continue;
      }
    }
    
    // Idempotency: skip if already generated
    if (existingGeneratedHashes.has(hash)) {
      duplicates++;
      continue;
    }
    
    const event = {
      ts: new Date().toISOString(),
      type: 'proposal_generated',
      date: date,
      proposal_id: proposalId,
      title: proposal.title || 'Untitled',
      proposal_hash: hash,
      status_after: 'open',
      source: 'sensory_queue'
    };
    if (gate.execution_worthiness && gate.execution_worthiness.applies) {
      event.execution_worthiness_score = gate.execution_worthiness.total;
      event.execution_worthiness_threshold = gate.execution_worthiness.threshold;
      event.execution_worthiness_components = gate.execution_worthiness.components;
    }
    
    appendEvent(event);
    existingGeneratedHashes.add(hash); // Prevent duplicates in same run
    if (proposalId !== 'UNKNOWN') {
      existingGeneratedIds.add(proposalId);
      seenRunGeneratedIds.add(proposalId);
    }
    ingested++;
  }
  
  const filteredReasons = Object.keys(filteredByReason).sort().map((k) => `${k}:${filteredByReason[k]}`).join(',');
  const filteredMsg = filtered > 0 ? `, ${filtered} filtered` : '';
  const filterDupMsg = filteredDuplicates > 0 ? `, ${filteredDuplicates} filter-duplicates` : '';
  const reasonMsg = filteredReasons ? ` reasons=${filteredReasons}` : '';
  console.log(`Ingested ${ingested} proposals for ${date} (${duplicates} duplicates skipped${filteredMsg}${filterDupMsg})${reasonMsg}`);
  return { ingested, duplicates, filtered, filtered_duplicates: filteredDuplicates, filtered_by_reason: filteredByReason };
}

// LIST: Show proposals with optional filtering
function list(opts = {}) {
  const events = loadEvents();
  const { status: filterStatus, days } = opts;
  
  // Build proposal state map
  const proposals = new Map();
  
  events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  
  for (const event of events) {
    const key = proposalEventKey(event);
    if (!key) continue;
    if (!proposals.has(key)) {
      proposals.set(key, {
        key,
        hash: event.proposal_hash || null,
        id: event.proposal_id,
        title: event.title,
        date: event.date,
        generated_at: event.ts
      });
    }
    
    const p = proposals.get(key);
    
    switch (event.type) {
      case 'proposal_generated':
        p.status = 'open';
        p.reason = null;
        break;
      case 'proposal_filtered':
        p.status = 'filtered';
        p.reason = event.filter_reason || event.reason || null;
        break;
      case 'proposal_accepted':
        p.status = 'accepted';
        break;
      case 'proposal_rejected':
        p.status = 'rejected';
        p.reason = event.reason;
        break;
      case 'proposal_done':
        p.status = 'done';
        break;
      case 'proposal_snoozed':
        p.status = 'snoozed';
        p.snooze_until = event.snooze_until;
        // Check expiration
        if (event.snooze_until && new Date(event.snooze_until) < new Date()) {
          p.status = 'open';
        }
        break;
    }
    
    if (event.note) {
      p.note = event.note;
    }
  }
  
  // Filter
  let results = Array.from(proposals.values());
  
  if (filterStatus) {
    // For snoozed, include only non-expired
    if (filterStatus === 'snoozed') {
      results = results.filter(p => p.status === 'snoozed');
    } else {
      results = results.filter(p => p.status === filterStatus);
    }
  }
  
  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days, 10));
    results = results.filter(p => new Date(p.generated_at) >= cutoff);
  }
  
  // Sort by date desc
  results.sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at));
  
  // Output
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   PROPOSAL QUEUE (${results.length} proposals)`);
  if (filterStatus) console.log(`   Filtered by status: ${filterStatus}`);
  if (days) console.log(`   Filtered by days: ${days}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  results.forEach(p => {
    const noteStr = p.note ? ` [note: ${p.note.slice(0, 30)}...]` : '';
    const reasonStr = p.reason ? ` [reason: ${p.reason.slice(0, 30)}...]` : '';
    const snoozeStr = p.snooze_until ? ` [snoozed until ${p.snooze_until}]` : '';
    const status = (p.status || 'unknown').toUpperCase();
    console.log(`   [${status}] ${p.id}: ${p.title.slice(0, 50)}${p.title.length > 50 ? '...' : ''}${snoozeStr}${reasonStr}${noteStr}`);
  });
  
  if (results.length === 0) {
    console.log('   (No proposals found)');
  }
  
  return results;
}

// ACCEPT: Mark proposal as accepted
function accept(proposalId, note) {
  const events = loadEvents();
  
  // Find the proposal
  const generated = events
    .filter(e => e.type === 'proposal_generated' && e.proposal_id === proposalId)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  
  if (!generated) {
    console.error(`Proposal ${proposalId} not found`);
    return { success: false, error: 'Not found' };
  }
  
  const event = {
    ts: new Date().toISOString(),
    type: 'proposal_accepted',
    date: generated.date,
    proposal_id: proposalId,
    proposal_hash: generated.proposal_hash,
    title: generated.title,
    status_after: 'accepted',
    note: note || null,
    source: 'sensory_queue'
  };
  
  appendEvent(event);
  console.log(`Accepted proposal ${proposalId}: ${generated.title}`);
  return { success: true };
}

// REJECT: Mark proposal as rejected
function reject(proposalId, reason, note) {
  if (!reason) {
    console.error('Reject requires --reason="..."');
    return { success: false, error: 'Missing reason' };
  }
  
  const events = loadEvents();
  const generated = events
    .filter(e => e.type === 'proposal_generated' && e.proposal_id === proposalId)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  
  if (!generated) {
    console.error(`Proposal ${proposalId} not found`);
    return { success: false, error: 'Not found' };
  }

  const current = getProposalStatus(generated.proposal_hash, proposalId);
  if (String(current && current.status || '').toLowerCase() === 'rejected') {
    const priorReject = getLatestRejectEvent(events, proposalId);
    const priorReason = String(priorReject && priorReject.reason || '').trim();
    const nextReason = String(reason || '').trim();
    const priorNote = String(priorReject && priorReject.note || '').trim();
    const nextNote = String(note || '').trim();
    if (priorReason === nextReason && priorNote === nextNote) {
      console.log(`Reject no-op suppressed for ${proposalId}: unchanged reason/note`);
      return { success: true, skipped: true, reason: 'no_op_reject_repeat' };
    }
  }
  
  const event = {
    ts: new Date().toISOString(),
    type: 'proposal_rejected',
    date: generated.date,
    proposal_id: proposalId,
    proposal_hash: generated.proposal_hash,
    title: generated.title,
    status_after: 'rejected',
    reason: reason,
    note: note || null,
    source: 'sensory_queue'
  };
  
  appendEvent(event);
  console.log(`Rejected proposal ${proposalId}: ${generated.title}`);
  console.log(`Reason: ${reason}`);
  return { success: true };
}

// DONE: Mark proposal as completed
function done(proposalId, note) {
  const events = loadEvents();
  const generated = events
    .filter(e => e.type === 'proposal_generated' && e.proposal_id === proposalId)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  
  if (!generated) {
    console.error(`Proposal ${proposalId} not found`);
    return { success: false, error: 'Not found' };
  }
  
  const event = {
    ts: new Date().toISOString(),
    type: 'proposal_done',
    date: generated.date,
    proposal_id: proposalId,
    proposal_hash: generated.proposal_hash,
    title: generated.title,
    status_after: 'done',
    note: note || null,
    source: 'sensory_queue'
  };
  
  appendEvent(event);
  console.log(`Marked proposal ${proposalId} as done: ${generated.title}`);
  return { success: true };
}

// SNOOZE: Mark proposal as snoozed until date
function snooze(proposalId, until, note) {
  if (!until) {
    console.error('Snooze requires --until=YYYY-MM-DD');
    return { success: false, error: 'Missing until date' };
  }
  
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    console.error('Invalid date format. Use YYYY-MM-DD');
    return { success: false, error: 'Invalid date' };
  }
  
  const events = loadEvents();
  const generated = events
    .filter(e => e.type === 'proposal_generated' && e.proposal_id === proposalId)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  
  if (!generated) {
    console.error(`Proposal ${proposalId} not found`);
    return { success: false, error: 'Not found' };
  }
  
  const event = {
    ts: new Date().toISOString(),
    type: 'proposal_snoozed',
    date: generated.date,
    proposal_id: proposalId,
    proposal_hash: generated.proposal_hash,
    title: generated.title,
    status_after: 'snoozed',
    snooze_until: until,
    note: note || null,
    source: 'sensory_queue'
  };
  
  appendEvent(event);
  console.log(`Snoozed proposal ${proposalId} until ${until}: ${generated.title}`);
  return { success: true };
}

// STATS: Show proposal statistics
function stats(opts = {}) {
  const events = loadEvents();
  const { days } = opts;
  
  // Filter by days if specified
  let filteredEvents = events;
  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days, 10));
    filteredEvents = events.filter(e => new Date(e.ts) >= cutoff);
  }
  
  // Compute derived status for each proposal
  const proposals = new Map();
  
  for (const event of filteredEvents) {
    const key = proposalEventKey(event);
    if (!key) continue;
    if (!proposals.has(key)) {
      proposals.set(key, {
        key,
        hash: event.proposal_hash || null,
        id: event.proposal_id,
        title: event.title,
        date: event.date
      });
    }
    
    const p = proposals.get(key);
    
    switch (event.type) {
      case 'proposal_generated': p.status = 'open'; break;
      case 'proposal_filtered': p.status = 'filtered'; break;
      case 'proposal_accepted': p.status = 'accepted'; break;
      case 'proposal_rejected': p.status = 'rejected'; break;
      case 'proposal_done': p.status = 'done'; break;
      case 'proposal_snoozed':
        p.status = 'snoozed';
        if (event.snooze_until && new Date(event.snooze_until) < new Date()) {
          p.status = 'open';
        }
        break;
    }
  }
  
  // Count by status
  const counts = { open: 0, accepted: 0, rejected: 0, done: 0, snoozed: 0, filtered: 0 };
  for (const p of proposals.values()) {
    counts[p.status] = (counts[p.status] || 0) + 1;
  }
  
  // Find recurring titles (same title across >=2 dates)
  const titleDates = new Map();
  for (const p of proposals.values()) {
    if (!titleDates.has(p.title)) {
      titleDates.set(p.title, new Set());
    }
    titleDates.get(p.title).add(p.date);
  }
  
  const recurring = Array.from(titleDates.entries())
    .filter(([title, dates]) => dates.size >= 2)
    .map(([title, dates]) => ({ title, count: dates.size }))
    .sort((a, b) => b.count - a.count);
  
  // Output
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   PROPOSAL QUEUE STATISTICS');
  if (days) console.log(`   Last ${days} days`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Open:      ${counts.open}`);
  console.log(`   Accepted:  ${counts.accepted}`);
  console.log(`   Rejected:  ${counts.rejected}`);
  console.log(`   Done:      ${counts.done}`);
  console.log(`   Snoozed:   ${counts.snoozed}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`   Total:     ${proposals.size}`);
  console.log('───────────────────────────────────────────────────────────');
  
  if (recurring.length > 0) {
    console.log('\n   🔁 RECURRING (appears across 2+ days):');
    recurring.forEach(r => {
      console.log(`      ${r.title.slice(0, 50)}${r.title.length > 50 ? '...' : ''} (${r.count} days)`);
    });
  }
  
  return { counts, total: proposals.size, recurring };
}

function loadSourceProposalStatusMap(days = null) {
  const out = new Map();
  if (!fs.existsSync(PROPOSALS_DIR)) return out;
  const files = fs.readdirSync(PROPOSALS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  let cutoff = null;
  if (days) {
    cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days, 10));
  }
  for (const f of files) {
    const day = f.replace(/\.json$/, '');
    if (cutoff && new Date(`${day}T00:00:00Z`) < cutoff) continue;
    const fp = path.join(PROPOSALS_DIR, f);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      continue;
    }
    const proposals = normalizeProposalsJson(parsed, fp);
    for (const p of proposals) {
      const id = normalizeProposalId(p);
      if (!id || id === 'UNKNOWN') continue;
      const status = String(p && p.status || 'open').toLowerCase();
      out.set(id, status);
    }
  }
  return out;
}

// SWEEP: apply deterministic cleanup filters to currently-open proposals.
function sweep(opts = {}) {
  const events = loadEvents();
  const { days } = opts;
  let scoped = events;
  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days, 10));
    scoped = events.filter(e => new Date(e.ts) >= cutoff);
  }

  scoped.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const proposals = new Map();
  for (const event of scoped) {
    const key = proposalEventKey(event);
    if (!key) continue;
    if (!proposals.has(key)) {
      proposals.set(key, {
        key,
        hash: event.proposal_hash || null,
        id: event.proposal_id,
        title: event.title || 'Untitled',
        date: event.date || getToday(),
        status: 'open',
        last_ts: String(event.ts || new Date().toISOString()),
        cross_signal_key: crossSignalSweepKeyFromTitle(event.title || '')
      });
    }
    const p = proposals.get(key);
    p.last_ts = String(event.ts || p.last_ts || new Date().toISOString());
    if (!p.cross_signal_key) p.cross_signal_key = crossSignalSweepKeyFromTitle(event.title || p.title || '');
    switch (event.type) {
      case 'proposal_generated': p.status = 'open'; break;
      case 'proposal_filtered': p.status = 'filtered'; break;
      case 'proposal_accepted': p.status = 'accepted'; break;
      case 'proposal_rejected': p.status = 'rejected'; break;
      case 'proposal_done': p.status = 'done'; break;
      case 'proposal_snoozed':
        p.status = 'snoozed';
        if (event.snooze_until && new Date(event.snooze_until) < new Date()) p.status = 'open';
        break;
    }
  }

  const sourceStatuses = loadSourceProposalStatusMap(days);
  let filtered = 0;
  for (const p of proposals.values()) {
    if (String(p.status || '') !== 'open') continue;
    const sourceStatus = sourceStatuses.get(String(p.id || ''));
    if (sourceStatus && sourceStatus !== 'open' && sourceStatus !== 'accepted' && sourceStatus !== 'snoozed') {
      appendEvent({
        ts: new Date().toISOString(),
        type: 'proposal_filtered',
        date: p.date || getToday(),
        proposal_id: p.id || 'UNKNOWN',
        title: p.title || 'Untitled',
        proposal_hash: p.hash || null,
        status_after: 'filtered',
        filter_reason: `source_status_${sourceStatus}`,
        quality_gate: 'sweep_v1',
        source: 'sensory_queue'
      });
      filtered += 1;
      continue;
    }
    const title = String(p.title || '');
    const staleAgeHours = ageHoursFromTs(p.last_ts);
    if (Number.isFinite(staleAgeHours) && staleAgeHours >= Number(SENSORY_QUEUE_STALE_OPEN_HOURS || 96)) {
      appendEvent({
        ts: new Date().toISOString(),
        type: 'proposal_filtered',
        date: p.date || getToday(),
        proposal_id: p.id || 'UNKNOWN',
        title: title || 'Untitled',
        proposal_hash: p.hash || null,
        status_after: 'filtered',
        filter_reason: 'stale_open_age_sweep',
        stale_age_hours: staleAgeHours,
        stale_threshold_hours: Number(SENSORY_QUEUE_STALE_OPEN_HOURS || 96),
        quality_gate: 'sweep_v3',
        source: 'sensory_queue'
      });
      filtered += 1;
      continue;
    }
    if (!/\[stub\]/i.test(title)) continue;
    appendEvent({
      ts: new Date().toISOString(),
      type: 'proposal_filtered',
      date: p.date || getToday(),
      proposal_id: p.id || 'UNKNOWN',
      title: title || 'Untitled',
      proposal_hash: p.hash || null,
      status_after: 'filtered',
      filter_reason: 'stub_title_sweep',
      quality_gate: 'sweep_v1',
      source: 'sensory_queue'
    });
    filtered += 1;
  }

  // De-dupe open cross-signal proposals by family/topic and keep newest only.
  const crossGroups = new Map();
  for (const p of proposals.values()) {
    if (String(p.status || '') !== 'open') continue;
    if (!p.cross_signal_key) continue;
    if (!crossGroups.has(p.cross_signal_key)) crossGroups.set(p.cross_signal_key, []);
    crossGroups.get(p.cross_signal_key).push(p);
  }
  for (const rows of crossGroups.values()) {
    rows.sort((a, b) => new Date(b.last_ts || 0) - new Date(a.last_ts || 0));
    for (const stale of rows.slice(1)) {
      appendEvent({
        ts: new Date().toISOString(),
        type: 'proposal_filtered',
        date: stale.date || getToday(),
        proposal_id: stale.id || 'UNKNOWN',
        title: stale.title || 'Untitled',
        proposal_hash: stale.hash || null,
        status_after: 'filtered',
        filter_reason: 'cross_signal_topic_duplicate_sweep',
        quality_gate: 'sweep_v2',
        source: 'sensory_queue'
      });
      filtered += 1;
    }
  }

  console.log(`Sweep complete: filtered=${filtered} scope_days=${days || 'all'}`);
  return { filtered };
}

// Get today's date string
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

// Parse args helper
function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = {};
  
  for (const arg of args.slice(1)) {
    if (arg.startsWith('--status=')) {
      opts.status = arg.slice(9);
    } else if (arg.startsWith('--days=')) {
      opts.days = parseInt(arg.slice(7), 10);
    } else if (arg.startsWith('--note=')) {
      opts.note = arg.slice(7).replace(/^"|"$/g, '');
    } else if (arg.startsWith('--reason=')) {
      opts.reason = arg.slice(9).replace(/^"|"$/g, '');
    } else if (arg.startsWith('--until=')) {
      opts.until = arg.slice(8);
    } else if (!opts.id && !arg.startsWith('--')) {
      opts.id = arg;
    }
  }
  
  return { cmd, opts };
}

// Main
function main() {
  const { cmd, opts } = parseArgs();
  
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('sensory_queue.js - Proposal queue management');
    console.log('');
    console.log('Commands:');
    console.log('  ingest [YYYY-MM-DD]              Ingest proposals for date');
    console.log('  list [--status=X] [--days=N]     List proposals');
    console.log('  accept <ID> [--note="..."]       Accept proposal');
    console.log('  reject <ID> --reason="..."        Reject proposal');
    console.log('  done <ID> [--note="..."]         Mark proposal done');
    console.log('  snooze <ID> --until=YYYY-MM-DD   Snooze proposal');
    console.log('  stats [--days=N]                 Show statistics');
    console.log('  sweep [--days=N]                 Filter open stub proposals');
    return;
  }
  
  switch (cmd) {
    case 'ingest':
      ingest(opts.id || null);
      break;
    case 'list':
      list({ status: opts.status, days: opts.days });
      break;
    case 'accept':
      if (!opts.id) {
        console.error('Usage: accept <proposal_id> [--note="..."]');
        process.exit(1);
      }
      accept(opts.id, opts.note);
      break;
    case 'reject':
      if (!opts.id) {
        console.error('Usage: reject <proposal_id> --reason="..." [--note="..."]');
        process.exit(1);
      }
      reject(opts.id, opts.reason, opts.note);
      break;
    case 'done':
      if (!opts.id) {
        console.error('Usage: done <proposal_id> [--note="..."]');
        process.exit(1);
      }
      done(opts.id, opts.note);
      break;
    case 'snooze':
      if (!opts.id) {
        console.error('Usage: snooze <proposal_id> --until=YYYY-MM-DD [--note="..."]');
        process.exit(1);
      }
      snooze(opts.id, opts.until, opts.note);
      break;
    case 'stats':
      stats({ days: opts.days });
      break;
    case 'sweep':
      sweep({ days: opts.days });
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

// Export for use by other modules
module.exports = {
  ingest,
  list,
  accept,
  reject,
  done,
  snooze,
  stats,
  sweep,
  evaluateQueueQualityGate,
  evaluateActionSpecGate,
  evaluateExecutionWorthinessGate,
  computeExecutionWorthiness,
  computeProposalHash,
  getProposalStatus,
  loadEvents,
  // Paths (setters for testing)
  set SENSORY_DIR(v) { SENSORY_DIR = v; PROPOSALS_DIR = path.join(v, 'proposals'); QUEUE_LOG = path.join(v, 'queue_log.jsonl'); ensureDir(); },
  set PROPOSALS_DIR(v) { PROPOSALS_DIR = v; },
  set QUEUE_LOG(v) { QUEUE_LOG = v; },
  get QUEUE_LOG() { return QUEUE_LOG; },
  get PROPOSALS_DIR() { return PROPOSALS_DIR; }
};

module.exports.QUEUE_LOG = QUEUE_LOG;
module.exports.PROPOSALS_DIR = PROPOSALS_DIR;

// Run if called directly
if (require.main === module) {
  main();
}
