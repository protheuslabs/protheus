#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
const queueSqlite = require('../../lib/queue_sqlite_runtime.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.BACKLOG_QUEUE_EXECUTOR_POLICY_PATH
  ? path.resolve(process.env.BACKLOG_QUEUE_EXECUTOR_POLICY_PATH)
  : path.join(ROOT, 'config', 'backlog_queue_executor_policy.json');

const EXECUTABLE_IDS = [
  "V3-RACE-195",
  "V3-RACE-196",
  "V3-RACE-197",
  "V3-RACE-198",
  "V3-RACE-199",
  "V3-RACE-200",
  "V3-RACE-201",
  "V3-RACE-202",
  "V3-RACE-203",
  "V3-RACE-215",
  "V3-RACE-216",
  "V3-RACE-217",
  "V3-RACE-218",
  "V3-RACE-219",
  "V3-RACE-220",
  "V3-RACE-221",
  "V3-RACE-222",
  "V3-RACE-223",
  "V3-RACE-224",
  "V3-RACE-225",
  "V3-RACE-226",
  "V3-RACE-227",
  "V3-RACE-228",
  "V3-RACE-229",
  "V3-RACE-230",
  "V3-RACE-231",
  "V3-RACE-232",
  "V3-RACE-233",
  "V3-RACE-234",
  "V3-RACE-235",
  "V3-RACE-236",
  "V3-RACE-237",
  "V3-RACE-238",
  "V3-RACE-239",
  "V3-RACE-240",
  "V3-RACE-241",
  "V3-RACE-242",
  "V3-RACE-243",
  "V3-RACE-244",
  "V3-RACE-245",
  "V3-RACE-246",
  "V3-RACE-247",
  "V3-RACE-248",
  "V3-RACE-249",
  "V3-RACE-250",
  "V3-RACE-251",
  "V3-RACE-252",
  "V3-RACE-253",
  "V3-RACE-254",
  "V3-RACE-255",
  "V3-RACE-256",
  "V3-RACE-257",
  "V3-RACE-258",
  "V3-RACE-259",
  "V3-RACE-260",
  "V3-RACE-261",
  "V3-RACE-262",
  "V3-RACE-263",
  "V3-RACE-264",
  "V3-RACE-265",
  "V3-RACE-266",
  "V3-RACE-267",
  "V3-RACE-268",
  "V3-RACE-269",
  "V3-RACE-270",
  "V3-RACE-271",
  "V3-RACE-272",
  "V3-RACE-273",
  "V3-RACE-274",
  "V3-RACE-275",
  "V3-RACE-276",
  "V3-RACE-277",
  "V3-RACE-278",
  "V3-RACE-279",
  "V3-RACE-280",
  "V3-RACE-281",
  "V3-RACE-282",
  "V3-RACE-283",
  "V3-RACE-284",
  "V3-RACE-285",
  "V3-RACE-286",
  "V3-RACE-287",
  "V3-RACE-288",
  "V3-RACE-289",
  "V3-RACE-290",
  "V3-RACE-291",
  "V3-RACE-292",
  "V3-RACE-293",
  "V3-RACE-294",
  "V3-RACE-295",
  "V3-RACE-296",
  "V3-RACE-297",
  "V3-RACE-298",
  "V3-RACE-299",
  "V3-RACE-300",
  "V3-RACE-301",
  "V3-RACE-302",
  "V3-RACE-303",
  "V3-RACE-304",
  "V3-RACE-305",
  "V3-RACE-306",
  "V3-RACE-307",
  "V3-RACE-308",
  "V3-RACE-309",
  "V3-RACE-310",
  "V3-RACE-311",
  "V3-RACE-312",
  "V3-RACE-313",
  "V3-RACE-314",
  "V3-RACE-315",
  "V3-RACE-316",
  "V3-RACE-317",
  "V3-RACE-318",
  "V3-RACE-319",
  "V3-RACE-320",
  "V3-RACE-321",
  "V3-RACE-322",
  "V3-RACE-323",
  "V3-RACE-324",
  "V3-RACE-325",
  "V3-RACE-326",
  "V3-RACE-327",
  "V3-RACE-328",
  "V3-RACE-329",
  "V3-RACE-330",
  "V3-RACE-331",
  "V3-RACE-332",
  "V3-RACE-333",
  "V3-RACE-334",
  "V3-RACE-335",
  "V3-RACE-336",
  "V3-RACE-337",
  "V3-RACE-338",
  "V3-RACE-339",
  "V3-RACE-340",
  "V3-RACE-341",
  "V3-RACE-342",
  "V3-RACE-343",
  "V3-RACE-344",
  "V3-RACE-345",
  "V3-RACE-346",
  "V3-RACE-347",
  "V3-RACE-348",
  "V3-RACE-349",
  "V3-RACE-350",
  "V3-RACE-351",
  "V3-RACE-352",
  "V3-RACE-353",
  "V3-RACE-354",
  "V3-RACE-355"
];

function nowIso(): string {
  return new Date().toISOString();
}

function rel(filePath: string): string {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function cleanText(v: unknown, maxLen = 320): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = String(tok).indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false): boolean {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}): AnyObj {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj): void {
  ensureDir(path.dirname(filePath));
  const tmp =     filePath + '.tmp-' + String(Date.now()) + '-' + String(process.pid);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function defaultPolicy(): AnyObj {
  return {
    schema_id: 'backlog_queue_executor_policy',
    schema_version: '1.0',
    enabled: true,
    registry_path: 'config/backlog_registry.json',
    state_root: 'state/ops/backlog_queue_executor',
    latest_path: 'state/ops/backlog_queue_executor/latest.json',
    history_path: 'state/ops/backlog_queue_executor/history.jsonl',
    sqlite: {
      enabled: true,
      db_path: 'state/ops/backlog_queue_executor/queue.db',
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
      busy_timeout_ms: 8000,
      queue_name: 'backlog_queue_executor',
      migrate_history_jsonl: true,
      mirror_jsonl: true
    }
  };
}

function resolvePath(raw: unknown, fallbackRel: string): string {
  const txt = cleanText(raw, 360);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function loadPolicy(policyPath: string): AnyObj {
  const base = defaultPolicy();
  const raw = readJson(policyPath, base);
  const sqliteRaw = raw.sqlite && typeof raw.sqlite === 'object' ? raw.sqlite : {};
  return {
    schema_id: 'backlog_queue_executor_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    registry_path: resolvePath(raw.registry_path || base.registry_path, base.registry_path),
    state_root: resolvePath(raw.state_root || base.state_root, base.state_root),
    latest_path: resolvePath(raw.latest_path || base.latest_path, base.latest_path),
    history_path: resolvePath(raw.history_path || base.history_path, base.history_path),
    sqlite: {
      enabled: sqliteRaw.enabled !== false,
      db_path: resolvePath(sqliteRaw.db_path || base.sqlite.db_path, base.sqlite.db_path),
      journal_mode: cleanText(sqliteRaw.journal_mode || base.sqlite.journal_mode, 24).toUpperCase() || 'WAL',
      synchronous: cleanText(sqliteRaw.synchronous || base.sqlite.synchronous, 24).toUpperCase() || 'NORMAL',
      busy_timeout_ms: Number.isFinite(Number(sqliteRaw.busy_timeout_ms))
        ? Math.max(100, Number(sqliteRaw.busy_timeout_ms))
        : Number(base.sqlite.busy_timeout_ms || 8000),
      queue_name: cleanText(sqliteRaw.queue_name || base.sqlite.queue_name, 120) || 'backlog_queue_executor',
      migrate_history_jsonl: sqliteRaw.migrate_history_jsonl !== false,
      mirror_jsonl: sqliteRaw.mirror_jsonl !== false
    }
  };
}

function normalizeId(raw: unknown): string {
  return cleanText(raw, 120).toUpperCase();
}

function loadRegistryRows(policy: AnyObj): AnyObj[] {
  const reg = readJson(policy.registry_path, {});
  return Array.isArray(reg.rows) ? reg.rows : [];
}

function selectTargets(rows: AnyObj[], args: AnyObj): AnyObj[] {
  const byId = new Map<string, AnyObj>();
  for (const row of rows) {
    const id = normalizeId(row && row.id || '');
    if (!id) continue;
    byId.set(id, row);
  }

  const requested = cleanText(args.ids || '', 8000)
    .split(',')
    .map((x) => normalizeId(x))
    .filter(Boolean);

  if (requested.length > 0) {
    return requested
      .map((id) => byId.get(id))
      .filter((row): row is AnyObj => !!row);
  }

  if (toBool(args.all, false) || String(args.mode || '').toLowerCase() === 'all') {
    return rows.filter((row) => normalizeId(row.status || '') === 'QUEUED');
  }

  const queuedIds = new Set(EXECUTABLE_IDS.map((id) => normalizeId(id)));
  return rows.filter((row) => {
    const id = normalizeId(row.id || '');
    const status = normalizeId(row.status || '');
    return status === 'QUEUED' && queuedIds.has(id);
  });
}

function executeRow(row: AnyObj, policy: AnyObj, dbCtx: AnyObj | null): AnyObj {
  const id = normalizeId(row.id || '');
  const status = cleanText(row.status || 'unknown', 40).toLowerCase();
  const receiptDir = path.join(policy.state_root, 'receipts');
  const receiptPath = path.join(receiptDir, id + '.json');
  const historyPath = path.join(policy.state_root, 'receipts_history.jsonl');

  const receipt = {
    schema_id: 'backlog_queue_execution_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: true,
    ts: nowIso(),
    id,
    class: cleanText(row.class || '', 80) || null,
    wave: cleanText(row.wave || '', 40) || null,
    status_before: status,
    title: cleanText(row.title || '', 400) || null,
    dependencies: Array.isArray(row.dependencies) ? row.dependencies : [],
    execution_mode: 'queued_backlog_lane_materialization',
    execution_surface: 'systems/ops/backlog_queue_executor.ts',
    policy_path: rel(DEFAULT_POLICY_PATH),
    receipt_path: rel(receiptPath)
  };

  if (dbCtx && dbCtx.db) {
    const queueName = cleanText(policy.sqlite && policy.sqlite.queue_name || 'backlog_queue_executor', 120) || 'backlog_queue_executor';
    queueSqlite.upsertQueueItem(dbCtx.db, queueName, row, status);
    queueSqlite.appendQueueEvent(dbCtx.db, queueName, id, 'queue_execute', {
      lane_id: id,
      status_before: status,
      title: receipt.title,
      wave: receipt.wave,
      class: receipt.class
    }, receipt.ts);
    const sqlReceipt = queueSqlite.insertReceipt(dbCtx.db, id, receipt);
    receipt.sqlite_receipt_id = cleanText(sqlReceipt && sqlReceipt.receipt_id || '', 120) || null;
  }

  if (!dbCtx || policy.sqlite.mirror_jsonl !== false) {
    writeJsonAtomic(receiptPath, receipt);
    appendJsonl(historyPath, receipt);
  }
  return receipt;
}

function run(policyPath: string, args: AnyObj): AnyObj {
  const policy = loadPolicy(policyPath);
  if (policy.enabled === false) {
    return {
      ok: true,
      skipped: true,
      reason: 'disabled',
      type: 'backlog_queue_executor',
      ts: nowIso(),
      policy_path: rel(policyPath)
    };
  }

  const rows = loadRegistryRows(policy);
  const targets = selectTargets(rows, args);
  let dbCtx: AnyObj | null = null;
  let migration: AnyObj | null = null;
  if (policy.sqlite && policy.sqlite.enabled !== false) {
    const db = queueSqlite.openQueueDb(policy.sqlite);
    queueSqlite.ensureQueueSchema(db);
    migration = policy.sqlite.migrate_history_jsonl === false
      ? {
          applied: false,
          skipped: true,
          reason: 'migration_disabled',
          rows_migrated: 0
        }
      : queueSqlite.migrateHistoryJsonl(
          db,
          policy.history_path,
          cleanText(policy.sqlite.queue_name || 'backlog_queue_executor', 120) || 'backlog_queue_executor'
        );
    dbCtx = { db, migration };
  }
  const receipts = targets.map((row) => executeRow(row, policy, dbCtx));
  const sqliteStats = dbCtx && dbCtx.db
    ? queueSqlite.queueStats(dbCtx.db, cleanText(policy.sqlite.queue_name || 'backlog_queue_executor', 120) || 'backlog_queue_executor')
    : null;
  if (dbCtx && dbCtx.db && typeof dbCtx.db.close === 'function') {
    try { dbCtx.db.close(); } catch {}
  }

  const summary = {
    schema_id: 'backlog_queue_executor_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: true,
    type: 'backlog_queue_executor',
    action: 'run',
    ts: nowIso(),
    policy_path: rel(policyPath),
    registry_path: rel(policy.registry_path),
    queued_ids_catalog_size: EXECUTABLE_IDS.length,
    target_count: targets.length,
    executed_count: receipts.length,
    executed_ids: receipts.map((r) => r.id),
    sqlite: {
      enabled: !!(policy.sqlite && policy.sqlite.enabled !== false),
      db_path: policy.sqlite && policy.sqlite.enabled !== false ? rel(policy.sqlite.db_path) : null,
      migration: migration || null,
      stats: sqliteStats
    },
    state_root: rel(policy.state_root),
    latest_path: rel(policy.latest_path),
    history_path: rel(policy.history_path)
  };

  writeJsonAtomic(policy.latest_path, summary);
  appendJsonl(policy.history_path, summary);
  return summary;
}

function status(policyPath: string): AnyObj {
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.latest_path, null as unknown as AnyObj);
  let sqlite: AnyObj = {
    enabled: !!(policy.sqlite && policy.sqlite.enabled !== false),
    db_path: policy.sqlite && policy.sqlite.enabled !== false ? rel(policy.sqlite.db_path) : null,
    stats: null
  };
  if (policy.sqlite && policy.sqlite.enabled !== false) {
    let db: any = null;
    try {
      db = queueSqlite.openQueueDb(policy.sqlite);
      queueSqlite.ensureQueueSchema(db);
      sqlite = {
        ...sqlite,
        stats: queueSqlite.queueStats(db, cleanText(policy.sqlite.queue_name || 'backlog_queue_executor', 120) || 'backlog_queue_executor')
      };
    } catch (err: any) {
      sqlite = {
        ...sqlite,
        error: cleanText(err && err.message || 'sqlite_status_failed', 220)
      };
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch {}
      }
    }
  }
  return {
    ok: true,
    type: 'backlog_queue_executor',
    action: 'status',
    ts: nowIso(),
    policy_path: rel(policyPath),
    latest,
    sqlite,
    queued_ids_catalog_size: EXECUTABLE_IDS.length
  };
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/backlog_queue_executor.js run [--all=1] [--ids=A,B,C] [--policy=<path>]');
  console.log('  node systems/ops/backlog_queue_executor.js status [--policy=<path>]');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase();
  if (args.help || cmd === 'help') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy
    ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
    : DEFAULT_POLICY_PATH;

  if (cmd === 'run') {
    const out = run(policyPath, args);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (toBool(args.strict, false) && out.ok !== true) process.exit(1);
    return;
  }

  if (cmd === 'status') {
    const out = status(policyPath);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) main();
