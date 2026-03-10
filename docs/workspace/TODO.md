# TODO (Ordered Blocker Queue)

Updated: 2026-03-10 (after-devtools + layer2-refactor)

Backlog implementation remains paused until runtime validation is real (non-deferred).

## Ordering policy
- Priority: higher first (`P0` highest).
- ROI: higher first (unblocks more surface area).
- Dependency: prerequisites first.

## Ordered execution queue

1. `OPS-BLOCKER-001` `P0` `ROI=10/10` `DEP=none` Unblock local binary execution. `STATUS: BLOCKED`
- Exit criteria:
- `/tmp/hello_c_test` executes and exits `0` with expected stdout.
- `/tmp/hello_rust_test` executes and exits `0` with expected stdout.
- `./target/debug/protheus-ops status` returns a JSON receipt without timeout.
- Current evidence:
- `/tmp/hello_c_test` hangs (`ETIMEDOUT` / no stdout).
- `/tmp/hello_rust_test` hangs (`ETIMEDOUT` / no stdout).
- `./target/debug/protheus-ops status` hangs (`SIGALRM` timeout in guarded runner).
- `/usr/sbin/spctl --assess --type execute /tmp/hello_c_test` => rejected.
- `sample` shows stuck at `_dyld_start` before `main`.
- `syspolicyd` observed pegged for extended runtime and cannot be restarted from current user context.
- `DevToolsSecurity` and `spctl developer-mode enable-terminal` are enabled, but blocker persists in-session.
- Latest artifact: `artifacts/todo_execution_2026-03-10_after_devtools.json`.

2. `OPS-BLOCKER-002` `P0` `ROI=9/10` `DEP=001` Remove deferred host-stall fallback from validation path. `STATUS: COMPLETE`
- Exit criteria:
- No `ops_domain_deferred_host_stall` receipts during validation commands.
- Validation wrappers fail closed on host stall/timeouts.
- Completion notes:
- `client/runtime/lib/rust_lane_bridge.ts` default set to `PROTHEUS_OPS_DEFER_ON_HOST_STALL=0`.
- `client/runtime/lib/legacy_retired_wrapper.js` default set to `PROTHEUS_OPS_DEFER_ON_HOST_STALL=0`.
- Validation now returns hard failures (`spawnSync .../protheus-ops ETIMEDOUT`) instead of deferred receipts.

3. `OPS-BLOCKER-003` `P0` `ROI=8/10` `DEP=001,002` Re-run full regression with real runtime execution. `STATUS: PARTIAL (runtime blocked)`
- Exit criteria:
- `./verify.sh` completes without deferred-host-stall receipts.
- System test suite reports real pass/fail outcomes.
- Current evidence:
- Full snapshot artifact: `artifacts/blocker_regression_2026-03-10.json`.
- Ordered TODO execution artifacts:
- `artifacts/todo_execution_2026-03-10_resume.json`
- `artifacts/todo_execution_2026-03-10_resume2.json`
- `artifacts/todo_execution_2026-03-10_after_devtools.json`
- Non-runtime checks pass (`metrics:rust-share:gate`, `ops:layer-placement:check`, `coreization_wave1_static_audit`).
- Long suite commands (`./verify.sh`, `ops:srs:top200:regression`) still timeout in this host/runtime state.
- Runtime checks fail-closed on local binary timeout until blocker 001 is resolved.

4. `COREIZATION-GATE-001` `P1` `ROI=7/10` `DEP=none` Keep client authority surfaces wrapper-only. `STATUS: COMPLETE`
- Exit criteria:
- `node scripts/ci/coreization_wave1_static_audit.mjs` -> `pass: true`.
- `npm run -s ops:layer-placement:check` -> `violations_count: 0`.
- Additional simplification applied:
- 19 non-deterministic V6 feature lanes moved from `core/layer0/ops/src` to `core/layer2/ops/src` with Layer 2 dispatch via `protheus_ops_core_v1`.

5. `BACKLOG-RESUME` `P2` `ROI=10/10 (deferred)` `DEP=001,002,003,COREIZATION-GATE-001` Resume ROI backlog execution only after blockers 1-4 pass. `STATUS: BLOCKED`
- Exit criteria:
- Blockers 1-4 marked complete in this file and checkpoint doc.

## Commands

- `node scripts/ci/coreization_wave1_static_audit.mjs --out artifacts/coreization_wave1_static_audit_2026-03-10.json`
- `npm run -s ops:layer-placement:check`
- `npm run -s metrics:rust-share:gate`
- `npm run -s ops:srs:top200:regression`
