#!/usr/bin/env node
'use strict';
export {};

/**
 * strategy_controller.js
 *
 * Adaptive strategy-memory controller.
 * Channelized access only through getters/setters/mutators + queue intake/materialization.
 *
 * Usage:
 *   node systems/strategy/strategy_controller.js status
 *   node systems/strategy/strategy_controller.js get [--id=<strategy_id>] [--queue=1] [--limit=N]
 *   node systems/strategy/strategy_controller.js intake --summary="..." [--text="..."] [--source=<source>] [--kind=<kind>] [--evidence=a,b]
 *   node systems/strategy/strategy_controller.js collect [YYYY-MM-DD] [--days=N] [--max=N]
 *   node systems/strategy/strategy_controller.js queue [--status=queued|all] [--limit=N]
 *   node systems/strategy/strategy_controller.js materialize --queue-id=<uid> --draft-file=<path>
 *   node systems/strategy/strategy_controller.js set-profile --profile-file=<path>
 *   node systems/strategy/strategy_controller.js mutate-profile --id=<strategy_id> --patch-file=<path>
 *   node systems/strategy/strategy_controller.js touch-use --id=<strategy_id> [--ts=<iso_ts>]
 *   node systems/strategy/strategy_controller.js sync-usage [YYYY-MM-DD] [--days=N]
 *   node systems/strategy/strategy_controller.js gc [--inactive-days=N] [--min-uses-30d=N] [--protect-new-days=N] [--apply=1]
 *   node systems/strategy/strategy_controller.js --help
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { 
  defaultStrategyDraft,
  STORE_ABS_PATH,
  normalizeMode,
  normalizeExecutionMode,
  ensureStrategyState,
  readStrategyState,
  setStrategyState,
  mutateStrategyState,
  validateProfileInput,
  upsertProfile,
  intakeSignal,
  materializeFromQueue,
  touchProfileUsage,
  gcProfiles
} = require('../adaptive/strategy/strategy_store.js');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.STRATEGY_CONTROLLER_RUNS_DIR
  ? path.resolve(process.env.STRATEGY_CONTROLLER_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const TRENDS_DIR = process.env.STRATEGY_CONTROLLER_TRENDS_DIR
  ? path.resolve(process.env.STRATEGY_CONTROLLER_TRENDS_DIR)
  : path.join(REPO_ROOT, 'state', 'sensory', 'trends');
const HYPOTHESES_DIR = process.env.STRATEGY_CONTROLLER_HYPOTHESES_DIR
  ? path.resolve(process.env.STRATEGY_CONTROLLER_HYPOTHESES_DIR)
  : path.join(REPO_ROOT, 'state', 'sensory', 'cross_signal', 'hypotheses');
const OUTCOME_FITNESS_PATH = process.env.STRATEGY_CONTROLLER_OUTCOME_FITNESS_PATH
  ? path.resolve(process.env.STRATEGY_CONTROLLER_OUTCOME_FITNESS_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'outcome_fitness.json');
const SCORECARD_LATEST_PATH = process.env.STRATEGY_CONTROLLER_SCORECARD_PATH
  ? path.resolve(process.env.STRATEGY_CONTROLLER_SCORECARD_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'scorecards', 'latest.json');
const GC_ARCHIVE_PATH = process.env.STRATEGY_CONTROLLER_GC_ARCHIVE_PATH
  ? path.resolve(process.env.STRATEGY_CONTROLLER_GC_ARCHIVE_PATH)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'gc_archive.jsonl');
const STRATEGY_SNAPSHOTS_DIR = process.env.STRATEGY_CONTROLLER_SNAPSHOTS_DIR
  ? path.resolve(process.env.STRATEGY_CONTROLLER_SNAPSHOTS_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'snapshots');
const STRATEGY_SNAPSHOT_INDEX_PATH = path.join(STRATEGY_SNAPSHOTS_DIR, 'index.json');
const STRATEGY_CONTROLLER_AUDIT_LOG_PATH = process.env.STRATEGY_CONTROLLER_AUDIT_LOG_PATH
  ? path.resolve(process.env.STRATEGY_CONTROLLER_AUDIT_LOG_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'strategy_controller_audit.jsonl');
const STRATEGY_CONTROLLER_AUDIT_STATE_PATH = process.env.STRATEGY_CONTROLLER_AUDIT_STATE_PATH
  ? path.resolve(process.env.STRATEGY_CONTROLLER_AUDIT_STATE_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'strategy_controller_audit_state.json');
const POLICY_ROOT_SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'policy_rootd.js');
const STRATEGY_CONTROLLER_REQUIRE_APPROVAL = String(process.env.STRATEGY_CONTROLLER_REQUIRE_APPROVAL || '1') !== '0';
const STRATEGY_CONTROLLER_APPROVAL_MIN_LEN = Math.max(10, Number(process.env.STRATEGY_CONTROLLER_APPROVAL_MIN_LEN || 12));
const STRATEGY_CONTROLLER_REQUIRE_POLICY_ROOT = String(process.env.STRATEGY_CONTROLLER_REQUIRE_POLICY_ROOT || '1') !== '0';
const STRATEGY_CONTROLLER_AUDIT_HMAC_KEY = String(process.env.STRATEGY_CONTROLLER_AUDIT_HMAC_KEY || '').trim();

function usage() {
  console.log('Usage:');
  console.log('  node systems/strategy/strategy_controller.js status');
  console.log('  node systems/strategy/strategy_controller.js get [--id=<strategy_id>] [--queue=1] [--limit=N]');
  console.log('  node systems/strategy/strategy_controller.js intake --summary="..." [--text="..."] [--source=<source>] [--kind=<kind>] [--evidence=a,b]');
  console.log('  node systems/strategy/strategy_controller.js collect [YYYY-MM-DD] [--days=N] [--max=N]');
  console.log('  node systems/strategy/strategy_controller.js queue [--status=queued|all] [--limit=N]');
  console.log('  node systems/strategy/strategy_controller.js materialize --queue-id=<uid> --draft-file=<path> --approval-note="..." [--lease-token=<token>] [--allow-elevated-mode=1]');
  console.log('  node systems/strategy/strategy_controller.js set-profile --profile-file=<path> --approval-note="..." [--lease-token=<token>] [--allow-elevated-mode=1]');
  console.log('  node systems/strategy/strategy_controller.js mutate-profile --id=<strategy_id> --patch-file=<path> --approval-note="..." [--lease-token=<token>] [--allow-elevated-mode=1]');
  console.log('  node systems/strategy/strategy_controller.js touch-use --id=<strategy_id> [--ts=<iso_ts>]');
  console.log('  node systems/strategy/strategy_controller.js sync-usage [YYYY-MM-DD] [--days=N]');
  console.log('  node systems/strategy/strategy_controller.js gc [--inactive-days=N] [--min-uses-30d=N] [--protect-new-days=N] [--apply=1] [--approval-note="..."] [--lease-token=<token>]');
  console.log('  node systems/strategy/strategy_controller.js restore --snapshot=<snapshot_id|abs_path> --approval-note="..." [--lease-token=<token>]');
  console.log('  node systems/strategy/strategy_controller.js --help');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
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

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeId(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function asList(v) {
  return String(v || '')
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function hmacHex(input, key) {
  return crypto.createHmac('sha256', String(key || '')).update(String(input || ''), 'utf8').digest('hex');
}

function loadAuditState() {
  const raw = readJson(STRATEGY_CONTROLLER_AUDIT_STATE_PATH, null);
  if (!raw || typeof raw !== 'object') return { seq: 0, last_hash: null };
  return {
    seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : 0,
    last_hash: raw.last_hash ? String(raw.last_hash) : null
  };
}

function saveAuditState(state) {
  fs.mkdirSync(path.dirname(STRATEGY_CONTROLLER_AUDIT_STATE_PATH), { recursive: true });
  fs.writeFileSync(
    STRATEGY_CONTROLLER_AUDIT_STATE_PATH,
    JSON.stringify({
      seq: Number.isFinite(Number(state && state.seq)) ? Number(state.seq) : 0,
      last_hash: state && state.last_hash ? String(state.last_hash) : null,
      updated_ts: nowIso()
    }, null, 2) + '\n',
    'utf8'
  );
}

function appendControllerAudit(event) {
  const state = loadAuditState();
  const seq = Number(state.seq || 0) + 1;
  const prevHash = state.last_hash ? String(state.last_hash) : null;
  const payload = {
    ts: nowIso(),
    seq,
    prev_hash: prevHash,
    ...(event && typeof event === 'object' ? event : {})
  };
  const payloadNoIntegrity = { ...payload };
  const payloadHash = sha256Hex(JSON.stringify(payloadNoIntegrity));
  const chainInput = `${String(prevHash || '')}|${payloadHash}|${seq}`;
  const hash = sha256Hex(chainInput);
  const integrity: AnyObj = {
    payload_hash: payloadHash,
    hash
  };
  if (STRATEGY_CONTROLLER_AUDIT_HMAC_KEY) {
    integrity.hmac = hmacHex(chainInput, STRATEGY_CONTROLLER_AUDIT_HMAC_KEY);
  }
  const row = {
    ...payloadNoIntegrity,
    integrity
  };
  appendJsonl(STRATEGY_CONTROLLER_AUDIT_LOG_PATH, row);
  saveAuditState({ seq, last_hash: hash });
  return row;
}

function strategyStateHash(stateObj) {
  const stable = stateObj && typeof stateObj === 'object' ? stateObj : {};
  return sha256Hex(JSON.stringify(stable));
}

function readRawStoreOrDefault() {
  const raw = readJson(STORE_ABS_PATH, null);
  return raw && typeof raw === 'object' ? raw : ensureStrategyState(null, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'read_raw_store'
  });
}

function loadSnapshotIndex() {
  const raw = readJson(STRATEGY_SNAPSHOT_INDEX_PATH, null);
  if (!raw || typeof raw !== 'object') return { version: '1.0', snapshots: [] };
  const rows = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  return {
    version: '1.0',
    snapshots: rows
  };
}

function saveSnapshotIndex(index) {
  const next = index && typeof index === 'object' ? index : { version: '1.0', snapshots: [] };
  fs.mkdirSync(path.dirname(STRATEGY_SNAPSHOT_INDEX_PATH), { recursive: true });
  fs.writeFileSync(
    STRATEGY_SNAPSHOT_INDEX_PATH,
    JSON.stringify({
      version: '1.0',
      updated_ts: nowIso(),
      snapshots: Array.isArray(next.snapshots) ? next.snapshots.slice(-500) : []
    }, null, 2) + '\n',
    'utf8'
  );
}

function createSnapshot(reason, actor) {
  const state = readRawStoreOrDefault();
  const ts = nowIso();
  const hash = strategyStateHash(state);
  const id = `ssnap_${ts.replace(/[-:.TZ]/g, '').slice(0, 14)}_${hash.slice(0, 10)}`;
  fs.mkdirSync(STRATEGY_SNAPSHOTS_DIR, { recursive: true });
  const filePath = path.join(STRATEGY_SNAPSHOTS_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    version: '1.0',
    id,
    ts,
    reason: cleanText(reason, 160) || 'snapshot',
    actor: cleanText(actor, 80) || 'unknown',
    state_hash: hash,
    state
  }, null, 2) + '\n', 'utf8');
  const index = loadSnapshotIndex();
  index.snapshots.push({
    id,
    ts,
    path: filePath,
    reason: cleanText(reason, 160) || 'snapshot',
    actor: cleanText(actor, 80) || 'unknown',
    state_hash: hash
  });
  saveSnapshotIndex(index);
  return { id, path: filePath, state_hash: hash };
}

function resolveSnapshotRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  const index = loadSnapshotIndex();
  for (let i = index.snapshots.length - 1; i >= 0; i--) {
    const row = index.snapshots[i];
    if (!row || typeof row !== 'object') continue;
    if (String(row.id || '') === raw && row.path && fs.existsSync(String(row.path))) return String(row.path);
  }
  return null;
}

function parseApproval(args) {
  return cleanText(args['approval-note'] || args.approval_note || '', 320);
}

function runPolicyRootAuthorize({ scope, target, approvalNote, leaseToken, source }) {
  const cliArgs = [
    POLICY_ROOT_SCRIPT,
    'authorize',
    `--scope=${String(scope || '').trim()}`,
    `--target=${String(target || '').trim()}`,
    `--approval-note=${String(approvalNote || '').trim()}`,
    `--source=${String(source || 'strategy_controller').trim()}`
  ];
  if (leaseToken) cliArgs.push(`--lease-token=${String(leaseToken).trim()}`);
  const r = spawnSync('node', cliArgs, { cwd: REPO_ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0 && payload && payload.ok === true && payload.decision === 'ALLOW',
    code: Number(r.status || 0),
    payload,
    stderr,
    stdout
  };
}

function enforceMutationGate(args, scope, target, source, opLabel) {
  const approvalNote = parseApproval(args);
  if (STRATEGY_CONTROLLER_REQUIRE_APPROVAL && approvalNote.length < STRATEGY_CONTROLLER_APPROVAL_MIN_LEN) {
    const err = new Error('approval_note_too_short');
    (err as AnyObj).details = { min_len: STRATEGY_CONTROLLER_APPROVAL_MIN_LEN };
    throw err;
  }
  const leaseToken = cleanText(args['lease-token'] || args.lease_token || process.env.CAPABILITY_LEASE_TOKEN || '', 8192);
  let policyRoot = null;
  if (STRATEGY_CONTROLLER_REQUIRE_POLICY_ROOT) {
    const pr = runPolicyRootAuthorize({
      scope,
      target,
      approvalNote,
      leaseToken,
      source: source || 'strategy_controller'
    });
    policyRoot = pr.payload || null;
    if (!pr.ok) {
      const err = new Error('policy_root_denied');
      (err as AnyObj).details = {
        detail: pr.stderr || pr.stdout || `policy_root_exit_${pr.code}`,
        policy_root: policyRoot
      };
      throw err;
    }
  }
  appendControllerAudit({
    type: 'strategy_controller_authorized',
    op: opLabel,
    scope,
    target,
    approval_note: approvalNote,
    policy_root: policyRoot,
    actor: cleanText(process.env.USER || 'unknown', 80)
  });
  return { approval_note: approvalNote, policy_root: policyRoot };
}

function profileRiskLevel(profile) {
  const src = profile && typeof profile === 'object' ? profile : {};
  const draft = src.draft && typeof src.draft === 'object' ? src.draft : {};
  const allowed = Array.isArray(draft.risk_policy && draft.risk_policy.allowed_risks)
    ? draft.risk_policy.allowed_risks.map((x) => String(x || '').toLowerCase())
    : ['low'];
  if (allowed.includes('high')) return 'high';
  if (allowed.includes('medium')) return 'medium';
  return 'low';
}

function profileMode(profile) {
  const src = profile && typeof profile === 'object' ? profile : {};
  const draft = src.draft && typeof src.draft === 'object' ? src.draft : {};
  return normalizeExecutionMode(draft.execution_policy && draft.execution_policy.mode, 'score_only');
}

function isRiskEscalation(prevProfile, nextProfile) {
  const prevRisk = profileRiskLevel(prevProfile);
  const nextRisk = profileRiskLevel(nextProfile);
  const order = { low: 0, medium: 1, high: 2 };
  const prevMode = profileMode(prevProfile);
  const nextMode = profileMode(nextProfile);
  const modeOrder = { score_only: 0, canary_execute: 1, execute: 2 };
  return Number(order[nextRisk] || 0) > Number(order[prevRisk] || 0)
    || Number(modeOrder[nextMode] || 0) > Number(modeOrder[prevMode] || 0);
}

function dateRange(endDate, days) {
  const out = [];
  const end = new Date(`${endDate}T00:00:00.000Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - (i * 24 * 60 * 60 * 1000));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function deepMerge(target, patch) {
  const base = target && typeof target === 'object' ? target : {};
  const src = patch && typeof patch === 'object' ? patch : {};
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadJsonFileOrExit(filePath, code, fieldName) {
  const abs = path.resolve(String(filePath || ''));
  if (!abs || !fs.existsSync(abs)) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `${fieldName || 'file'}_missing`,
      path: abs
    }, null, 2) + '\n');
    process.exit(code);
  }
  const parsed = readJson(abs, null);
  if (!parsed || typeof parsed !== 'object') {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `${fieldName || 'file'}_invalid_json`,
      path: abs
    }, null, 2) + '\n');
    process.exit(code);
  }
  return parsed;
}

function strategyUsageFromRuns(endDate, days) {
  const dates = dateRange(endDate, days);
  const byId = {};
  for (const dateStr of dates) {
    const rows = readJsonl(path.join(RUNS_DIR, `${dateStr}.jsonl`));
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      const strategyId = normalizeId(evt.strategy_id || '');
      if (!strategyId) continue;
      const result = String(evt.result || '');
      if (result === 'no_candidates') continue;
      if (!byId[strategyId]) byId[strategyId] = { uses_window: 0, last_used_ts: null };
      byId[strategyId].uses_window += 1;
      const ts = evt.ts && Number.isFinite(Date.parse(evt.ts)) ? String(evt.ts) : null;
      if (ts && (!byId[strategyId].last_used_ts || Date.parse(ts) > Date.parse(byId[strategyId].last_used_ts))) {
        byId[strategyId].last_used_ts = ts;
      }
    }
  }
  return byId;
}

function collectSignals(endDate, days, maxItems) {
  const items = [];
  const seen = new Set();
  function push(item) {
    if (!item || typeof item !== 'object') return;
    const key = `${String(item.source || '')}|${String(item.kind || '')}|${String(item.summary || '').slice(0, 160)}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }

  const scorecard = readJson(SCORECARD_LATEST_PATH, null);
  if (scorecard && typeof scorecard === 'object' && Array.isArray(scorecard.top_strategies)) {
    for (const row of scorecard.top_strategies.slice(0, 3)) {
      push({
        source: 'strategy_scorecards',
        kind: 'scorecard_top_strategy',
        summary: cleanText(`Top strategy signal: ${row.strategy_id || 'unknown'} stage=${row.stage || 'unknown'} score=${row.score || 0}`, 220),
        text: JSON.stringify(row).slice(0, 4000),
        evidence_refs: ['state/adaptive/strategy/scorecards/latest.json'],
        recommended_generation_mode: normalizeMode((row.stage === 'scaled' || row.stage === 'validated') ? 'deep-thinker' : 'hyper-creative', 'hyper-creative')
      });
    }
  }

  const fitness = readJson(OUTCOME_FITNESS_PATH, null);
  if (fitness && typeof fitness === 'object') {
    const metric = Number(fitness.realized_outcome_score || 0);
    const blocks = fitness.proposal_blocks && fitness.proposal_blocks.blocked_by_reason
      ? Object.keys(fitness.proposal_blocks.blocked_by_reason).slice(0, 4)
      : [];
    push({
      source: 'outcome_fitness',
      kind: 'fitness_feedback',
      summary: cleanText(`Outcome fitness ${metric.toFixed(3)} with top blocks: ${blocks.join(', ') || 'none'}`, 220),
      text: JSON.stringify({
        realized_outcome_score: fitness.realized_outcome_score,
        proposal_blocks: fitness.proposal_blocks || {},
        strategy_policy: fitness.strategy_policy || {}
      }).slice(0, 4000),
      evidence_refs: ['state/adaptive/strategy/outcome_fitness.json'],
      recommended_generation_mode: metric < 0.5 ? 'deep-thinker' : 'hyper-creative'
    });
  }

  const dates = dateRange(endDate, days);
  for (const dateStr of dates) {
    const trends = readJson(path.join(TRENDS_DIR, `${dateStr}.json`), null);
    if (trends && typeof trends === 'object') {
      const top = Array.isArray(trends.topics) ? trends.topics.slice(0, 5) : [];
      if (top.length) {
        push({
          source: 'sensory_trends',
          kind: 'cross_eye_topics',
          summary: cleanText(`Trend cluster ${dateStr}: ${top.map((t) => (t && t.topic) || t).join(', ')}`, 220),
          text: JSON.stringify(top).slice(0, 4000),
          evidence_refs: [`state/sensory/trends/${dateStr}.json`],
          recommended_generation_mode: 'hyper-creative'
        });
      }
    }
    const hypotheses = readJson(path.join(HYPOTHESES_DIR, `${dateStr}.json`), null);
    if (hypotheses && typeof hypotheses === 'object') {
      const rows = Array.isArray(hypotheses.hypotheses) ? hypotheses.hypotheses : (Array.isArray(hypotheses.items) ? hypotheses.items : []);
      for (const row of rows.slice(0, 4)) {
        const title = cleanText(row && (row.title || row.hypothesis || row.summary), 200);
        if (!title) continue;
        push({
          source: 'cross_signal_hypotheses',
          kind: 'hypothesis',
          summary: cleanText(`Hypothesis ${dateStr}: ${title}`, 220),
          text: JSON.stringify(row).slice(0, 4000),
          evidence_refs: [`state/sensory/cross_signal/hypotheses/${dateStr}.json`],
          recommended_generation_mode: 'deep-thinker'
        });
      }
    }
  }

  return items.slice(0, Math.max(1, maxItems));
}

function cmdStatus() {
  const state = ensureStrategyState(null, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'status'
  });
  const queued = state.intake_queue.filter((q) => q.status === 'queued').length;
  const consumed = state.intake_queue.filter((q) => q.status === 'consumed').length;
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    policy: state.policy,
    counts: {
      profiles_total: state.profiles.length,
      queue_total: state.intake_queue.length,
      queue_queued: queued,
      queue_consumed: consumed
    },
    metrics: state.metrics,
    modes: ['hyper-creative', 'deep-thinker']
  }, null, 2) + '\n');
}

function cmdGet(args) {
  const state = ensureStrategyState(null, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'get'
  });
  const id = normalizeId(args.id || '');
  const queue = String(args.queue || '0') === '1';
  const limit = clampInt(args.limit, 1, 500, 50);

  if (id) {
    const profile = state.profiles.find((p) => String(p.id || '') === id) || null;
    process.stdout.write(JSON.stringify({
      ok: !!profile,
      id,
      profile
    }, null, 2) + '\n');
    if (!profile) process.exit(1);
    return;
  }

  const out: AnyObj = {
    ok: true,
    ts: nowIso(),
    profiles: state.profiles.slice(0, limit)
  };
  if (queue) out.intake_queue = state.intake_queue.slice(0, limit);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function cmdIntake(args) {
  const summary = cleanText(args.summary || '', 220);
  if (!summary) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'summary_required'
    }, null, 2) + '\n');
    process.exit(2);
  }
  const result = intakeSignal(null, {
    source: cleanText(args.source || 'manual', 80),
    kind: cleanText(args.kind || 'signal', 60),
    summary,
    text: String(args.text || '').trim().slice(0, 6000),
    evidence_refs: asList(args.evidence || ''),
    recommended_generation_mode: normalizeMode(args.mode || '', 'hyper-creative')
  }, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'manual_intake',
    actor: process.env.USER || 'unknown'
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    action: result.action,
    queue_item: result.queue_item
  }, null, 2) + '\n');
}

function cmdCollect(args) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const days = clampInt(args.days, 1, 30, 2);
  const maxItems = clampInt(args.max, 1, 60, 8);
  const signals = collectSignals(date, days, maxItems);
  const queued = [];
  for (const signal of signals) {
    const res = intakeSignal(null, signal, {
      source: 'systems/strategy/strategy_controller.js',
      reason: 'collect_signals',
      actor: process.env.USER || 'unknown'
    });
    queued.push({
      action: res.action,
      uid: res.queue_item ? res.queue_item.uid : null,
      source: signal.source,
      kind: signal.kind,
      summary: signal.summary
    });
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    date,
    days,
    scanned: signals.length,
    queued
  }, null, 2) + '\n');
}

function cmdQueue(args) {
  const state = ensureStrategyState(null, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'queue_list'
  });
  const status = String(args.status || 'queued').trim().toLowerCase();
  const limit = clampInt(args.limit, 1, 500, 50);
  let rows = state.intake_queue.slice();
  if (status !== 'all') rows = rows.filter((q) => String(q.status || '') === status);
  rows.sort((a, b) => Date.parse(b.created_ts || 0) - Date.parse(a.created_ts || 0));
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    status_filter: status,
    count: rows.length,
    queue: rows.slice(0, limit)
  }, null, 2) + '\n');
}

function cmdMaterialize(args) {
  const queueId = String(args['queue-id'] || args.queue_id || '').trim();
  if (!queueId) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'queue_id_required'
    }, null, 2) + '\n');
    process.exit(2);
  }
  const draft = loadJsonFileOrExit(args['draft-file'] || args.draft_file, 2, 'draft_file');
  const allowElevatedMode = String(args['allow-elevated-mode'] || args.allow_elevated_mode || '0') === '1';
  const validatedDraft = validateProfileInput({
    ...draft,
    allow_elevated_mode: allowElevatedMode
  }, {
    allow_elevated_mode: allowElevatedMode
  });
  const before = readStrategyState(null, null);
  const state = before && typeof before === 'object' ? before : { profiles: [] };
  const existing = Array.isArray(state.profiles)
    ? state.profiles.find((p) => String(p.id || '') === String(validatedDraft.id || '')) || null
    : null;
  const riskEscalation = isRiskEscalation(existing, validatedDraft);
  enforceMutationGate(args, 'strategy_profile_mutation', validatedDraft.id || queueId, 'strategy_controller.materialize', 'materialize');
  if (riskEscalation) {
    enforceMutationGate(args, 'strategy_profile_risk_escalation', validatedDraft.id || queueId, 'strategy_controller.materialize', 'materialize_risk_escalation');
  }
  const snapshot = createSnapshot('materialize_from_queue', process.env.USER || 'unknown');
  const out = materializeFromQueue(null, queueId, validatedDraft, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'materialize_queue_draft',
    actor: process.env.USER || 'unknown',
    allow_elevated_mode: allowElevatedMode
  });
  const after = readStrategyState(null, null);
  appendControllerAudit({
    type: 'strategy_controller_mutation',
    op: 'materialize',
    target: String(validatedDraft.id || queueId),
    queue_uid: queueId,
    action: out.action,
    risk_escalation: riskEscalation,
    snapshot_id: snapshot.id,
    before_hash: strategyStateHash(before),
    after_hash: strategyStateHash(after),
    actor: cleanText(process.env.USER || 'unknown', 80)
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    action: out.action,
    profile: out.profile,
    queue_item: out.queue_item,
    snapshot
  }, null, 2) + '\n');
}

function cmdSetProfile(args) {
  const profile = loadJsonFileOrExit(args['profile-file'] || args.profile_file, 2, 'profile_file');
  const allowElevatedMode = String(args['allow-elevated-mode'] || args.allow_elevated_mode || '0') === '1';
  const validated = validateProfileInput({
    ...profile,
    allow_elevated_mode: allowElevatedMode
  }, {
    allow_elevated_mode: allowElevatedMode
  });
  const before = readStrategyState(null, null);
  const state = before && typeof before === 'object' ? before : { profiles: [] };
  const existing = Array.isArray(state.profiles)
    ? state.profiles.find((p) => String(p.id || '') === String(validated.id || '')) || null
    : null;
  const riskEscalation = isRiskEscalation(existing, validated);
  enforceMutationGate(args, 'strategy_profile_mutation', validated.id, 'strategy_controller.set_profile', 'set-profile');
  if (riskEscalation) {
    enforceMutationGate(args, 'strategy_profile_risk_escalation', validated.id, 'strategy_controller.set_profile', 'set-profile_risk_escalation');
  }
  const snapshot = createSnapshot('set_profile', process.env.USER || 'unknown');
  const out = upsertProfile(null, validated, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'set_profile',
    actor: process.env.USER || 'unknown',
    allow_elevated_mode: allowElevatedMode
  });
  const after = readStrategyState(null, null);
  appendControllerAudit({
    type: 'strategy_controller_mutation',
    op: 'set-profile',
    target: String(validated.id || ''),
    action: out.action,
    risk_escalation: riskEscalation,
    snapshot_id: snapshot.id,
    before_hash: strategyStateHash(before),
    after_hash: strategyStateHash(after),
    actor: cleanText(process.env.USER || 'unknown', 80)
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    action: out.action,
    profile: out.profile,
    snapshot
  }, null, 2) + '\n');
}

function cmdMutateProfile(args) {
  const id = normalizeId(args.id || '');
  if (!id) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'id_required'
    }, null, 2) + '\n');
    process.exit(2);
  }
  const patch = loadJsonFileOrExit(args['patch-file'] || args.patch_file, 2, 'patch_file');
  const allowElevatedMode = String(args['allow-elevated-mode'] || args.allow_elevated_mode || '0') === '1';
  const before = readStrategyState(null, null);
  const beforeState = before && typeof before === 'object' ? before : { profiles: [] };
  const existing = Array.isArray(beforeState.profiles)
    ? beforeState.profiles.find((p) => String(p.id || '') === id) || null
    : null;
  if (!existing) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `strategy_not_found:${id}`
    }, null, 2) + '\n');
    process.exit(1);
  }
  const previewMerged = deepMerge(existing, patch);
  const validatedMerged = validateProfileInput({
    ...previewMerged,
    id,
    allow_elevated_mode: allowElevatedMode
  }, {
    allow_elevated_mode: allowElevatedMode
  });
  const riskEscalation = isRiskEscalation(existing, validatedMerged);
  enforceMutationGate(args, 'strategy_profile_mutation', id, 'strategy_controller.mutate_profile', 'mutate-profile');
  if (riskEscalation) {
    enforceMutationGate(args, 'strategy_profile_risk_escalation', id, 'strategy_controller.mutate_profile', 'mutate-profile_risk_escalation');
  }
  const snapshot = createSnapshot('mutate_profile', process.env.USER || 'unknown');
  let changed = null;
  mutateStrategyState(null, (state) => {
    const idx = state.profiles.findIndex((p) => String(p.id || '') === id);
    if (idx < 0) throw new Error(`strategy_not_found:${id}`);
    const current = state.profiles[idx];
    const merged = deepMerge(current, patch);
    const validated = validateProfileInput({
      ...merged,
      id,
      allow_elevated_mode: allowElevatedMode
    }, {
      allow_elevated_mode: allowElevatedMode
    });
    validated.updated_ts = nowIso();
    state.profiles[idx] = validated;
    state.metrics.total_profiles_updated = Number(state.metrics.total_profiles_updated || 0) + 1;
    changed = validated;
    return state;
  }, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'mutate_profile',
    actor: process.env.USER || 'unknown',
    allow_elevated_mode: allowElevatedMode
  });
  const after = readStrategyState(null, null);
  appendControllerAudit({
    type: 'strategy_controller_mutation',
    op: 'mutate-profile',
    target: id,
    action: 'mutated',
    risk_escalation: riskEscalation,
    snapshot_id: snapshot.id,
    before_hash: strategyStateHash(before),
    after_hash: strategyStateHash(after),
    actor: cleanText(process.env.USER || 'unknown', 80)
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    action: 'mutated',
    profile: changed,
    snapshot
  }, null, 2) + '\n');
}

function cmdTouchUse(args) {
  const id = normalizeId(args.id || '');
  if (!id) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'id_required'
    }, null, 2) + '\n');
    process.exit(2);
  }
  const out = touchProfileUsage(null, id, args.ts || null, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'touch_use',
    actor: process.env.USER || 'unknown'
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    profile: out.profile
  }, null, 2) + '\n');
}

function cmdSyncUsage(args) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const days = clampInt(args.days, 1, 90, 30);
  const usageMap = strategyUsageFromRuns(date, days);
  let touched = 0;
  const next = mutateStrategyState(null, (state) => {
    const ts = nowIso();
    state.profiles = state.profiles.map((profile) => {
      const id = normalizeId(profile.id || '');
      if (!id || !usageMap[id]) return profile;
      const row = usageMap[id];
      const usage = profile.usage && typeof profile.usage === 'object' ? { ...profile.usage } : {};
      usage.uses_30d = Number(row.uses_window || 0);
      usage.last_usage_sync_ts = ts;
      if (row.last_used_ts) usage.last_used_ts = String(row.last_used_ts);
      if (!Array.isArray(usage.use_events)) usage.use_events = [];
      if (row.last_used_ts) {
        usage.use_events = [...usage.use_events, String(row.last_used_ts)].slice(-256);
      }
      profile.usage = usage;
      profile.updated_ts = ts;
      touched += 1;
      return profile;
    });
    state.metrics.last_usage_sync_ts = ts;
    return state;
  }, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'sync_usage',
    actor: process.env.USER || 'unknown'
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    date,
    days,
    touched,
    profile_count: next.profiles.length
  }, null, 2) + '\n');
}

function cmdGc(args) {
  const apply = String(args.apply || '0') === '1';
  const inactiveDays = clampInt(args['inactive-days'] || args.inactive_days, 1, 365, 21);
  const minUses = clampInt(args['min-uses-30d'] || args.min_uses_30d, 0, 1000, 1);
  const protectDays = clampInt(args['protect-new-days'] || args.protect_new_days, 0, 90, 3);
  const before = apply ? readStrategyState(null, null) : null;
  const snapshot = apply
    ? (enforceMutationGate(args, 'strategy_profile_gc_apply', 'adaptive_strategy_registry', 'strategy_controller.gc', 'gc-apply'), createSnapshot('gc_apply', process.env.USER || 'unknown'))
    : null;
  const out = gcProfiles(null, {
    apply,
    inactive_days: inactiveDays,
    min_uses_30d: minUses,
    protect_new_days: protectDays
  }, {
    source: 'systems/strategy/strategy_controller.js',
    reason: apply ? 'gc_apply' : 'gc_preview',
    actor: process.env.USER || 'unknown'
  });
  if (apply && Array.isArray(out.removed) && out.removed.length) {
    for (const row of out.removed) {
      appendJsonl(GC_ARCHIVE_PATH, {
        ts: nowIso(),
        type: 'strategy_gc_delete',
        source: 'systems/strategy/strategy_controller.js',
        ...row
      });
    }
    const after = readStrategyState(null, null);
    appendControllerAudit({
      type: 'strategy_controller_mutation',
      op: 'gc-apply',
      target: 'adaptive_strategy_registry',
      removed_count: Array.isArray(out.removed) ? out.removed.length : 0,
      snapshot_id: snapshot && snapshot.id ? snapshot.id : null,
      before_hash: strategyStateHash(before),
      after_hash: strategyStateHash(after),
      actor: cleanText(process.env.USER || 'unknown', 80)
    });
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    apply,
    policy: out.policy,
    removed_count: Array.isArray(out.removed) ? out.removed.length : 0,
    removed: out.removed || [],
    kept_count: Array.isArray(out.kept) ? out.kept.length : 0,
    snapshot
  }, null, 2) + '\n');
}

function cmdRestore(args) {
  const snapshotRef = String(args.snapshot || '').trim();
  if (!snapshotRef) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'snapshot_required'
    }, null, 2) + '\n');
    process.exit(2);
  }
  enforceMutationGate(args, 'strategy_profile_mutation', 'adaptive_strategy_registry_restore', 'strategy_controller.restore', 'restore');
  const snapshotPath = resolveSnapshotRef(snapshotRef);
  if (!snapshotPath) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'snapshot_not_found',
      snapshot: snapshotRef
    }, null, 2) + '\n');
    process.exit(1);
  }
  const snapshot = readJson(snapshotPath, null);
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.state || typeof snapshot.state !== 'object') {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'snapshot_invalid',
      path: snapshotPath
    }, null, 2) + '\n');
    process.exit(1);
  }
  const before = readStrategyState(null, null);
  setStrategyState(null, snapshot.state, {
    source: 'systems/strategy/strategy_controller.js',
    reason: 'restore_snapshot',
    actor: process.env.USER || 'unknown'
  });
  const after = readStrategyState(null, null);
  appendControllerAudit({
    type: 'strategy_controller_mutation',
    op: 'restore',
    target: 'adaptive_strategy_registry',
    snapshot_ref: snapshotRef,
    snapshot_path: snapshotPath,
    snapshot_id: cleanText(snapshot.id, 80) || null,
    before_hash: strategyStateHash(before),
    after_hash: strategyStateHash(after),
    actor: cleanText(process.env.USER || 'unknown', 80)
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    action: 'restored',
    snapshot: {
      ref: snapshotRef,
      path: snapshotPath,
      id: cleanText(snapshot.id, 80) || null
    }
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    if (cmd === 'status') return cmdStatus();
    if (cmd === 'get') return cmdGet(args);
    if (cmd === 'intake') return cmdIntake(args);
    if (cmd === 'collect') return cmdCollect(args);
    if (cmd === 'queue') return cmdQueue(args);
    if (cmd === 'materialize') return cmdMaterialize(args);
    if (cmd === 'set-profile') return cmdSetProfile(args);
    if (cmd === 'mutate-profile') return cmdMutateProfile(args);
    if (cmd === 'touch-use') return cmdTouchUse(args);
    if (cmd === 'sync-usage') return cmdSyncUsage(args);
    if (cmd === 'gc') return cmdGc(args);
    if (cmd === 'restore') return cmdRestore(args);
  } catch (err) {
    const msg = cleanText(err && err.message ? err.message : err, 300);
    appendControllerAudit({
      type: 'strategy_controller_error',
      op: cmd,
      error: msg,
      details: err && err.details ? err.details : null,
      actor: cleanText(process.env.USER || 'unknown', 80)
    });
    process.stdout.write(JSON.stringify({
      ok: false,
      error: msg,
      details: err && err.details ? err.details : null,
      command: cmd
    }, null, 2) + '\n');
    process.exit(1);
  }

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  collectSignals,
  strategyUsageFromRuns,
  defaultStrategyDraft
};
