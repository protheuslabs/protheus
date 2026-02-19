#!/usr/bin/env node
/**
 * sensory_queue.js - Sensory Layer v1.2.2 (PROPOSAL QUEUE)
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

function normalizeBlockedReason(admissionPreview) {
  const blocked = admissionPreview && Array.isArray(admissionPreview.blocked_by)
    ? admissionPreview.blocked_by
    : [];
  return blocked.length ? String(blocked[0] || 'admission_blocked') : 'admission_blocked';
}

function evaluateQueueQualityGate(proposal) {
  const meta = proposal && proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : null;
  if (!metaHasQualitySignals(meta)) {
    return { allow: true, reason: null, gated: false };
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

  return { allow: true, reason: null, gated: true };
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
  let ingested = 0;
  let duplicates = 0;
  let filtered = 0;
  let filteredDuplicates = 0;
  const filteredByReason = {};
  
  for (const proposal of proposals) {
    const hash = computeProposalHash(proposal);
    
    // Idempotency: skip if already generated
    if (existingGeneratedHashes.has(hash)) {
      duplicates++;
      continue;
    }

    const gate = evaluateQueueQualityGate(proposal);
    if (!gate.allow) {
      if (existingFilteredHashes.has(hash)) {
        filteredDuplicates++;
        continue;
      }
      const reason = String(gate.reason || 'filtered');
      const filterEvent = {
        ts: new Date().toISOString(),
        type: 'proposal_filtered',
        date,
        proposal_id: proposal.id || 'UNKNOWN',
        title: proposal.title || 'Untitled',
        proposal_hash: hash,
        status_after: 'filtered',
        filter_reason: reason,
        quality_gate: 'ingest_v1',
        source: 'sensory_queue'
      };
      appendEvent(filterEvent);
      existingFilteredHashes.add(hash);
      filtered++;
      filteredByReason[reason] = Number(filteredByReason[reason] || 0) + 1;
      continue;
    }
    
    const event = {
      ts: new Date().toISOString(),
      type: 'proposal_generated',
      date: date,
      proposal_id: proposal.id || 'UNKNOWN',
      title: proposal.title || 'Untitled',
      proposal_hash: hash,
      status_after: 'open',
      source: 'sensory_queue'
    };
    
    appendEvent(event);
    existingGeneratedHashes.add(hash); // Prevent duplicates in same run
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
    const hash = event.proposal_hash;
    if (!proposals.has(hash)) {
      proposals.set(hash, {
        hash,
        id: event.proposal_id,
        title: event.title,
        date: event.date,
        generated_at: event.ts
      });
    }
    
    const p = proposals.get(hash);
    
    switch (event.type) {
      case 'proposal_generated':
        p.status = 'open';
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
    console.log(`   [${p.status.toUpperCase()}] ${p.id}: ${p.title.slice(0, 50)}${p.title.length > 50 ? '...' : ''}${snoozeStr}${reasonStr}${noteStr}`);
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
    const hash = event.proposal_hash;
    if (!proposals.has(hash)) {
      proposals.set(hash, {
        hash,
        id: event.proposal_id,
        title: event.title,
        date: event.date
      });
    }
    
    const p = proposals.get(hash);
    
    switch (event.type) {
      case 'proposal_generated': p.status = 'open'; break;
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
  const counts = { open: 0, accepted: 0, rejected: 0, done: 0, snoozed: 0 };
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
  evaluateQueueQualityGate,
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
