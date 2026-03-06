# Rust Kernel Top-10 Migration Batch

Date: 2026-03-06
Mode: conduit-first kernel lane routing

## Scope

Top 10 targets from `docs/RUST_KERNEL_MIGRATION_CANDIDATES.md` lines 32-41:

1. systems/assimilation/assimilation_controller.ts
2. systems/continuum/continuum_core.ts
3. systems/sensory/focus_controller.ts
4. systems/weaver/weaver_core.ts
5. systems/identity/identity_anchor.ts
6. systems/dual_brain/coordinator.ts
7. lib/strategy_resolver.ts
8. lib/duality_seed.ts
9. systems/autonomy/pain_signal.ts
10. systems/budget/system_budget.ts

## Migration Result

- Rust execution authority moved to conduit kernel path in `crates/conduit` via `KernelLaneCommandHandler`.
- TS surfaces are thin wrappers only.
- Shared lane bridge (`lib/legacy_retired_lane_bridge.js`) now routes through conduit daemon instead of direct legacy-retired-lane CLI calls.
- `systems/assimilation/assimilation_controller.ts` was explicitly converted to direct conduit client routing.

## Validation

- `node` execution for all 10 target wrappers returns `ok: true` with Rust-generated deterministic lane receipts.
- `cargo check -p conduit -p protheus-ops-core` passed.
- `npm run -s formal:invariants:run` passed (`failed_invariants: 0`).
