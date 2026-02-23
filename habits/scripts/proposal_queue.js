#!/usr/bin/env node
/**
 * proposal_queue.js - Proposal Queue v1.0 (Decision + Outcome Tracking)
 *
 * NOTE (spine/queue_gc dependency):
 * - queue_gc.js calls:
 *     node habits/scripts/proposal_queue.js reject <ID> "<reason>"
 * - If you ever change the CLI surface, update queue_gc.js accordingly.
 *
 * Goal:
 * - Make sensory proposals actionable + measurable for closed-loop evolution (e.g., External Eyes atrophy/grow).
 *
 * Constraints:
 * - No autonomous execution.
 * - Append-only decision log (JSONL).
 * - Deterministic; no LLM required.
 * - Integrates with existing sensory proposals:
 *   state/sensory/proposals/YYYY-MM-DD.json
 *
 * State:
 * - state/queue/decisions/YYYY-MM-DD.jsonl (append-only)
 * - state/queue/metrics/YYYY-MM-DD.json (derived, rewrite allowed)
 *
 * Commands:
 *   - list [--date=YYYY-MM-DD] [--status=pending|accepted|rejected|parked]
 *   - accept <proposal_id> "<reason>"
 *   - reject <proposal_id> "<reason>"
 *   - park <proposal_id> "<reason>"
 *   - outcome <proposal_id> shipped|reverted|no_change "<evidence_ref>"
 *   - metrics [--date=YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');

// Root assumptions (repo root = two levels up from habits/scripts)
const REPO_ROOT = path.join(__dirname, '..', '..');
const SENSORY_PROPOSALS_DIR = path.join(REPO_ROOT, 'state', 'sensory', 'proposals');
const SENSORY_QUEUE_LOG = path.join(REPO_ROOT, 'state', 'sensory', 'queue_log.jsonl');

const QUEUE_DIR = path.join(REPO_ROOT, 'state', 'queue');
const DECISIONS_DIR = path.join(QUEUE_DIR, 'decisions');
const METRICS_DIR = path.join(QUEUE_DIR, 'metrics');

function ensureDirs() {
  [QUEUE_DIR, DECISIONS_DIR, METRICS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function decisionsPathFor(dateStr) {
  return path.join(DECISIONS_DIR, `${dateStr}.jsonl`);
}

function metricsPathFor(dateStr) {
  return path.join(METRICS_DIR, `${dateStr}.json`);
}

function proposalsPathFor(dateStr) {
  return path.join(SENSORY_PROPOSALS_DIR, `${dateStr}.json`);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlEventsSafe(p) {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed line; keep deterministic behavior
    }
  }
  return out;
}

function appendJsonl(p, obj) {
  ensureDirs();
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}

function writeJsonPretty(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
}

// CLI arg parsing: --key=value
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        out[a.slice(2)] = true;
      } else {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        out[k] = v;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Overlay model:
// - Decisions: last decision event wins (accept|reject|park)
// - Outcomes: last outcome event wins (shipped|reverted|no_change)
function buildOverlay(events) {
  const byId = new Map();
  for (const e of events) {
    if (!e || !e.proposal_id || !e.type) continue;
    const cur = byId.get(e.proposal_id) || { decision: null, outcome: null, decision_ts: null, outcome_ts: null };
    if (e.type === 'decision' && e.decision) {
      if (!cur.decision_ts || String(e.ts) >= String(cur.decision_ts)) {
        cur.decision = e.decision;
        cur.decision_ts = e.ts;
        cur.reason = e.reason;
      }
    } else if (e.type === 'outcome' && e.outcome) {
      if (!cur.outcome_ts || String(e.ts) >= String(cur.outcome_ts)) {
        cur.outcome = e.outcome;
        cur.outcome_ts = e.ts;
        cur.evidence_ref = e.evidence_ref;
      }
    }
    byId.set(e.proposal_id, cur);
  }
  return byId;
}

function normalizedStatus(proposal, overlayEntry, sensoryEntry = null) {
  const explicit = String(proposal && (proposal.status || proposal.state) || '').trim().toLowerCase();
  if (explicit) {
    if (explicit === 'accepted' || explicit === 'accept' || explicit === 'admitted' || explicit === 'queued') return 'accepted';
    if (explicit === 'parked' || explicit === 'snoozed') return 'parked';
    if (
      explicit === 'rejected'
      || explicit === 'reject'
      || explicit === 'filtered'
      || explicit === 'superseded'
      || explicit === 'archived'
      || explicit === 'dropped'
    ) return 'rejected';
    if (
      explicit === 'resolved'
      || explicit === 'done'
      || explicit === 'closed'
      || explicit === 'shipped'
      || explicit === 'no_change'
      || explicit === 'reverted'
    ) return 'closed';
  }
  if (sensoryEntry && sensoryEntry.status) {
    const sensoryStatus = String(sensoryEntry.status).trim().toLowerCase();
    if (sensoryStatus === 'rejected' || sensoryStatus === 'filtered') return 'rejected';
    if (sensoryStatus === 'accepted') return 'accepted';
    if (
      sensoryStatus === 'done'
      || sensoryStatus === 'closed'
      || sensoryStatus === 'resolved'
      || sensoryStatus === 'shipped'
      || sensoryStatus === 'no_change'
      || sensoryStatus === 'reverted'
    ) return 'closed';
    if (sensoryStatus === 'parked' || sensoryStatus === 'snoozed') return 'parked';
  }
  if (overlayEntry && overlayEntry.outcome) {
    const outcome = String(overlayEntry.outcome).trim().toLowerCase();
    if (
      outcome === 'shipped'
      || outcome === 'no_change'
      || outcome === 'reverted'
      || outcome === 'done'
      || outcome === 'resolved'
      || outcome === 'closed'
    ) return 'closed';
  }
  if (!overlayEntry || !overlayEntry.decision) return 'pending';
  if (overlayEntry.decision === 'accept') return 'accepted';
  if (overlayEntry.decision === 'reject') return 'rejected';
  if (overlayEntry.decision === 'park') return 'parked';
  return 'pending';
}

function buildSensoryOverlay(events, dateStr) {
  const byId = new Map();
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.proposal_id || e.id || '').trim();
    if (!id || id === 'UNKNOWN') continue;
    const t = String(e.type || '').trim().toLowerCase();
    if (!t) continue;
    let status = null;
    if (t === 'proposal_generated') status = 'pending';
    else if (t === 'proposal_filtered' || t === 'proposal_rejected') status = 'rejected';
    else if (t === 'proposal_accepted') status = 'accepted';
    else if (t === 'proposal_done') status = 'done';
    else if (t === 'proposal_snoozed') {
      const untilMs = Date.parse(String(e.snooze_until || ''));
      status = Number.isFinite(untilMs) && untilMs > Date.now() ? 'parked' : 'pending';
    }
    if (!status) continue;
    byId.set(id, {
      status,
      ts: e.ts || null,
      reason: e.reason || e.filter_reason || null
    });
  }
  return byId;
}

function terminalStatusLabel(status, overlayEntry, sensoryEntry) {
  if (status === 'rejected') {
    const sensoryStatus = String(sensoryEntry && sensoryEntry.status || '').trim().toLowerCase();
    if (sensoryStatus === 'filtered') return 'filtered';
    return 'rejected';
  }
  const outcome = String(overlayEntry && overlayEntry.outcome || '').trim().toLowerCase();
  if (outcome === 'shipped' || outcome === 'reverted' || outcome === 'no_change') return outcome;
  const sensoryStatus = String(sensoryEntry && sensoryEntry.status || '').trim().toLowerCase();
  if (sensoryStatus === 'shipped' || sensoryStatus === 'reverted' || sensoryStatus === 'no_change') return sensoryStatus;
  if (sensoryStatus === 'done' || sensoryStatus === 'resolved') return 'done';
  return 'closed';
}

function listProposalFiles(opts = {}) {
  if (!fs.existsSync(SENSORY_PROPOSALS_DIR)) return [];
  let files = fs.readdirSync(SENSORY_PROPOSALS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date))) {
    files = files.filter((f) => f === `${opts.date}.json`);
  } else if (opts.days != null) {
    const days = Math.max(1, Number(opts.days) || 1);
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
    files = files.filter((f) => {
      const day = f.slice(0, 10);
      const ms = Date.parse(`${day}T00:00:00.000Z`);
      return Number.isFinite(ms) && ms >= cutoff.getTime();
    });
  }
  return files;
}

function readDecisionEventsAll() {
  if (!fs.existsSync(DECISIONS_DIR)) return [];
  const files = fs.readdirSync(DECISIONS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    out.push(...readJsonlEventsSafe(path.join(DECISIONS_DIR, f)));
  }
  return out;
}

function normalizeProposalsShape(raw) {
  if (Array.isArray(raw)) {
    return {
      proposals: raw,
      write(next) { return next; }
    };
  }
  if (raw && Array.isArray(raw.proposals)) {
    return {
      proposals: raw.proposals,
      write(next) { return { ...raw, proposals: next }; }
    };
  }
  return null;
}

function reconcileCmd(opts) {
  const dryRun = String(opts['dry-run'] || opts.dry_run || '0') === '1';
  const files = listProposalFiles({
    date: opts.date || null,
    days: opts.all ? null : (opts.days || 30)
  });
  if (files.length === 0) {
    console.log('No proposal files found to reconcile.');
    return {
      ok: true,
      files_scanned: 0,
      files_updated: 0,
      proposals_updated: 0,
      dry_run: dryRun
    };
  }

  const overlay = buildOverlay(readDecisionEventsAll());
  const sensoryOverlay = buildSensoryOverlay(readJsonlEventsSafe(SENSORY_QUEUE_LOG));
  const now = new Date().toISOString();

  let filesUpdated = 0;
  let proposalsUpdated = 0;
  const sample = [];

  for (const file of files) {
    const fp = path.join(SENSORY_PROPOSALS_DIR, file);
    const raw = readJsonSafe(fp);
    const shaped = normalizeProposalsShape(raw);
    if (!shaped) continue;
    const next = [];
    let changedInFile = 0;

    for (const proposal of shaped.proposals) {
      const p = proposal && typeof proposal === 'object' ? { ...proposal } : proposal;
      const id = String(p && p.id || '').trim();
      if (!id) {
        next.push(p);
        continue;
      }
      const ov = overlay.get(id) || null;
      const sensory = sensoryOverlay.get(id) || null;
      const target = normalizedStatus(p, ov, sensory);
      if (target === 'rejected' || target === 'closed') {
        const desired = terminalStatusLabel(target, ov, sensory);
        const current = String(p && (p.status || p.state) || '').trim().toLowerCase();
        if (current !== desired) {
          p.status = desired;
          p.queue_synced_ts = now;
          p.queue_synced_reason = String((ov && ov.reason) || (sensory && sensory.reason) || `reconcile_${target}`);
          p.queue_synced_source = 'proposal_queue_reconcile_v1';
          changedInFile += 1;
          proposalsUpdated += 1;
          if (sample.length < 20) {
            sample.push({
              file,
              proposal_id: id,
              from: current || null,
              to: desired
            });
          }
        }
      }
      next.push(p);
    }

    if (changedInFile > 0) {
      filesUpdated += 1;
      if (!dryRun) {
        writeJsonPretty(fp, shaped.write(next));
      }
    }
  }

  const out = {
    ok: true,
    files_scanned: files.length,
    files_updated: filesUpdated,
    proposals_updated: proposalsUpdated,
    dry_run: dryRun,
    sample_updates: sample
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

function loadProposals(dateStr) {
  const p = proposalsPathFor(dateStr);
  const data = readJsonSafe(p);
  if (!data) return { ok: false, proposals: [], error: `No proposals found at ${p}` };

  // Accept both formats:
  // - array (preferred)
  // - { proposals: [...] }
  let proposals = null;
  if (Array.isArray(data)) proposals = data;
  else if (data && Array.isArray(data.proposals)) proposals = data.proposals;

  if (!Array.isArray(proposals)) {
    return { ok: false, proposals: [], error: 'Proposals must be an array (or {proposals:[...]})' };
  }
  return { ok: true, proposals };
}

function listCmd(opts) {
  const dateStr = opts.date || todayStr();
  const desiredStatus = opts.status || null;

  const { ok, proposals, error } = loadProposals(dateStr);
  if (!ok) {
    console.error(error);
    process.exit(1);
  }

  const decisionsFile = decisionsPathFor(dateStr);
  const events = readJsonlEventsSafe(decisionsFile);
  const overlay = buildOverlay(events);
  const sensoryOverlay = buildSensoryOverlay(readJsonlEventsSafe(SENSORY_QUEUE_LOG), dateStr);

  const enriched = proposals.map(p => {
    const ov = overlay.get(p.id) || null;
    const sensory = sensoryOverlay.get(String(p && p.id || '')) || null;
    const status = normalizedStatus(p, ov, sensory);
    return {
      ...p,
      __status: status,
      __decision: ov?.decision || null,
      __reason: ov?.reason || sensory?.reason || null,
      __outcome: ov?.outcome || null,
      __evidence_ref: ov?.evidence_ref || null
    };
  });

  const filtered = desiredStatus ? enriched.filter(p => p.__status === desiredStatus) : enriched;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`PROPOSAL QUEUE v1.0 (${filtered.length} proposals)`);
  console.log(`Date: ${dateStr}`);
  if (desiredStatus) console.log(`Filtered by status: ${desiredStatus}`);
  console.log('═══════════════════════════════════════════════════════════');

  if (filtered.length === 0) {
    console.log('(none)');
    return;
  }

  for (const p of filtered) {
    const status = p.__status.toUpperCase()[0];
    const outcomeStr = p.__outcome ? ` [${p.__outcome}]` : '';
    const evidenceStr = p.__evidence_ref ? ` ref=${p.__evidence_ref}` : '';
    console.log(`[${status}] ${p.id}: ${p.title}${outcomeStr}${evidenceStr}`);
    if (p.__reason) console.log(`    reason: ${p.__reason}`);
  }
}

function recordDecision(proposalId, decision, reason) {
  if (!proposalId) {
    console.error('Error: proposal_id required');
    process.exit(1);
  }
  if (!reason) {
    console.error('Error: reason required');
    process.exit(1);
  }
  const dateStr = todayStr();
  const evt = {
    ts: new Date().toISOString(),
    type: 'decision',
    proposal_id: proposalId,
    decision,
    reason
  };
  appendJsonl(decisionsPathFor(dateStr), evt);
  console.log(`Recorded ${decision} for ${proposalId}: ${reason}`);
}

function recordOutcome(proposalId, outcome, evidenceRef) {
  if (!proposalId) {
    console.error('Error: proposal_id required');
    process.exit(1);
  }
  if (!evidenceRef) {
    console.error('Error: evidence_ref required');
    process.exit(1);
  }
  const dateStr = todayStr();
  const evt = {
    ts: new Date().toISOString(),
    type: 'outcome',
    proposal_id: proposalId,
    outcome,
    evidence_ref: evidenceRef
  };
  appendJsonl(decisionsPathFor(dateStr), evt);
  console.log(`Recorded ${outcome} for ${proposalId}: ${evidenceRef}`);
}

function metricsCmd(opts) {
  const dateStr = opts.date || todayStr();

  const { ok, proposals, error } = loadProposals(dateStr);
  if (!ok) {
    console.error(error);
    process.exit(1);
  }

  const decisionsFile = decisionsPathFor(dateStr);
  const events = readJsonlEventsSafe(decisionsFile);
  const overlay = buildOverlay(events);
  const sensoryOverlay = buildSensoryOverlay(readJsonlEventsSafe(SENSORY_QUEUE_LOG), dateStr);

  const enriched = proposals.map(p => {
    const ov = overlay.get(p.id) || null;
    const sensory = sensoryOverlay.get(String(p && p.id || '')) || null;
    const status = normalizedStatus(p, ov, sensory);
    return { ...p, __status: status, __outcome: ov?.outcome || null };
  });

  const total = enriched.length;
  const accepted = enriched.filter(p => p.__status === 'accepted').length;
  const closed = enriched.filter(p => p.__status === 'closed').length;
  const rejected = enriched.filter(p => p.__status === 'rejected').length;
  const parked = enriched.filter(p => p.__status === 'parked').length;
  const pending = enriched.filter(p => p.__status === 'pending').length;
  const acceptedOrClosed = accepted + closed;

  // Outcomes among accepted and closed proposals.
  const acceptedWithOutcome = enriched.filter(
    p => (p.__status === 'accepted' || p.__status === 'closed') && p.__outcome
  );
  const shipped = acceptedWithOutcome.filter(p => String(p.__outcome) === 'shipped').length;
  const reverted = acceptedWithOutcome.filter(p => String(p.__outcome) === 'reverted').length;
  const noChange = acceptedWithOutcome.filter(p => String(p.__outcome) === 'no_change').length;

  const adoptionRate = total > 0 ? acceptedOrClosed / total : 0;
  const outcomeRate = acceptedOrClosed > 0 ? acceptedWithOutcome.length / acceptedOrClosed : 0;
  const revertRate = (shipped + reverted) > 0 ? reverted / (shipped + reverted) : 0;

  const metrics = {
    date: dateStr,
    counts: {
      total,
      pending,
      accepted,
      closed,
      accepted_or_closed: acceptedOrClosed,
      rejected,
      parked,
      shipped,
      reverted,
      no_change: noChange
    },
    rates: {
      adoption_rate: parseFloat(adoptionRate.toFixed(3)),
      outcome_rate: parseFloat(outcomeRate.toFixed(3)),
      revert_rate: parseFloat(revertRate.toFixed(3))
    },
    by_type: {}
  };

  // Breakdown by proposal type
  const byType = {};
  for (const p of enriched) {
    const t = p.type || 'unknown';
    if (!byType[t]) byType[t] = { total: 0, accepted: 0, closed: 0, shipped: 0, reverted: 0 };
    byType[t].total++;
    if (p.__status === 'accepted') byType[t].accepted++;
    if (p.__status === 'closed') byType[t].closed++;
    if (p.__outcome === 'shipped') byType[t].shipped++;
    if (p.__outcome === 'reverted') byType[t].reverted++;
  }
  metrics.by_type = byType;

  const mp = metricsPathFor(dateStr);
  ensureDirs();
  fs.writeFileSync(mp, JSON.stringify(metrics, null, 2));

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`PROPOSAL METRICS v1.0 (${dateStr})`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Total proposals: ${total}`);
  console.log(`  Pending:  ${pending}`);
  console.log(`  Accepted: ${accepted}`);
  console.log(`  Closed:   ${closed}`);
  console.log(`  Rejected: ${rejected}`);
  console.log(`  Parked:   ${parked}`);
  console.log('');
  console.log('Outcomes (among accepted):');
  console.log(`  Shipped:   ${shipped}`);
  console.log(`  Reverted:  ${reverted}`);
  console.log(`  No change: ${noChange}`);
  console.log('');
  console.log('Rates:');
  console.log(`  Adoption: ${(adoptionRate * 100).toFixed(1)}%`);
  console.log(`  Outcome:  ${(outcomeRate * 100).toFixed(1)}%`);
  console.log(`  Revert:   ${(revertRate * 100).toFixed(1)}%`);
  console.log('');
  console.log('By type:');
  for (const [t, v] of Object.entries(byType)) {
    const adopted = v.total > 0 ? (v.accepted / v.total * 100).toFixed(0) : '0';
    const revert = (v.shipped + v.reverted) > 0 ? (v.reverted / (v.shipped + v.reverted) * 100).toFixed(0) : '0';
    console.log(`  ${t}: ${v.total} total, ${adopted}% adoption, ${revert}% revert`);
  }
  console.log('');
  console.log(`File: ${mp}`);
}

function proposeCmd(args) {
  // Placeholder for propose if needed; currently proposals come from sensory_insight
  console.log('Proposals are generated by sensory_insight.js. To add proposals, run:');
  console.log('  node habits/scripts/sensory_insight.js daily [YYYY-MM-DD]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('proposal_queue.js v1.0 - Decision + Outcome Tracking');
    console.log('');
  console.log('Commands:');
    console.log('  list [--date=YYYY-MM-DD] [--status=STATUS]');
    console.log('  accept <proposal_id> "<reason>"');
    console.log('  reject <proposal_id> "<reason>"');
    console.log('  park   <proposal_id> "<reason>"');
    console.log('  outcome <proposal_id> shipped|reverted|no_change "<evidence_ref>"');
    console.log('  metrics [--date=YYYY-MM-DD]');
    console.log('  reconcile [--days=N|--date=YYYY-MM-DD|--all=1] [--dry-run=1]');
    console.log('');
    console.log('Status: pending|accepted|closed|rejected|parked');
    console.log('Outcomes tracked for accepted and closed proposals.');
    return;
  }

  switch (cmd) {
    case 'list':
      listCmd(args);
      break;
    case 'accept':
      recordDecision(args._[1], 'accept', args._[2]);
      break;
    case 'reject':
      recordDecision(args._[1], 'reject', args._[2]);
      break;
    case 'park':
      recordDecision(args._[1], 'park', args._[2]);
      break;
    case 'outcome':
      recordOutcome(args._[1], args._[2], args._[3]);
      break;
    case 'metrics':
      metricsCmd(args);
      break;
    case 'reconcile':
      reconcileCmd(args);
      break;
    case 'propose':
      proposeCmd(args);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

module.exports = {
  ensureDirs,
  decisionsPathFor,
  metricsPathFor,
  loadProposals,
  buildOverlay,
  normalizedStatus,
  listCmd,
  metricsCmd,
  reconcileCmd,
  recordDecision,
  recordOutcome,
  parseArgs
};

if (require.main === module) {
  main();
}
