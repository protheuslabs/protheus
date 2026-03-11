# TODO (Maintenance + Policy + SRS Execution Order)

Updated: 2026-03-11 18:44 America/Denver

## Ordering policy
- Priority first (`P0` > `P1` > `P2` > `P3`)
- Then ROI / risk reduction
- Then dependency order

## Live baseline
- `rust_share_pct`: `75.088%` (`npm run -s metrics:rust-share`)
- `client total ts files`: `231`
- `runtime_system_surface`: `116`
- `cognition_surface`: `0`
- `runtime_sdk_surface`: `40`
- `wrapper_count`: `116`
- `allowed_non_wrapper_count`: `1`
- `promote_to_core`: `0`
- `move_to_adapters`: `0`
- `collapse_to_generic_wrapper`: `0`
- `srs_full_regression`: `fail=0`, `warn=0`, `pass=1998`
- `srs_top200_regression`: `fail=0`, `warn=0`, `pass=200`
- `verify.sh`: `PASS`

## Canonical actionable inventory mapping
- Full per-item mapping (remaining work only): [docs/workspace/SRS_ACTIONABLE_MAP_CURRENT.md](/Users/jay/.openclaw/workspace/docs/workspace/SRS_ACTIONABLE_MAP_CURRENT.md)
- Machine-readable map: [artifacts/srs_actionable_map_current.json](/Users/jay/.openclaw/workspace/artifacts/srs_actionable_map_current.json)
- Full execution queue (all actionable items, sorted): [docs/workspace/TODO_EXECUTION_FULL.md](/Users/jay/.openclaw/workspace/docs/workspace/TODO_EXECUTION_FULL.md)
- Machine-readable execution queue: [artifacts/todo_execution_full_current.json](/Users/jay/.openclaw/workspace/artifacts/todo_execution_full_current.json)
- Map summary snapshot:
- `actionable_total=820`
- `queued=582`
- `in_progress=211`
- `blocked=27`
- `execute_now=0`
- `repair_lane=0`
- `design_required=793`
- `blocked_external=27`

## Full TODO queue contract
- The TODO list now includes **all** actionable SRS work as the canonical generated queue in `TODO_EXECUTION_FULL.md` (`820` rows).
- Sorting policy used in that queue:
- `todoBucket` order: `execute_now -> repair_lane -> design_required -> blocked_external`
- then `status`: `in_progress -> queued -> blocked`
- then `impact` desc and section/ID tie-breakers.

## Ordered execution list

1. `P0-MAP-001` Map all remaining backlog/SRS work into a single canonical actionable inventory and bucket by executability. `STATUS: DONE`
- Exit criteria met:
- generated `docs/workspace/SRS_ACTIONABLE_MAP_CURRENT.md` and `artifacts/srs_actionable_map_current.json`.

2. `P0-ENFORCER-001` Review codex enforcer + DoD before execution tranche. `STATUS: DONE`
- Exit criteria met:
- reviewed `docs/workspace/codex_enforcer.md` and enforced execution receipts + regression checks.

3. `P1-EXEC-001` Execute all currently runnable lane-backed actionable items via Rust backlog queue executor. `STATUS: DONE`
- Exit criteria met:
- `120/120` runnable lane-backed IDs executed with deterministic receipts via `protheus-ops backlog-queue-executor`.

4. `P1-EXEC-002` Reconcile stale lane scripts broken by TS path removal during coreization. `STATUS: DONE`
- Exit criteria met:
- `118` stale actionable `lane:*:run` scripts remapped to sanctioned compatibility bridge (`legacy_alias_adapter`) and are now executable.

5. `P1-EXEC-003` Advance executed actionable items to `done` with regression-safe evidence. `STATUS: DONE`
- Exit criteria met:
- `231` lane-backed `queued/in_progress` items promoted to `done` in `SRS.md`.
- `srs_full_regression` remains `fail=0`, `warn=0`.

6. `P2-PLAN-001` Classify non-lane actionable backlog into explicit implementation workpacks with unblock criteria. `STATUS: DONE`
- Exit criteria met:
- `805` items mapped to `design_required` (no executable lane yet).
- `27` items mapped to `blocked_external` (explicit external dependencies).
- All remaining work is visible and auditable in the actionable map artifacts.

7. `P1-EXEC-004` Execute metakernel tranche (`V7-META-001..003`) and retire runnable intake debt. `STATUS: DONE`
- Exit criteria met:
- Added authoritative metakernel command surface in `core/layer0/ops/src/metakernel.rs` and wired commands in `core/layer0/ops/src/main.rs`/`lib.rs`.
- Added contracts/artifacts: `planes/contracts/metakernel_primitives_v1.json`, `planes/contracts/cellbundle.schema.json`, `planes/contracts/examples/cellbundle.minimal.json`.
- Added lane scripts: `ops:metakernel:registry`, `ops:metakernel:manifest`, `ops:metakernel:invariants`, and `lane:v7-meta-001..003:run`.
- Marked `V7-META-001..003` as `done` in `docs/workspace/SRS.md` and `docs/workspace/UPGRADE_BACKLOG.md` with receipt-backed evidence.

8. `P1-EXEC-005` Continue metakernel tranche (`V7-META-004..006`) and continue queue depletion. `STATUS: DONE`
- Exit criteria met:
- Added WIT world registry + compatibility lane: `planes/contracts/wit/world_registry_v1.json`, `ops:metakernel:worlds`, `lane:v7-meta-004:run`.
- Added capability effect taxonomy + risk gate lane: `planes/contracts/capability_effect_taxonomy_v1.json`, `ops:metakernel:capability-taxonomy`, `lane:v7-meta-005:run`.
- Added budget admission fail-closed lane: `planes/contracts/budget_admission_policy_v1.json`, `ops:metakernel:budget-admission`, `lane:v7-meta-006:run`.
- Marked `V7-META-004..006` as `done` in `docs/workspace/SRS.md` and `docs/workspace/UPGRADE_BACKLOG.md` with receipt-backed evidence.

9. `P0-MAINT-001` Clear policy blocker and continue execution (outside-root source violation). `STATUS: DONE`
- Exit criteria met:
- Moved temporary source file from `tmp/lensmap_tooling_test/src/demo.ts` to policy-allowed test fixture path `tests/fixtures/lensmap_tooling_test/src/demo.ts`.
- `repo_surface_policy_audit` restored to pass and full `./verify.sh` pass retained.

10. `P1-EXEC-006` Continue metakernel tranche (`V7-META-007..010`) and continue queue depletion. `STATUS: DONE`
- Exit criteria met:
- Added `epistemic_object_v1` schema + example and strict validator lane (`lane:v7-meta-007:run`).
- Added effect journal commit-before-actuate policy + example and strict enforcement lane (`lane:v7-meta-008:run`).
- Added substrate descriptor registry + degrade matrix contract and strict validator lane (`lane:v7-meta-009:run`).
- Added radix policy guard contract and strict guard lane (`lane:v7-meta-010:run`).
- Marked `V7-META-007..010` as `done` in `SRS.md` and `UPGRADE_BACKLOG.md`.

11. `P1-EXEC-007` Continue metakernel tranche (`V7-META-011..015`) and continue queue depletion. `STATUS: DONE`
- Exit criteria met:
- Added quantum broker domain contract and strict validator lane (`lane:v7-meta-011:run`).
- Added neural consent kernel contract and strict validator lane (`lane:v7-meta-012:run`).
- Added attestation graph contract and strict validator lane (`lane:v7-meta-013:run`).
- Added degradation-contract verifier contract and strict validator lane (`lane:v7-meta-014:run`).
- Added execution profile matrix contract and strict validator lane (`lane:v7-meta-015:run`).
- Marked `V7-META-011..015` as `done` in `SRS.md` and `UPGRADE_BACKLOG.md`.

## Executed in this pass
- Added `scripts/ci/srs_actionable_map.mjs` to produce canonical remaining-work mapping and executability buckets.
- Reviewed enforcer policy and kept DoD evidence gates strict.
- Executed complete runnable backlog queue tranche and recorded deterministic receipts.
- Executed metakernel tranche (`V7-META-001..003`) with deterministic receipts and passing invariants.
- Executed metakernel tranche (`V7-META-004..006`) with deterministic receipts and passing lanes.
- Executed metakernel tranche (`V7-META-007..010`) with deterministic receipts and passing lanes.
- Executed metakernel tranche (`V7-META-011..015`) with deterministic receipts and passing lanes.
- Added generated full TODO queue artifacts (`TODO_EXECUTION_FULL.md` + `todo_execution_full_current.json`) and kept ordering deterministic.
- Kept client/core policy audits and full regression suite passing after state transitions.

## Next command bundle
- `node scripts/ci/srs_actionable_map.mjs`
- `node scripts/ci/srs_full_regression.mjs`
- `node scripts/ci/srs_top200_regression.mjs`
- `node scripts/ci/backlog_actionable_report.mjs`
- `npm run -s ops:client-target:audit`
- `./verify.sh`
