# TODO (Maintenance + Policy + SRS Execution Order)

Updated: 2026-03-11 17:45 America/Denver

## Ordering policy
- Priority first (`P0` > `P1` > `P2` > `P3`)
- Then ROI / risk reduction
- Then dependency order

## Live baseline
- `rust_share_pct`: `74.939%` (`npm run -s metrics:rust-share`)
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
- Map summary snapshot:
- `actionable_total=835`
- `queued=597`
- `in_progress=211`
- `blocked=27`
- `execute_now=0`
- `repair_lane=0`
- `design_required=808`
- `blocked_external=27`

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
- `808` items mapped to `design_required` (no executable lane yet).
- `27` items mapped to `blocked_external` (explicit external dependencies).
- All remaining work is visible and auditable in the actionable map artifacts.

## Executed in this pass
- Added `scripts/ci/srs_actionable_map.mjs` to produce canonical remaining-work mapping and executability buckets.
- Reviewed enforcer policy and kept DoD evidence gates strict.
- Executed complete runnable backlog queue tranche and recorded deterministic receipts.
- Kept client/core policy audits and full regression suite passing after state transitions.

## Next command bundle
- `node scripts/ci/srs_actionable_map.mjs`
- `node scripts/ci/srs_full_regression.mjs`
- `node scripts/ci/srs_top200_regression.mjs`
- `node scripts/ci/backlog_actionable_report.mjs`
- `npm run -s ops:client-target:audit`
- `./verify.sh`
