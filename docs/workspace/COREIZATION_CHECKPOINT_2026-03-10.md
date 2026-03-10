# Coreization Checkpoint (2026-03-10)

## Scope
- Hard Coreization Wave 1 static verification pass for:
  - `client/runtime/systems/security`
  - `client/runtime/systems/spine`
  - `client/runtime/systems/memory`
  - `client/runtime/systems/autonomy`
  - `client/runtime/systems/workflow`
  - `client/runtime/systems/ops/protheusd.ts`

## Static Audit Result
- Command:
  - `node scripts/ci/coreization_wave1_static_audit.mjs --out artifacts/coreization_wave1_static_audit_2026-03-10.json`
- Result:
  - `pass: true`
  - `violation_count: 0`
  - `warning_count: 0`
- Module summary:
  - `security`: wrappers `197`, non-wrappers `0`
  - `spine`: wrappers `14`, non-wrappers `0`
  - `memory`: wrappers `63`, non-wrappers `0`
  - `autonomy`: wrappers `122`, non-wrappers `0`
  - `workflow`: wrappers `35`, non-wrappers `0`
  - `ops-daemon`: wrappers `1`, non-wrappers `0`

## Cleanup Applied
- Added missing ownership marker in:
  - `client/runtime/systems/security/venom_containment_layer.ts`
- Added wrapper-policy marker token used by layer-placement guard:
  - `client/runtime/systems/security/venom_containment_layer.ts`
- Layer simplification/refactor:
  - Moved 19 high-level V6 feature lanes from `core/layer0/ops/src` to `core/layer2/ops/src`:
    - `opendev_dual_agent`, `company_layer_orchestration`, `wifi_csi_engine`,
      `biological_computing_adapter`, `observability_automation_engine`,
      `persistent_background_runtime`, `workspace_gateway_runtime`, `p2p_gossip_seed`,
      `startup_agency_builder`, `timeseries_receipt_engine`, `webgpu_inference_adapter`,
      `context_doctor`, `discord_swarm_orchestration`, `bookmark_knowledge_pipeline`,
      `public_api_catalog`, `decentralized_data_marketplace`, `autoresearch_loop`,
      `intel_sweep_router`, `gui_drift_manager`.
  - `core/layer0/ops/src/main.rs` dispatch now routes these lanes through `protheus_ops_core_v1` (Layer 2 crate).

## Rust Share
- Command:
  - `npm run -s metrics:rust-share:gate`
- Result:
  - `rust_share_pct: 63.723`
  - `rs: 118795`, `ts: 39301`, `js: 28329`

## Runtime Regression Status
- Runtime execution remains blocked in this session:
  - Local compiled binaries (including minimal `/tmp` test binaries) hang before `main`.
- Host policy evidence:
- `/tmp/hello_c_test` and `/tmp/hello_rust_test` hang with no stdout (guarded runner exits via `SIGALRM`).
- `./target/debug/protheus-ops status` hangs (guarded runner exits via `SIGALRM`).
  - `spctl --assess --type execute /tmp/hello_c_test` -> rejected.
  - `sample` on hanging process shows call graph pinned at `_dyld_start` (never enters `main`).
  - `syspolicyd` observed pegged for extended runtime; restart requires elevated host control outside this process.
- Host remediation attempted in-session:
  - `spctl developer-mode enable-terminal` executed successfully.
  - `DevToolsSecurity -enable` executed successfully.
- Execution behavior unchanged for local compiled binaries.
- Post-toggle execution artifact:
  - `artifacts/todo_execution_2026-03-10_after_devtools.json`
  - `host.devtools.status`: pass
  - `OPS-BLOCKER-001` probes: still timeout (`SIGALRM`)
  - `OPS-BLOCKER-003` (`./verify.sh`): timed out (45s cap in guarded run)
- Deferred fallback status:
  - `OPS-BLOCKER-002` completed (fail-closed defaults enabled).
  - Active bridge defaults now set `PROTHEUS_OPS_DEFER_ON_HOST_STALL=0`.
- Current command snapshot (fail-closed):
  - `./verify.sh` -> timed out (60s cap in blocker run)
  - `npm run -s typecheck:systems` -> `spawnSync .../target/debug/protheus-ops ETIMEDOUT`
  - `npm run -s ops:source-runtime:check` -> `spawnSync .../target/debug/protheus-ops ETIMEDOUT`
  - `npm run -s ops:subconscious-boundary:check` -> `spawnSync .../target/debug/protheus-ops ETIMEDOUT`
  - `npm run -s test:memory:context-budget` -> `spawnSync .../target/debug/protheus-ops ETIMEDOUT`
  - `npm run -s test:memory:matrix` -> `spawnSync .../target/debug/protheus-ops ETIMEDOUT`
  - `npm run -s test:memory:auto-recall` -> `spawnSync .../target/debug/protheus-ops ETIMEDOUT`
  - `npm run -s test:reflexes` -> `spawnSync .../target/debug/protheus-ops ETIMEDOUT`
  - `npm run -s ops:srs:top200:regression` -> timeout in this host/runtime state
  - `npm run -s metrics:rust-share:gate` -> pass (`rust_share_pct: 63.723`)
  - `npm run -s ops:layer-placement:check` -> pass (`violations_count:0`) after restoring policy file + ownership headers
- Full regression artifact:
  - `artifacts/blocker_regression_2026-03-10.json`
- Ordered TODO execution artifact:
  - `artifacts/todo_execution_2026-03-10.json`
  - `artifacts/todo_execution_2026-03-10_resume.json`
  - `artifacts/todo_execution_2026-03-10_resume2.json`
  - `artifacts/todo_execution_2026-03-10_after_devtools.json`
- Action when environment clears:
  - Re-run `./verify.sh`
  - Re-run system suite:
    - `npm run -s typecheck:systems`
    - `npm run -s test:ops:source-runtime-classifier`
    - `npm run -s test:ops:subconscious-boundary-guard`
    - `npm run -s test:memory:context-budget`
    - `npm run -s test:memory:matrix`
    - `npm run -s test:memory:auto-recall`
    - `npm run -s test:reflexes`
