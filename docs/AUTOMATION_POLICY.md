# Automation Policy

As of 2026-02-19, this policy defines what is automatic, what is gated, and what requires operator approval.

## Purpose

- Keep systems behavior predictable.
- Prevent ambiguity between sensing and acting.
- Make autonomy progression explicit and auditable.

## Core Principle

- Eyes are passive sensors.
- Sensing is automatic.
- Acting is gated.

## Always Automatic (Spine Pipeline)

When `node systems/spine/spine.js eyes|daily` runs, these stages run deterministically:

1. `external_eyes run`
2. `external_eyes score`
3. `external_eyes evolve`
4. `eyes_insight run` (raw -> proposals)
5. `sensory_queue ingest`
6. `bridge_from_proposals run`

Daily mode additionally runs:

1. `queue_gc run`
2. `sensory_queue sweep`
3. `queue_log_compact run --apply=1`
4. `git_outcomes run`
5. `dopamine_engine closeout`
6. `sensory_digest daily`

Daily mode also forces one collector canary run:

- `external_eyes canary` (one non-stub eye, forced regardless cadence/cooldown)

## Automatic Observability

These are automatic and do not perform external side effects:

- Collector health summary ledger events (`spine_collector_health`)
- Daily signal SLO health event (`spine_signal_slo`)
- Router preflight + alerts (`spine_router_preflight`, `spine_router_alert`)
- No-actionable-signal receipts from `eyes_insight`
- Collector-starved anomaly snapshots
- Collector remediation proposal generation on repeated fetch failures

## Gated Autonomy (Feature Flag)

Autonomy execution is conditional:

- If `AUTONOMY_ENABLED=1`: `systems/autonomy/autonomy_controller.js run` executes in daily spine.
- Otherwise: spine records `spine_autonomy_skipped` with reason `feature_flag_disabled`.

This means proposal generation can be automatic while proposal execution remains gated.

## Human-Approved / Elevated Paths

These require explicit operator intent and/or elevated guard paths:

- External actuation execution (`systems/actuation/actuation_executor.js run ...`)
- Model catalog apply operations (`model_catalog_loop.js apply ...`) with approval note
- Any break-glass guarded operation under `systems/security/guard.js`

## Current Mode Clarification

- The system is not "manual only."
- It is "automation-first for sensing and preparation, gated for high-impact action."
- Empty actionable proposals usually indicate low/failed signal quality, not missing automation wiring.

## Operator Controls

- Check current health: `node systems/autonomy/health_status.js`
- View collector reliability: `node habits/scripts/external_eyes.js doctor`
- Force one collector probe run: `node habits/scripts/external_eyes.js canary`
- Inspect queue: `node habits/scripts/sensory_queue.js list --date=YYYY-MM-DD`

## Queue Hygiene Behavior

- `queue_gc` now applies budget-aware cap tuning before rejecting overflow proposals.
- Budget pressure source order:
1. `QUEUE_GC_BUDGET_PRESSURE` override (`none|soft|hard`)
2. active system budget autopause (`hard`)
3. `systems/budget/system_budget.js status` projection pressure
- Under pressure, GC tightens:
1. `cap_per_eye`
2. `cap_per_type`
3. `ttl_hours`
- `sensory_queue sweep` applies deterministic cleanup:
1. cross-signal family/topic duplicate pruning
2. stale-open rejection gate (`SENSORY_QUEUE_STALE_OPEN_HOURS`)
3. no-op repeated reject suppression (same reason/note for already-rejected proposal)
