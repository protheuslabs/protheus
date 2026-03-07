#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 320): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonl(filePath: string): AnyObj[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
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

function nowIso() {
  return new Date().toISOString();
}

function normalizeQueueName(v: unknown): string {
  const raw = cleanText(v || '', 140).toLowerCase();
  const normalized = raw.replace(/[^a-z0-9._:-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'default_queue';
}

function isLockedError(err: unknown): boolean {
  const msg = cleanText((err as any)?.message || '', 200).toLowerCase();
  return msg.includes('database is locked') || Number((err as any)?.errcode || 0) === 5;
}

function sleepMs(ms: number) {
  const waitMs = Math.max(1, Number(ms) || 1);
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, waitMs);
}

function execWithLockRetry(db: any, sql: string, maxRetries = 6): void {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      db.exec(sql);
      return;
    } catch (err) {
      if (!isLockedError(err) || attempt >= maxRetries) throw err;
      sleepMs(20 * Math.pow(2, attempt));
      attempt += 1;
    }
  }
}

function openQueueDb(sqliteCfg: AnyObj) {
  const dbPath = String(sqliteCfg && sqliteCfg.db_path || '').trim();
  if (!dbPath) throw new Error('queue_sqlite_db_path_required');
  ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  const journalMode = cleanText(sqliteCfg.journal_mode || 'WAL', 24).toUpperCase() || 'WAL';
  const synchronous = cleanText(sqliteCfg.synchronous || 'NORMAL', 24).toUpperCase() || 'NORMAL';
  const busyTimeoutMs = Number.isFinite(Number(sqliteCfg.busy_timeout_ms))
    ? Math.max(100, Number(sqliteCfg.busy_timeout_ms))
    : 5000;

  // Set busy timeout first so subsequent pragma writes tolerate startup contention.
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  execWithLockRetry(db, `PRAGMA journal_mode=${journalMode};`);
  execWithLockRetry(db, `PRAGMA synchronous=${synchronous};`);
  execWithLockRetry(db, `PRAGMA foreign_keys=ON;`);
  return db;
}

function ensureQueueSchema(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      detail_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backlog_queue_items (
      lane_id TEXT PRIMARY KEY,
      queue_name TEXT NOT NULL,
      class TEXT,
      wave TEXT,
      status TEXT NOT NULL,
      title TEXT,
      dependencies_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backlog_queue_lookup
      ON backlog_queue_items(queue_name, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS backlog_queue_events (
      event_id TEXT PRIMARY KEY,
      queue_name TEXT NOT NULL,
      lane_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backlog_queue_events_lookup
      ON backlog_queue_events(queue_name, ts DESC);
    CREATE TABLE IF NOT EXISTS backlog_queue_receipts (
      receipt_id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backlog_queue_receipts_lane
      ON backlog_queue_receipts(lane_id, ts DESC);
  `);
}

function migrationAlreadyApplied(db: any, migrationId: string): boolean {
  const row = db.prepare('SELECT migration_id FROM queue_schema_migrations WHERE migration_id = ? LIMIT 1').get(migrationId);
  return !!(row && row.migration_id);
}

function markMigrationApplied(db: any, migrationId: string, detail: AnyObj) {
  db.prepare(`
    INSERT OR REPLACE INTO queue_schema_migrations (migration_id, applied_at, detail_json)
    VALUES (?, ?, ?)
  `).run(migrationId, nowIso(), JSON.stringify(detail || {}));
}

function migrateHistoryJsonl(db: any, historyPath: string, queueName = 'backlog_queue_executor') {
  const migrationId = `jsonl_history_to_sqlite:${path.resolve(historyPath)}`;
  if (!historyPath || !fs.existsSync(historyPath)) {
    return { applied: false, skipped: true, reason: 'history_path_missing', rows_migrated: 0, migration_id: migrationId };
  }
  if (migrationAlreadyApplied(db, migrationId)) {
    return { applied: false, skipped: true, reason: 'already_applied', rows_migrated: 0, migration_id: migrationId };
  }

  const rows = readJsonl(historyPath);
  if (!rows.length) {
    markMigrationApplied(db, migrationId, {
      source_path: historyPath,
      rows_migrated: 0
    });
    return { applied: true, skipped: false, reason: 'empty_source', rows_migrated: 0, migration_id: migrationId };
  }

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO backlog_queue_events (
      event_id, queue_name, lane_id, event_type, payload_json, ts
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  let migratedCount = 0;
  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    for (const row of rows) {
      const payloadJson = stableStringify(row || {});
      const eventId = sha256Hex(payloadJson);
      const laneId = cleanText(row && (row.lane_id || row.id) || '', 120) || null;
      const eventType = cleanText(row && row.action || 'history_import', 80) || 'history_import';
      const ts = cleanText(row && (row.ts || row.timestamp) || '', 120) || nowIso();
      const out = insertEvent.run(
        eventId,
        normalizeQueueName(queueName),
        laneId,
        eventType,
        payloadJson,
        ts
      );
      if (Number(out && out.changes || 0) > 0) migratedCount += 1;
    }
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }
  markMigrationApplied(db, migrationId, {
    source_path: historyPath,
    rows_seen: rows.length,
    rows_migrated: migratedCount
  });
  return {
    applied: true,
    skipped: false,
    reason: 'ok',
    rows_seen: rows.length,
    rows_migrated: migratedCount,
    migration_id: migrationId
  };
}

function upsertQueueItem(db: any, queueName: string, row: AnyObj, status: string) {
  const laneId = cleanText(row && row.id || '', 120).toUpperCase();
  if (!laneId) return { ok: false, error: 'lane_id_missing' };
  const payloadJson = stableStringify(row || {});
  const updatedAt = nowIso();
  db.prepare(`
    INSERT INTO backlog_queue_items (
      lane_id, queue_name, class, wave, status, title, dependencies_json, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lane_id) DO UPDATE SET
      queue_name=excluded.queue_name,
      class=excluded.class,
      wave=excluded.wave,
      status=excluded.status,
      title=excluded.title,
      dependencies_json=excluded.dependencies_json,
      payload_json=excluded.payload_json,
      updated_at=excluded.updated_at
  `).run(
    laneId,
    normalizeQueueName(queueName),
    cleanText(row && row.class || '', 120) || null,
    cleanText(row && row.wave || '', 80) || null,
    cleanText(status || row && row.status || 'queued', 40).toLowerCase(),
    cleanText(row && row.title || '', 400) || null,
    JSON.stringify(Array.isArray(row && row.dependencies) ? row.dependencies : []),
    payloadJson,
    updatedAt
  );
  return { ok: true, lane_id: laneId, updated_at: updatedAt };
}

function appendQueueEvent(db: any, queueName: string, laneId: string, eventType: string, payload: AnyObj, ts = nowIso()) {
  const payloadJson = stableStringify(payload || {});
  const eventId = sha256Hex(`${normalizeQueueName(queueName)}|${laneId}|${eventType}|${payloadJson}|${ts}`);
  db.prepare(`
    INSERT OR IGNORE INTO backlog_queue_events (
      event_id, queue_name, lane_id, event_type, payload_json, ts
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    normalizeQueueName(queueName),
    cleanText(laneId, 120).toUpperCase() || null,
    cleanText(eventType, 80) || 'event',
    payloadJson,
    cleanText(ts, 120) || nowIso()
  );
  return { event_id: eventId };
}

function insertReceipt(db: any, laneId: string, receipt: AnyObj) {
  const payloadJson = stableStringify(receipt || {});
  const receiptId = sha256Hex(payloadJson);
  const ts = cleanText(receipt && receipt.ts || '', 120) || nowIso();
  db.prepare(`
    INSERT OR REPLACE INTO backlog_queue_receipts (receipt_id, lane_id, receipt_json, ts)
    VALUES (?, ?, ?, ?)
  `).run(receiptId, cleanText(laneId, 120).toUpperCase(), payloadJson, ts);
  return { receipt_id: receiptId, ts };
}

function queueStats(db: any, queueName: string) {
  const q = normalizeQueueName(queueName);
  const itemRow = db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_items WHERE queue_name = ?').get(q);
  const eventRow = db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_events WHERE queue_name = ?').get(q);
  const receiptRow = db.prepare('SELECT COUNT(*) AS count FROM backlog_queue_receipts').get();
  return {
    queue_name: q,
    items: Number(itemRow && itemRow.count || 0),
    events: Number(eventRow && eventRow.count || 0),
    receipts: Number(receiptRow && receiptRow.count || 0)
  };
}

module.exports = {
  openQueueDb,
  ensureQueueSchema,
  migrateHistoryJsonl,
  upsertQueueItem,
  appendQueueEvent,
  insertReceipt,
  queueStats
};
