# Rust Kernel Top-10 Migration Batch

Date: 2026-03-06
Mode: conduit-first kernel lane routing

## Scope

Top 10 targets from `client/docs/RUST_KERNEL_MIGRATION_CANDIDATES.md` lines 32-41:

1. client/systems/assimilation/assimilation_controller.ts
2. client/systems/continuum/continuum_core.ts
3. client/systems/sensory/focus_controller.ts
4. client/systems/weaver/weaver_core.ts
5. client/systems/identity/identity_anchor.ts
6. client/systems/dual_brain/coordinator.ts
7. client/lib/strategy_resolver.ts
8. client/lib/duality_seed.ts
9. client/systems/autonomy/pain_signal.ts
10. client/systems/budget/system_budget.ts

## Migration Result

- Rust execution authority moved to conduit kernel path in `core/layer2/conduit` via `KernelLaneCommandHandler`.
- TS surfaces are thin wrappers only.
- Shared lane bridge (`client/lib/legacy_retired_lane_bridge.js`) now routes through conduit daemon instead of direct legacy-retired-lane CLI calls.
- `client/systems/assimilation/assimilation_controller.ts` was explicitly converted to direct conduit client routing.
- Additional direct-conduit uplift for high-impact lanes:
  - `client/systems/security/guard.ts`
  - `client/systems/echo/heroic_echo_controller.ts`
  - `client/systems/helix/helix_controller.ts`
  - `client/systems/assimilation/group_evolving_agents_primitive.ts`
  - `client/systems/autonomy/self_documentation_closeout.ts`

## Validation

- `node` execution for all 10 target wrappers returns `ok: true` with Rust-generated deterministic lane receipts.
- `cargo check -p conduit -p protheus-ops-core` passed.
- `npm run -s formal:invariants:run` passed (`failed_invariants: 0`).
- Benchmark matrix rerun uses live `run` metrics with no fallback (`runtime_metric_source.mode=run`, `fallback_reason=null`).
