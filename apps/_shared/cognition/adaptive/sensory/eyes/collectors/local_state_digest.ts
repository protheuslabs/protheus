/**
 * adaptive/sensory/eyes/collectors/local_state_digest.ts
 *
 * Deterministic offline-safe collector.
 * Reads local state artifacts only (no network) and emits actionable signal items.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE_DIR = path.join(__dirname, '..', '..', '..', '..');
const STATE_DIR = path.join(WORKSPACE_DIR, 'local', 'state');
const SENSORY_PROPOSALS_DIR = path.join(STATE_DIR, 'sensory', 'proposals');
const QUEUE_DECISIONS_DIR = path.join(STATE_DIR, 'queue', 'decisions');
const GIT_OUTCOMES_DIR = path.join(STATE_DIR, 'git', 'outcomes');
const EYES_REGISTRY_PATH = path.join(STATE_DIR, 'sensory', 'eyes', 'registry.json');

function sha16(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function normalizeProposalsPayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.proposals)) return raw.proposals;
  return [];
}

function baseTopics(eyeConfig) {
  const defaults = ['automation', 'system', 'growth'];
  const topics = Array.isArray(eyeConfig && eyeConfig.topics) ? eyeConfig.topics : [];
  const out = [];
  for (const t of topics.concat(defaults)) {
    const v = String(t || '').trim().toLowerCase();
    if (!v) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 5);
}

function proposalStats(dateStr) {
  const fp = path.join(SENSORY_PROPOSALS_DIR, `${dateStr}.json`);
  const arr = normalizeProposalsPayload(readJsonSafe(fp, []));
  let open = 0;
  let resolved = 0;
  for (const p of arr) {
    const status = String((p && p.status) || 'open').toLowerCase();
    if (status === 'resolved' || status === 'rejected') resolved += 1;
    else open += 1;
  }
  return { total: arr.length, open, resolved, path: fp };
}

function decisionStats(dateStr) {
  const fp = path.join(QUEUE_DECISIONS_DIR, `${dateStr}.jsonl`);
  const evts = readJsonlSafe(fp);
  let accepted = 0;
  let shipped = 0;
  let noChange = 0;
  let reverted = 0;
  for (const e of evts) {
    if (!e || !e.type) continue;
    if (e.type === 'decision' && String(e.decision) === 'accept') accepted += 1;
    if (e.type === 'outcome' && String(e.outcome) === 'shipped') shipped += 1;
    if (e.type === 'outcome' && String(e.outcome) === 'no_change') noChange += 1;
    if (e.type === 'outcome' && String(e.outcome) === 'reverted') reverted += 1;
  }
  return { accepted, shipped, no_change: noChange, reverted, path: fp };
}

function gitOutcomeStats(dateStr) {
  const fp = path.join(GIT_OUTCOMES_DIR, `${dateStr}.jsonl`);
  const evts = readJsonlSafe(fp).filter(e => e && e.type === 'git_outcomes_ok');
  const latest = evts.length ? evts[evts.length - 1] : null;
  return {
    tags_found: Number((latest && latest.tags_found) || 0),
    outcomes_recorded: Number((latest && latest.outcomes_recorded) || 0),
    outcomes_skipped: Number((latest && latest.outcomes_skipped) || 0),
    path: fp
  };
}

function outageStats() {
  const reg = readJsonSafe(EYES_REGISTRY_PATH, {});
  const out = reg && reg.outage_mode ? reg.outage_mode : {};
  return {
    active: out.active === true,
    failed_transport_eyes: Number(out.last_failed_transport_eyes || 0),
    window_hours: Number(out.last_window_hours || 0),
    since: out.since || null,
    path: EYES_REGISTRY_PATH
  };
}

function itemFor(kind, dateStr, title, preview, topics, sourcePath) {
  const safeKind = String(kind || 'local').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const url = `https://local.workspace/signals/${dateStr}/${safeKind}`;
  const id = sha16(`${dateStr}|${safeKind}|${url}`);
  return {
    collected_at: nowIso(),
    id,
    url,
    title: String(title || '').slice(0, 180),
    content_preview: String(preview || '').slice(0, 240),
    topics: Array.isArray(topics) ? topics.slice(0, 5) : [],
    bytes: Math.min(1024, String(title || '').length + String(preview || '').length + String(sourcePath || '').length + 96)
  };
}

function preflightLocalStateDigest(eyeConfig, budgets) {
  const checks = [];
  const failures = [];
  const maxItems = Number(budgets && budgets.max_items);
  if (!Number.isFinite(maxItems) || maxItems <= 0) {
    failures.push({ code: 'invalid_budget', message: 'budgets.max_items must be > 0' });
  } else {
    checks.push({ name: 'max_items_valid', ok: true, value: maxItems });
  }
  if (!fs.existsSync(STATE_DIR)) {
    failures.push({ code: 'state_missing', message: `state directory missing: ${STATE_DIR}` });
  } else {
    checks.push({ name: 'state_dir_present', ok: true });
  }
  return {
    ok: failures.length === 0,
    parser_type: 'local_state_digest',
    checks,
    failures
  };
}

async function collectLocalStateDigest(eyeConfig, budgets) {
  const started = Date.now();
  const pf = preflightLocalStateDigest(eyeConfig, budgets);
  if (!pf.ok) {
    const first = pf.failures[0] || {};
    const err = new Error(`local_state_preflight_failed (${String(first.message || 'unknown').slice(0, 160)})`);
    err.code = String(first.code || 'local_state_preflight_failed');
    throw err;
  }

  const dateStr = todayStr();
  const maxItems = Math.max(1, Math.min(Number((budgets && budgets.max_items) || 4), 8));
  const topics = baseTopics(eyeConfig);
  const p = proposalStats(dateStr);
  const d = decisionStats(dateStr);
  const g = gitOutcomeStats(dateStr);
  const o = outageStats();
  const backlogThreshold = Math.max(1, Number(process.env.LOCAL_STATE_BACKLOG_ALERT_THRESHOLD || 6));
  const outcomeGapAcceptedMin = Math.max(1, Number(process.env.LOCAL_STATE_OUTCOME_GAP_ACCEPTED_MIN || 2));
  const taggingGapAcceptedMin = Math.max(1, Number(process.env.LOCAL_STATE_TAGGING_GAP_ACCEPTED_MIN || 1));

  const candidates = [];
  if (o.active) {
    candidates.push(itemFor(
      'infra_outage',
      dateStr,
      `Stabilize automation infrastructure: outage mode active across ${o.failed_transport_eyes} sensors`,
      `Outage mode has been active since ${o.since || 'unknown'}. Prioritize resilient transport recovery and deterministic fallback routing.`,
      topics.concat(['infra', 'resilience']).slice(0, 5),
      o.path
    ));
  }

  if (p.open >= backlogThreshold) {
    candidates.push(itemFor(
      'proposal_backlog',
      dateStr,
      `Remediate backlog saturation: open=${p.open} (threshold=${backlogThreshold})`,
      `Queue backlog exceeded threshold. Snapshot total=${p.total}, open=${p.open}, resolved=${p.resolved}. Reduce queue pressure with deterministic admission and closeout discipline.`,
      topics.concat(['throughput']).slice(0, 5),
      p.path
    ));
  }

  if (d.accepted >= outcomeGapAcceptedMin && d.shipped === 0) {
    candidates.push(itemFor(
      'outcome_gap',
      dateStr,
      `Remediate execution gap: accepted=${d.accepted}, shipped=${d.shipped}`,
      `Accepted proposals are not converting to shipped outcomes. no_change=${d.no_change}, reverted=${d.reverted}, recorded=${g.outcomes_recorded}. Prioritize one accepted proposal to completion with verifiable evidence.`,
      topics.concat(['measurement']).slice(0, 5),
      d.path
    ));
  }

  if (d.accepted >= taggingGapAcceptedMin && g.tags_found === 0) {
    candidates.push(itemFor(
      'tagging_gap',
      dateStr,
      `Increase automation reliability: enforce proposal traceability (accepted=${d.accepted}, git_tags=${g.tags_found})`,
      `No proposal:<ID> commit tags were detected for accepted=${d.accepted}. Enforce deterministic proposal tagging to improve shipped outcome attribution.`,
      topics.concat(['reliability']).slice(0, 5),
      g.path
    ));
  }

  const dedup = new Map();
  for (const item of candidates) {
    if (!item || !item.url) continue;
    if (!dedup.has(item.url)) dedup.set(item.url, item);
  }
  const items = Array.from(dedup.values()).slice(0, maxItems);
  const durationMs = Date.now() - started;
  return {
    success: true,
    items,
    duration_ms: durationMs,
    requests: 0,
    bytes: items.reduce((s, i) => s + Number(i.bytes || 0), 0)
  };
}

module.exports = { collectLocalStateDigest, preflightLocalStateDigest };
