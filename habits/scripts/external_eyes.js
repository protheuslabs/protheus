#!/usr/bin/env node
/**
 * external_eyes.js v1.0 - External Eyes Framework
 * 
 * Controlled external intel gathering with budgets, scoring, and evolution.
 * Sensing-only. NO autonomous execution.
 * 
 * Commands:
 *   node habits/scripts/external_eyes.js run [--eye=<id>] [--max-eyes=N]
 *   node habits/scripts/external_eyes.js preflight [--strict]
 *   node habits/scripts/external_eyes.js canary-signal [--eye=<id>]
 *   node habits/scripts/external_eyes.js score [YYYY-MM-DD]
 *   node habits/scripts/external_eyes.js evolve [YYYY-MM-DD]
 *   node habits/scripts/external_eyes.js list
 *   node habits/scripts/external_eyes.js propose "<name>" "<domain>" "<notes>"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { collectWithDriver, preflightWithDriver } = require('../../systems/sensory/collector_driver.js');
const { classifyCollectorError, isTransportFailureCode } = require('../../adaptive/sensory/eyes/collectors/collector_errors');
const {
  maybeRefreshFocusTriggers,
  evaluateFocusForEye
} = require('../../systems/sensory/focus_controller.js');
const { analyzeTemporalPatterns } = require('../../systems/sensory/temporal_patterns.js');
const { resolveCatalogPath, ensureCatalog } = require('../../lib/eyes_catalog.js');

// Paths
const WORKSPACE_DIR = path.join(__dirname, '..', '..');
const CONFIG_PATH = resolveCatalogPath(WORKSPACE_DIR);

// Allow overrides (tests / multi-workspace)
const STATE_DIR = process.env.EYES_STATE_DIR
  ? path.resolve(process.env.EYES_STATE_DIR)
  : path.join(WORKSPACE_DIR, 'state', 'sensory', 'eyes');

const RAW_DIR = path.join(STATE_DIR, 'raw');
const METRICS_DIR = path.join(STATE_DIR, 'metrics');
const PROPOSALS_DIR = path.join(STATE_DIR, 'proposals');
const REGISTRY_PATH = path.join(STATE_DIR, 'registry.json');

// Sensory proposals (from eyes_insight.js)
const SENSORY_PROPOSALS_DIR = process.env.EYES_SENSORY_PROPOSALS_DIR
  ? path.resolve(process.env.EYES_SENSORY_PROPOSALS_DIR)
  : path.join(WORKSPACE_DIR, 'state', 'sensory', 'proposals');

// Proposal queue decisions (outcomes live here)
const QUEUE_DIR = process.env.EYES_QUEUE_DIR
  ? path.resolve(process.env.EYES_QUEUE_DIR)
  : path.join(WORKSPACE_DIR, 'state', 'queue');
const DECISIONS_DIR = path.join(QUEUE_DIR, 'decisions');
const SENSORY_ROOT_DIR = path.dirname(STATE_DIR);
const ANOMALIES_DIR = path.join(SENSORY_ROOT_DIR, 'anomalies');
const SENSORY_QUEUE_LOG_PATH = process.env.EYES_SENSORY_QUEUE_LOG_PATH
  ? path.resolve(process.env.EYES_SENSORY_QUEUE_LOG_PATH)
  : path.join(WORKSPACE_DIR, 'state', 'sensory', 'queue_log.jsonl');

// Ensure directories exist
function ensureDirs() {
  [STATE_DIR, RAW_DIR, METRICS_DIR, PROPOSALS_DIR, SENSORY_PROPOSALS_DIR, ANOMALIES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Load config
function loadConfig() {
  return ensureCatalog(CONFIG_PATH);
}

// Load or initialize registry (runtime state)
function loadRegistry() {
  ensureDirs(); // Ensure state directory exists before writing
  if (!fs.existsSync(REGISTRY_PATH)) {
    const config = loadConfig();
    const registry = {
      version: '1.0',
      last_updated: new Date().toISOString(),
      eyes: config.eyes.map(eye => ({
        ...eye,
        run_count: 0,
        total_items: 0,
        total_errors: 0
      }))
    };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
    return registry;
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

// Save registry
function saveRegistry(registry) {
  registry.last_updated = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hoursSince(ts) {
  if (!ts) return null;
  const d = new Date(String(ts));
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

function asPositiveNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asFiniteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Runtime authority is registry first, with config as immutable defaults.
function effectiveEye(eyeConfig, registryEye) {
  return {
    ...eyeConfig,
    status: (registryEye && typeof registryEye.status === 'string' && registryEye.status.trim())
      ? registryEye.status
      : eyeConfig.status,
    cadence_hours: asPositiveNumber(
      registryEye ? registryEye.cadence_hours : undefined,
      asPositiveNumber(eyeConfig.cadence_hours, 24)
    ),
    score_ema: asFiniteNumber(
      registryEye ? registryEye.score_ema : undefined,
      asFiniteNumber(eyeConfig.score_ema, 50)
    )
  };
}

// Get today's date string
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

// Compute hash for deduplication
function computeHash(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function countRealSignalItems(items) {
  if (!Array.isArray(items)) return 0;
  let count = 0;
  for (const item of items) {
    const title = String(item && item.title || '').toUpperCase();
    const tags = Array.isArray(item && item.tags) ? item.tags.map((t) => String(t || '').toLowerCase()) : [];
    const fallback = item && item.fallback === true;
    const fallbackTag = tags.includes('fallback');
    const titleFallback = title.includes('FALLBACK');
    if (!title.includes('[STUB]') && !fallback && !fallbackTag && !titleFallback) count++;
  }
  return count;
}

function normalizedItemTopics(item) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };
  if (Array.isArray(item && item.topics)) {
    for (const t of item.topics) push(t);
  }
  if (Array.isArray(item && item.topics_field)) {
    for (const t of item.topics_field) push(t);
  }
  if (Array.isArray(item && item.tags)) {
    for (const t of item.tags) push(t);
  }
  return out.slice(0, 8);
}

function isFallbackItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.fallback === true) return true;
  const title = String(item.title || '').toUpperCase();
  if (title.includes('[STUB]') || title.includes('FALLBACK')) return true;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  return tags.some((t) => String(t || '').toLowerCase() === 'fallback');
}

// Check if domain is allowlisted
function isDomainAllowed(eye, url) {
  try {
    const hostname = new URL(url).hostname;
    return eye.allowed_domains.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadProposalsForDate(dateStr) {
  const filePath = path.join(SENSORY_PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(filePath)) return { filePath, container: null, proposals: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return { filePath, container: null, proposals: parsed };
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.proposals)) {
      return { filePath, container: parsed, proposals: parsed.proposals };
    }
    return { filePath, container: null, proposals: [] };
  } catch {
    return { filePath, container: null, proposals: [] };
  }
}

function saveProposalsForDate(filePath, proposals, container) {
  ensureDirs();
  if (container && typeof container === 'object' && !Array.isArray(container)) {
    const next = { ...container, proposals };
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(proposals, null, 2));
}

function normalizeFailure(errLike) {
  return classifyCollectorError(errLike);
}

function isTransportFailure(errLike, explicitCode = null) {
  if (explicitCode && isTransportFailureCode(explicitCode)) return true;
  const c = normalizeFailure(errLike);
  return c.transport === true;
}

function hasRecentTransportFailure(regEye, windowHours) {
  if (!regEye) return false;
  if (!isTransportFailure({ message: regEye.last_error, code: regEye.last_error_code }, regEye.last_error_code)) return false;
  const h = hoursSince(regEye.last_error_ts || regEye.last_run);
  if (!Number.isFinite(h)) return true;
  return h <= Number(windowHours || 24);
}

function nonStubEyeIds(config) {
  return (config.eyes || [])
    .filter(e => String(e && e.parser_type || '').toLowerCase() !== 'stub')
    .filter(e => String(e && e.status || '').toLowerCase() !== 'retired')
    .map(e => String(e.id))
    .filter(Boolean);
}

function ensureOutageModeState(registry) {
  if (!registry || typeof registry !== 'object') return {
    active: false,
    since: null,
    entered_count: 0,
    exited_count: 0
  };
  if (!registry.outage_mode || typeof registry.outage_mode !== 'object') {
    registry.outage_mode = {
      active: false,
      since: null,
      until: null,
      entered_count: 0,
      exited_count: 0,
      last_change_ts: null,
      last_reason: null,
      last_failed_transport_eyes: 0,
      last_success_eyes: 0,
      last_window_hours: Number(process.env.EYES_INFRA_OUTAGE_WINDOW_HOURS || 6),
      last_min_eyes: Number(process.env.EYES_INFRA_OUTAGE_MIN_EYES || 2)
    };
  }
  return registry.outage_mode;
}

function evaluateOutageWindow(config, windowHours = 6) {
  const eyeSet = new Set(nonStubEyeIds(config));
  const recent = readRecentRawEvents(windowHours).filter(e => eyeSet.has(String(e && e.eye_id || '')));
  const failedTransportEyes = new Set();
  const okRunEyes = new Set();
  const realItemEyes = new Set();
  for (const e of recent) {
    if (!e || !e.eye_id) continue;
    if (e.type === 'eye_run_failed') {
      const transport = isTransportFailure({ message: e.error, code: e.error_code }, e.error_code);
      if (transport) failedTransportEyes.add(String(e.eye_id));
    } else if (e.type === 'eye_run_ok' && Number(e.items_collected || 0) > 0) {
      okRunEyes.add(String(e.eye_id));
    } else if (e.type === 'external_item') {
      const title = String(e.title || '').toUpperCase();
      if (!title.includes('[STUB]')) {
        realItemEyes.add(String(e.eye_id));
      }
    }
  }
  const successEyes = new Set();
  for (const eyeId of okRunEyes) {
    if (realItemEyes.has(eyeId)) successEyes.add(eyeId);
  }
  return {
    window_hours: Number(windowHours || 6),
    non_stub_eyes: eyeSet.size,
    failed_transport_eyes: Array.from(failedTransportEyes),
    success_eyes: Array.from(successEyes)
  };
}

function updateOutageMode(config, registry, opts = {}) {
  const windowHours = Math.max(1, Number(opts.window_hours || process.env.EYES_INFRA_OUTAGE_WINDOW_HOURS || 6));
  const minEyes = Math.max(1, Number(opts.min_eyes || process.env.EYES_INFRA_OUTAGE_MIN_EYES || 2));
  const now = new Date().toISOString();
  const state = ensureOutageModeState(registry);
  const evalWindow = evaluateOutageWindow(config, windowHours);
  const failedCount = evalWindow.failed_transport_eyes.length;
  const successCount = evalWindow.success_eyes.length;
  const shouldActivate = failedCount >= minEyes && successCount === 0;
  let transition = null;

  if (state.active) {
    if (successCount > 0) {
      state.active = false;
      state.until = now;
      state.exited_count = Number(state.exited_count || 0) + 1;
      state.last_change_ts = now;
      state.last_reason = 'non_stub_success_detected';
      transition = 'exit';
    }
  } else if (shouldActivate) {
    state.active = true;
    state.since = now;
    state.until = null;
    state.entered_count = Number(state.entered_count || 0) + 1;
    state.last_change_ts = now;
    state.last_reason = `multi_eye_transport_failure:${failedCount}/${minEyes}`;
    transition = 'enter';
  }

  state.last_failed_transport_eyes = failedCount;
  state.last_success_eyes = successCount;
  state.last_window_hours = windowHours;
  state.last_min_eyes = minEyes;

  return {
    active: state.active === true,
    transition,
    min_eyes: minEyes,
    window_hours: windowHours,
    failed_transport_eyes: failedCount,
    success_eyes: successCount,
    failed_eye_ids: evalWindow.failed_transport_eyes,
    success_eye_ids: evalWindow.success_eyes,
    state
  };
}

function emitInfrastructureOutageAnomaly(dateStr, outageInfo) {
  ensureDirs();
  const fp = path.join(ANOMALIES_DIR, `${dateStr}.infrastructure.json`);
  const payload = {
    date: dateStr,
    checked_at: new Date().toISOString(),
    source: 'external_eyes',
    outage_mode: {
      active: outageInfo.active === true,
      since: outageInfo.state && outageInfo.state.since ? outageInfo.state.since : null,
      transition: outageInfo.transition || null
    },
    window_hours: Number(outageInfo.window_hours || 6),
    min_eyes: Number(outageInfo.min_eyes || 2),
    failed_transport_eyes: Array.isArray(outageInfo.failed_eye_ids) ? outageInfo.failed_eye_ids : [],
    success_eyes: Array.isArray(outageInfo.success_eye_ids) ? outageInfo.success_eye_ids : [],
    anomalies: outageInfo.active ? [
      {
        type: 'infrastructure_outage',
        severity: 'high',
        message: `Multi-eye transport outage detected (${Number(outageInfo.failed_transport_eyes || 0)} failing eyes in ${Number(outageInfo.window_hours || 6)}h)`
      }
    ] : []
  };
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2));
  return fp;
}

function buildInfrastructureOutageProposal(dateStr, outageInfo) {
  const nextCommand = 'node systems/routing/route_execute.js --task="Diagnose shared transport outage affecting multiple non-stub eyes; verify DNS/network/auth path and apply minimal deterministic fix." --tokens_est=1200 --repeats_14d=2 --errors_30d=1 --dry-run';
  const validation = [
    'At least one non-stub eye emits eye_run_ok with items_collected > 0',
    'Outage mode exits automatically on first successful non-stub run',
    'No new auto-park penalties applied during outage mode'
  ];
  const actionSpec = {
    version: 1,
    objective: 'Restore shared external-eye transport reliability with verifiable recovery checks',
    target: 'infrastructure:external_eyes_transport',
    next_command: nextCommand,
    verify: validation,
    success_criteria: [
      {
        metric: 'collector_success_runs',
        target: '>=1 non-stub eye_run_ok with items_collected>0',
        horizon: 'next run'
      },
      {
        metric: 'outage_mode_state',
        target: 'infrastructure outage mode deactivates automatically',
        horizon: '24h'
      }
    ],
    rollback: 'Revert transport-path changes and restore last known stable collector behavior'
  };
  const sinceSeed = (outageInfo.state && outageInfo.state.since) ? String(outageInfo.state.since).slice(0, 13) : String(dateStr);
  const idSeed = `infrastructure_outage:${sinceSeed}`;
  return {
    id: `INFRA-${computeHash(idSeed)}`,
    type: 'infrastructure_outage',
    title: '[Infra] Stabilize shared transport for external eyes',
    evidence: [
      {
        source: 'eyes_raw',
        path: `state/sensory/eyes/raw/${dateStr}.jsonl`,
        match: 'eye_run_failed transport',
        evidence_ref: 'eyes:infrastructure',
        evidence_url: null,
        evidence_item_hash: null
      },
      {
        source: 'anomaly',
        path: `state/sensory/anomalies/${dateStr}.infrastructure.json`,
        match: 'infrastructure_outage',
        evidence_ref: 'eyes:infrastructure',
        evidence_url: null,
        evidence_item_hash: null
      }
    ],
    expected_impact: 'high',
    risk: 'low',
    validation,
    suggested_next_command: nextCommand,
    action_spec: actionSpec,
    meta: {
      remediation_kind: 'infrastructure_transport_outage',
      trigger: 'multi_eye_transport_failure',
      failed_transport_eyes: Number(outageInfo.failed_transport_eyes || 0),
      window_hours: Number(outageInfo.window_hours || 6),
      min_eyes: Number(outageInfo.min_eyes || 2),
      outage_since: outageInfo.state && outageInfo.state.since ? outageInfo.state.since : null,
      action_spec_version: Number(actionSpec.version || 1),
      action_spec_target: String(actionSpec.target || '')
    }
  };
}

function emitInfrastructureOutageProposal(dateStr, outageInfo) {
  const { filePath, container, proposals } = loadProposalsForDate(dateStr);
  const next = Array.isArray(proposals) ? [...proposals] : [];
  const proposal = buildInfrastructureOutageProposal(dateStr, outageInfo);
  const existingById = new Set(next.map(p => String((p && p.id) || '')).filter(Boolean));
  if (existingById.has(proposal.id)) return { added: 0, filePath, proposal_id: proposal.id };
  next.push(proposal);
  saveProposalsForDate(filePath, next, container);
  return { added: 1, filePath, proposal_id: proposal.id };
}

function resolveInfrastructureOutageProposals(reason, resolvedAt) {
  ensureDirs();
  const files = fs.readdirSync(SENSORY_PROPOSALS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  let resolved = 0;
  for (const f of files) {
    const fp = path.join(SENSORY_PROPOSALS_DIR, f);
    const { container, proposals } = loadProposalsForDate(String(f).replace(/\.json$/, ''));
    if (!Array.isArray(proposals) || proposals.length === 0) continue;
    let changed = false;
    const next = proposals.map((p) => {
      if (!p || p.type !== 'infrastructure_outage') return p;
      if (String(p.status || '').toLowerCase() === 'resolved') return p;
      changed = true;
      resolved++;
      return {
        ...p,
        status: 'resolved',
        resolved_at: resolvedAt,
        resolution_reason: String(reason || 'outage_recovered').slice(0, 120)
      };
    });
    if (changed) {
      saveProposalsForDate(fp, next, container);
    }
  }
  return { resolved };
}

function readRecentRawEvents(windowHours) {
  const nowMs = Date.now();
  const sinceMs = nowMs - (Math.max(1, Number(windowHours || 24)) * 60 * 60 * 1000);
  const files = fs.existsSync(RAW_DIR)
    ? fs.readdirSync(RAW_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
    : [];
  const events = [];
  for (const f of files.slice(-3)) {
    const filePath = path.join(RAW_DIR, f);
    for (const e of safeReadJsonl(filePath)) {
      const ts = Date.parse(String(e && e.ts || ''));
      if (!Number.isFinite(ts)) continue;
      if (ts < sinceMs || ts > nowMs + 60 * 1000) continue;
      events.push(e);
    }
  }
  return events;
}

function emitCollectorStarvedAnomaly(config, windowHours = 24) {
  ensureDirs();
  const nonStubEyeIds = (config.eyes || [])
    .filter(e => String(e && e.parser_type || '').toLowerCase() !== 'stub')
    .filter(e => String(e && e.status || '').toLowerCase() !== 'retired')
    .map(e => String(e.id))
    .filter(Boolean);

  const eyeSet = new Set(nonStubEyeIds);
  const recent = readRecentRawEvents(windowHours).filter(e => eyeSet.has(String(e && e.eye_id || '')));
  const okRuns = recent.filter(e => e && e.type === 'eye_run_ok' && Number(e.items_collected || 0) > 0);
  const startedRuns = recent.filter(e => e && e.type === 'eye_run_started');
  const failedRuns = recent.filter(e => e && e.type === 'eye_run_failed');
  const realItems = recent.filter(e => e && e.type === 'external_item')
    .filter(e => !String(e.title || '').toUpperCase().includes('[STUB]'));
  const starved = realItems.length === 0;
  const byEye = {};
  for (const id of nonStubEyeIds) byEye[id] = { started: 0, ok: 0, failed: 0 };
  for (const e of startedRuns) byEye[e.eye_id] && (byEye[e.eye_id].started += 1);
  for (const e of okRuns) byEye[e.eye_id] && (byEye[e.eye_id].ok += 1);
  for (const e of failedRuns) byEye[e.eye_id] && (byEye[e.eye_id].failed += 1);

  const anomalyPath = path.join(ANOMALIES_DIR, `${getToday()}.collectors.json`);
  const payload = {
    date: getToday(),
    checked_at: new Date().toISOString(),
    source: 'external_eyes',
    window_hours: Number(windowHours || 24),
    stats: {
      non_stub_eyes: nonStubEyeIds.length,
      started_runs: startedRuns.length,
      ok_runs_with_items: okRuns.length,
      failed_runs: failedRuns.length,
      real_external_items: realItems.length
    },
    by_eye: byEye,
    anomalies: starved ? [
      {
        type: 'collector_starved',
        severity: 'high',
        message: `No successful non-stub collector signals (non-stub items) in last ${Number(windowHours || 24)}h`
      }
    ] : []
  };
  fs.writeFileSync(anomalyPath, JSON.stringify(payload, null, 2));
  return {
    starved,
    path: anomalyPath,
    window_hours: Number(windowHours || 24),
    ok_runs_with_items: okRuns.length,
    real_external_items: realItems.length
  };
}

function signalSlo(dateStr) {
  ensureDirs();
  const date = dateStr || getToday();
  const config = loadConfig();
  const thresholds = {
    real_external_items: Math.max(1, Number(process.env.EYES_SLO_MIN_REAL_EXTERNAL_ITEMS || 1)),
    accepted_items: Math.max(1, Number(process.env.EYES_SLO_MIN_ACCEPTED_ITEMS || 1)),
    proposal_generated: Math.max(1, Number(process.env.EYES_SLO_MIN_PROPOSAL_GENERATED || 1))
  };

  const nonStubEyeIds = new Set(
    (config.eyes || [])
      .filter(e => String(e && e.parser_type || '').toLowerCase() !== 'stub')
      .filter(e => String(e && e.status || '').toLowerCase() !== 'retired')
      .map(e => String(e.id))
      .filter(Boolean)
  );

  const rawPath = path.join(RAW_DIR, `${date}.jsonl`);
  const rawEvents = safeReadJsonl(rawPath);
  const realExternalItems = rawEvents
    .filter(e => e && e.type === 'external_item')
    .filter(e => nonStubEyeIds.has(String(e.eye_id || '')))
    .filter(e => !String(e.title || '').toUpperCase().includes('[STUB]'))
    .length;

  const proposalData = loadProposalsForDate(date);
  const proposals = Array.isArray(proposalData.proposals) ? proposalData.proposals : [];
  const acceptedItems = proposals.filter(p => String(p && p.type || '') === 'external_intel').length;

  const queueEvents = safeReadJsonl(SENSORY_QUEUE_LOG_PATH);
  const proposalGenerated = queueEvents
    .filter(e => e && e.type === 'proposal_generated' && String(e.date || '') === String(date))
    .length;

  const checks = {
    real_external_items: {
      value: realExternalItems,
      threshold: thresholds.real_external_items,
      ok: realExternalItems >= thresholds.real_external_items
    },
    accepted_items: {
      value: acceptedItems,
      threshold: thresholds.accepted_items,
      ok: acceptedItems >= thresholds.accepted_items
    },
    proposal_generated: {
      value: proposalGenerated,
      threshold: thresholds.proposal_generated,
      ok: proposalGenerated >= thresholds.proposal_generated
    }
  };
  const failed = Object.entries(checks)
    .filter(([, v]) => v && v.ok !== true)
    .map(([k]) => k);
  const ok = failed.length === 0;

  const payload = {
    ts: new Date().toISOString(),
    type: 'signal_slo',
    date,
    ok,
    checks,
    failed_checks: failed,
    sources: {
      raw_path: rawPath,
      proposals_path: proposalData.filePath,
      queue_log_path: SENSORY_QUEUE_LOG_PATH
    }
  };

  process.stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

function buildCollectorRemediationProposal(eyeConfig, registryEye, threshold) {
  const eyeId = String(eyeConfig.id || 'unknown_eye');
  const parserType = String((registryEye && registryEye.parser_type) || eyeConfig.parser_type || 'unknown');
  const lastErrorCode = String((registryEye && registryEye.last_error_code) || 'collector_error');
  const nextCommand = `node systems/routing/route_execute.js --task="Diagnose repeated collector fetch failures for eye ${eyeId}; implement minimal deterministic fix; preserve sensing-only behavior." --tokens_est=900 --repeats_14d=2 --errors_30d=1 --dry-run`;
  const validation = [
    'Collector run returns eye_run_ok with at least one item',
    'Two consecutive runs complete without eye_run_failed',
    'Collector path remains deterministic and sensing-only'
  ];
  const actionSpec = {
    version: 1,
    objective: `Stabilize collector ${eyeId} with bounded deterministic remediation`,
    target: `collector:${eyeId}`,
    next_command: nextCommand,
    verify: validation,
    success_criteria: [
      {
        metric: 'collector_success_runs',
        target: '>=1 eye_run_ok with items_collected>0',
        horizon: 'next 2 runs'
      },
      {
        metric: 'collector_failure_streak',
        target: 'consecutive_failures resets to 0',
        horizon: '24h'
      }
    ],
    rollback: `Revert collector remediation for ${eyeId} and restore prior stable config`
  };
  return {
    id: `COLLECTOR-${computeHash(`collector_remediation:${eyeId}`)}`,
    type: 'collector_remediation',
    title: `[Collector] Stabilize failing sensor collector (${eyeId})`,
    evidence: [
      {
        source: 'eyes_raw',
        path: `state/sensory/eyes/raw/${getToday()}.jsonl`,
        match: `eye_run_failed | ${eyeId}`.slice(0, 120),
        evidence_ref: `eye:${eyeId}`,
        evidence_url: null,
        evidence_item_hash: null
      }
    ],
    expected_impact: 'medium',
    risk: 'low',
    validation,
    suggested_next_command: nextCommand,
    action_spec: actionSpec,
    meta: {
      source_eye: eyeId,
      remediation_kind: 'collector_fetch_failure',
      trigger: 'consecutive_failures',
      threshold: Number(threshold),
      parser_type: parserType,
      last_error_code: lastErrorCode,
      action_spec_version: Number(actionSpec.version || 1),
      action_spec_target: String(actionSpec.target || '')
    }
  };
}

function emitCollectorRemediationProposals(dateStr, config, registry) {
  const threshold = Number(process.env.EYES_FAILURE_REMEDIATION_THRESHOLD || 2);
  if (!Number.isFinite(threshold) || threshold < 1) {
    return { added: 0, skipped: 0 };
  }

  const { filePath, container, proposals } = loadProposalsForDate(dateStr);
  const existingById = new Set(
    (Array.isArray(proposals) ? proposals : [])
      .map(p => (p && p.id ? String(p.id) : ''))
      .filter(Boolean)
  );

  const next = Array.isArray(proposals) ? [...proposals] : [];
  let added = 0;
  let skipped = 0;

  for (const eyeConfig of (config.eyes || [])) {
    const reg = (registry.eyes || []).find(e => e && e.id === eyeConfig.id);
    if (!reg) continue;
    const parserType = String(reg.parser_type || eyeConfig.parser_type || '').toLowerCase();
    if (parserType === 'stub') continue;
    if (String(reg.status || eyeConfig.status || '').toLowerCase() === 'retired') continue;

    const consecutiveFailures = Number(reg.consecutive_failures || 0);
    if (consecutiveFailures < threshold) continue;
    if (!isTransportFailure({ message: reg.last_error, code: reg.last_error_code }, reg.last_error_code)) continue;

    const proposal = buildCollectorRemediationProposal(eyeConfig, reg, threshold);
    if (!proposal.id || existingById.has(proposal.id)) {
      skipped += 1;
      continue;
    }
    next.push(proposal);
    existingById.add(proposal.id);
    added += 1;
  }

  if (added > 0) {
    saveProposalsForDate(filePath, next, container);
  }
  return { added, skipped, filePath };
}

function safeReadJsonl(filePath) {
  const events = [];
  try {
    if (!fs.existsSync(filePath)) return events;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        // ignore malformed line
      }
    }
  } catch (e) {
    return events;
  }
  return events;
}

function dateToMs(d) {
  return new Date(d + 'T00:00:00.000Z').getTime();
}

function datesInWindow(windowDays, nowDateStr) {
  const out = [];
  const nowMs = dateToMs(nowDateStr);
  for (let i = 0; i < windowDays; i++) {
    const ms = nowMs - (i * 24 * 60 * 60 * 1000);
    const iso = new Date(ms).toISOString().slice(0, 10);
    out.push(iso);
  }
  return out;
}

// Yield signals:
// proposed_total: # proposals in state/sensory/proposals for this eye in window
// shipped_total: # outcomes shipped in state/queue/decisions with evidence_ref "eye:<id>"
// yield_rate: shipped_total / proposed_total (0 if none)
function computeYieldSignals(windowDays, nowDateStr) {
  const windowDates = datesInWindow(windowDays, nowDateStr);
  const proposedByEye = {};
  const shippedByEye = {};

  // Proposed counts
  for (const d of windowDates) {
    const fp = path.join(SENSORY_PROPOSALS_DIR, `${d}.json`);
    const arr = safeReadJson(fp, []);
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const eye = (p && p.meta && p.meta.source_eye) ? String(p.meta.source_eye) : null;
      if (!eye) continue;
      proposedByEye[eye] = (proposedByEye[eye] || 0) + 1;
    }
  }

  // Shipped counts
  for (const d of windowDates) {
    const fp = path.join(DECISIONS_DIR, `${d}.jsonl`);
    const evts = safeReadJsonl(fp);
    for (const e of evts) {
      if (!e || e.type !== 'outcome') continue;
      if (String(e.outcome) !== 'shipped') continue;
      const ref = String(e.evidence_ref || '');
      const m = ref.match(/\beye:([^\s]+)/);
      const eye = m ? m[1] : null;
      if (!eye) continue;
      shippedByEye[eye] = (shippedByEye[eye] || 0) + 1;
    }
  }

  const eyes = new Set([...Object.keys(proposedByEye), ...Object.keys(shippedByEye)]);
  const out = {};
  for (const eye of eyes) {
    const proposed = proposedByEye[eye] || 0;
    const shipped = shippedByEye[eye] || 0;
    const yieldRate = proposed > 0 ? shipped / proposed : 0;
    out[eye] = { proposed_total: proposed, shipped_total: shipped, yield_rate: yieldRate };
  }
  return out;
}

/**
 * Read proposal_queue outcome events and attribute them to eyes.
 * We attribute only when evidence_ref includes "eye:<id>".
 * Deterministic scoring:
 *   shipped => +3
 *   no_change => +1
 *   reverted => -5
 *
 * We compute per-eye avg_points over the window, then delta = clamp(avg_points, -5, +5).
 * If no outcomes for an eye, delta=0.
 */
function computeOutcomeSignals(windowDays, nowDateStr) {
  const results = {}; // eyeId -> { shipped, no_change, reverted, total, points, avg_points, delta }
  const now = new Date(nowDateStr);
  if (!fs.existsSync(DECISIONS_DIR)) return results;

  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const filePath = path.join(DECISIONS_DIR, `${dateStr}.jsonl`);
    const events = safeReadJsonl(filePath);

    for (const ev of events) {
      if (!ev || ev.type !== 'outcome') continue;
      const evidenceRef = String(ev.evidence_ref || '');
      const m = evidenceRef.match(/(?:^|[\s,;])eye:([a-zA-Z0-9_\-]+)/);
      if (!m) continue;
      const eyeId = m[1];
      if (!results[eyeId]) {
        results[eyeId] = { shipped: 0, no_change: 0, reverted: 0, total: 0, points: 0, avg_points: 0, delta: 0 };
      }
      const outcome = String(ev.outcome || '').toLowerCase();
      if (outcome === 'shipped') {
        results[eyeId].shipped++;
        results[eyeId].points += 3;
        results[eyeId].total++;
      } else if (outcome === 'no_change') {
        results[eyeId].no_change++;
        results[eyeId].points += 1;
        results[eyeId].total++;
      } else if (outcome === 'reverted') {
        results[eyeId].reverted++;
        results[eyeId].points -= 5;
        results[eyeId].total++;
      }
    }
  }

  for (const [eyeId, r] of Object.entries(results)) {
    r.avg_points = r.total > 0 ? (r.points / r.total) : 0;
    r.delta = clamp(r.avg_points, -5, 5);
  }
  return results;
}

// STUB: Simulate external eye collection
// In v1.0, this is a stub that generates synthetic events for testing
function stubCollect(eye, budget) {
  const items = [];
  const count = Math.min(3, budget.max_items); // Generate 3 stub items max
  
  const now = new Date().toISOString();
  
  for (let i = 0; i < count; i++) {
    const item = {
      id: computeHash(`${eye.id}-${now}-${i}`),
      url: `https://${eye.allowed_domains[0]}/item/${i}`,
      title: `[STUB] ${eye.name} item ${i+1}`,
      source: eye.id,
      collected_at: now,
      topics: eye.topics || [],
      content_preview: `Stub content from ${eye.name} about ${eye.topics?.[0] || 'general'}`,
      bytes: 256
    };
    items.push(item);
  }
  
  return {
    success: true,
    items,
    duration_ms: 100 + items.length * 10,
    requests: 1,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0)
  };
}

// Append event to raw log
function appendRawLog(dateStr, event) {
  const logPath = path.join(RAW_DIR, `${dateStr}.jsonl`);
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(logPath, line, 'utf8');
}

/**
 * Collector dispatch (deterministic)
 * - Keep collectors tiny and explicit
 * - No LLM calls inside collectors
 */
async function collectEye(eyeConfig) {
  if (String(eyeConfig && eyeConfig.parser_type || '').toLowerCase() === 'stub') {
    return stubCollect(eyeConfig, eyeConfig.budgets || {});
  }
  const out = await collectWithDriver(eyeConfig);
  if (out && out.success === true) return out;
  return {
    success: false,
    items: [],
    duration_ms: Number(out && out.duration_ms) || 0,
    requests: Number(out && out.requests) || 0,
    bytes: Number(out && out.bytes) || 0,
    error: out && out.error ? out.error : 'collector_failed'
  };
}

function staticPreflightEye(eyeConfig) {
  return preflightWithDriver(eyeConfig);
}

async function preflight(opts = {}) {
  ensureDirs();
  const config = loadConfig();
  const report = [];

  for (const eyeConfig of (config.eyes || [])) {
    const parserType = String(eyeConfig.parser_type || '').toLowerCase();
    const status = String(eyeConfig.status || '').toLowerCase();
    let staticRep = staticPreflightEye(eyeConfig) || { ok: false, checks: [], failures: [] };
    
    // Handle async preflight results
    if (staticRep instanceof Promise) {
      staticRep = await staticRep.catch(() => ({ ok: false, checks: [], failures: [{ code: 'preflight_error', message: 'Async preflight failed' }] }));
    }
    
    const row = {
      eye_id: String(eyeConfig.id || ''),
      parser_type: parserType,
      status,
      runnable: status !== 'retired' && parserType !== 'stub',
      ok: !!staticRep.ok,
      checks: Array.isArray(staticRep.checks) ? staticRep.checks : [],
      failures: Array.isArray(staticRep.failures) ? staticRep.failures : []
    };
    report.push(row);
  }

  const failingRunnable = report.filter(r => r.runnable && r.ok !== true);
  const failureCodeCounts = {};
  for (const row of failingRunnable) {
    for (const f of (row.failures || [])) {
      const code = String((f && f.code) || 'unknown_error');
      failureCodeCounts[code] = (failureCodeCounts[code] || 0) + 1;
    }
  }

  const payload = {
    ts: new Date().toISOString(),
    type: 'collector_preflight',
    ok: failingRunnable.length === 0,
    checked: report.length,
    failed_runnable_eyes: failingRunnable.length,
    failure_code_counts: failureCodeCounts,
    report
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  return payload;
}

// RUN: Execute eligible eyes based on cadence and status
async function run(opts = {}) {
  ensureDirs();
  
  const config = loadConfig();
  const registry = loadRegistry();
  const today = getToday();
  const { eye: specificEye, maxEyes = config.global_limits.max_concurrent_runs, forceEyeId = null } = opts;
  const selfHealPass = opts.selfHealPass === true;
  const selfHealEnabled = !selfHealPass && String(process.env.EYES_SELF_HEAL_ENABLED || '1') !== '0';
  const outageStart = updateOutageMode(config, registry);
  const focusEnabled = String(process.env.EYES_FOCUS_ENABLED || '1') !== '0';
  let focusRefresh = null;
  if (focusEnabled) {
    try {
      focusRefresh = maybeRefreshFocusTriggers({
        dateStr: today,
        reason: 'external_eyes_run'
      });
    } catch (err) {
      focusRefresh = {
        ok: false,
        error: String(err && err.message ? err.message : err || 'focus_refresh_failed').slice(0, 180)
      };
    }
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - RUN CYCLE');
  console.log('═══════════════════════════════════════════════════════════');
  if (focusEnabled && focusRefresh && focusRefresh.refreshed) {
    console.log(`🎯 Focus triggers refreshed: ${Number(focusRefresh.trigger_count || 0)} active`);
  } else if (focusEnabled && focusRefresh && focusRefresh.ok === false) {
    console.log(`⚠️  Focus refresh failed: ${String(focusRefresh.error || 'unknown').slice(0, 120)}`);
  }
  if (outageStart.transition === 'enter') {
    console.log(`🚨 Outage mode ENTER: failed_transport_eyes=${outageStart.failed_transport_eyes}/${outageStart.min_eyes} window=${outageStart.window_hours}h`);
  } else if (outageStart.transition === 'exit') {
    console.log('🟢 Outage mode EXIT: non-stub success observed');
  } else if (outageStart.active) {
    console.log(`🚨 Outage mode ACTIVE: failed_transport_eyes=${outageStart.failed_transport_eyes}/${outageStart.min_eyes} window=${outageStart.window_hours}h`);
  }
  appendRawLog(today, {
    ts: new Date().toISOString(),
    type: 'infra_outage_state',
    active: outageStart.active === true,
    transition: outageStart.transition || null,
    failed_transport_eyes: Number(outageStart.failed_transport_eyes || 0),
    min_eyes: Number(outageStart.min_eyes || 2),
    window_hours: Number(outageStart.window_hours || 6),
    failed_eye_ids: outageStart.failed_eye_ids || []
  });
  
  let runCount = 0;
  let eyesRun = [];
  
  for (const eyeConfig of config.eyes) {
    let registryEye = registry.eyes.find(e => e.id === eyeConfig.id);
    if (!registryEye) {
      registryEye = {
        ...eyeConfig,
        run_count: 0,
        total_runs: 0,
        total_items: 0,
        total_errors: 0,
        consecutive_failures: 0
      };
      registry.eyes.push(registryEye);
    }
    const runtimeEye = effectiveEye(eyeConfig, registryEye);
    const parserType = String(runtimeEye.parser_type || eyeConfig.parser_type || '').toLowerCase();
    const isForced = forceEyeId && eyeConfig.id === forceEyeId;

    if (specificEye && eyeConfig.id !== specificEye) continue;
    if (runCount >= maxEyes) break;
    
    // Check status
    if (runtimeEye.status === 'retired') {
      console.log(`⏭️  Skipping ${eyeConfig.id}: retired`);
      continue;
    }

    // Cooldown gate after repeated failures (auto-park).
    if (!isForced && registryEye.cooldown_until) {
      const until = new Date(String(registryEye.cooldown_until));
      if (!isNaN(until.getTime()) && Date.now() < until.getTime()) {
        const hrs = Math.max(0, (until.getTime() - Date.now()) / (1000 * 60 * 60));
        console.log(`⏭️  Skipping ${eyeConfig.id}: cooldown (${hrs.toFixed(1)}h left)`);
        continue;
      }
      // Cooldown expired: clear marker and move to probation for controlled retry.
      registryEye.cooldown_until = null;
      if (registryEye.status === 'dormant') registryEye.status = 'probation';
    }
    
    // Check cadence
    const lastRun = registryEye?.last_run ? new Date(registryEye.last_run) : null;
    const hoursSinceLastRun = lastRun ? (Date.now() - lastRun) / (1000 * 60 * 60) : Infinity;
    
    if (!isForced && hoursSinceLastRun < runtimeEye.cadence_hours) {
      console.log(`⏭️  Skipping ${eyeConfig.id}: cadence (${Math.round(hoursSinceLastRun)}h < ${runtimeEye.cadence_hours}h)`);
      continue;
    }
    
    // RUN the eye
    if (isForced) {
      console.log(`🚦 Canary forcing ${eyeConfig.id} (bypass cadence/cooldown)`);
    }
    console.log(`👁️  Running ${eyeConfig.id}...`);
    
    // Emit breadcrumb: eye_run_started
    const startEvent = {
      ts: new Date().toISOString(),
      type: 'eye_run_started',
      eye_id: eyeConfig.id,
      eye_name: eyeConfig.name,
      budget: eyeConfig.budgets,
      status: runtimeEye.status
    };
    appendRawLog(today, startEvent);
    
    try {
      // Deterministic collector dispatch (real collectors + stub fallback)
      const result = await collectEye(eyeConfig);
      
      if (result.success) {
        let focused = {
          ok: true,
          eye_id: eyeConfig.id,
          date: today,
          selected_count: 0,
          items: Array.isArray(result.items) ? result.items : [],
          focus_events: []
        };
        if (focusEnabled && parserType !== 'stub' && Array.isArray(result.items) && result.items.length > 0) {
          try {
            focused = await evaluateFocusForEye({
              eye: runtimeEye,
              items: result.items,
              dateStr: today
            });
          } catch (focusErr) {
            focused = {
              ok: false,
              eye_id: eyeConfig.id,
              date: today,
              selected_count: 0,
              items: result.items,
              focus_events: [],
              error: String(focusErr && focusErr.message ? focusErr.message : focusErr || 'focus_eval_failed').slice(0, 160)
            };
            appendRawLog(today, {
              ts: new Date().toISOString(),
              type: 'eye_focus_failed',
              eye_id: eyeConfig.id,
              error: focused.error
            });
          }
        }

        const emittedItems = Array.isArray(focused.items) ? focused.items : (Array.isArray(result.items) ? result.items : []);
        const realSignalItems = parserType === 'stub' ? 0 : countRealSignalItems(emittedItems);

        // Emit items (scan/focus annotations included)
        emittedItems.forEach(item => {
          const topics = normalizedItemTopics(item);
          const fallbackItem = isFallbackItem(item);
          appendRawLog(today, {
            ts: item.collected_at,
            type: 'external_item',
            eye_id: eyeConfig.id,
            parser_type: parserType,
            item_hash: item.id,
            url: item.url,
            title: item.title,
            topics,
            tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
            fallback: fallbackItem,
            content_preview: String(item.content_preview || item.description || item.summary || '').slice(0, 280),
            bytes: item.bytes,
            focus_mode: String(item.focus_mode || 'scan'),
            focus_score: Number.isFinite(Number(item.focus_score)) ? Number(item.focus_score) : null,
            focus_trigger_hits: Array.isArray(item.focus_trigger_hits) ? item.focus_trigger_hits.slice(0, 8) : [],
            focus_lens_hits: Array.isArray(item.focus_lens_hits) ? item.focus_lens_hits.slice(0, 8) : [],
            focus_lens_exclude_hits: Array.isArray(item.focus_lens_exclude_hits) ? item.focus_lens_exclude_hits.slice(0, 8) : [],
            focus_lens_delta: Number.isFinite(Number(item.focus_lens_delta)) ? Number(item.focus_lens_delta) : null,
            focus_details: item.focus_mode === 'focus' ? (item.focus_details || null) : null
          });
        });

        // Emit focus-specific breadcrumbs
        for (const ev of (Array.isArray(focused.focus_events) ? focused.focus_events : [])) {
          appendRawLog(today, ev);
        }
        
        // Emit breadcrumb: eye_run_ok
        appendRawLog(today, {
          ts: new Date().toISOString(),
          type: 'eye_run_ok',
          eye_id: eyeConfig.id,
          items_collected: emittedItems.length,
          focus_selected: Number(focused.selected_count || 0),
          duration_ms: result.duration_ms,
          requests: result.requests,
          bytes: result.bytes
        });
        
        // Update registry
        registryEye.last_run = new Date().toISOString();
        registryEye.last_success = new Date().toISOString();
        registryEye.total_runs = Number(registryEye.total_runs || 0) + 1;
        registryEye.run_count++;
        registryEye.total_items += result.items.length;
        registryEye.consecutive_failures = 0;
        if (parserType !== 'stub') {
          if (realSignalItems > 0) {
            registryEye.consecutive_no_signal_runs = 0;
            registryEye.last_real_signal_ts = new Date().toISOString();
          } else {
            registryEye.consecutive_no_signal_runs = Number(registryEye.consecutive_no_signal_runs || 0) + 1;
          }
        }
        registryEye.cooldown_until = null;
        registryEye.last_error = null;
        registryEye.last_error_code = null;
        registryEye.last_error_http_status = null;
        if (String(registryEye.status || runtimeEye.status || '').toLowerCase() === 'dormant') {
          registryEye.status = 'probation';
        }
        const runs = Math.max(1, Number(registryEye.total_runs || 0));
        registryEye.error_rate = Number(registryEye.total_errors || 0) / runs;

        const outageStateNow = ensureOutageModeState(registry);
        if (outageStateNow.active === true && parserType !== 'stub' && result.items.length > 0) {
          outageStateNow.active = false;
          outageStateNow.until = new Date().toISOString();
          outageStateNow.exited_count = Number(outageStateNow.exited_count || 0) + 1;
          outageStateNow.last_change_ts = outageStateNow.until;
          outageStateNow.last_reason = `first_non_stub_success:${eyeConfig.id}`;
          appendRawLog(today, {
            ts: outageStateNow.until,
            type: 'infra_outage_state',
            active: false,
            transition: 'exit',
            reason: outageStateNow.last_reason
          });
          console.log(`   🟢 Outage mode exited by successful run: ${eyeConfig.id}`);
        }
        
        eyesRun.push({
          id: eyeConfig.id,
          items: emittedItems.length,
          real_items: realSignalItems,
          focus: Number(focused.selected_count || 0),
          duration_ms: result.duration_ms
        });
        
        console.log(`   ✅ ${emittedItems.length} items (${Number(focused.selected_count || 0)} focus), ${result.duration_ms}ms`);
      }
      
    } catch (err) {
      const c = normalizeFailure(err);
      const envBlocked = String(c.code || '') === 'env_blocked';
      // Emit breadcrumb: eye_run_failed
      appendRawLog(today, {
        ts: new Date().toISOString(),
        type: 'eye_run_failed',
        eye_id: eyeConfig.id,
        error: c.message,
        error_code: c.code,
        error_http_status: c.http_status,
        retryable: c.retryable
      });
      
      registryEye.last_run = new Date().toISOString();
      if (!envBlocked) {
        registryEye.total_runs = Number(registryEye.total_runs || 0) + 1;
        registryEye.total_errors++;
      }
      registryEye.last_error = c.message;
      registryEye.last_error_code = c.code;
      registryEye.last_error_http_status = c.http_status;
      registryEye.last_error_ts = new Date().toISOString();
      if (!envBlocked) {
        const runs = Math.max(1, Number(registryEye.total_runs || registryEye.run_count || 0));
        registryEye.error_rate = registryEye.total_errors / runs;
      }

      const FAIL_PARK_THRESHOLD = Number(process.env.EYES_FAIL_PARK_THRESHOLD || 3);
      const FAIL_PARK_HOURS = Number(process.env.EYES_FAIL_PARK_HOURS || 24);
      const outageStateNow = ensureOutageModeState(registry);
      const suppressPenalty = outageStateNow.active === true && parserType !== 'stub';
      if (envBlocked) {
        console.log(`   ⚠️  Environment blocked: failure penalty suppressed for ${eyeConfig.id}`);
      } else if (suppressPenalty) {
        console.log(`   ⚠️  Outage mode: failure penalty suppressed for ${eyeConfig.id}`);
      } else {
        registryEye.consecutive_failures = Number(registryEye.consecutive_failures || 0) + 1;
        if (parserType !== 'stub') {
          registryEye.consecutive_no_signal_runs = Number(registryEye.consecutive_no_signal_runs || 0) + 1;
        }
        if (registryEye.consecutive_failures >= FAIL_PARK_THRESHOLD) {
          registryEye.status = 'dormant';
          registryEye.cooldown_until = new Date(Date.now() + (FAIL_PARK_HOURS * 60 * 60 * 1000)).toISOString();
          console.log(`   ⚠️  Auto-parked: consecutive_failures=${registryEye.consecutive_failures} cooldown=${FAIL_PARK_HOURS}h`);
        }
      }
      
      console.log(`   ❌ Failed: ${c.code} ${c.message}`);
    }
    
    runCount++;
  }

  const outageEnd = updateOutageMode(config, registry);
  if (outageEnd.transition === 'enter') {
    appendRawLog(today, {
      ts: new Date().toISOString(),
      type: 'infra_outage_state',
      active: true,
      transition: 'enter',
      failed_transport_eyes: Number(outageEnd.failed_transport_eyes || 0),
      min_eyes: Number(outageEnd.min_eyes || 2),
      window_hours: Number(outageEnd.window_hours || 6),
      failed_eye_ids: outageEnd.failed_eye_ids || []
    });
    console.log(`🚨 Outage mode ENTER: failed_transport_eyes=${outageEnd.failed_transport_eyes}/${outageEnd.min_eyes} window=${outageEnd.window_hours}h`);
  } else if (outageEnd.transition === 'exit') {
    appendRawLog(today, {
      ts: new Date().toISOString(),
      type: 'infra_outage_state',
      active: false,
      transition: 'exit',
      reason: 'non_stub_success_detected'
    });
    console.log('🟢 Outage mode EXIT: non-stub success observed');
    const resolved = resolveInfrastructureOutageProposals('outage_recovered_non_stub_success', new Date().toISOString());
    if (resolved.resolved > 0) {
      console.log(`✅ Closed infrastructure outage proposals: ${resolved.resolved}`);
    }
  }

  if (outageEnd.active) {
    const anomalyPath = emitInfrastructureOutageAnomaly(today, outageEnd);
    const infraProposal = emitInfrastructureOutageProposal(today, outageEnd);
    console.log(`🚨 infrastructure_outage active path=${anomalyPath}`);
    if (infraProposal.added > 0) {
      console.log(`🛠️  Infrastructure remediation proposal added: ${infraProposal.proposal_id}`);
    }
  } else {
    const remediation = emitCollectorRemediationProposals(today, config, registry);
    if (remediation.added > 0) {
      console.log(`🛠️  Collector remediation proposals added: ${remediation.added}`);
    }
  }
  const starvedCheck = emitCollectorStarvedAnomaly(
    config,
    Number(process.env.EYES_STARVED_WINDOW_HOURS || 24)
  );
  if (starvedCheck.starved) {
    console.log(`⚠️  collector_starved window=${starvedCheck.window_hours}h path=${starvedCheck.path}`);
  }

  let temporalReport = null;
  if (!selfHealPass) {
    try {
      temporalReport = analyzeTemporalPatterns({
        dateStr: today,
        lookbackDays: Number(process.env.EYES_TEMPORAL_LOOKBACK_DAYS || 7),
        write: true
      });
      appendRawLog(today, {
        ts: new Date().toISOString(),
        type: 'temporal_patterns',
        lookback_days: Number(temporalReport.lookback_days || 0),
        dark_candidates: Array.isArray(temporalReport.dark_candidates) ? temporalReport.dark_candidates.length : 0,
        anomalies: Array.isArray(temporalReport.anomalies) ? temporalReport.anomalies.length : 0
      });
      console.log(
        `📈 temporal_patterns dark=${Array.isArray(temporalReport.dark_candidates) ? temporalReport.dark_candidates.length : 0}` +
        ` anomalies=${Array.isArray(temporalReport.anomalies) ? temporalReport.anomalies.length : 0}`
      );
    } catch (err) {
      appendRawLog(today, {
        ts: new Date().toISOString(),
        type: 'temporal_patterns_failed',
        error: String(err && err.message ? err.message : err || 'temporal_patterns_failed').slice(0, 160)
      });
      console.log(`⚠️  temporal_patterns failed: ${String(err && err.message ? err.message : err || 'unknown').slice(0, 120)}`);
    }
  }
  
  saveRegistry(registry);

  const selfHealStats = {
    enabled: selfHealEnabled,
    attempted: 0,
    recovered: 0,
    candidates: []
  };

  if (selfHealEnabled && temporalReport && Array.isArray(temporalReport.dark_candidates)) {
    const maxHeal = Math.max(0, Number(process.env.EYES_SELF_HEAL_MAX_PER_RUN || 2));
    const healCooldownHours = Math.max(1, Number(process.env.EYES_SELF_HEAL_COOLDOWN_HOURS || 4));
    const retryCadenceHours = Math.max(1, Number(process.env.EYES_RETRY_CADENCE_HOURS || 6));
    const nowMs = Date.now();

    for (const cand of temporalReport.dark_candidates) {
      if (selfHealStats.attempted >= maxHeal) break;
      const eyeId = String(cand && cand.eye_id || '');
      if (!eyeId) continue;
      if (specificEye && specificEye !== eyeId) continue;

      const latestRegistry = loadRegistry();
      const regEye = (latestRegistry.eyes || []).find((e) => e && e.id === eyeId);
      if (!regEye) continue;
      const cooldownUntil = Date.parse(String(regEye.self_heal_cooldown_until || ''));
      if (Number.isFinite(cooldownUntil) && nowMs < cooldownUntil) continue;

      selfHealStats.candidates.push(eyeId);
      selfHealStats.attempted += 1;
      appendRawLog(today, {
        ts: new Date().toISOString(),
        type: 'eye_self_heal_triggered',
        eye_id: eyeId,
        reason: 'went_dark',
        expected_silence_hours: Number(cand.expected_silence_hours || 0),
        last_signal_hours: Number(cand.last_signal_hours || 0),
        baseline_avg_real_items: Number(cand.baseline_avg_real_items || 0)
      });
      console.log(`🩺 Self-heal probe: ${eyeId}`);

      const healRes = await run({
        eye: eyeId,
        maxEyes: 1,
        forceEyeId: eyeId,
        selfHealPass: true
      });
      const recovered = Array.isArray(healRes.eyes)
        && healRes.eyes.some((r) => r && r.id === eyeId && Number(r.real_items || 0) > 0);
      if (recovered) selfHealStats.recovered += 1;

      const postRegistry = loadRegistry();
      const postEye = (postRegistry.eyes || []).find((e) => e && e.id === eyeId);
      if (postEye) {
        postEye.self_heal_attempts = Number(postEye.self_heal_attempts || 0) + 1;
        postEye.self_heal_recoveries = Number(postEye.self_heal_recoveries || 0) + (recovered ? 1 : 0);
        postEye.last_self_heal_ts = new Date().toISOString();
        postEye.last_self_heal_result = recovered ? 'recovered' : 'no_recovery';
        postEye.self_heal_cooldown_until = new Date(Date.now() + (healCooldownHours * 60 * 60 * 1000)).toISOString();
        if (!recovered) {
          postEye.status = 'probation';
          postEye.cadence_hours = Math.min(Number(postEye.cadence_hours || retryCadenceHours), retryCadenceHours);
        }
        saveRegistry(postRegistry);
      }

      appendRawLog(today, {
        ts: new Date().toISOString(),
        type: 'eye_self_heal_result',
        eye_id: eyeId,
        recovered,
        real_items: Array.isArray(healRes.eyes)
          ? Number((healRes.eyes.find((r) => r && r.id === eyeId) || {}).real_items || 0)
          : 0
      });
      console.log(`   ${recovered ? '✅' : '⚠️'} Self-heal ${eyeId}: ${recovered ? 'recovered' : 'no_recovery'}`);
    }
  }
  
  console.log('───────────────────────────────────────────────────────────');
  console.log(`🎯 Ran ${eyesRun.length}/${runCount} eyes eligible`);
  eyesRun.forEach(e => console.log(`   - ${e.id}: ${e.items} items (${Number(e.real_items || 0)} real, ${Number(e.focus || 0)} focus) in ${e.duration_ms}ms`));
  if (selfHealEnabled && selfHealStats.attempted > 0) {
    console.log(`🩺 Self-heal: attempted=${selfHealStats.attempted}, recovered=${selfHealStats.recovered}`);
  }
  console.log('═══════════════════════════════════════════════════════════');
  
  return { ran: eyesRun.length, eyes: eyesRun, self_heal: selfHealStats };
}

function pickCanaryEye(config, registry) {
  const RETRY_WINDOW_HOURS = Number(process.env.EYES_RETRY_WINDOW_HOURS || 24);
  const candidates = [];
  for (const eyeConfig of (config.eyes || [])) {
    const parserType = String(eyeConfig.parser_type || '').toLowerCase();
    if (parserType === 'stub') continue;
    const status = String(eyeConfig.status || '').toLowerCase();
    if (status === 'retired') continue;
    const reg = (registry.eyes || []).find(e => e && e.id === eyeConfig.id) || {};
    const recentFailure = hasRecentTransportFailure(reg, RETRY_WINDOW_HOURS);
    const lastSuccessHours = hoursSince(reg.last_success);
    candidates.push({
      id: eyeConfig.id,
      recentFailure: recentFailure ? 1 : 0,
      consecutiveFailures: Number(reg.consecutive_failures || 0),
      lastSuccessHours: Number.isFinite(lastSuccessHours) ? lastSuccessHours : 1e9
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (b.recentFailure !== a.recentFailure) return b.recentFailure - a.recentFailure;
    if (b.consecutiveFailures !== a.consecutiveFailures) return b.consecutiveFailures - a.consecutiveFailures;
    if (b.lastSuccessHours !== a.lastSuccessHours) return b.lastSuccessHours - a.lastSuccessHours;
    return String(a.id).localeCompare(String(b.id));
  });
  return candidates[0];
}

function statusRank(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return 0;
  if (s === 'probation') return 1;
  if (s === 'dormant') return 2;
  if (s === 'retired') return 3;
  return 4;
}

function pickSignalCanaryEye(config, registry) {
  const STALE_SUCCESS_HOURS = Number(process.env.EYES_SIGNAL_STALE_SUCCESS_HOURS || 72);
  const rows = [];
  for (const eyeConfig of (config.eyes || [])) {
    const parserType = String(eyeConfig.parser_type || '').toLowerCase();
    if (parserType === 'stub') continue;
    const reg = (registry.eyes || []).find(e => e && e.id === eyeConfig.id) || {};
    const runtimeEye = effectiveEye(eyeConfig, reg);
    if (String(runtimeEye.status || '').toLowerCase() === 'retired') continue;
    const lastSuccessHours = hoursSince(reg.last_success);
    rows.push({
      id: String(eyeConfig.id),
      status: String(runtimeEye.status || ''),
      scoreEma: Number(runtimeEye.score_ema || 0),
      consecutiveFailures: Number(reg.consecutive_failures || 0),
      lastSuccessHours: Number.isFinite(lastSuccessHours) ? lastSuccessHours : null
    });
  }
  if (!rows.length) return null;

  const preferred = rows.filter(r =>
    r.consecutiveFailures === 0
    && statusRank(r.status) <= 1
    && (r.lastSuccessHours == null || r.lastSuccessHours <= STALE_SUCCESS_HOURS)
  );
  const pool = preferred.length ? preferred : rows;
  pool.sort((a, b) => {
    if (statusRank(a.status) !== statusRank(b.status)) return statusRank(a.status) - statusRank(b.status);
    if (a.consecutiveFailures !== b.consecutiveFailures) return a.consecutiveFailures - b.consecutiveFailures;
    const aSuccess = Number.isFinite(a.lastSuccessHours) ? a.lastSuccessHours : 1e9;
    const bSuccess = Number.isFinite(b.lastSuccessHours) ? b.lastSuccessHours : 1e9;
    if (aSuccess !== bSuccess) return aSuccess - bSuccess;
    if (b.scoreEma !== a.scoreEma) return b.scoreEma - a.scoreEma;
    return String(a.id).localeCompare(String(b.id));
  });
  return pool[0];
}

async function canary(opts = {}) {
  ensureDirs();
  const config = loadConfig();
  const registry = loadRegistry();
  const pick = opts.eye
    ? { id: String(opts.eye), recentFailure: 0, consecutiveFailures: 0, lastSuccessHours: 0 }
    : pickCanaryEye(config, registry);

  if (!pick || !pick.id) {
    console.log('canary: no eligible non-stub eyes');
    return { ran: 0, selected_eye: null };
  }

  console.log(`canary: selected ${pick.id}`);
  const res = await run({
    eye: pick.id,
    maxEyes: 1,
    forceEyeId: pick.id
  });
  return { ...res, selected_eye: pick.id };
}

async function canarySignal(opts = {}) {
  ensureDirs();
  const config = loadConfig();
  const registry = loadRegistry();
  const pick = opts.eye
    ? { id: String(opts.eye) }
    : pickSignalCanaryEye(config, registry);

  if (!pick || !pick.id) {
    console.log('canary-signal: no eligible non-stub eyes');
    return { ran: 0, selected_eye: null };
  }

  console.log(`canary-signal: selected ${pick.id}`);
  const res = await run({
    eye: pick.id,
    maxEyes: 1,
    forceEyeId: pick.id
  });
  return { ...res, selected_eye: pick.id };
}

// SCORE: Compute usefulness metrics per eye
function score(dateStr) {
  ensureDirs();
  const date = dateStr || getToday();
  const rawLogPath = path.join(RAW_DIR, `${date}.jsonl`);
  
  if (!fs.existsSync(rawLogPath)) {
    console.log(`No raw events for ${date}`);
    return null;
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - SCORING');
  console.log(`   Date: ${date}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  // Load events
  const lines = fs.readFileSync(rawLogPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(e => e !== null);
  
  // Group by eye
  const byEye = {};
  const urlHashes = new Set();
  const signalHeuristics = {
    // Simple heuristics for "signal" content
    hasTopic: (item) => item.topics && item.topics.length > 0,
    hasTitle: (item) => item.title && item.title.length > 20
  };
  
  for (const event of lines) {
    if (event.eye_id) {
      if (!byEye[event.eye_id]) {
        byEye[event.eye_id] = {
          items: [],
          ok_runs: [],
          failed_runs: []
        };
      }
      
      if (event.type === 'external_item') {
        byEye[event.eye_id].items.push(event);
        urlHashes.add(event.item_hash);
      } else if (event.type === 'eye_run_ok') {
        byEye[event.eye_id].ok_runs.push(event);
      } else if (event.type === 'eye_run_failed') {
        byEye[event.eye_id].failed_runs.push(event);
      }
    }
  }
  
  // Compute metrics per eye
  const metrics = {};
  const config = loadConfig();
  const registry = loadRegistry();
  
  const YIELD_WINDOW_DAYS = 14;
  const yieldSignals = computeYieldSignals(YIELD_WINDOW_DAYS, date);
  
  for (const [eyeId, data] of Object.entries(byEye)) {
    const eyeConfig = config.eyes.find(e => e.id === eyeId);
    const regEye = registry.eyes.find(e => e.id === eyeId);
    if (!eyeConfig) continue;
    const runtimeEye = effectiveEye(eyeConfig, regEye);
    const parserType = String(runtimeEye.parser_type || eyeConfig.parser_type || '').toLowerCase();
    
    const items = data.items;
    const uniqueItems = new Set(items.map(i => i.item_hash)).size;
    const totalBytes = items.reduce((sum, i) => sum + (i.bytes || 0), 0);
    const totalRequests = data.ok_runs.reduce((sum, r) => sum + (r.requests || 0), 0);
    const totalDuration = data.ok_runs.reduce((sum, r) => sum + (r.duration_ms || 0), 0);
    const errorCount = data.failed_runs.length;
    const totalRuns = data.ok_runs.length + errorCount;
    const transportFailureCount = data.failed_runs
      .filter(r => isTransportFailure({ message: r && r.error, code: r && r.error_code }, r && r.error_code))
      .length;
    
    // Signal rate: items passing heuristics
    const signalItems = items.filter(i => 
      signalHeuristics.hasTopic(i) && signalHeuristics.hasTitle(i)
    ).length;
    
    // Proposal yield (stub: 0 in v1.0)
    const proposalYield = 0;
    
    // Compute quality score (0-100)
    const noveltyRate = uniqueItems / Math.max(items.length, 1);
    const signalRate = items.length > 0 ? signalItems / items.length : 0;
    const errorRate = totalRuns > 0 ? errorCount / totalRuns : 0;
    
    // Composite score
    // Include yield lightly (outcome-weighted sensing):
    // - yield_rate contributes up to +20 points when yield approaches 1.0
    // - but typical yields are low, so this mostly helps distinguish "signal that converts"
    // - confidence = min(1, proposed / 20) to avoid high bonuses on small samples
    const y = yieldSignals[eyeId] ? yieldSignals[eyeId].yield_rate : 0;
    const proposed = yieldSignals[eyeId] ? yieldSignals[eyeId].proposed_total : 0;
    const confidence = Math.min(1, proposed / 20);
    const rawScore = (
      noveltyRate * 30 +      // 30% novelty
      signalRate * 40 +         // 40% signal
      (1 - errorRate) * 20 +   // 20% reliability
      Math.min(proposalYield * 10, 10) +  // 10% proposal yield
      Math.min(y * 20, 20) * confidence    // outcome yield bonus (max +20), confidence-weighted
    );
    const oldEma = runtimeEye.score_ema;
    const reliabilityFault = parserType !== 'stub' && transportFailureCount > 0 && items.length === 0;
    const scoreCap = parserType === 'stub' ? 35 : 100;
    let cappedRawScore = Math.min(rawScore, scoreCap);
    const lastSuccessHours = hoursSince(regEye && regEye.last_success);
    const STALE_SUCCESS_HOURS = Number(process.env.EYES_STALE_SUCCESS_HOURS || 24);
    const staleCapApplied = !reliabilityFault && Number.isFinite(lastSuccessHours) && lastSuccessHours > STALE_SUCCESS_HOURS;
    if (staleCapApplied) {
      cappedRawScore = Math.min(cappedRawScore, 20);
    }
    if (reliabilityFault) {
      // Keep quality score neutral during transport outages; this is reliability fault, not signal quality.
      cappedRawScore = oldEma;
    }
    
    // Update EMA
    const alpha = config.scoring.ema_alpha || 0.3;
    const newEma = alpha * cappedRawScore + (1 - alpha) * oldEma;
    
    metrics[eyeId] = {
      date,
      eye_id: eyeId,
      eye_name: runtimeEye.name,
      
      // Count metrics
      total_items: items.length,
      unique_items: uniqueItems,
      signal_items: signalItems,
      proposal_yield: proposalYield,
      
      // Rate metrics
      novelty_rate: parseFloat(noveltyRate.toFixed(2)),
      signal_rate: parseFloat(signalRate.toFixed(2)),
      error_rate: parseFloat(errorRate.toFixed(2)),
      
      // Cost metrics
      cost_ms: totalDuration,
      cost_requests: totalRequests,
      cost_bytes: totalBytes,
      
      // Score
      raw_score: parseFloat(cappedRawScore.toFixed(1)),
      score_ema: parseFloat(newEma.toFixed(1)),
      score_ema_previous: parseFloat(oldEma.toFixed(1)),
      is_stub_source: parserType === 'stub',
      reliability_fault: reliabilityFault,
      transport_failure_count: transportFailureCount,

      // Outcome yield signals (windowed)
      yield_window_days: YIELD_WINDOW_DAYS,
      proposed_total: yieldSignals[eyeId] ? yieldSignals[eyeId].proposed_total : 0,
      shipped_total: yieldSignals[eyeId] ? yieldSignals[eyeId].shipped_total : 0,
      yield_rate: parseFloat((yieldSignals[eyeId] ? yieldSignals[eyeId].yield_rate : 0).toFixed(3)),
      yield_confidence: parseFloat(confidence.toFixed(3))
    };
    
    console.log(`📊 ${eyeId}:`);
    console.log(`   Items: ${items.length} (${uniqueItems} unique, ${signalItems} signal)`);
    console.log(`   Rates: novelty=${(noveltyRate*100).toFixed(0)}%, signal=${(signalRate*100).toFixed(0)}%, error=${(errorRate*100).toFixed(0)}%`);
    console.log(`   Cost: ${totalDuration}ms, ${totalRequests} reqs, ${totalBytes} bytes`);
    console.log(`   Score: raw=${cappedRawScore.toFixed(1)}, EMA=${oldEma.toFixed(1)} → ${newEma.toFixed(1)}`);
    if (parserType === 'stub') console.log('   Stub policy: score capped to prevent promotion/cadence acceleration');
    if (reliabilityFault) console.log(`   Reliability policy: transport_fault_count=${transportFailureCount} (quality score held neutral)`);
    if (staleCapApplied) {
      console.log(`   Stale policy: last_success ${lastSuccessHours.toFixed(1)}h ago (cap applied)`);
    }
    if (yieldSignals[eyeId]) {
      console.log(`   Yield(14d): proposed=${yieldSignals[eyeId].proposed_total}, shipped=${yieldSignals[eyeId].shipped_total}, rate=${(yieldSignals[eyeId].yield_rate*100).toFixed(1)}%, conf=${(confidence*100).toFixed(0)}%`);
    }
    console.log('');
  }
  
  // Save metrics
  const metricsPath = path.join(METRICS_DIR, `${date}.json`);
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(`✅ Metrics saved: ${metricsPath}`);
  
  return metrics;
}

// EVOLVE: Update score_ema and adjust cadence/status
function evolve(dateStr) {
  ensureDirs();
  const date = dateStr || getToday();
  const metricsPath = path.join(METRICS_DIR, `${date}.json`);
  
  if (!fs.existsSync(metricsPath)) {
    console.log(`No metrics for ${date}. Run 'score' first.`);
    return null;
  }
  
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const registry = loadRegistry();
  const config = loadConfig();
  
  const OUTCOME_WINDOW_DAYS = 14; // deterministic window for outcomes
  // Compute once per evolve (do NOT recompute per eye)
  const outcomeSignals = computeOutcomeSignals(OUTCOME_WINDOW_DAYS, date);
  const yieldSignals = computeYieldSignals(OUTCOME_WINDOW_DAYS, date);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - EVOLUTION');
  console.log(`   Date: ${date}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  const changes = [];
  
  for (const eyeId in metrics) {
    const m = metrics[eyeId];
    const eyeConfig = config.eyes.find(e => e.id === eyeId);
    if (!eyeConfig) continue;
    
    let regEye = registry.eyes.find(e => e.id === eyeId);
    if (!regEye) {
      regEye = {
        ...eyeConfig,
        run_count: 0,
        total_items: 0,
        total_errors: 0
      };
      registry.eyes.push(regEye);
    }
    const runtimeEye = effectiveEye(eyeConfig, regEye);
    const parserType = String(runtimeEye.parser_type || eyeConfig.parser_type || '').toLowerCase();
    
    // Update EMA in registry
    regEye.score_ema = m.score_ema;

    // Store yield observability (derived)
    const ys = yieldSignals[eyeId] || { proposed_total: 0, shipped_total: 0, yield_rate: 0 };
    regEye.yield_window_days = OUTCOME_WINDOW_DAYS;
    regEye.proposed_total = ys.proposed_total;
    regEye.shipped_total = ys.shipped_total;
    regEye.yield_rate = parseFloat((ys.yield_rate || 0).toFixed(3));

    // Outcome-based adjustment (closed-loop attribution)
    // This uses proposal_queue outcomes tagged with evidence_ref "eye:<id>"
    if (outcomeSignals[eyeId] && outcomeSignals[eyeId].total > 0) {
      const sig = outcomeSignals[eyeId];
      // Apply small deterministic bump/penalty to score_ema
      regEye.score_ema = clamp((regEye.score_ema ?? 50) + sig.delta, 0, 100);
      // Store observability fields (non-authoritative, derived)
      regEye.outcomes_window_days = OUTCOME_WINDOW_DAYS;
      regEye.outcomes_total = sig.total;
      regEye.outcomes_shipped = sig.shipped;
      regEye.outcomes_reverted = sig.reverted;
      regEye.outcomes_no_change = sig.no_change;
      regEye.outcomes_points = sig.points;
      regEye.outcomes_delta = sig.delta;
    } else {
      // still keep fields consistent but don't overwrite historic fields aggressively
      regEye.outcomes_window_days = OUTCOME_WINDOW_DAYS;
      regEye.outcomes_total = regEye.outcomes_total ?? 0;
      regEye.outcomes_delta = 0;
    }

    const oldCadence = runtimeEye.cadence_hours;
    const oldStatus = runtimeEye.status;
    let newCadence = oldCadence;
    let newStatus = oldStatus;
    let reason = '';
    const STUB_MIN_CADENCE_HOURS = Number(process.env.EYES_STUB_MIN_CADENCE_HOURS || 24);
    const RETRY_CADENCE_HOURS = Math.max(1, Number(process.env.EYES_RETRY_CADENCE_HOURS || 6));
    const RETRY_WINDOW_HOURS = Math.max(1, Number(process.env.EYES_RETRY_WINDOW_HOURS || 24));
    const recentTransportFailure = hasRecentTransportFailure(regEye, RETRY_WINDOW_HOURS);

    // Backlog approximation: proposed_total - shipped_total (windowed)
    // Not perfect (doesn't count rejects/done), but enough to prevent runaway cadence decreases.
    const backlogEst = Math.max(0, (ys.proposed_total || 0) - (ys.shipped_total || 0));
    const BACKLOG_THROTTLE = config.scoring.backlog_throttle || 20;

    // Yield thresholds
    const YIELD_LOW = config.scoring.yield_threshold_low || 0.10; // 10%
    const YIELD_MIN_PROPOSED = config.scoring.yield_min_proposed || 10; // only enforce once we have data

    // Evolution rules
    // 0) Stub sources must not accelerate; keep slow cadence and non-active status.
    if (parserType === 'stub') {
      newCadence = Math.max(oldCadence, STUB_MIN_CADENCE_HOURS);
      if (oldStatus === 'active') newStatus = 'probation';
      reason = `Stub source guardrail (min cadence ${STUB_MIN_CADENCE_HOURS}h, no acceleration)`;
    }
    // 0b) Transport failures are reliability faults; force retry cadence instead of low-signal demotion.
    else if (recentTransportFailure) {
      newCadence = Math.min(oldCadence, RETRY_CADENCE_HOURS);
      if (oldStatus === 'dormant') newStatus = 'probation';
      reason = `Reliability retry mode (transport failures within ${RETRY_WINDOW_HOURS}h)`;
    }
    // 1. If score_ema < 20 for 30 days => dormant
    else if (m.score_ema < config.scoring.score_threshold_dormant && regEye.run_count > 30) {
      newStatus = 'dormant';
      newCadence = Math.min(168, config.scoring.cadence_max_hours);
      reason = 'Score < 20 for >30 days';
    }
    // 1b. If yield is low (outcome-weighted) and we have enough volume, slow the eye down
    else if ((ys.proposed_total || 0) >= YIELD_MIN_PROPOSED && (ys.yield_rate || 0) < YIELD_LOW) {
      newCadence = Math.min(oldCadence * 2, config.scoring.cadence_max_hours);
      reason = `Low yield (${(ys.yield_rate*100).toFixed(1)}% < ${(YIELD_LOW*100).toFixed(0)}%) over ${OUTCOME_WINDOW_DAYS}d`;
    }
    // 2. If score_ema < 30 for 14 days => cadence *= 2
    else if (m.score_ema < config.scoring.score_threshold_low && m.raw_score < 30) {
      newCadence = Math.min(oldCadence * 2, config.scoring.cadence_max_hours);
      reason = 'Score < 30 for >14 days';
    }
    // 3. If score_ema > 70 for 14 days => cadence /= 2
    else if (m.score_ema > config.scoring.score_threshold_high && m.raw_score > 70) {
      // Only speed up if backlog is healthy
      if (backlogEst >= BACKLOG_THROTTLE) {
        newCadence = oldCadence; // hold steady
        reason = `High score but backlogEst=${backlogEst} >= ${BACKLOG_THROTTLE} (hold cadence)`;
      } else {
        newCadence = Math.max(oldCadence / 2, config.scoring.cadence_min_hours);
        reason = 'Score > 70 for >14 days';
      }
    }
    
    // Apply changes
    if (newCadence !== oldCadence || newStatus !== oldStatus) {
      regEye.cadence_hours = Math.round(newCadence);
      regEye.status = newStatus;
      
      changes.push({
        eye_id: eyeId,
        old_cadence: oldCadence,
        new_cadence: Math.round(newCadence),
        old_status: oldStatus,
        new_status: newStatus,
        reason
      });
      
      console.log(`🔄 ${eyeId}:`);
      console.log(`   Status: ${oldStatus} → ${newStatus}`);
      console.log(`   Cadence: ${oldCadence}h → ${Math.round(newCadence)}h`);
      console.log(`   Reason: ${reason}`);
      console.log('');
    }
  }
  
  // Persist to registry (config updates are manual for now)
  saveRegistry(registry);
  
  // Write evolution event
  const evolveEvent = {
    ts: new Date().toISOString(),
    type: 'eyes_evolved',
    date,
    changes,
    summary: `${changes.length} eyes adjusted`
  };
  
  const evolvePath = path.join(STATE_DIR, 'evolution.jsonl');
  fs.appendFileSync(evolvePath, JSON.stringify(evolveEvent) + '\n');
  
  if (changes.length === 0) {
    console.log('🟢 No changes needed - all eyes stable');
  }
  
  console.log(`✅ Evolution complete: ${changes.length} eyes adjusted`);
  
  return changes;
}

// LIST: Show all eyes and their status
function list() {
  const config = loadConfig();
  const registry = loadRegistry();
  const outage = ensureOutageModeState(registry);
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EXTERNAL EYES - REGISTRY');
  console.log('═══════════════════════════════════════════════════════════');
  if (outage.active === true) {
    console.log(`🚨 Outage mode ACTIVE since=${String(outage.since || 'unknown').slice(0, 19)} reason=${String(outage.last_reason || 'n/a').slice(0, 80)}`);
  }
  
  config.eyes.forEach(eye => {
    const reg = registry.eyes.find(e => e.id === eye.id);
    const runtimeEye = effectiveEye(eye, reg);
    const totalRuns = Number((reg && reg.total_runs) || (reg && reg.run_count) || 0);
    const totalErrors = Number((reg && reg.total_errors) || 0);
    const boundedErrors = Math.min(Math.max(totalErrors, 0), Math.max(totalRuns, 0));
    const successRate = totalRuns > 0 ? ((totalRuns - boundedErrors) / totalRuns) : 0;
    const lastSuccessHours = hoursSince(reg && reg.last_success);
    const statusEmoji = {
      active: '✅',
      probation: '🔍',
      dormant: '💤',
      retired: '⏹️'
    }[runtimeEye.status] || '⚪';
    
    console.log(`${statusEmoji} ${eye.id} (${runtimeEye.status})`);
    console.log(`   Name: ${eye.name}`);
    console.log(`   Cadence: ${runtimeEye.cadence_hours}h`);
    console.log(`   Score EMA: ${runtimeEye.score_ema.toFixed(1)}`);
    console.log(`   Topics: ${eye.topics?.join(', ') || 'none'}`);
    console.log(`   Runs: ${reg?.run_count || 0}, Items: ${reg?.total_items || 0}`);
    console.log(`   Health: success_rate=${(successRate * 100).toFixed(1)}%, consecutive_failures=${reg?.consecutive_failures || 0}, last_success_h=${lastSuccessHours == null ? 'n/a' : lastSuccessHours.toFixed(1)}`);
    if (reg && reg.last_error_code) {
      console.log(`   Last error: ${reg.last_error_code} ${String(reg.last_error || '').slice(0, 100)}`);
    }
    console.log(`   Budget: ${eye.budgets?.max_items || 'N/A'} items, ${eye.budgets?.max_seconds || 'N/A'}s`);
    console.log('');
  });
  
  console.log('───────────────────────────────────────────────────────────');
  console.log(`Total: ${config.eyes.length} eyes configured`);
  console.log('═══════════════════════════════════════════════════════════');
  
  return config.eyes;
}

function doctor() {
  const config = loadConfig();
  const registry = loadRegistry();
  const outage = ensureOutageModeState(registry);
  const STALE_SUCCESS_HOURS = Number(process.env.EYES_STALE_SUCCESS_HOURS || 24);
  const FAIL_PARK_THRESHOLD = Number(process.env.EYES_FAIL_PARK_THRESHOLD || 3);
  const DARK_RUN_THRESHOLD = Number(process.env.EYES_DARK_RUN_THRESHOLD || 2);
  const report = [];
  const failureCodeCounts = {};
  for (const eye of config.eyes) {
    const reg = registry.eyes.find(e => e.id === eye.id) || {};
    const runtimeEye = effectiveEye(eye, reg);
    const totalRuns = Number(reg.total_runs || reg.run_count || 0);
    const totalErrors = Number(reg.total_errors || 0);
    const boundedErrors = Math.min(Math.max(totalErrors, 0), Math.max(totalRuns, 0));
    const successRate = totalRuns > 0 ? (totalRuns - boundedErrors) / totalRuns : null;
    const lastSuccessHours = hoursSince(reg.last_success);
    const parserType = String(runtimeEye.parser_type || eye.parser_type || '').toLowerCase();
    const reasons = [];
    if (parserType === 'stub') reasons.push('stub_source');
    if (outage.active === true && parserType !== 'stub') reasons.push('infra_outage_active');
    if (Number(reg.consecutive_failures || 0) >= FAIL_PARK_THRESHOLD) reasons.push('consecutive_failures_high');
    if (Number(reg.consecutive_no_signal_runs || 0) >= DARK_RUN_THRESHOLD) reasons.push('no_signal_streak_high');
    if (Number.isFinite(lastSuccessHours) && lastSuccessHours > STALE_SUCCESS_HOURS) reasons.push('last_success_stale');
    if (successRate != null && successRate < 0.5 && totalRuns >= 3) reasons.push('low_success_rate');
    const fallbackFailure = reg.last_error ? normalizeFailure({ message: reg.last_error }) : null;
    const lastErrorCode = String(reg.last_error_code || (fallbackFailure && fallbackFailure.code) || '');
    if (lastErrorCode) {
      failureCodeCounts[lastErrorCode] = (failureCodeCounts[lastErrorCode] || 0) + 1;
      if (isTransportFailureCode(lastErrorCode)) reasons.push(`transport:${lastErrorCode}`);
    }
    report.push({
      eye_id: eye.id,
      status: runtimeEye.status,
      parser_type: parserType,
      total_runs: totalRuns,
      total_errors: totalErrors,
      success_rate: successRate == null ? null : Number(successRate.toFixed(3)),
      consecutive_failures: Number(reg.consecutive_failures || 0),
      consecutive_no_signal_runs: Number(reg.consecutive_no_signal_runs || 0),
      last_success_hours: lastSuccessHours == null ? null : Number(lastSuccessHours.toFixed(2)),
      last_real_signal_ts: reg.last_real_signal_ts || null,
      last_self_heal_ts: reg.last_self_heal_ts || null,
      last_self_heal_result: reg.last_self_heal_result || null,
      self_heal_attempts: Number(reg.self_heal_attempts || 0),
      self_heal_recoveries: Number(reg.self_heal_recoveries || 0),
      last_error_code: lastErrorCode || null,
      last_error: reg.last_error ? String(reg.last_error).slice(0, 160) : null,
      healthy: reasons.length === 0,
      reasons
    });
  }
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    type: 'collector_doctor',
    outage_mode: {
      active: outage.active === true,
      since: outage.since || null,
      until: outage.until || null,
      entered_count: Number(outage.entered_count || 0),
      exited_count: Number(outage.exited_count || 0),
      last_reason: outage.last_reason || null,
      last_failed_transport_eyes: Number(outage.last_failed_transport_eyes || 0),
      last_window_hours: Number(outage.last_window_hours || 0),
      last_min_eyes: Number(outage.last_min_eyes || 0)
    },
    thresholds: {
      stale_success_hours: STALE_SUCCESS_HOURS,
      fail_park_threshold: FAIL_PARK_THRESHOLD
    },
    failure_code_counts: failureCodeCounts,
    report
  }, null, 2) + '\n');
  return report;
}

function temporal(dateStr) {
  const date = dateStr || getToday();
  const report = analyzeTemporalPatterns({
    dateStr: date,
    lookbackDays: Number(process.env.EYES_TEMPORAL_LOOKBACK_DAYS || 7),
    write: true
  });
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    type: 'temporal_patterns',
    date,
    lookback_days: report.lookback_days,
    dark_candidates: Array.isArray(report.dark_candidates) ? report.dark_candidates.length : 0,
    anomalies: Array.isArray(report.anomalies) ? report.anomalies.length : 0,
    trend_path: report.trend_path || null,
    anomaly_path: report.anomaly_path || null
  }, null, 2) + '\n');
  return report;
}

// RECONCILE: Apply config-defined static fields into runtime registry intentionally.
function reconcile() {
  const config = loadConfig();
  const registry = loadRegistry();
  const changes = [];

  for (const eye of config.eyes) {
    let reg = registry.eyes.find(e => e.id === eye.id);
    if (!reg) {
      reg = {
        id: eye.id,
        status: eye.status || 'probation',
        cadence_hours: eye.cadence_hours || 24,
        score_ema: 50,
        run_count: 0,
        total_items: 0,
        total_errors: 0,
        total_runs: 0
      };
      registry.eyes.push(reg);
      changes.push({ eye_id: eye.id, field: 'create', from: null, to: 'created' });
    }

    const staticFields = [
      'name',
      'status',
      'cadence_hours',
      'parser_type',
      'probation_days',
      'domains',
      'topics',
      'budgets'
    ];

    for (const field of staticFields) {
      const nextVal = eye[field];
      if (typeof nextVal === 'undefined') continue;
      const prevVal = reg[field];
      if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
        reg[field] = nextVal;
        changes.push({ eye_id: eye.id, field, from: prevVal, to: nextVal });
      }
    }
  }

  saveRegistry(registry);
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    type: 'collector_reconcile',
    changes_count: changes.length,
    changes
  }, null, 2) + '\n');
  return changes;
}

// PROPOSE: Create a new eye proposal
function propose(name, domain, notes) {
  ensureDirs();
  
  if (!name || !domain) {
    console.error('Usage: propose "<name>" "<domain>" "<notes>"');
    return null;
  }
  
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
  const date = getToday();
  
  const proposal = {
    id: `proto_${id}`,
    name,
    proposed_domains: [domain],
    notes,
    proposed_status: 'probation',
    proposed_cadence_hours: 24,
    proposed_budgets: {
      max_items: 10,
      max_seconds: 30,
      max_bytes: 1048576,
      max_requests: 3
    },
    proposed_topics: [],
    proposed_date: date,
    proposed_by: 'external_eyes.js propose',
    status: 'pending_review'
  };
  
  const proposalPath = path.join(PROPOSALS_DIR, `${date}.json`);
  let proposals = [];
  if (fs.existsSync(proposalPath)) {
    proposals = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
  }
  
  proposals.push(proposal);
  fs.writeFileSync(proposalPath, JSON.stringify(proposals, null, 2));
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   EYE PROPOSAL CREATED');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`ID: ${proposal.id}`);
  console.log(`Name: ${name}`);
  console.log(`Domain: ${domain}`);
  console.log(`Status: pending_review`);
  console.log(`File: ${proposalPath}`);
  console.log('');
  console.log('⏭️  Next: Review proposal and add to the eyes catalog through eyes_intake');
  console.log('═══════════════════════════════════════════════════════════');
  
  return proposal;
}

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = {};
  const positional = [];
  
  for (const arg of args.slice(1)) {
    if (arg.startsWith('--eye=')) {
      opts.eye = arg.slice(6);
    } else if (arg.startsWith('--max-eyes=')) {
      opts.maxEyes = parseInt(arg.slice(11), 10);
    } else if (arg === '--strict') {
      opts.strict = true;
    } else if (arg === '--network' || arg === '--network=1') {
      opts.network = true;
    } else if (arg.startsWith('--')) {
      // Other flags
    } else if (!arg.startsWith('-') && positional.length < 3) {
      positional.push(arg);
    }
  }
  
  return { cmd, opts, positional };
}

// Main
async function main() {
  const { cmd, opts, positional } = parseArgs();
  
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('external_eyes.js v1.0 - External Eyes Framework');
    console.log('');
    console.log('Commands:');
    console.log('  run [--eye=<id>] [--max-eyes=N]       Run eligible eyes');
    console.log('  preflight [--strict]                  Collector prerequisite/transport preflight');
    console.log('  canary [--eye=<id>]                   Force one non-stub collector run');
    console.log('  canary-signal [--eye=<id>]            Force one healthy non-stub collector run');
    console.log('  slo [YYYY-MM-DD]                      Signal SLO check (strict, exits non-zero on failure)');
    console.log('  score [YYYY-MM-DD]                    Compute usefulness metrics');
    console.log('  evolve [YYYY-MM-DD]                   Adjust cadence/status based on scores');
    console.log('  temporal [YYYY-MM-DD]                 Analyze temporal signal trends + dark eyes');
    console.log('  list                                  Show all eyes and status');
    console.log('  doctor                                Collector reliability health report');
    console.log('  reconcile                             Apply config static fields to registry');
    console.log('  propose "<name>" "<domain>" "<notes>"  Propose new eye (requires manual review)');
    console.log('');
    console.log('Constraints:');
    console.log('  - Budgets enforced (max_items, max_seconds, max_bytes, max_requests)');
    console.log('  - Domain allowlisting required');
    console.log('  - Probation status for new eyes');
    console.log('  - Deterministic scoring, NO LLM required');
    return;
  }
  
  switch (cmd) {
    case 'run':
      await run(opts);
      break;
    case 'preflight': {
      const rep = await preflight(opts);
      if (opts.strict && rep && rep.ok !== true) process.exit(2);
      break;
    }
    case 'canary':
      await canary(opts);
      break;
    case 'canary-signal':
      await canarySignal(opts);
      break;
    case 'slo': {
      const res = signalSlo(positional[0] || null);
      if (!res.ok) process.exit(2);
      break;
    }
    case 'score':
      score(positional[0] || null);
      break;
    case 'evolve':
      evolve(positional[0] || null);
      break;
    case 'list':
      list();
      break;
    case 'temporal':
      temporal(positional[0] || null);
      break;
    case 'doctor':
      doctor();
      break;
    case 'reconcile':
      reconcile();
      break;
    case 'propose':
      if (positional.length < 2) {
        console.error('Usage: propose "<name>" "<domain>" ["<notes>"]');
        process.exit(1);
      }
      propose(positional[0], positional[1], positional[2] || '');
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

// Export for testing
module.exports = {
  run,
  preflight,
  canary,
  canarySignal,
  signalSlo,
  score,
  evolve,
  list,
  doctor,
  temporal,
  reconcile,
  propose,
  loadConfig,
  loadRegistry,
  saveRegistry,
  isDomainAllowed,
  computeHash,
  computeOutcomeSignals,
  ensureDirs,
  safeReadJsonl,
  computeYieldSignals,
  resolveInfrastructureOutageProposals
};

// Run if called directly
if (require.main === module) {
  main();
}
