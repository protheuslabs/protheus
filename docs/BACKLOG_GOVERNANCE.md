# Backlog Governance

`systems/ops/backlog_registry.ts` is the canonical backlog governance lane.

## Source Of Truth

- Authoritative human source: `UPGRADE_BACKLOG.md`
- Generated artifacts:
  - `config/backlog_registry.json`
  - `docs/backlog_views/active.md`
  - `docs/backlog_views/archive.md`
- Lifecycle state:
  - `state/ops/backlog_registry/state.json`

Never hand-edit generated registry/view files.

## Commands

```bash
npm run ops:backlog:registry:sync
npm run ops:backlog:registry:check
npm run ops:backlog:registry:metrics
npm run ops:backlog:registry:triage
npm run ops:backlog:pathfinder:run
npm run ops:backlog:pathfinder:status
npm run ops:backlog:lane-batch:list
npm run ops:backlog:lane-batch:status
```

## Governance Checks

- WIP cap for `in_progress` rows (`governance.max_in_progress`)
- Template quality checks for active rows (`quality.*`)
- Dependency integrity checks for active rows
- Stale and purge-candidate detection using state age windows

## Metrics

- Throughput (done in last 7/30 days)
- Cycle time (`first_seen_at` -> `done_at`)
- Status distribution and active pressure

## Triage View

- Ready queue (`queued/proposed` with dependencies already done)
- Blocked items now dependency-clear
- Stale items and purge candidates
- Queued/proposed work blocked by open dependencies

## Execution Reality

- `systems/ops/backlog_queue_executor.ts` is a receipt/materialization lane.
- It does **not** mutate backlog status (`queued -> done`) by itself.
- Use `backlog_execution_pathfinder` to determine:
  - which queued rows are runnable now (`lane:<id>:run` exists and dependencies are closed),
  - which rows are dependency-ready but still missing implementation lanes,
  - which dependency IDs unlock the largest number of blocked rows.

## Batch Lane Coverage

- `systems/ops/backlog_lane_batch_delivery.ts` provides lane execution coverage for IDs that lacked dedicated lane scripts.
- Policy: `config/backlog_lane_batch_delivery_policy.json`
- Per-ID scripts are published as:
  - `lane:<id>:run`
  - `test:lane:<id>`
