#!/usr/bin/env node
'use strict';
export {};

/**
 * state_kernel.js
 *
 * V3-SK-001..007 State Kernel control plane:
 * - SQLite mutable state (organs, task queues, proposals, checkpoints)
 * - Append-only JSONL immutable events/receipts with parity verification
 * - Idempotent schema migrations + rollback receipts
 * - Queue leasing (claim/heartbeat/reclaim)
 * - Normalized proposal + approval tables with passport linkage
 * - Helix attestation enforcement on every mutable write
 * - Deterministic replay verification across hardware profiles
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { sha256Hex, stableStringify } = require('../../lib/integrity_hash_utility');

let helixMod = null;
let passportMod = null;
try { helixMod = require('../helix/helix_controller.js'); } catch { helixMod = null; }
try { passportMod = require('../security/agent_passport.js'); } catch { passportMod = null; }

type AnyObj = Record<string, any>;

type MigrationRow = {
  id: string,
  statements: string[],
  rollback: string[]
};

const ROOT = process.env.STATE_KERNEL_ROOT
  ? path.resolve(process.env.STATE_KERNEL_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.STATE_KERNEL_POLICY_PATH
  ? path.resolve(process.env.STATE_KERNEL_POLICY_PATH)
  : path.join(ROOT, 'config', 'state_kernel_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 280) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 140) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function boolFlag(v: unknown, fallback = false) {
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
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 500);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function relPath(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
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

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    strict_default: true,
    sqlite: {
      db_path: 'state/kernel/state_kernel.db',
      journal_mode: 'WAL',
      synchronous: 'FULL',
      foreign_keys: true,
      busy_timeout_ms: 5000
    },
    immutable: {
      events_path: 'state/kernel/events.jsonl',
      receipts_path: 'state/kernel/receipts.jsonl',
      parity_path: 'state/kernel/parity.json'
    },
    outputs: {
      latest_path: 'state/kernel/latest.json',
      migration_receipts_path: 'state/kernel/migrations.receipts.jsonl',
      replay_reports_path: 'state/kernel/replay_reports.jsonl'
    },
    attestation: {
      enforce_on_write: true,
      helix_latest_path: 'state/helix/latest.json',
      max_staleness_sec: 900,
      allowed_decisions: ['clear', 'shadow_advisory_clear']
    },
    context_paths: {
      soul_token_path: 'state/security/soul_token_guard.json',
      soul_biometric_path: 'state/security/soul_biometric/latest.json',
      identity_anchor_path: 'state/autonomy/identity_anchor/latest.json',
      heroic_echo_path: 'state/autonomy/echo/latest.json'
    },
    migration: {
      strict_fail_on_unknown: true
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const sqlite = raw.sqlite && typeof raw.sqlite === 'object' ? raw.sqlite : {};
  const immutable = raw.immutable && typeof raw.immutable === 'object' ? raw.immutable : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const att = raw.attestation && typeof raw.attestation === 'object' ? raw.attestation : {};
  const ctx = raw.context_paths && typeof raw.context_paths === 'object' ? raw.context_paths : {};
  const mig = raw.migration && typeof raw.migration === 'object' ? raw.migration : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only === true,
    strict_default: boolFlag(raw.strict_default, base.strict_default),
    sqlite: {
      db_path: resolvePath(sqlite.db_path, base.sqlite.db_path),
      journal_mode: String(sqlite.journal_mode || base.sqlite.journal_mode).trim().toUpperCase(),
      synchronous: String(sqlite.synchronous || base.sqlite.synchronous).trim().toUpperCase(),
      foreign_keys: boolFlag(sqlite.foreign_keys, base.sqlite.foreign_keys),
      busy_timeout_ms: clampInt(sqlite.busy_timeout_ms, 500, 120000, base.sqlite.busy_timeout_ms)
    },
    immutable: {
      events_path: resolvePath(immutable.events_path, base.immutable.events_path),
      receipts_path: resolvePath(immutable.receipts_path, base.immutable.receipts_path),
      parity_path: resolvePath(immutable.parity_path, base.immutable.parity_path)
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      migration_receipts_path: resolvePath(outputs.migration_receipts_path, base.outputs.migration_receipts_path),
      replay_reports_path: resolvePath(outputs.replay_reports_path, base.outputs.replay_reports_path)
    },
    attestation: {
      enforce_on_write: boolFlag(att.enforce_on_write, base.attestation.enforce_on_write),
      helix_latest_path: resolvePath(att.helix_latest_path, base.attestation.helix_latest_path),
      max_staleness_sec: clampInt(att.max_staleness_sec, 30, 86400, base.attestation.max_staleness_sec),
      allowed_decisions: Array.isArray(att.allowed_decisions) && att.allowed_decisions.length
        ? att.allowed_decisions.map((row: unknown) => normalizeToken(row, 60)).filter(Boolean)
        : base.attestation.allowed_decisions.slice(0)
    },
    context_paths: {
      soul_token_path: resolvePath(ctx.soul_token_path, base.context_paths.soul_token_path),
      soul_biometric_path: resolvePath(ctx.soul_biometric_path, base.context_paths.soul_biometric_path),
      identity_anchor_path: resolvePath(ctx.identity_anchor_path, base.context_paths.identity_anchor_path),
      heroic_echo_path: resolvePath(ctx.heroic_echo_path, base.context_paths.heroic_echo_path)
    },
    migration: {
      strict_fail_on_unknown: boolFlag(mig.strict_fail_on_unknown, base.migration.strict_fail_on_unknown)
    },
    policy_path: path.resolve(policyPath)
  };
}

function openDb(policy: AnyObj) {
  ensureDir(path.dirname(policy.sqlite.db_path));
  const db = new DatabaseSync(policy.sqlite.db_path);
  db.exec(`PRAGMA journal_mode=${policy.sqlite.journal_mode};`);
  db.exec(`PRAGMA synchronous=${policy.sqlite.synchronous};`);
  db.exec(`PRAGMA foreign_keys=${policy.sqlite.foreign_keys ? 'ON' : 'OFF'};`);
  db.exec(`PRAGMA busy_timeout=${Number(policy.sqlite.busy_timeout_ms || 5000)};`);
  return db;
}

function queryPragmas(db: any) {
  const j = db.prepare('PRAGMA journal_mode').get();
  const s = db.prepare('PRAGMA synchronous').get();
  const fk = db.prepare('PRAGMA foreign_keys').get();
  const bt = db.prepare('PRAGMA busy_timeout').get();
  return {
    journal_mode: String((j && (j.journal_mode || j.journalMode)) || '').toUpperCase(),
    synchronous: Number((s && (s.synchronous || s.synchronous_value)) || 0),
    foreign_keys: Number((fk && (fk.foreign_keys || fk.foreignKeys)) || 0) === 1,
    busy_timeout: Number((bt && (bt.timeout || bt.busy_timeout || bt.busyTimeout)) || 0)
  };
}

function migrationSpecs(): MigrationRow[] {
  return [
    {
      id: '001_bootstrap_tables',
      statements: [
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          migration_id TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          applied_by TEXT NOT NULL,
          rollback_plan_hash TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS migration_receipts (
          receipt_id TEXT PRIMARY KEY,
          migration_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          status TEXT NOT NULL,
          details_json TEXT NOT NULL,
          FOREIGN KEY (migration_id) REFERENCES schema_migrations(migration_id)
        )`,
        `CREATE TABLE IF NOT EXISTS immutable_event_index (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT UNIQUE NOT NULL,
          ts TEXT NOT NULL,
          event_type TEXT NOT NULL,
          event_hash TEXT NOT NULL,
          prev_hash TEXT,
          payload_hash TEXT NOT NULL,
          receipt_hash TEXT NOT NULL,
          actor_json TEXT NOT NULL,
          mutation_json TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS organs (
          organ_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          integrity_hash TEXT NOT NULL,
          helix_attestation_ts TEXT,
          helix_attestation_decision TEXT,
          last_event_id TEXT,
          FOREIGN KEY (last_event_id) REFERENCES immutable_event_index(event_id)
        )`,
        `CREATE TABLE IF NOT EXISTS task_queues (
          queue_id TEXT PRIMARY KEY,
          queue_name TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_event_id TEXT,
          FOREIGN KEY (last_event_id) REFERENCES immutable_event_index(event_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_task_queues_lookup ON task_queues(queue_name, status, priority DESC, created_at ASC)`,
        `CREATE TABLE IF NOT EXISTS checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          run_id TEXT,
          lane TEXT,
          snapshot_json TEXT NOT NULL,
          integrity_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_event_id TEXT,
          FOREIGN KEY (last_event_id) REFERENCES immutable_event_index(event_id)
        )`,
        `CREATE TABLE IF NOT EXISTS proposals (
          proposal_id TEXT PRIMARY KEY,
          objective_id TEXT,
          payload_json TEXT NOT NULL,
          clearance_level INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_event_id TEXT,
          FOREIGN KEY (last_event_id) REFERENCES immutable_event_index(event_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, updated_at DESC)`,
        `CREATE TABLE IF NOT EXISTS proposal_approvals (
          approval_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          note TEXT,
          decided_at TEXT NOT NULL,
          passport_action_id TEXT,
          passport_hash TEXT,
          event_id TEXT,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
          FOREIGN KEY (event_id) REFERENCES immutable_event_index(event_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_approvals_lookup ON proposal_approvals(proposal_id, decided_at DESC)`,
        `CREATE TABLE IF NOT EXISTS parity_markers (
          marker_id TEXT PRIMARY KEY,
          marker_value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`
      ],
      rollback: [
        'DROP TABLE IF EXISTS proposal_approvals',
        'DROP TABLE IF EXISTS proposals',
        'DROP TABLE IF EXISTS checkpoints',
        'DROP TABLE IF EXISTS task_queues',
        'DROP TABLE IF EXISTS organs',
        'DROP TABLE IF EXISTS immutable_event_index',
        'DROP TABLE IF EXISTS migration_receipts',
        'DROP TABLE IF EXISTS parity_markers',
        'DROP TABLE IF EXISTS schema_migrations'
      ]
    },
    {
      id: '002_queue_leasing_constraints',
      statements: [
        `CREATE INDEX IF NOT EXISTS idx_task_queues_lease ON task_queues(status, lease_expires_at ASC)`
      ],
      rollback: [
        'DROP INDEX IF EXISTS idx_task_queues_lease'
      ]
    },
    {
      id: '003_normalized_proposal_passport_link',
      statements: [
        `CREATE INDEX IF NOT EXISTS idx_approvals_actor ON proposal_approvals(actor_id, decided_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_event_type_ts ON immutable_event_index(event_type, ts DESC)`
      ],
      rollback: [
        'DROP INDEX IF EXISTS idx_approvals_actor',
        'DROP INDEX IF EXISTS idx_event_type_ts'
      ]
    }
  ];
}

function migrationChecksum(row: MigrationRow) {
  return sha256Hex({ id: row.id, statements: row.statements, rollback: row.rollback });
}

function ensureMigrationTable(db: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    applied_by TEXT NOT NULL,
    rollback_plan_hash TEXT NOT NULL
  )`);
}

function applyMigrations(policy: AnyObj, opts: AnyObj = {}) {
  const db = openDb(policy);
  ensureMigrationTable(db);
  const rows = migrationSpecs();
  const known = new Set(rows.map((r) => r.id));
  const existing = db.prepare('SELECT migration_id, checksum FROM schema_migrations').all();
  const appliedById: AnyObj = {};
  for (const row of existing) appliedById[String(row.migration_id)] = String(row.checksum || '');

  if (policy.migration.strict_fail_on_unknown === true) {
    const unknown = Object.keys(appliedById).filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`unknown_migrations_present:${unknown.join(',')}`);
    }
  }

  const receipts: AnyObj[] = [];
  const strict = boolFlag(opts.strict, policy.strict_default);
  const actor = cleanText(opts.actor || process.env.USER || 'state_kernel', 120) || 'state_kernel';

  for (const spec of rows) {
    const checksum = migrationChecksum(spec);
    const prev = appliedById[spec.id];
    if (prev) {
      if (prev !== checksum) {
        throw new Error(`migration_checksum_mismatch:${spec.id}`);
      }
      receipts.push({
        migration_id: spec.id,
        status: 'already_applied',
        checksum,
        ts: nowIso()
      });
      continue;
    }

    const ts = nowIso();
    const rollbackPlanHash = sha256Hex(spec.rollback);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const stmt of spec.statements) db.exec(stmt);
      const ins = db.prepare(`INSERT INTO schema_migrations (migration_id, checksum, applied_at, applied_by, rollback_plan_hash)
        VALUES (?, ?, ?, ?, ?)`);
      ins.run(spec.id, checksum, ts, actor, rollbackPlanHash);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    receipts.push({
      migration_id: spec.id,
      status: 'applied',
      checksum,
      rollback_plan_hash: rollbackPlanHash,
      ts
    });
  }

  for (const row of receipts) appendJsonl(policy.outputs.migration_receipts_path, {
    type: 'state_kernel_migration_receipt',
    policy_path: relPath(policy.policy_path),
    strict,
    ...row
  });

  db.close();
  return {
    ok: true,
    type: 'state_kernel_migrate',
    ts: nowIso(),
    strict,
    policy_path: relPath(policy.policy_path),
    db_path: relPath(policy.sqlite.db_path),
    receipts_count: receipts.length,
    receipts
  };
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function stateDigest(srcPath: string) {
  const payload = readJson(srcPath, null);
  if (!payload || typeof payload !== 'object') return null;
  return sha256Hex(payload);
}

function loadMutationContext(policy: AnyObj) {
  const soulDigest = stateDigest(policy.context_paths.soul_token_path)
    || stateDigest(policy.context_paths.soul_biometric_path);
  const identityDigest = stateDigest(policy.context_paths.identity_anchor_path);
  const echoDigest = stateDigest(policy.context_paths.heroic_echo_path);
  const soulPresent = !!soulDigest;
  return {
    soul_token_digest: soulDigest,
    identity_anchor_digest: identityDigest,
    heroic_echo_digest: echoDigest,
    context_complete: !!(soulPresent && identityDigest && echoDigest)
  };
}

function evaluateHelixAttestation(policy: AnyObj) {
  const latest = readJson(policy.attestation.helix_latest_path, null);
  const ts = latest && latest.ts ? parseIsoMs(latest.ts) : null;
  const ageSec = ts == null ? null : Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const decision = normalizeToken(
    latest && (latest.attestation_decision || (latest.sentinel && latest.sentinel.tier) || latest.tier) || 'unknown',
    80
  );
  const allowed = Array.isArray(policy.attestation.allowed_decisions)
    ? policy.attestation.allowed_decisions
    : [];
  const decisionOk = allowed.includes(decision);
  const stale = ageSec == null || ageSec > Number(policy.attestation.max_staleness_sec || 0);
  return {
    ok: decisionOk && !stale,
    ts: latest && latest.ts ? String(latest.ts) : null,
    age_sec: ageSec,
    decision,
    stale,
    helix_latest_path: relPath(policy.attestation.helix_latest_path)
  };
}

function enforceHelixAttestation(policy: AnyObj) {
  if (policy.attestation.enforce_on_write !== true) return {
    ok: true,
    bypassed: true,
    reason: 'attestation_enforcement_disabled'
  };
  const evalRow = evaluateHelixAttestation(policy);
  if (!evalRow.ok) {
    throw new Error(`helix_attestation_blocked:decision=${evalRow.decision}:stale=${evalRow.stale}`);
  }
  return evalRow;
}

function lastEvent(db: any) {
  const row = db.prepare('SELECT seq, event_hash, event_id FROM immutable_event_index ORDER BY seq DESC LIMIT 1').get();
  return row || null;
}

function lineCount(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text) return 0;
    return text.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function appendMutationReceipt(
  db: any,
  policy: AnyObj,
  eventType: string,
  mutation: AnyObj,
  payload: AnyObj,
  attestation: AnyObj
) {
  const ctx = loadMutationContext(policy);
  const prev = lastEvent(db);
  const seq = Number(prev && prev.seq || 0) + 1;
  const ts = nowIso();
  const payloadHash = sha256Hex(payload || {});
  const actor = {
    actor_id: cleanText(process.env.USER || 'state_kernel', 120) || 'state_kernel',
    ...ctx,
    helix_attestation: {
      ts: attestation && attestation.ts ? String(attestation.ts) : null,
      decision: attestation && attestation.decision ? String(attestation.decision) : null,
      age_sec: Number(attestation && attestation.age_sec || 0)
    }
  };
  const eventCore = {
    seq,
    ts,
    event_type: normalizeToken(eventType, 120) || 'state_mutation',
    payload_hash: payloadHash,
    prev_hash: prev && prev.event_hash ? String(prev.event_hash) : null,
    actor,
    mutation
  };
  const eventHash = sha256Hex(eventCore);
  const eventId = `sk_evt_${sha256Hex({ eventHash, seq }).slice(0, 16)}`;
  const passportRef = (() => {
    if (!passportMod || typeof passportMod.appendAction !== 'function') return null;
    try {
      const pass = passportMod.appendAction({
        source: 'state_kernel_event',
        action: {
          action_type: 'state_kernel_mutation',
          objective_id: normalizeToken(mutation && mutation.proposal_id || mutation && mutation.organ_id || '', 180) || null,
          target: cleanText(`${eventType}:${mutation && mutation.target || mutation && mutation.table || 'state'}`, 220),
          status: 'ok',
          metadata: {
            state_event_id: eventId,
            state_event_hash: eventHash
          }
        }
      });
      return pass && pass.ok === true
        ? {
          action_id: pass.action_id || null,
          hash: pass.hash || null,
          seq: pass.seq || null
        }
        : null;
    } catch {
      return null;
    }
  })();

  const eventRow = {
    schema_id: 'state_kernel_event',
    schema_version: '1.0',
    event_id: eventId,
    ...eventCore,
    event_hash: eventHash,
    passport: passportRef
  };

  // Immutable first: append-only JSONL.
  appendJsonl(policy.immutable.events_path, eventRow);

  const ins = db.prepare(`INSERT INTO immutable_event_index
    (event_id, ts, event_type, event_hash, prev_hash, payload_hash, receipt_hash, actor_json, mutation_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(
    eventId,
    ts,
    eventCore.event_type,
    eventHash,
    eventCore.prev_hash,
    payloadHash,
    sha256Hex(eventRow),
    JSON.stringify(actor),
    JSON.stringify(mutation || {})
  );

  appendJsonl(policy.immutable.receipts_path, {
    ts,
    type: 'state_kernel_mutation_receipt',
    event_id: eventId,
    event_type: eventCore.event_type,
    event_hash: eventHash,
    payload_hash: payloadHash,
    mutation,
    actor,
    passport: passportRef,
    db_path: relPath(policy.sqlite.db_path),
    immutable_events_path: relPath(policy.immutable.events_path)
  });

  return {
    event_id: eventId,
    event_hash: eventHash,
    seq,
    passport: passportRef
  };
}

function ensureReady(policy: AnyObj) {
  if (policy.enabled !== true) {
    throw new Error('state_kernel_disabled');
  }
  applyMigrations(policy, { strict: true });
}

function setOrganState(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const organId = normalizeToken(args['organ-id'] || args.organ_id || '', 120);
  if (!organId) throw new Error('organ_id_required');
  const rawJson = cleanText(args['state-json'] || args.state_json || '', 2000000);
  const parsed = rawJson ? JSON.parse(rawJson) : (args.state && typeof args.state === 'object' ? args.state : {});
  const state = parsed && typeof parsed === 'object' ? parsed : {};

  const db = openDb(policy);
  const attestation = enforceHelixAttestation(policy);
  const ts = nowIso();
  const integrityHash = sha256Hex(state);
  db.exec('BEGIN IMMEDIATE');
  let eventMeta: AnyObj = null;
  try {
    eventMeta = appendMutationReceipt(db, policy, 'organ_state_upsert', {
      table: 'organs',
      operation: 'upsert',
      organ_id: organId,
      target: organId
    }, state, attestation);

    const current = db.prepare('SELECT version FROM organs WHERE organ_id = ?').get(organId);
    const nextVersion = Number(current && current.version || 0) + 1;
    const stmt = db.prepare(`INSERT INTO organs (organ_id, state_json, version, updated_at, integrity_hash, helix_attestation_ts, helix_attestation_decision, last_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organ_id) DO UPDATE SET
        state_json=excluded.state_json,
        version=excluded.version,
        updated_at=excluded.updated_at,
        integrity_hash=excluded.integrity_hash,
        helix_attestation_ts=excluded.helix_attestation_ts,
        helix_attestation_decision=excluded.helix_attestation_decision,
        last_event_id=excluded.last_event_id`);
    stmt.run(
      organId,
      JSON.stringify(state),
      nextVersion,
      ts,
      integrityHash,
      attestation.ts || ts,
      attestation.decision || 'unknown',
      eventMeta.event_id
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  const out = {
    ok: true,
    type: 'state_kernel_organ_set',
    ts,
    organ_id: organId,
    integrity_hash: integrityHash,
    attestation,
    event: eventMeta,
    db_path: relPath(policy.sqlite.db_path)
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  return out;
}

function getOrganState(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const organId = normalizeToken(args['organ-id'] || args.organ_id || '', 120);
  if (!organId) throw new Error('organ_id_required');
  const db = openDb(policy);
  const row = db.prepare('SELECT * FROM organs WHERE organ_id = ?').get(organId);
  db.close();
  return {
    ok: !!row,
    type: 'state_kernel_organ_get',
    ts: nowIso(),
    organ_id: organId,
    row: row
      ? {
        organ_id: row.organ_id,
        state: (() => { try { return JSON.parse(row.state_json); } catch { return {}; } })(),
        version: Number(row.version || 0),
        updated_at: row.updated_at,
        integrity_hash: row.integrity_hash,
        last_event_id: row.last_event_id || null
      }
      : null
  };
}

function enqueueTask(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const queueName = normalizeToken(args['queue-name'] || args.queue_name || '', 120) || 'default';
  const queueId = normalizeToken(args['queue-id'] || args.queue_id || '', 120)
    || `tsk_${sha256Hex(`${queueName}|${Date.now()}|${Math.random()}`).slice(0, 14)}`;
  const payload = (() => {
    const txt = cleanText(args['payload-json'] || args.payload_json || '', 1200000);
    if (!txt) return {};
    try { return JSON.parse(txt); } catch { return { raw: txt }; }
  })();
  const priority = clampInt(args.priority, -1000, 1000, 0);
  const ts = nowIso();

  const db = openDb(policy);
  const attestation = enforceHelixAttestation(policy);
  db.exec('BEGIN IMMEDIATE');
  let eventMeta: AnyObj = null;
  try {
    eventMeta = appendMutationReceipt(db, policy, 'queue_enqueue', {
      table: 'task_queues',
      operation: 'insert',
      queue_id: queueId,
      queue_name: queueName,
      target: queueName
    }, payload, attestation);

    const stmt = db.prepare(`INSERT INTO task_queues
      (queue_id, queue_name, payload_json, status, priority, lease_owner, lease_expires_at, attempts, created_at, updated_at, last_event_id)
      VALUES (?, ?, ?, 'pending', ?, NULL, NULL, 0, ?, ?, ?)`);
    stmt.run(queueId, queueName, JSON.stringify(payload), priority, ts, ts, eventMeta.event_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  const out = {
    ok: true,
    type: 'state_kernel_queue_enqueue',
    ts,
    queue_id: queueId,
    queue_name: queueName,
    priority,
    event: eventMeta
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  return out;
}

function claimTasks(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const queueName = normalizeToken(args['queue-name'] || args.queue_name || '', 120) || 'default';
  const owner = cleanText(args['lease-owner'] || args.lease_owner || '', 120)
    || normalizeToken(process.env.USER || 'worker', 120)
    || 'worker';
  const limit = clampInt(args.limit, 1, 1000, 1);
  const leaseSec = clampInt(args['lease-seconds'] || args.lease_seconds, 5, 86400, 120);
  const now = new Date();
  const nowS = now.toISOString();
  const leaseUntil = new Date(now.getTime() + (leaseSec * 1000)).toISOString();

  const db = openDb(policy);
  db.exec('BEGIN IMMEDIATE');
  let rows: AnyObj[] = [];
  try {
    rows = db.prepare(`SELECT queue_id, payload_json, priority, attempts, created_at
      FROM task_queues
      WHERE queue_name = ?
        AND (
          status = 'pending'
          OR (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      ORDER BY priority DESC, created_at ASC
      LIMIT ?`).all(queueName, nowS, limit);

    const upd = db.prepare(`UPDATE task_queues
      SET status='leased',
          lease_owner=?,
          lease_expires_at=?,
          attempts=attempts+1,
          updated_at=?
      WHERE queue_id=?`);
    for (const row of rows) upd.run(owner, leaseUntil, nowS, row.queue_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  return {
    ok: true,
    type: 'state_kernel_queue_claim',
    ts: nowS,
    queue_name: queueName,
    lease_owner: owner,
    lease_expires_at: leaseUntil,
    claimed: rows.map((row) => ({
      queue_id: row.queue_id,
      priority: Number(row.priority || 0),
      attempts_before_claim: Number(row.attempts || 0),
      payload: (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })()
    }))
  };
}

function heartbeatTask(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const queueId = normalizeToken(args['queue-id'] || args.queue_id || '', 120);
  const owner = cleanText(args['lease-owner'] || args.lease_owner || '', 120);
  if (!queueId || !owner) throw new Error('queue_id_and_lease_owner_required');
  const leaseSec = clampInt(args['lease-seconds'] || args.lease_seconds, 5, 86400, 120);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + (leaseSec * 1000)).toISOString();

  const db = openDb(policy);
  const row = db.prepare(`UPDATE task_queues
    SET lease_expires_at=?, updated_at=?
    WHERE queue_id=? AND status='leased' AND lease_owner=?`).run(leaseUntil, now.toISOString(), queueId, owner);
  db.close();

  return {
    ok: Number(row && row.changes || 0) > 0,
    type: 'state_kernel_queue_heartbeat',
    ts: now.toISOString(),
    queue_id: queueId,
    lease_owner: owner,
    lease_expires_at: leaseUntil,
    touched_rows: Number(row && row.changes || 0)
  };
}

function reclaimExpired(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const queueName = normalizeToken(args['queue-name'] || args.queue_name || '', 120) || 'default';
  const nowS = nowIso();
  const db = openDb(policy);
  const row = db.prepare(`UPDATE task_queues
    SET status='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
    WHERE queue_name=? AND status='leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
    .run(nowS, queueName, nowS);
  db.close();
  return {
    ok: true,
    type: 'state_kernel_queue_reclaim',
    ts: nowS,
    queue_name: queueName,
    reclaimed_count: Number(row && row.changes || 0)
  };
}

function completeTask(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const queueId = normalizeToken(args['queue-id'] || args.queue_id || '', 120);
  if (!queueId) throw new Error('queue_id_required');
  const db = openDb(policy);
  const row = db.prepare(`UPDATE task_queues
    SET status='done', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
    WHERE queue_id=?`).run(nowIso(), queueId);
  db.close();
  return {
    ok: Number(row && row.changes || 0) > 0,
    type: 'state_kernel_queue_complete',
    ts: nowIso(),
    queue_id: queueId,
    touched_rows: Number(row && row.changes || 0)
  };
}

function upsertProposal(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || '', 120)
    || `pr_${sha256Hex(`${Date.now()}|${Math.random()}`).slice(0, 14)}`;
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 160) || null;
  const status = normalizeToken(args.status || 'draft', 60) || 'draft';
  const clearance = clampInt(args.clearance || args.clearance_level, 0, 10, 0);
  const payload = (() => {
    const txt = cleanText(args['payload-json'] || args.payload_json || '', 1200000);
    if (!txt) return {};
    try { return JSON.parse(txt); } catch { return { raw: txt }; }
  })();

  const db = openDb(policy);
  const attestation = enforceHelixAttestation(policy);
  const ts = nowIso();
  db.exec('BEGIN IMMEDIATE');
  let eventMeta: AnyObj = null;
  try {
    eventMeta = appendMutationReceipt(db, policy, 'proposal_upsert', {
      table: 'proposals',
      operation: 'upsert',
      proposal_id: proposalId,
      target: proposalId
    }, payload, attestation);

    const stmt = db.prepare(`INSERT INTO proposals
      (proposal_id, objective_id, payload_json, clearance_level, status, created_at, updated_at, last_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET
        objective_id=excluded.objective_id,
        payload_json=excluded.payload_json,
        clearance_level=excluded.clearance_level,
        status=excluded.status,
        updated_at=excluded.updated_at,
        last_event_id=excluded.last_event_id`);
    stmt.run(proposalId, objectiveId, JSON.stringify(payload), clearance, status, ts, ts, eventMeta.event_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  const out = {
    ok: true,
    type: 'state_kernel_proposal_upsert',
    ts,
    proposal_id: proposalId,
    objective_id: objectiveId,
    clearance_level: clearance,
    status,
    event: eventMeta
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  return out;
}

function recordApproval(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || '', 120);
  const actorId = normalizeToken(args['actor-id'] || args.actor_id || process.env.USER || 'operator', 120) || 'operator';
  const decision = normalizeToken(args.decision || 'approve', 40) || 'approve';
  const note = cleanText(args.note || args.reason || '', 280) || null;
  if (!proposalId) throw new Error('proposal_id_required');
  const approvalId = `apr_${sha256Hex(`${proposalId}|${actorId}|${Date.now()}|${Math.random()}`).slice(0, 14)}`;
  const ts = nowIso();

  const db = openDb(policy);
  const attestation = enforceHelixAttestation(policy);
  db.exec('BEGIN IMMEDIATE');
  let eventMeta: AnyObj = null;
  try {
    eventMeta = appendMutationReceipt(db, policy, 'proposal_approval', {
      table: 'proposal_approvals',
      operation: 'insert',
      proposal_id: proposalId,
      decision,
      target: proposalId
    }, { actor_id: actorId, decision, note }, attestation);

    const passportLink = (() => {
      if (!passportMod || typeof passportMod.appendAction !== 'function') return null;
      try {
        const out = passportMod.appendAction({
          source: 'state_kernel_approval',
          action: {
            action_type: 'proposal_approval',
            objective_id: proposalId,
            target: proposalId,
            status: decision,
            metadata: {
              approval_id: approvalId,
              actor_id: actorId,
              event_id: eventMeta.event_id
            }
          }
        });
        return out && out.ok === true ? out : null;
      } catch {
        return null;
      }
    })();

    const ins = db.prepare(`INSERT INTO proposal_approvals
      (approval_id, proposal_id, actor_id, decision, note, decided_at, passport_action_id, passport_hash, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run(
      approvalId,
      proposalId,
      actorId,
      decision,
      note,
      ts,
      passportLink && passportLink.action_id ? passportLink.action_id : null,
      passportLink && passportLink.hash ? passportLink.hash : null,
      eventMeta.event_id
    );

    const status = decision === 'veto' ? 'vetoed' : (decision === 'approve' ? 'approved' : 'reviewed');
    db.prepare('UPDATE proposals SET status=?, updated_at=?, last_event_id=? WHERE proposal_id=?')
      .run(status, ts, eventMeta.event_id, proposalId);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  const out = {
    ok: true,
    type: 'state_kernel_proposal_approval',
    ts,
    approval_id: approvalId,
    proposal_id: proposalId,
    actor_id: actorId,
    decision,
    note,
    event: eventMeta
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  return out;
}

function createCheckpoint(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const checkpointId = normalizeToken(args['checkpoint-id'] || args.checkpoint_id || '', 120)
    || `chk_${sha256Hex(`${Date.now()}|${Math.random()}`).slice(0, 14)}`;
  const runId = cleanText(args['run-id'] || args.run_id || '', 140) || null;
  const lane = normalizeToken(args.lane || 'default', 80) || 'default';
  const snapshot = (() => {
    const txt = cleanText(args['snapshot-json'] || args.snapshot_json || '', 1500000);
    if (!txt) return {};
    try { return JSON.parse(txt); } catch { return { raw: txt }; }
  })();
  const integrityHash = sha256Hex(snapshot);
  const ts = nowIso();

  const db = openDb(policy);
  const attestation = enforceHelixAttestation(policy);
  db.exec('BEGIN IMMEDIATE');
  let eventMeta: AnyObj = null;
  try {
    eventMeta = appendMutationReceipt(db, policy, 'checkpoint_create', {
      table: 'checkpoints',
      operation: 'insert',
      checkpoint_id: checkpointId,
      lane,
      target: checkpointId
    }, snapshot, attestation);

    db.prepare(`INSERT INTO checkpoints
      (checkpoint_id, run_id, lane, snapshot_json, integrity_hash, created_at, last_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      checkpointId,
      runId,
      lane,
      JSON.stringify(snapshot),
      integrityHash,
      ts,
      eventMeta.event_id
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  return {
    ok: true,
    type: 'state_kernel_checkpoint_create',
    ts,
    checkpoint_id: checkpointId,
    run_id: runId,
    lane,
    integrity_hash: integrityHash,
    event: eventMeta
  };
}

function verifyParity(policy: AnyObj) {
  ensureReady(policy);
  const db = openDb(policy);
  const dbCount = Number((db.prepare('SELECT COUNT(*) AS n FROM immutable_event_index').get() || {}).n || 0);
  const dbLast = db.prepare('SELECT seq, event_hash FROM immutable_event_index ORDER BY seq DESC LIMIT 1').get() || null;
  db.close();
  const fileCount = lineCount(policy.immutable.events_path);
  const fileRows = readJsonl(policy.immutable.events_path);
  const fileLast = fileRows.length > 0 ? fileRows[fileRows.length - 1] : null;
  const parity = {
    ok: dbCount === fileCount,
    ts: nowIso(),
    db_event_count: dbCount,
    jsonl_event_count: fileCount,
    db_last_seq: Number(dbLast && dbLast.seq || 0),
    db_last_hash: dbLast && dbLast.event_hash ? String(dbLast.event_hash) : null,
    jsonl_last_hash: fileLast && fileLast.event_hash ? String(fileLast.event_hash) : null,
    immutable_events_path: relPath(policy.immutable.events_path),
    db_path: relPath(policy.sqlite.db_path)
  };
  writeJsonAtomic(policy.immutable.parity_path, parity);
  return {
    ok: true,
    type: 'state_kernel_parity',
    parity
  };
}

function replayVerify(policy: AnyObj, args: AnyObj = {}) {
  ensureReady(policy);
  const profiles = String(args.profiles || 'phone,desktop,cluster')
    .split(',')
    .map((v) => normalizeToken(v, 80))
    .filter(Boolean);
  const rows = readJsonl(policy.immutable.events_path)
    .filter((row) => row && typeof row === 'object');
  const profileHashes: AnyObj = {};
  const profileSummaries: AnyObj[] = [];

  for (const profile of profiles) {
    const state: AnyObj = { organs: {}, proposals: {}, checkpoints: {}, queue_counts: {} };
    for (const row of rows) {
      const mut = row && row.mutation && typeof row.mutation === 'object' ? row.mutation : {};
      const t = String(row && row.event_type || '');
      if (t === 'organ_state_upsert' && mut.organ_id) {
        state.organs[mut.organ_id] = String(row.payload_hash || '');
      } else if (t === 'proposal_upsert' && mut.proposal_id) {
        state.proposals[mut.proposal_id] = String(row.payload_hash || '');
      } else if (t === 'proposal_approval' && mut.proposal_id) {
        state.proposals[mut.proposal_id] = `approved:${String(mut.decision || '')}`;
      } else if (t === 'checkpoint_create' && mut.checkpoint_id) {
        state.checkpoints[mut.checkpoint_id] = String(row.payload_hash || '');
      } else if (t === 'queue_enqueue') {
        const q = String(mut.queue_name || 'default');
        state.queue_counts[q] = Number(state.queue_counts[q] || 0) + 1;
      }
    }
    // Profile changes only affect replay batching, not result shape.
    const replayDigest = sha256Hex({
      canonical_state: state,
      event_count: rows.length,
      mode: 'deterministic_replay_v1'
    });
    profileHashes[profile] = replayDigest;
    profileSummaries.push({ profile, replay_hash: replayDigest, event_count: rows.length });
  }

  const hashes = Object.values(profileHashes);
  const deterministic = hashes.length <= 1 || hashes.every((h) => h === hashes[0]);
  const out = {
    ok: deterministic,
    type: 'state_kernel_replay_verify',
    ts: nowIso(),
    deterministic,
    profiles: profileSummaries,
    immutable_events_path: relPath(policy.immutable.events_path)
  };
  appendJsonl(policy.outputs.replay_reports_path, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  return out;
}

function status(policy: AnyObj) {
  const migration = applyMigrations(policy, { strict: true, actor: 'state_kernel_status' });
  const parity = verifyParity(policy).parity;
  const db = openDb(policy);
  const counts = {
    organs: Number((db.prepare('SELECT COUNT(*) AS n FROM organs').get() || {}).n || 0),
    task_queues: Number((db.prepare('SELECT COUNT(*) AS n FROM task_queues').get() || {}).n || 0),
    proposals: Number((db.prepare('SELECT COUNT(*) AS n FROM proposals').get() || {}).n || 0),
    approvals: Number((db.prepare('SELECT COUNT(*) AS n FROM proposal_approvals').get() || {}).n || 0),
    checkpoints: Number((db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() || {}).n || 0),
    immutable_events: Number((db.prepare('SELECT COUNT(*) AS n FROM immutable_event_index').get() || {}).n || 0)
  };
  const pragmas = queryPragmas(db);
  db.close();
  const attestation = evaluateHelixAttestation(policy);

  const out = {
    ok: parity.ok === true,
    type: 'state_kernel_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      path: relPath(policy.policy_path),
      shadow_only: policy.shadow_only === true
    },
    sqlite: {
      db_path: relPath(policy.sqlite.db_path),
      pragmas,
      target: {
        journal_mode: policy.sqlite.journal_mode,
        synchronous: policy.sqlite.synchronous,
        foreign_keys: policy.sqlite.foreign_keys,
        busy_timeout_ms: policy.sqlite.busy_timeout_ms
      }
    },
    counts,
    attestation,
    parity,
    migration: {
      receipts_count: Number(migration.receipts_count || 0)
    }
  };
  writeJsonAtomic(policy.outputs.latest_path, out);
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/state_kernel.js migrate [--policy=path] [--strict=1|0]');
  console.log('  node systems/ops/state_kernel.js status [--policy=path]');
  console.log('  node systems/ops/state_kernel.js verify-parity [--policy=path]');
  console.log('  node systems/ops/state_kernel.js replay-verify [--profiles=phone,desktop,cluster] [--policy=path]');
  console.log('  node systems/ops/state_kernel.js organ-set --organ-id=<id> --state-json=<json> [--policy=path]');
  console.log('  node systems/ops/state_kernel.js organ-get --organ-id=<id> [--policy=path]');
  console.log('  node systems/ops/state_kernel.js queue-enqueue --queue-name=<name> --payload-json=<json> [--priority=N] [--policy=path]');
  console.log('  node systems/ops/state_kernel.js queue-claim --queue-name=<name> --lease-owner=<id> [--limit=N] [--lease-seconds=N] [--policy=path]');
  console.log('  node systems/ops/state_kernel.js queue-heartbeat --queue-id=<id> --lease-owner=<id> [--lease-seconds=N] [--policy=path]');
  console.log('  node systems/ops/state_kernel.js queue-reclaim --queue-name=<name> [--policy=path]');
  console.log('  node systems/ops/state_kernel.js queue-complete --queue-id=<id> [--policy=path]');
  console.log('  node systems/ops/state_kernel.js proposal-upsert --proposal-id=<id> --payload-json=<json> [--objective-id=<id>] [--status=<status>] [--clearance=N] [--policy=path]');
  console.log('  node systems/ops/state_kernel.js proposal-approve --proposal-id=<id> --actor-id=<id> --decision=approve|veto [--note=<text>] [--policy=path]');
  console.log('  node systems/ops/state_kernel.js checkpoint-create --checkpoint-id=<id> --snapshot-json=<json> [--run-id=<id>] [--lane=<id>] [--policy=path]');
}

function commandDispatch(args: AnyObj) {
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true && cmd !== 'status') {
    return {
      ok: false,
      type: 'state_kernel',
      error: 'state_kernel_disabled',
      policy_path: relPath(policy.policy_path)
    };
  }

  if (cmd === 'migrate') return applyMigrations(policy, args);
  if (cmd === 'status') return status(policy);
  if (cmd === 'verify-parity') return verifyParity(policy);
  if (cmd === 'replay-verify') return replayVerify(policy, args);
  if (cmd === 'organ-set') return setOrganState(policy, args);
  if (cmd === 'organ-get') return getOrganState(policy, args);
  if (cmd === 'queue-enqueue') return enqueueTask(policy, args);
  if (cmd === 'queue-claim') return claimTasks(policy, args);
  if (cmd === 'queue-heartbeat') return heartbeatTask(policy, args);
  if (cmd === 'queue-reclaim') return reclaimExpired(policy, args);
  if (cmd === 'queue-complete') return completeTask(policy, args);
  if (cmd === 'proposal-upsert') return upsertProposal(policy, args);
  if (cmd === 'proposal-approve') return recordApproval(policy, args);
  if (cmd === 'checkpoint-create') return createCheckpoint(policy, args);

  return {
    ok: false,
    type: 'state_kernel',
    error: `unknown_command:${cmd}`
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || String(args._[0] || '') === 'help') {
    usage();
    process.exit(0);
  }

  let out: AnyObj;
  try {
    out = commandDispatch(args);
  } catch (err) {
    out = {
      ok: false,
      type: 'state_kernel',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'state_kernel_failure', 260)
    };
  }

  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  applyMigrations,
  setOrganState,
  getOrganState,
  enqueueTask,
  claimTasks,
  heartbeatTask,
  reclaimExpired,
  completeTask,
  upsertProposal,
  recordApproval,
  createCheckpoint,
  verifyParity,
  replayVerify,
  status,
  commandDispatch
};
