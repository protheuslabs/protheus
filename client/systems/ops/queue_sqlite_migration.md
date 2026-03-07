# Queue SQLite Migration Plan

## Context

`backlog_queue_executor` historically persisted queue execution state in JSONL artifacts only:

- `state/ops/backlog_queue_executor/history.jsonl`
- `state/ops/backlog_queue_executor/receipts_history.jsonl`

That format is easy to inspect, but it is not ideal for concurrent writers and selective querying.

## Objectives

1. Preserve behavior and existing JSONL receipts.
2. Add SQLite as the primary concurrent-write queue store with WAL mode.
3. Provide deterministic JSONL -> SQLite migration for existing history.
4. Keep rollback simple (`mirror_jsonl` remains enabled by default).

## Storage Model

SQLite database (default):

- `state/ops/backlog_queue_executor/queue.db`

Tables:

- `backlog_queue_items`
  - one row per lane id
  - latest queue metadata + payload snapshot
- `backlog_queue_events`
  - append-style event stream (`queue_execute`, imported history events)
- `backlog_queue_receipts`
  - normalized execution receipts keyed by stable content hash
- `queue_schema_migrations`
  - idempotent migration tracking (`jsonl_history_to_sqlite:<path>`)

## Concurrency Controls

- `PRAGMA journal_mode=WAL`
- `PRAGMA synchronous=NORMAL`
- `PRAGMA busy_timeout=8000`

These settings allow independent workers to write without global file-lock contention typical of JSONL append paths.

## Migration Sequence

1. Open DB and ensure schema.
2. If `migrate_history_jsonl=true`, import `history.jsonl` into `backlog_queue_events`.
3. Mark migration in `queue_schema_migrations` to avoid re-import loops.
4. Continue live writes into SQLite.
5. Keep JSONL mirror writes enabled (`mirror_jsonl=true`) for rollback and human audit.

## Rollback Plan

If SQLite path fails or must be disabled:

1. Set `sqlite.enabled=false` in `client/config/backlog_queue_executor_policy.json`.
2. Continue running with JSONL-only state (existing code path remains valid).
3. SQLite artifact remains for forensic/audit reads and can be removed later.

## Validation Checklist

- `node client/memory/tools/tests/backlog_queue_executor.test.js`
- `node client/memory/tools/tests/backlog_queue_executor_sqlite_concurrency.test.js`
- `node client/systems/ops/backlog_queue_executor.js run --all=1 --strict=1`
- `node client/systems/ops/backlog_queue_executor.js status`

Expected:

- `sqlite.enabled=true`
- non-zero `sqlite.stats.events` after run
- no regression in JSONL receipt generation
