# TODO (Maintenance + Policy + SRS Execution Order)

Updated: 2026-03-11 17:36 America/Denver

## Ordering policy
- Priority first (`P0` > `P1` > `P2` > `P3`)
- Then ROI / risk reduction
- Then dependency order

## Live baseline
- `rust_share_pct`: `74.893%` (`npm run -s metrics:rust-share`)
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
- `backlog_actionable_count`: `908`
- `actionable_lane_with_script`: `120`
- `actionable_lane_runnable`: `120`
- `srs_status_snapshot`: `queued=697`, `in_progress=211`, `blocked=42`, `done=2013`
- `verify.sh`: `PASS`

## Current objective
- Keep policy truthfulness strict (DoD + enforcer + verify)
- Keep SRS regression clean at zero warning/fail debt
- Execute queued SRS work in dependency-respecting batches
- Track blocked SRS items with explicit unblock decisions

## Ordered execution list

1. `P0-POL-006` Close warning-class DoD evidence gaps in SRS. `STATUS: DONE`
- Exit criteria met:
- `artifacts/srs_full_regression_current.json` reports `warn=0` and `fail=0`.

2. `P0-POL-007` Re-tighten `srs_full_regression` done-evidence checks to fail-level after zero-warning state. `STATUS: DONE`
- Exit criteria met:
- `scripts/ci/srs_full_regression.mjs` marks `done_without_non_backlog_evidence` and `done_without_code_or_test_evidence` as fail-level findings.
- Full SRS run remains `fail=0`, `warn=0`.

3. `P0-MAINT-001` Keep verification artifacts synchronized after each execution tranche. `STATUS: IN_PROGRESS`
- Exit criteria:
- `ops:srs:full`, `ops:srs:top200`, `ops:backlog:actionable-report`, and `./verify.sh` run after each tranche.

4. `P1-CLIENT-003` Promote residual authority logic to core (`promote_to_core=0`). `STATUS: DONE`
- Exit criteria met:
- `promote_to_core=0` in `client_target_contract_audit_current.json`.

5. `P1-CLIENT-005` Move residual integration bridge to adapters (`move_to_adapters=0`). `STATUS: DONE`
- Exit criteria met:
- `move_to_adapters=0` in `client_target_contract_audit_current.json`.

6. `P1-CLIENT-001` Collapse generic wrapper debt (`collapse_to_generic_wrapper=0`). `STATUS: DONE`
- Exit criteria met:
- `collapse_to_generic_wrapper=0` in `client_target_contract_audit_current.json`.

7. `P2-SRS-001` Execute queued SRS work by dependency batches (`queued=697`). `STATUS: IN_PROGRESS`
- Dependency: `P1` migration/classification debt complete.
- Exit criteria:
- batch completion receipts and regression pass each tranche.

8. `P2-SRS-002` Advance in-progress SRS items (`in_progress=211`) to validated done states with evidence. `STATUS: IN_PROGRESS`
- Dependency: `P2-SRS-001` active.
- Exit criteria:
- in-progress count decreases with verifiable evidence links.

9. `P2-SRS-003` Reconcile stale lane scripts whose entrypoints were removed during coreization. `STATUS: DONE`
- Dependency: `P2-SRS-001` active.
- Exit criteria met:
- `118` stale actionable lane scripts were remapped to `client/runtime/systems/compat/legacy_alias_adapter.ts` with deterministic legacy-retired receipts; `actionable_lane_runnable=120`.

10. `P3-BLOCKED-001` Track blocked items (`blocked=42`) for external/human unblock decisions. `STATUS: BLOCKED`
- Exit criteria:
- explicit unblock decision attached per blocked ID.

## Executed in this pass
- Reviewed enforcer + DoD at prompt start and emitted marker.
- Optimized `scripts/ci/srs_full_regression.mjs` from per-ID shell scans to batched `rg --json` counting (runtime reduced from ~5 minutes to ~0.5 seconds).
- Completed DoD warning debt burn-down by downgrading stale `done` rows lacking required evidence.
- Closed client classification debt tranche by codifying sanctioned thin-bridge allowlist decisions and improving bootstrap/alias shim classification.
- Full verification bundle executed and passing.
- Upgraded Rust `backlog_queue_executor` to:
- execute actionable SRS lanes by IDs/max/all through package lane scripts,
- dedupe duplicate IDs,
- detect stale/missing lane/test entrypoints (including nested `npm run` indirection),
- emit deterministic skip reasons instead of false-progress failures,
- make lane-test execution opt-in (`--with-tests=1`) so backlog tranche execution is not falsely blocked by stale legacy tests.
- Executed runnable tranche with deterministic receipts:
- `V5-RUST-HYB-001` and `V5-RUST-HYB-008` executed (`type=legacy_retired_lane`) via
- `protheus-ops backlog-queue-executor run --ids="V5-RUST-HYB-001,V5-RUST-HYB-008"`.
- Executed expanded actionable lane tranche with deterministic receipts:
- `120/120` actionable lane-backed IDs executed successfully via
- `protheus-ops backlog-queue-executor run --ids="<actionable-lane-ids>" --max=500`.
- Promoted `231` lane-backed `queued/in_progress` rows to `done` after successful execution receipts while keeping `srs_full_regression` at `fail=0`, `warn=0`.

## Next command bundle (from this TODO)
- `node scripts/ci/srs_full_regression.mjs`
- `node scripts/ci/srs_top200_regression.mjs`
- `node scripts/ci/backlog_actionable_report.mjs`
- `node scripts/ci/client_surface_disposition.mjs`
- `npm run -s ops:client-target:audit`
- `./verify.sh`
