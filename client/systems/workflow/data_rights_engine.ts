#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/workflow/data_rights_engine.js
 *
 * V2-060: consent, provenance, and data-rights engine.
 *
 * Responsibilities:
 * - Signed provenance receipts for ingested training artifacts.
 * - Consent revocation queue with bounded SLA metadata.
 * - Deterministic unlearning propagation across training queues/checkpoints.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  evaluateAccess,
  buildAccessContext
} = require('../security/enterprise_access_gate');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.DATA_RIGHTS_POLICY_PATH
  ? path.resolve(process.env.DATA_RIGHTS_POLICY_PATH)
  : path.join(ROOT, 'config', 'data_rights_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 140) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
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
  for (const token of argv) {
    const raw = String(token || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonlAtomic(filePath: string, rows: AnyObj[]) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  fs.renameSync(tmp, filePath);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function sha12(seed: string) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function signReceipt(payload: AnyObj, policy: AnyObj) {
  const signing = policy && policy.signing && typeof policy.signing === 'object'
    ? policy.signing
    : {};
  const keyId = cleanText(signing.key_id || 'local_dev', 80) || 'local_dev';
  const secretFromEnv = cleanText(process.env[String(signing.key_env || '')] || '', 500);
  const secretFallback = cleanText(signing.dev_fallback_key || 'data_rights_dev_key', 500);
  const secret = secretFromEnv || secretFallback;
  const body = stableStringify(payload);
  return {
    key_id: keyId,
    signature: crypto
      .createHash('sha256')
      .update(`${secret}|${body}`, 'utf8')
      .digest('hex')
  };
}

function runtimePaths(policyPath: string, policy: AnyObj) {
  const stateDir = process.env.DATA_RIGHTS_STATE_DIR
    ? path.resolve(process.env.DATA_RIGHTS_STATE_DIR)
    : path.join(ROOT, 'state', 'workflow', 'data_rights');
  const queuePaths = policy && policy.queue_paths && typeof policy.queue_paths === 'object'
    ? policy.queue_paths
    : {};
  const resolvePath = (raw: unknown, fallback: string) => {
    const txt = cleanText(raw || fallback, 280);
    if (path.isAbsolute(txt)) return txt;
    return path.join(ROOT, txt);
  };
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    provenance_path: path.join(stateDir, 'provenance.jsonl'),
    rights_events_path: path.join(stateDir, 'rights_events.jsonl'),
    receipts_path: path.join(stateDir, 'receipts.jsonl'),
    latest_path: path.join(stateDir, 'latest.json'),
    queue_state_path: path.join(stateDir, 'revocation_queue.json'),
    unlearning_queue_path: path.join(stateDir, 'unlearning_queue.jsonl'),
    pending_queue_path: resolvePath(queuePaths.pending_queue, 'state/nursery/training/workflow_learning_queue.jsonl'),
    canary_queue_path: resolvePath(queuePaths.canary_queue, 'state/nursery/training/workflow_learning_canary.jsonl'),
    master_queue_path: resolvePath(queuePaths.master_queue, 'state/nursery/training/continuum_queue.jsonl'),
    checkpoints_index_path: resolvePath(
      policy && policy.checkpoints_index_path,
      'state/nursery/training/checkpoints/index.json'
    ),
    datasets_dir_path: resolvePath(
      policy && policy.datasets_dir_path,
      'state/nursery/training/datasets'
    ),
    quarantine_state_path: resolvePath(
      policy && policy.quarantine_state_path,
      'state/nursery/training/quarantine_state.json'
    )
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    sla_hours: 24,
    signing: {
      key_id: 'local_dev',
      key_env: 'DATA_RIGHTS_SIGNING_KEY',
      dev_fallback_key: 'data_rights_dev_key'
    },
    queue_paths: {
      pending_queue: 'state/nursery/training/workflow_learning_queue.jsonl',
      canary_queue: 'state/nursery/training/workflow_learning_canary.jsonl',
      master_queue: 'state/nursery/training/continuum_queue.jsonl'
    },
    checkpoints_index_path: 'state/nursery/training/checkpoints/index.json',
    datasets_dir_path: 'state/nursery/training/datasets',
    quarantine_state_path: 'state/nursery/training/quarantine_state.json',
    defaults: {
      owner_id: 'local_operator',
      classification: 'internal'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const signing = raw.signing && typeof raw.signing === 'object' ? raw.signing : {};
  const queuePaths = raw.queue_paths && typeof raw.queue_paths === 'object' ? raw.queue_paths : {};
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    sla_hours: clampInt(raw.sla_hours, 1, 24 * 365, base.sla_hours),
    signing: {
      key_id: cleanText(signing.key_id || base.signing.key_id, 80) || base.signing.key_id,
      key_env: cleanText(signing.key_env || base.signing.key_env, 120) || base.signing.key_env,
      dev_fallback_key: cleanText(signing.dev_fallback_key || base.signing.dev_fallback_key, 500)
        || base.signing.dev_fallback_key
    },
    queue_paths: {
      pending_queue: cleanText(queuePaths.pending_queue || base.queue_paths.pending_queue, 280),
      canary_queue: cleanText(queuePaths.canary_queue || base.queue_paths.canary_queue, 280),
      master_queue: cleanText(queuePaths.master_queue || base.queue_paths.master_queue, 280)
    },
    checkpoints_index_path: cleanText(raw.checkpoints_index_path || base.checkpoints_index_path, 280),
    datasets_dir_path: cleanText(raw.datasets_dir_path || base.datasets_dir_path, 280),
    quarantine_state_path: cleanText(raw.quarantine_state_path || base.quarantine_state_path, 280),
    defaults: {
      owner_id: normalizeToken(defaults.owner_id || base.defaults.owner_id, 120) || base.defaults.owner_id,
      classification: normalizeToken(defaults.classification || base.defaults.classification, 80)
        || base.defaults.classification
    }
  };
}

function loadQueueState(filePath: string) {
  const src = readJson(filePath, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'data_rights_revocation_queue',
      schema_version: '1.0',
      updated_at: nowIso(),
      requests: []
    };
  }
  return {
    schema_id: 'data_rights_revocation_queue',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    requests: Array.isArray(src.requests) ? src.requests : []
  };
}

function saveQueueState(filePath: string, state: AnyObj) {
  writeJsonAtomic(filePath, {
    schema_id: 'data_rights_revocation_queue',
    schema_version: '1.0',
    updated_at: nowIso(),
    requests: Array.isArray(state && state.requests) ? state.requests : []
  });
}

function getDeleteKey(row: AnyObj) {
  return normalizeToken(
    row
    && ((row.training_conduit && row.training_conduit.delete && row.training_conduit.delete.key)
      || (row.delete && row.delete.key)
      || row.delete_key
      || row.deleteKey),
    220
  ) || null;
}

function recordSignedEvent(paths: AnyObj, policy: AnyObj, type: string, payload: AnyObj = {}) {
  const baseEvent = {
    ts: nowIso(),
    type,
    policy_version: policy.version,
    ...payload
  };
  const signature = signReceipt(baseEvent, policy);
  const row = {
    ...baseEvent,
    signature
  };
  appendJsonl(paths.rights_events_path, row);
  appendJsonl(paths.receipts_path, row);
  return row;
}

function recordTrainingDatumProvenance(metadata: AnyObj, options: AnyObj = {}) {
  const policyPath = path.resolve(String(options.policy_path || process.env.DATA_RIGHTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  if (policy.enabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: 'policy_disabled'
    };
  }
  const source = metadata && metadata.source && typeof metadata.source === 'object'
    ? metadata.source
    : {};
  const owner = metadata && metadata.owner && typeof metadata.owner === 'object'
    ? metadata.owner
    : {};
  const consent = metadata && metadata.consent && typeof metadata.consent === 'object'
    ? metadata.consent
    : {};
  const deletion = metadata && metadata.delete && typeof metadata.delete === 'object'
    ? metadata.delete
    : {};
  const provenanceRow = {
    ts: nowIso(),
    event: normalizeToken(options.event || 'ingest', 80) || 'ingest',
    datum_id: normalizeToken(source.datum_id || options.datum_id || '', 220) || `datum_${sha12(nowIso())}`,
    source_system: normalizeToken(source.system || options.source_system || 'unknown', 120) || 'unknown',
    source_channel: normalizeToken(source.channel || options.source_channel || 'unknown', 120) || 'unknown',
    source_path: cleanText(source.path || options.source_path || '', 320) || null,
    owner_id: normalizeToken(owner.id || options.owner_id || policy.defaults.owner_id, 120) || policy.defaults.owner_id,
    license_id: normalizeToken(
      metadata && metadata.license && metadata.license.id || options.license_id || 'unknown',
      160
    ) || 'unknown',
    consent_status: normalizeToken(consent.status || options.consent_status || 'unknown', 40) || 'unknown',
    consent_mode: normalizeToken(consent.mode || options.consent_mode || 'unknown', 80) || 'unknown',
    classification: normalizeToken(metadata && metadata.classification || options.classification || policy.defaults.classification, 80)
      || policy.defaults.classification,
    delete_key: normalizeToken(deletion.key || options.delete_key || '', 220) || null,
    context: options.context && typeof options.context === 'object'
      ? options.context
      : {}
  };
  appendJsonl(paths.provenance_path, provenanceRow);
  const event = recordSignedEvent(paths, policy, 'data_rights_provenance_recorded', {
    datum_id: provenanceRow.datum_id,
    delete_key: provenanceRow.delete_key,
    source_system: provenanceRow.source_system,
    source_channel: provenanceRow.source_channel,
    consent_status: provenanceRow.consent_status,
    classification: provenanceRow.classification
  });
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'data_rights_ingest',
    ts: nowIso(),
    datum_id: provenanceRow.datum_id,
    delete_key: provenanceRow.delete_key,
    event_id: `dre_${sha12(stableStringify(event))}`
  });
  return {
    ok: true,
    provenance: provenanceRow,
    event
  };
}

function cmdIngest(args: AnyObj) {
  const metadata = {
    source: {
      datum_id: args['datum-id'] || args.datum_id || '',
      system: args['source-system'] || args.source_system || 'manual',
      channel: args['source-channel'] || args.source_channel || 'manual',
      path: args['source-path'] || args.source_path || ''
    },
    owner: {
      id: args['owner-id'] || args.owner_id || ''
    },
    license: {
      id: args['license-id'] || args.license_id || 'unknown'
    },
    consent: {
      status: args['consent-status'] || args.consent_status || 'unknown',
      mode: args['consent-mode'] || args.consent_mode || 'unknown'
    },
    delete: {
      key: args['delete-key'] || args.delete_key || ''
    },
    classification: args.classification || 'internal'
  };
  const result = recordTrainingDatumProvenance(metadata, {
    event: args.event || 'manual_ingest',
    context: {
      source: 'data_rights_engine_cli'
    }
  });
  return {
    ok: true,
    type: 'data_rights_ingest',
    ts: nowIso(),
    datum_id: result.provenance.datum_id,
    delete_key: result.provenance.delete_key
  };
}

function cmdRevoke(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.DATA_RIGHTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'data_rights_revoke',
      error: 'policy_disabled'
    };
  }
  const deleteKey = normalizeToken(args['delete-key'] || args.delete_key || '', 220);
  if (!deleteKey) {
    return {
      ok: false,
      type: 'data_rights_revoke',
      error: 'delete_key_required'
    };
  }
  const now = nowIso();
  const requestId = `drq_${sha12(`${deleteKey}|${now}|${Math.random()}`)}`;
  const deadline = new Date(Date.now() + (Number(policy.sla_hours || 24) * 60 * 60 * 1000)).toISOString();
  const queueState = loadQueueState(paths.queue_state_path);
  const request = {
    request_id: requestId,
    ts: now,
    delete_key: deleteKey,
    owner_id: normalizeToken(args['owner-id'] || args.owner_id || policy.defaults.owner_id, 120) || policy.defaults.owner_id,
    reason: cleanText(args.reason || 'consent_revoked', 280) || 'consent_revoked',
    scope: normalizeToken(args.scope || 'training_conduit', 120) || 'training_conduit',
    status: 'pending',
    deadline_ts: deadline
  };
  queueState.requests.push(request);
  saveQueueState(paths.queue_state_path, queueState);
  const event = recordSignedEvent(paths, policy, 'data_rights_consent_revoked', {
    request_id: requestId,
    delete_key: deleteKey,
    owner_id: request.owner_id,
    reason: request.reason,
    deadline_ts: deadline
  });
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'data_rights_revoke',
    ts: now,
    request_id: requestId,
    delete_key: deleteKey,
    deadline_ts: deadline,
    signature: event.signature
  });
  return {
    ok: true,
    type: 'data_rights_revoke',
    ts: now,
    request_id: requestId,
    delete_key: deleteKey,
    deadline_ts: deadline
  };
}

function filterQueueRowsByDeleteKey(filePath: string, deleteKey: string) {
  const rows = readJsonl(filePath);
  const kept: AnyObj[] = [];
  const removed: AnyObj[] = [];
  for (const row of rows) {
    if (getDeleteKey(row) === deleteKey) removed.push(row);
    else kept.push(row);
  }
  return {
    file_path: filePath,
    before: rows.length,
    kept,
    removed
  };
}

function listJsonlFiles(dirPath: string) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const out: string[] = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || !fs.existsSync(cur)) continue;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && full.toLowerCase().endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

function collectEntryIds(rows: AnyObj[]) {
  const out = new Set<string>();
  for (const row of rows || []) {
    const entryId = normalizeToken(
      row && (row.entry_id || row.entryId || row.workflow_id || row.workflowId) || '',
      140
    );
    if (entryId) out.add(entryId);
  }
  return out;
}

function scrubCheckpointStateByEntryIds(filePath: string, entryIds: Set<string>, requestId: string, apply: boolean) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      file_path: filePath,
      before: 0,
      marked_unlearned: 0,
      touched_entry_ids: []
    };
  }
  const src = readJson(filePath, {});
  const checkpoints = src && src.checkpoints && typeof src.checkpoints === 'object'
    ? src.checkpoints
    : {};
  const out = { ...src, checkpoints: { ...checkpoints } };
  const touched: string[] = [];
  let changed = 0;

  for (const [entryIdRaw, rowRaw] of Object.entries(checkpoints)) {
    const entryId = normalizeToken(entryIdRaw || '', 140);
    if (!entryId || !entryIds.has(entryId)) continue;
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw as AnyObj : {};
    if (String(row.status || '') === 'unlearned') continue;
    const next = {
      ...row,
      status: 'unlearned',
      unlearned_at: nowIso(),
      unlearn_request_id: requestId,
      previous_status: cleanText(row.status || 'unknown', 80) || 'unknown'
    };
    out.checkpoints[entryIdRaw] = next;
    touched.push(entryId);
    changed += 1;
  }

  if (apply && changed > 0) {
    writeJsonAtomic(filePath, out);
  }
  return {
    file_path: filePath,
    before: Object.keys(checkpoints).length,
    marked_unlearned: changed,
    touched_entry_ids: touched
  };
}

function cmdProcess(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.DATA_RIGHTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const apply = toBool(args.apply, false);
  const accessDecision = apply
    ? evaluateAccess(
        'data_rights.process_apply',
        buildAccessContext(args, {
          target_tenant_id: args['target-tenant-id']
            || args.target_tenant_id
            || args['tenant-id']
            || args.tenant_id
            || process.env.PROTHEUS_TARGET_TENANT_ID
            || process.env.PROTHEUS_TENANT_ID
            || null
        })
      )
    : null;
  if (apply && accessDecision && accessDecision.allow !== true) {
    return {
      ok: false,
      type: 'data_rights_process',
      ts: nowIso(),
      error: 'enterprise_access_denied',
      access_decision: accessDecision
    };
  }
  const max = clampInt(args.max, 1, 1000, 50);
  const queueState = loadQueueState(paths.queue_state_path);
  const pending = queueState.requests.filter((row: AnyObj) => String(row.status || 'pending') === 'pending').slice(0, max);
  const processed: AnyObj[] = [];

  for (const request of pending) {
    const deleteKey = normalizeToken(request.delete_key || '', 220);
    if (!deleteKey) continue;
    const queueScans = [
      filterQueueRowsByDeleteKey(paths.pending_queue_path, deleteKey),
      filterQueueRowsByDeleteKey(paths.canary_queue_path, deleteKey),
      filterQueueRowsByDeleteKey(paths.master_queue_path, deleteKey)
    ];
    const datasetScans = listJsonlFiles(paths.datasets_dir_path)
      .map((filePath) => filterQueueRowsByDeleteKey(filePath, deleteKey));
    const affectedEntryIds = new Set<string>();
    for (const scan of [...queueScans, ...datasetScans]) {
      const ids = collectEntryIds(scan.removed || []);
      for (const id of ids) affectedEntryIds.add(id);
    }
    const checkpointDelta = scrubCheckpointStateByEntryIds(
      paths.quarantine_state_path,
      affectedEntryIds,
      cleanText(request.request_id || '', 120) || null,
      apply
    );
    if (apply) {
      for (const scan of [...queueScans, ...datasetScans]) writeJsonlAtomic(scan.file_path, scan.kept);
    }
    const queueRowsRemoved = queueScans.reduce((acc, scan) => acc + scan.removed.length, 0);
    const datasetRowsRemoved = datasetScans.reduce((acc, scan) => acc + scan.removed.length, 0);
    const affectedRows = queueRowsRemoved + datasetRowsRemoved + Number(checkpointDelta.marked_unlearned || 0);
    const unlearningRow = {
      ts: nowIso(),
      request_id: request.request_id,
      delete_key: deleteKey,
      status: apply ? 'queued' : 'simulated',
      affected_rows: affectedRows,
      queue_deltas: queueScans.map((scan) => ({
        path: relPath(scan.file_path),
        before: scan.before,
        removed: scan.removed.length,
        after: scan.kept.length
      })),
      dataset_deltas: datasetScans.map((scan) => ({
        path: relPath(scan.file_path),
        before: scan.before,
        removed: scan.removed.length,
        after: scan.kept.length
      })),
      checkpoint_delta: {
        path: relPath(checkpointDelta.file_path || paths.quarantine_state_path),
        before: Number(checkpointDelta.before || 0),
        marked_unlearned: Number(checkpointDelta.marked_unlearned || 0),
        touched_entry_ids: checkpointDelta.touched_entry_ids || []
      },
      checkpoints_index_path: relPath(paths.checkpoints_index_path)
    };
    appendJsonl(paths.unlearning_queue_path, unlearningRow);
    request.status = apply ? 'processed' : 'simulated';
    request.processed_at = nowIso();
    request.affected_rows = affectedRows;
    request.queue_rows_removed = queueRowsRemoved;
    request.dataset_rows_removed = datasetRowsRemoved;
    request.checkpoints_marked_unlearned = Number(checkpointDelta.marked_unlearned || 0);
    processed.push({
      request_id: request.request_id,
      delete_key: deleteKey,
      affected_rows: affectedRows,
      queue_rows_removed: queueRowsRemoved,
      dataset_rows_removed: datasetRowsRemoved,
      checkpoints_marked_unlearned: Number(checkpointDelta.marked_unlearned || 0),
      status: request.status
    });
    recordSignedEvent(paths, policy, 'data_rights_unlearning_propagated', {
      request_id: request.request_id,
      delete_key: deleteKey,
      apply,
      affected_rows: affectedRows,
      queue_rows_removed: queueRowsRemoved,
      dataset_rows_removed: datasetRowsRemoved,
      checkpoints_marked_unlearned: Number(checkpointDelta.marked_unlearned || 0)
    });
  }

  saveQueueState(paths.queue_state_path, queueState);
  const out = {
    ok: true,
    type: 'data_rights_process',
    ts: nowIso(),
    apply,
    access_decision: accessDecision,
    processed_count: processed.length,
    processed
  };
  writeJsonAtomic(paths.latest_path, out);
  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.DATA_RIGHTS_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const queueState = loadQueueState(paths.queue_state_path);
  const requests = Array.isArray(queueState.requests) ? queueState.requests : [];
  const counts = {
    total_requests: requests.length,
    pending: requests.filter((row: AnyObj) => String(row.status || '') === 'pending').length,
    processed: requests.filter((row: AnyObj) => String(row.status || '') === 'processed').length,
    simulated: requests.filter((row: AnyObj) => String(row.status || '') === 'simulated').length,
    provenance_rows: readJsonl(paths.provenance_path).length
  };
  return {
    ok: true,
    type: 'data_rights_status',
    ts: nowIso(),
    counts,
    paths: {
      provenance_path: relPath(paths.provenance_path),
      rights_events_path: relPath(paths.rights_events_path),
      receipts_path: relPath(paths.receipts_path),
      queue_state_path: relPath(paths.queue_state_path),
      unlearning_queue_path: relPath(paths.unlearning_queue_path),
      datasets_dir_path: relPath(paths.datasets_dir_path),
      quarantine_state_path: relPath(paths.quarantine_state_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/data_rights_engine.js ingest --datum-id=<id> --delete-key=<id> [--source-system=<id>] [--source-channel=<id>]');
  console.log('  node systems/workflow/data_rights_engine.js revoke --delete-key=<id> [--reason=<text>] [--owner-id=<id>]');
  console.log('  node systems/workflow/data_rights_engine.js process [--apply=1|0] [--max=50]');
  console.log('  node systems/workflow/data_rights_engine.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'ingest') out = cmdIngest(args);
  else if (cmd === 'revoke') out = cmdRevoke(args);
  else if (cmd === 'process') out = cmdProcess(args);
  else if (cmd === 'status') out = cmdStatus(args);
  else {
    usage();
    process.exit(2);
    return;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out && out.ok === false) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runtimePaths,
  recordTrainingDatumProvenance,
  cmdRevoke,
  cmdProcess,
  cmdStatus
};
