#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  buildTrainingConduitMetadata,
  validateTrainingConduitMetadata,
  loadTrainingConduitPolicy
} = require('../../lib/training_conduit_schema');
const {
  loadTrainabilityMatrixPolicy,
  evaluateTrainingDatumTrainability
} = require('../../lib/trainability_matrix');
const {
  loadRedactionClassificationPolicy,
  classifyTrainingDatum
} = require('../../lib/redaction_classification');
let recordTrainingDatumProvenance = null;
try {
  ({ recordTrainingDatumProvenance } = require('./data_rights_engine'));
} catch {
  recordTrainingDatumProvenance = null;
}

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.LEARNING_CONDUIT_POLICY_PATH
  ? path.resolve(process.env.LEARNING_CONDUIT_POLICY_PATH)
  : path.join(ROOT, 'config', 'learning_conduit_policy.json');
const STATE_PATH = process.env.LEARNING_CONDUIT_STATE_PATH
  ? path.resolve(process.env.LEARNING_CONDUIT_STATE_PATH)
  : path.join(ROOT, 'state', 'workflow', 'learning_conduit', 'state.json');
const RECEIPTS_PATH = process.env.LEARNING_CONDUIT_RECEIPTS_PATH
  ? path.resolve(process.env.LEARNING_CONDUIT_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'workflow', 'learning_conduit', 'receipts.jsonl');
const LATEST_PATH = process.env.LEARNING_CONDUIT_LATEST_PATH
  ? path.resolve(process.env.LEARNING_CONDUIT_LATEST_PATH)
  : path.join(ROOT, 'state', 'workflow', 'learning_conduit', 'latest.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
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
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
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
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
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

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function hash10(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    proposal_only: true,
    metadata_strict: true,
    trainability_strict: true,
    require_explicit_consent: true,
    queue_paths: {
      pending_queue: 'state/nursery/training/workflow_learning_queue.jsonl',
      canary_queue: 'state/nursery/training/workflow_learning_canary.jsonl',
      master_queue: 'state/nursery/training/continuum_queue.jsonl'
    },
    canary: {
      required: true,
      min_score: 0.75
    },
    redaction_classification: {
      enabled: true,
      strict_block: true,
      policy_path: 'config/redaction_classification_policy.json'
    },
    defaults: {
      owner_id: 'workflow_operator',
      owner_type: 'human_operator',
      license_id: 'internal_protheus',
      consent_status: 'granted',
      consent_mode: 'explicit_opt_in',
      consent_evidence_ref: 'config/training_conduit_policy.json',
      retention_days: 365,
      delete_scope: 'workflow_learning_conduit'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const queuePaths = raw.queue_paths && typeof raw.queue_paths === 'object' ? raw.queue_paths : {};
  const canary = raw.canary && typeof raw.canary === 'object' ? raw.canary : {};
  const redaction = raw.redaction_classification && typeof raw.redaction_classification === 'object'
    ? raw.redaction_classification
    : {};
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    proposal_only: raw.proposal_only !== false,
    metadata_strict: raw.metadata_strict !== false,
    trainability_strict: raw.trainability_strict !== false,
    require_explicit_consent: raw.require_explicit_consent !== false,
    queue_paths: {
      pending_queue: cleanText(queuePaths.pending_queue || base.queue_paths.pending_queue, 260) || base.queue_paths.pending_queue,
      canary_queue: cleanText(queuePaths.canary_queue || base.queue_paths.canary_queue, 260) || base.queue_paths.canary_queue,
      master_queue: cleanText(queuePaths.master_queue || base.queue_paths.master_queue, 260) || base.queue_paths.master_queue
    },
    canary: {
      required: canary.required !== false,
      min_score: Number.isFinite(Number(canary.min_score))
        ? Math.max(0, Math.min(1, Number(canary.min_score)))
        : base.canary.min_score
    },
    redaction_classification: {
      enabled: redaction.enabled !== false,
      strict_block: redaction.strict_block !== false,
      policy_path: cleanText(
        redaction.policy_path || base.redaction_classification.policy_path,
        260
      ) || base.redaction_classification.policy_path
    },
    defaults: {
      owner_id: normalizeToken(defaults.owner_id || base.defaults.owner_id, 120) || base.defaults.owner_id,
      owner_type: normalizeToken(defaults.owner_type || base.defaults.owner_type, 80) || base.defaults.owner_type,
      license_id: normalizeToken(defaults.license_id || base.defaults.license_id, 160) || base.defaults.license_id,
      consent_status: normalizeToken(defaults.consent_status || base.defaults.consent_status, 40) || base.defaults.consent_status,
      consent_mode: normalizeToken(defaults.consent_mode || base.defaults.consent_mode, 80) || base.defaults.consent_mode,
      consent_evidence_ref: cleanText(defaults.consent_evidence_ref || base.defaults.consent_evidence_ref, 260) || base.defaults.consent_evidence_ref,
      retention_days: clampInt(defaults.retention_days, 1, 3650, base.defaults.retention_days),
      delete_scope: normalizeToken(defaults.delete_scope || base.defaults.delete_scope, 120) || base.defaults.delete_scope
    }
  };
}

function resolveQueuePath(raw: string) {
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(ROOT, raw);
}

function defaultState() {
  return {
    schema_id: 'workflow_learning_conduit_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    entries: {}
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'workflow_learning_conduit_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    entries: src.entries && typeof src.entries === 'object' ? src.entries : {}
  };
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'workflow_learning_conduit_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    entries: state && state.entries && typeof state.entries === 'object' ? state.entries : {}
  });
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/learning_conduit.js ingest [--run-payload=path] [--consent-status=granted] [--consent-mode=explicit_opt_in]');
  console.log('  node systems/workflow/learning_conduit.js promote --entry-id=<id> [--canary-pass=1] [--canary-score=0.8] [--apply=1]');
  console.log('  node systems/workflow/learning_conduit.js status [--entry-id=<id>]');
}

function loadRunPayload(args: AnyObj) {
  const explicit = cleanText(args.run_payload || args['run-payload'] || '', 300);
  const runPath = explicit
    ? path.resolve(explicit)
    : path.join(ROOT, 'state', 'adaptive', 'workflows', 'executor', 'latest.json');
  const payload = readJson(runPath, null);
  return {
    run_path: runPath,
    payload
  };
}

function deriveMetadataClassification(redaction: AnyObj) {
  const categories = Array.isArray(redaction && redaction.categories) ? redaction.categories : [];
  const set = new Set(categories.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean));
  if (set.has('secret')) return 'restricted_secret';
  if (set.has('license_sensitive')) return 'license_sensitive';
  if (set.has('pii')) return 'sensitive_pii';
  return 'internal_runtime';
}

function buildQueueRows(policy: AnyObj, runPayload: AnyObj, args: AnyObj) {
  const results = Array.isArray(runPayload && runPayload.results) ? runPayload.results : [];
  const trainabilityPolicy = loadTrainabilityMatrixPolicy();
  const conduitPolicy = loadTrainingConduitPolicy();
  const redactionCfg = policy && policy.redaction_classification && typeof policy.redaction_classification === 'object'
    ? policy.redaction_classification
    : {};
  const redactionPolicyPath = cleanText(redactionCfg.policy_path || '', 260);
  const redactionPolicy = loadRedactionClassificationPolicy(
    redactionPolicyPath
      ? path.resolve(ROOT, redactionPolicyPath)
      : undefined
  );
  const redactionSummary: AnyObj = {
    enabled: redactionCfg.enabled === true,
    rows_scanned: 0,
    redacted_rows: 0,
    blocked_rows: 0,
    findings_total: 0,
    categories: {}
  };
  const rows: AnyObj[] = [];
  const rejected: AnyObj[] = [];

  for (const row of results) {
    const workflowId = normalizeToken(row && row.workflow_id || 'unknown', 120) || 'unknown';
    const entryId = `lq_${hash10(`${runPayload.run_id || 'run'}|${workflowId}|${row.status || 'unknown'}`)}`;
    const redaction = redactionCfg.enabled === true
      ? classifyTrainingDatum({
          workflow_id: workflowId,
          workflow_status: cleanText(row && row.status || 'unknown', 40) || 'unknown',
          failure_reason: cleanText(row && row.failure_reason || '', 400) || '',
          message: cleanText(row && row.message || '', 400) || '',
          reason: cleanText(row && row.reason || '', 400) || '',
          step_results: Array.isArray(row && row.step_results)
            ? row.step_results.map((step: AnyObj) => ({
                error: cleanText(step && step.error || '', 300),
                stderr: cleanText(step && step.stderr || '', 300),
                stdout: cleanText(step && step.stdout || '', 300),
                reason: cleanText(step && step.reason || '', 220),
                command: cleanText(step && step.command || '', 220)
              }))
            : []
        }, redactionPolicy)
      : {
          enabled: false,
          blocked: false,
          redacted: false,
          categories: [],
          findings: [],
          sanitized_text: '',
          evidence: null
        };
    if (redactionCfg.enabled === true) {
      redactionSummary.rows_scanned += 1;
      if (redaction && redaction.redacted === true) redactionSummary.redacted_rows += 1;
      if (redaction && redaction.blocked === true) redactionSummary.blocked_rows += 1;
      const findings = Array.isArray(redaction && redaction.findings) ? redaction.findings : [];
      redactionSummary.findings_total += findings.reduce((sum: number, finding: AnyObj) => (
        sum + Number(finding && finding.match_count || 0)
      ), 0);
      for (const category of Array.isArray(redaction && redaction.categories) ? redaction.categories : []) {
        const token = normalizeToken(category, 80) || 'general';
        redactionSummary.categories[token] = Number(redactionSummary.categories[token] || 0) + 1;
      }
    }
    const metadataClassification = deriveMetadataClassification(redaction);
    const metadata = buildTrainingConduitMetadata({
      ts: nowIso(),
      source_system: 'workflow_executor',
      source_channel: 'workflow_outcome',
      source_path: relPath(path.join(ROOT, 'state', 'adaptive', 'workflows', 'executor', 'latest.json')),
      datum_id: `${runPayload.run_id || 'run'}:${workflowId}`,
      provider: 'internal',
      owner_id: policy.defaults.owner_id,
      owner_type: policy.defaults.owner_type,
      license_id: policy.defaults.license_id,
      consent_status: cleanText(args.consent_status || args['consent-status'] || policy.defaults.consent_status, 40),
      consent_mode: cleanText(args.consent_mode || args['consent-mode'] || policy.defaults.consent_mode, 80),
      consent_evidence_ref: cleanText(args.consent_evidence_ref || args['consent-evidence-ref'] || policy.defaults.consent_evidence_ref, 260),
      retention_days: policy.defaults.retention_days,
      delete_scope: policy.defaults.delete_scope,
      delete_key: `${runPayload.run_id || 'run'}:${workflowId}`,
      classification: metadataClassification
    }, conduitPolicy);
    const validation = validateTrainingConduitMetadata(metadata, conduitPolicy);
    const trainability = evaluateTrainingDatumTrainability(metadata, trainabilityPolicy);
    const consentGranted = String(metadata && metadata.consent && metadata.consent.status || '').toLowerCase() === 'granted';

    const reasons: string[] = [];
    if (policy.metadata_strict && validation.ok !== true) reasons.push('metadata_validation_failed');
    if (policy.trainability_strict && trainability.allow !== true) reasons.push('trainability_rejected');
    if (policy.require_explicit_consent && !consentGranted) reasons.push('consent_not_granted');
    if (redactionCfg.enabled === true && redactionCfg.strict_block === true && redaction && redaction.blocked === true) {
      reasons.push('sensitive_content_blocked');
    }

    const queueRow = {
      entry_id: entryId,
      ts: nowIso(),
      source_run_id: cleanText(runPayload.run_id || '', 120) || null,
      workflow_id: workflowId,
      workflow_status: cleanText(row && row.status || 'unknown', 40) || 'unknown',
      failure_reason: cleanText(row && row.failure_reason || '', 180) || null,
      mutation_applied: Number(row && row.mutation_summary && row.mutation_summary.applied || 0) > 0,
      learning_signal: {
        succeeded: row && row.ok === true,
        blocked: row && row.blocked_by_gate === true,
        duration_ms: Number(row && row.duration_ms || 0)
      },
      learning_text: cleanText(redaction && redaction.sanitized_text || '', 1600) || null,
      redaction: {
        enabled: redactionCfg.enabled === true,
        blocked: redaction && redaction.blocked === true,
        redacted: redaction && redaction.redacted === true,
        categories: Array.isArray(redaction && redaction.categories) ? redaction.categories : [],
        findings: Array.isArray(redaction && redaction.findings) ? redaction.findings : [],
        evidence: redaction && redaction.evidence && typeof redaction.evidence === 'object'
          ? redaction.evidence
          : null
      },
      training_conduit: metadata,
      trainability,
      stage: reasons.length ? 'rejected' : 'pending_canary',
      reasons
    };

    if (reasons.length) rejected.push(queueRow);
    else rows.push(queueRow);
  }

  return { rows, rejected, redaction_summary: redactionSummary };
}

function cmdIngest(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'learning_conduit_ingest', error: 'learning_conduit_disabled' })}\n`);
    process.exit(1);
  }

  const { run_path, payload } = loadRunPayload(args);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'learning_conduit_ingest', error: 'workflow_run_payload_not_found', run_path: relPath(run_path) })}\n`);
    process.exit(1);
  }

  const state = loadState();
  const pendingQueuePath = resolveQueuePath(policy.queue_paths.pending_queue);
  const canaryQueuePath = resolveQueuePath(policy.queue_paths.canary_queue);
  const built = buildQueueRows(policy, payload, args);
  let rightsEventsWritten = 0;

  for (const row of built.rows) {
    appendJsonl(pendingQueuePath, row);
    appendJsonl(canaryQueuePath, row);
    state.entries[row.entry_id] = row;
    if (typeof recordTrainingDatumProvenance === 'function') {
      try {
        const rightsOut = recordTrainingDatumProvenance(row.training_conduit, {
          event: 'learning_conduit_ingest',
          context: {
            entry_id: row.entry_id,
            queue_stage: 'pending_canary',
            workflow_status: row.workflow_status
          }
        });
        if (rightsOut && rightsOut.ok === true) rightsEventsWritten += 1;
      } catch {
        // Rights engine is best-effort for compatibility.
      }
    }
  }
  for (const row of built.rejected) {
    state.entries[row.entry_id] = row;
    if (typeof recordTrainingDatumProvenance === 'function') {
      try {
        const rightsOut = recordTrainingDatumProvenance(row.training_conduit, {
          event: 'learning_conduit_ingest_rejected',
          context: {
            entry_id: row.entry_id,
            queue_stage: 'rejected',
            reasons: Array.isArray(row.reasons) ? row.reasons : []
          }
        });
        if (rightsOut && rightsOut.ok === true) rightsEventsWritten += 1;
      } catch {
        // Rights engine is best-effort for compatibility.
      }
    }
  }
  saveState(state);

  const out = {
    ok: true,
    type: 'learning_conduit_ingest',
    ts: nowIso(),
    run_id: cleanText(payload.run_id || '', 120) || null,
    ingested: built.rows.length,
    rejected: built.rejected.length,
    rights_events_written: rightsEventsWritten,
    pending_queue_path: relPath(pendingQueuePath),
    canary_queue_path: relPath(canaryQueuePath),
    redaction_summary: built && built.redaction_summary && typeof built.redaction_summary === 'object'
      ? built.redaction_summary
      : null,
    proposal_only: policy.proposal_only === true
  };
  writeJsonAtomic(LATEST_PATH, out);
  appendJsonl(RECEIPTS_PATH, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdPromote(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const entryId = normalizeToken(args.entry_id || args['entry-id'] || '', 120);
  const row = entryId ? state.entries[entryId] : null;
  if (!row) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'learning_conduit_promote', error: 'entry_not_found' })}\n`);
    process.exit(1);
  }
  const canaryPass = toBool(args.canary_pass != null ? args.canary_pass : args['canary-pass'], false);
  const canaryScore = Number.isFinite(Number(args.canary_score != null ? args.canary_score : args['canary-score']))
    ? Number(args.canary_score != null ? args.canary_score : args['canary-score'])
    : 0;
  const apply = toBool(args.apply, false);
  const blocked: string[] = [];
  if (policy.canary.required === true && !canaryPass) blocked.push('canary_pass_required');
  if (policy.canary.required === true && canaryScore < Number(policy.canary.min_score || 0)) blocked.push('canary_score_below_min');
  if (row.stage === 'rejected') blocked.push('entry_rejected_at_ingest');
  if (apply !== true) blocked.push('apply_disabled');

  const masterQueuePath = resolveQueuePath(policy.queue_paths.master_queue);
  if (!blocked.length) {
    const promotedRow = {
      ...row,
      stage: 'promoted',
      promoted_at: nowIso(),
      canary: {
        passed: true,
        score: canaryScore
      }
    };
    appendJsonl(masterQueuePath, promotedRow);
    state.entries[entryId] = promotedRow;
    saveState(state);
  }

  const out = {
    ok: blocked.length === 0,
    type: 'learning_conduit_promote',
    ts: nowIso(),
    entry_id: entryId,
    canary_pass: canaryPass,
    canary_score: canaryScore,
    blocked,
    master_queue_path: relPath(masterQueuePath)
  };
  writeJsonAtomic(LATEST_PATH, out);
  appendJsonl(RECEIPTS_PATH, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (blocked.length) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const state = loadState();
  const entryId = normalizeToken(args.entry_id || args['entry-id'] || '', 120);
  if (entryId) {
    process.stdout.write(`${JSON.stringify({ ok: true, type: 'learning_conduit_status', entry_id: entryId, entry: state.entries[entryId] || null })}\n`);
    return;
  }
  const rows = Object.values(state.entries || {});
  const counts = {
    total: rows.length,
    pending_canary: rows.filter((row: any) => row && row.stage === 'pending_canary').length,
    rejected: rows.filter((row: any) => row && row.stage === 'rejected').length,
    promoted: rows.filter((row: any) => row && row.stage === 'promoted').length
  };
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'learning_conduit_status', counts })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'ingest') return cmdIngest(args);
  if (cmd === 'promote') return cmdPromote(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
