# Rust50 Lane Tracker

Last updated: 2026-03-05 (America/Denver)
Branch target: `main`

## Purpose
Persistent lane-by-lane migration log so progress is preserved outside chat context.

## Gate Contract (per lane)
1. `cargo test` (lane-appropriate crate/manifest)
2. `cargo clippy -- -D warnings` (lane-appropriate crate/manifest)
3. `npm run -s formal:invariants:run` with `NODE_PATH=.../node_modules`
4. Commit + push to `origin/main`

## Completed In This Run
- [x] `1dd15784` retire generic-json legacy fallback
- [x] `42c3b4d1` retire generic-yaml legacy fallback
- [x] `aa1b060a` retire openfang legacy fallback
- [x] `3246b0b5` retire workflow-graph legacy fallback
- [x] `697a4928` retire autotest-controller legacy TypeScript lane
- [x] `8434df99` retire autotest-doctor legacy TypeScript lane
- [x] `3cb7304b` retire spine legacy TypeScript lane
- [x] `f000496e` retire idle-dream-cycle legacy TypeScript lane
- [x] `e6b73a53` retire memory-transition legacy TypeScript lane

## Remaining Legacy TS Lanes (Current Queue)
- [x] `systems/autonomy/strategy_mode_governor_legacy.ts`
- [x] `systems/spine/contract_check_legacy.ts`
- [x] `systems/routing/model_router_legacy.ts`
- [x] `systems/ops/foundation_contract_gate_legacy.ts`
- [x] `systems/ops/state_kernel_legacy.ts`
- [x] `systems/personas/cli_legacy.ts`
- [x] `systems/workflow/workflow_executor_legacy.ts`
- [x] `systems/autonomy/autonomy_controller_legacy.ts`
- [x] `systems/autonomy/inversion_controller_legacy.ts`
- [ ] `systems/autonomy/proposal_enricher_legacy.ts`
- [ ] `systems/autonomy/health_status_legacy.ts`

## Notes
- Some Rust lane entrypoints still route through legacy script adapters in `crates/ops/src/*`.
- Retirement stubs are fail-closed and emit deterministic JSON error payloads.
- Full functional replacement for those lanes requires replacing `legacy_bridge::run_passthrough` / `run_legacy_script_compat` in Rust entrypoints.
