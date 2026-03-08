#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadQueue, queueForApproval } = require('../../lib/approval_gate');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_AUTONOMY_DIR = fs.existsSync(path.join(ROOT, 'local', 'state', 'autonomy'))
  ? path.join(ROOT, 'local', 'state', 'autonomy')
  : path.join(ROOT, 'state', 'autonomy');
const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : DEFAULT_AUTONOMY_DIR;
const REPLAY_DIR = process.env.AUTONOMY_AUTOPHAGY_REPLAY_REPORTS_DIR
  ? path.resolve(process.env.AUTONOMY_AUTOPHAGY_REPLAY_REPORTS_DIR)
  : path.join(AUTONOMY_DIR, 'autophagy_replay');
const PAYLOAD_DIR = process.env.AUTONOMY_AUTOPHAGY_APPROVAL_PAYLOADS_DIR
  ? path.resolve(process.env.AUTONOMY_AUTOPHAGY_APPROVAL_PAYLOADS_DIR)
  : path.join(AUTONOMY_DIR, 'autophagy_approval_payloads');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/non_yield_enqueue.js run [--replay=<path>] [--max=N] [--dry-run]');
  console.log('  node systems/autonomy/non_yield_enqueue.js status [--replay=<path>] [--max=N]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function resolvePath(raw, fallbackAbs) {
  const v = String(raw || '').trim();
  if (!v) return fallbackAbs;
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

function toInt(v, fallback, lo = 1, hi = 1000) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function latestReplayPath() {
  if (!fs.existsSync(REPLAY_DIR)) return null;
  const files = fs.readdirSync(REPLAY_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  if (!files.length) return null;
  return path.join(REPLAY_DIR, files[files.length - 1]);
}

function queueIds(queue) {
  const ids = new Set();
  for (const section of ['pending', 'approved', 'denied', 'history']) {
    const rows = Array.isArray(queue && queue[section]) ? queue[section] : [];
    for (const row of rows) {
      const id = String(row && row.action_id || '').trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

function normalizeCandidateId(raw) {
  const out = String(raw || '').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
  return out || 'unknown';
}

function candidateIdFromActionId(actionId) {
  const id = String(actionId || '').trim().toLowerCase();
  const m = /^act_autophagy_([a-z0-9_-]+)(?:_|$)/.exec(id);
  return m ? String(m[1] || '') : '';
}

function activeAutophagyCandidateIds(queue) {
  const ids = new Set();
  for (const section of ['pending', 'approved']) {
    const rows = Array.isArray(queue && queue[section]) ? queue[section] : [];
    for (const row of rows) {
      const id = candidateIdFromActionId(row && row.action_id);
      if (!id) continue;
      ids.add(id);
    }
  }
  return ids;
}

function actionIdForCandidate(candidate, endDate) {
  const cid = normalizeCandidateId(candidate && candidate.candidate_id);
  const datePart = String(endDate || '').replace(/[^0-9]/g, '') || 'unknown';
  return `act_autophagy_${cid}_${datePart}`;
}

function candidateImpactScore(candidate) {
  const row = candidate && typeof candidate === 'object' ? candidate : {};
  const deltas = row.deltas_vs_baseline && typeof row.deltas_vs_baseline === 'object'
    ? row.deltas_vs_baseline
    : {};
  const support = Math.max(0, Number(row.support_count || 0));
  const confidence = Math.max(0, Math.min(1, Number(row.confidence || 0)));
  const driftGain = Math.max(0, -Number(deltas.drift_rate || 0));
  const yieldGain = Math.max(0, Number(deltas.yield_rate || 0));
  const safetyGain = Math.max(0, -Number(deltas.safety_stop_rate || 0));
  const impact = (driftGain * 1200) + (yieldGain * 700) + (safetyGain * 900) + (support * 0.35) + (confidence * 25);
  return Number(impact.toFixed(6));
}

function rankReplayPassCandidates(rows) {
  const arr = Array.isArray(rows) ? rows.slice() : [];
  arr.sort((a, b) => {
    const ai = candidateImpactScore(a);
    const bi = candidateImpactScore(b);
    if (bi !== ai) return bi - ai;
    const ac = Number(a && a.confidence || 0);
    const bc = Number(b && b.confidence || 0);
    if (bc !== ac) return bc - ac;
    const as = Number(a && a.support_count || 0);
    const bs = Number(b && b.support_count || 0);
    if (bs !== as) return bs - as;
    return String(a && a.candidate_id || '').localeCompare(String(b && b.candidate_id || ''));
  });
  return arr;
}

function summarizeCandidate(candidate) {
  const category = String(candidate && candidate.category || 'unknown');
  const reason = String(candidate && candidate.reason || 'unknown');
  const support = Number(candidate && candidate.support_count || 0);
  const conf = Number(candidate && candidate.confidence || 0);
  const impact = candidateImpactScore(candidate);
  return `[Autophagy] ${category}/${reason} support=${support} conf=${conf.toFixed(3)} impact=${impact.toFixed(2)}`;
}

function reasonForQueue(candidate) {
  const guardrail = String(candidate && candidate.guardrail || '').trim() || 'replay_pass_non_regression';
  const deltas = candidate && candidate.deltas_vs_baseline && typeof candidate.deltas_vs_baseline === 'object'
    ? candidate.deltas_vs_baseline
    : {};
  return `Replay gate pass. Guardrail: ${guardrail}. deltas(drift=${Number(deltas.drift_rate || 0).toFixed(6)},yield=${Number(deltas.yield_rate || 0).toFixed(6)},safety=${Number(deltas.safety_stop_rate || 0).toFixed(6)}). Human approval required before canary.`;
}

function writePayload(actionId, payload) {
  ensureDir(PAYLOAD_DIR);
  const fp = path.join(PAYLOAD_DIR, `${actionId}.json`);
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return fp;
}

function run(opts = {}) {
  const replayPath = resolvePath(opts.replay, latestReplayPath() || '');
  const maxItems = toInt(opts.max, 10, 1, 500);
  const dryRun = opts.dry_run === true;
  if (!replayPath || !fs.existsSync(replayPath)) {
    throw new Error(`replay_missing:${replayPath || REPLAY_DIR}`);
  }

  const replay = readJson(replayPath);
  const endDate = String(replay && replay.end_date || '');
  const passRows = Array.isArray(replay && replay.replay_pass_candidates) ? replay.replay_pass_candidates : [];
  const rankedPassRows = rankReplayPassCandidates(passRows);

  const queue = loadQueue();
  const existingIds = queueIds(queue);
  const activeCandidateIds = activeAutophagyCandidateIds(queue);

  let scanned = 0;
  let queued = 0;
  let skippedExisting = 0;
  let skippedDuplicateCandidate = 0;
  const actions = [];

  for (const candidate of rankedPassRows) {
    if (scanned >= maxItems) break;
    scanned += 1;
    const candidateId = normalizeCandidateId(candidate && candidate.candidate_id);
    const actionId = actionIdForCandidate(candidate, endDate);
    const impactScore = candidateImpactScore(candidate);
    if (activeCandidateIds.has(candidateId)) {
      skippedDuplicateCandidate += 1;
      actions.push({
        action_id: actionId,
        candidate_id: candidateId,
        status: 'SKIPPED_DUPLICATE_CANDIDATE',
        impact_score: impactScore
      });
      continue;
    }
    if (existingIds.has(actionId)) {
      skippedExisting += 1;
      actions.push({
        action_id: actionId,
        candidate_id: candidateId,
        status: 'SKIPPED_EXISTING',
        impact_score: impactScore
      });
      continue;
    }

    const envelope = {
      action_id: actionId,
      directive_id: 'T0_invariants',
      type: 'autophagy_policy_candidate',
      summary: summarizeCandidate(candidate)
    };
    const gateReason = reasonForQueue(candidate);

    if (dryRun) {
      actions.push({
        action_id: actionId,
        candidate_id: candidateId,
        status: 'DRY_RUN_PENDING',
        impact_score: impactScore,
        summary: envelope.summary
      });
      continue;
    }

    const payloadPath = writePayload(actionId, {
      ts: new Date().toISOString(),
      type: 'autophagy_policy_candidate_payload',
      source_replay_path: replayPath,
      replay_end_date: endDate,
      candidate
    });

    const res = queueForApproval(envelope, gateReason);
    activeCandidateIds.add(candidateId);
    queued += 1;
    actions.push({
      action_id: actionId,
      candidate_id: candidateId,
      status: String(res && res.status || 'PENDING'),
      impact_score: impactScore,
      payload_path: payloadPath,
      summary: envelope.summary
    });
  }

  return {
    ok: true,
    type: 'autonomy_non_yield_enqueue',
    ts: new Date().toISOString(),
    replay_path: replayPath,
    dry_run: dryRun,
    max_items: maxItems,
    counts: {
      replay_pass_candidates: passRows.length,
      scanned,
      queued,
      skipped_existing: skippedExisting,
      skipped_duplicate_candidate: skippedDuplicateCandidate
    },
    actions
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  const out = run({
    replay: args.replay,
    max: args.max,
    dry_run: args['dry-run'] === true || args.dry_run === true || cmd === 'status'
  });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'non_yield_enqueue_failed') }) + '\n');
    process.exit(1);
  }
}
