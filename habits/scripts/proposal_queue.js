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

function normalizedStatus(overlayEntry) {
  if (!overlayEntry || !overlayEntry.decision) return 'pending';
  if (overlayEntry.decision === 'accept') return 'accepted';
  if (overlayEntry.decision === 'reject') return 'rejected';
  if (overlayEntry.decision === 'park') return 'parked';
  return 'pending';
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

  const enriched = proposals.map(p => {
    const ov = overlay.get(p.id) || null;
    const status = normalizedStatus(ov);
    return { ...p, __status: status, __decision: ov?.decision || null, __reason: ov?.reason || null, __outcome: ov?.outcome || null, __evidence_ref: ov?.evidence_ref || null };
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

  const enriched = proposals.map(p => {
    const ov = overlay.get(p.id) || null;
    const status = normalizedStatus(ov);
    return { ...p, __status: status, __outcome: ov?.outcome || null };
  });

  const total = enriched.length;
  const accepted = enriched.filter(p => p.__status === 'accepted').length;
  const rejected = enriched.filter(p => p.__status === 'rejected').length;
  const parked = enriched.filter(p => p.__status === 'parked').length;
  const pending = enriched.filter(p => p.__status === 'pending').length;

  // Outcomes among accepted
  const acceptedWithOutcome = enriched.filter(p => p.__status === 'accepted' && p.__outcome);
  const shipped = acceptedWithOutcome.filter(p => p.__outcome === 'shipped').length;
  const reverted = acceptedWithOutcome.filter(p => p.__outcome === 'reverted').length;
  const noChange = acceptedWithOutcome.filter(p => p.__outcome === 'no_change').length;

  const adoptionRate = total > 0 ? accepted / total : 0;
  const outcomeRate = accepted > 0 ? acceptedWithOutcome.length / accepted : 0;
  const revertRate = (shipped + reverted) > 0 ? reverted / (shipped + reverted) : 0;

  const metrics = {
    date: dateStr,
    counts: { total, pending, accepted, rejected, parked, shipped, reverted, no_change: noChange },
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
    if (!byType[t]) byType[t] = { total: 0, accepted: 0, shipped: 0, reverted: 0 };
    byType[t].total++;
    if (p.__status === 'accepted') byType[t].accepted++;
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
    console.log('');
    console.log('Status: pending|accepted|rejected|parked');
    console.log('Outcomes tracked only for accepted proposals.');
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
  recordDecision,
  recordOutcome,
  parseArgs
};

if (require.main === module) {
  main();
}
