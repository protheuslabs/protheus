# TODO (Ordered Blocker Queue)

Updated: 2026-03-10 (runtime-unblocked + verification-green)

## Ordering policy
- Priority: higher first (`P0` highest).
- ROI: higher first (unblocks more surface area).
- Dependency: prerequisites first.

## Ordered execution queue

1. `OPS-BLOCKER-001` `P0` `ROI=10/10` `DEP=none` Unblock local binary execution. `STATUS: COMPLETE`
- Exit criteria:
- `/tmp/hello_c_test` executes and exits `0` with expected stdout.
- `/tmp/hello_rust_test` executes and exits `0` with expected stdout.
- `./target/debug/protheus-ops status` returns a JSON receipt without timeout.
- Completion evidence:
- `artifacts/todo_execution_2026-03-10_resume_runtime_unblocked.json`

2. `OPS-BLOCKER-002` `P0` `ROI=9/10` `DEP=001` Remove deferred host-stall fallback from validation path. `STATUS: COMPLETE`
- Exit criteria:
- No `ops_domain_deferred_host_stall` receipts during validation commands.
- Validation wrappers fail closed on host stall/timeouts.
- Completion notes:
- `client/runtime/lib/rust_lane_bridge.ts` defaults `PROTHEUS_OPS_DEFER_ON_HOST_STALL=0`.
- `client/runtime/lib/legacy_retired_wrapper.js` defaults `PROTHEUS_OPS_DEFER_ON_HOST_STALL=0`.

3. `OPS-BLOCKER-003` `P0` `ROI=8/10` `DEP=001,002` Re-run full regression with real runtime execution. `STATUS: COMPLETE`
- Exit criteria:
- `./verify.sh` completes without deferred-host-stall receipts.
- System test suite reports real pass/fail outcomes.
- Completion evidence:
- `./verify.sh` passed on 2026-03-10.
- `artifacts/todo_execution_2026-03-10_resume_runtime_unblocked.json`
- `artifacts/regression_suite_resume_runtime_unblocked.json`
- `artifacts/srs_top200_regression_2026-03-10.json`

4. `COREIZATION-GATE-001` `P1` `ROI=7/10` `DEP=none` Keep client authority surfaces wrapper-only. `STATUS: COMPLETE`
- Exit criteria:
- `node scripts/ci/coreization_wave1_static_audit.mjs` -> `pass: true`.
- `npm run -s ops:layer-placement:check` -> `violations_count: 0`.
- `npm run -s metrics:rust-share:gate` -> `rust_share_pct >= 60`.
- Current evidence:
- `artifacts/coreization_wave1_static_audit_2026-03-10_resume.json`
- Rust share now `64.884%`.

5. `BACKLOG-RESUME` `P2` `ROI=10/10` `DEP=001,002,003,COREIZATION-GATE-001` Resume ROI backlog execution now that blockers are clear. `STATUS: IN_PROGRESS`
- Exit criteria:
- Select next ROI tranche and execute against core-first lane ownership.
- Tranche progress:
- LLMN regression shield tranche completed (`V6-LLMN-001..004`), with passing evidence:
  - `node client/memory/tools/tests/llmn_mode_conformance.test.js`
  - `node client/memory/tools/tests/strategy_resolver.test.js`
  - `node client/memory/tools/tests/model_router_routing_features.test.js`
  - `node client/memory/tools/tests/model_router_variant_policy.test.js`
  - `node client/memory/tools/tests/legacy_path_alias_adapters.test.js`
- Smart-memory low-burn tranche completed for `V6-MEMORY-013..019`, with passing evidence:
  - `node client/memory/tools/tests/memory_recall_context_budget.test.js`
  - `node client/memory/tools/tests/conversation_eye_bootstrap.test.js`
  - `node client/memory/tools/tests/memory_burn_slo_guard.test.js`
  - `node client/memory/tools/tests/memory_efficiency_plane.test.js`
  - `node client/memory/tools/tests/memory_matrix.test.js`
  - `node client/memory/tools/tests/memory_auto_recall.test.js`
  - `node client/memory/tools/tests/memory_index_freshness_gate.test.js`
  - `cargo test --manifest-path core/layer1/memory_runtime/Cargo.toml`
- Token telemetry extension completed for `V6-MEMORY-021`:
  - `core/layer1/memory_runtime/src/token_telemetry.rs`
  - `cargo test --manifest-path core/layer1/memory_runtime/Cargo.toml`
- Swarm router closure tranche completed (`V6-SWARM-001..006`):
  - `cargo test --manifest-path core/layer0/swarm_router/Cargo.toml`
- Initiative/iceberg closure tranche completed (`V6-INITIATIVE-013`, `V6-ARCH-ICEBERG-028`):
  - `cargo test -p protheus-ops-core attention_queue`
  - `cargo test -p execution_core initiative`
  - `npm run -s test:ops:source-runtime-classifier`
  - `npm run -s test:ops:subconscious-boundary-guard`
- Primitive core closure tranche completed (`V6-PRIM-001`, `V6-PRIM-002`, `V6-PRIM-003`, `V6-PRIM-006`):
  - `cargo test -p task`
  - `cargo test -p resource`
  - `cargo test -p isolation`
  - `cargo test -p protheus-observability-core-v1`
- Primitive residual audit tranche completed (`V6-PRIM-009`):
  - `docs/client/reports/primitive_ts_logic_audit_2026-03-10.md`
  - `artifacts/primitive_ts_logic_audit_2026-03-10.json`
- Primitive wrapper contract lane remains in progress (`V6-PRIM-008`) with scoped gate:
  - `./target/debug/protheus-ops contract-check --rust-contract-check-ids=primitive_ts_wrapper_contract`

## Commands

- `node scripts/ci/coreization_wave1_static_audit.mjs --out artifacts/coreization_wave1_static_audit_2026-03-10_resume.json`
- `npm run -s ops:layer-placement:check`
- `npm run -s metrics:rust-share:gate`
- `npm run -s ops:srs:top200:regression`
- `./verify.sh`
