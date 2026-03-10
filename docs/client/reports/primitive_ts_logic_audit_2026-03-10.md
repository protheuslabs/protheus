# Primitive TS Logic Audit (Residuals)

Date: 2026-03-10  
Scope: `primitive_ts_wrapper_contract` policy entries + `client/runtime/systems/primitives/*.ts`

## Summary

- Contract entries audited: 21
- Contract entries already thin direct-conduit wrappers: 0
- Contract residuals (still non-wrapper/drift): 21
- Primitive TS files audited: 16
- Primitive TS files still non-wrapper logic: 16

## Contract Residuals (REQ-08-005)

All entries currently fail the direct-conduit wrapper token contract (`createConduitLaneModule` + `direct_conduit_lane_bridge.js`) and should be treated as migration backlog.

| TS Surface | Residual Type | Target Rust Ownership |
|---|---|---|
| `client/runtime/lib/strategy_resolver.ts` | non-wrapper TS logic | `core/layer2/execution` |
| `client/runtime/lib/duality_seed.ts` | non-wrapper TS logic | `core/layer2/autonomy` |
| `client/runtime/systems/autonomy/pain_signal.ts` | legacy wrapper/drift | `core/layer2/autonomy` |
| `client/runtime/systems/budget/system_budget.ts` | legacy wrapper/drift | `core/layer1/resource` |
| `client/runtime/systems/redteam/ant_colony_controller.ts` | legacy wrapper/drift | `core/layer2/autonomy` |
| `client/runtime/systems/attribution/value_attribution_primitive.ts` | legacy wrapper/drift | `core/layer1/observability` |
| `client/runtime/systems/assimilation/capability_profile_compiler.ts` | legacy wrapper/drift | `core/layer2/autonomy` |
| `client/runtime/systems/autonomy/multi_agent_debate_orchestrator.ts` | legacy wrapper/drift | `core/layer2/autonomy` |
| `client/runtime/systems/primitives/long_horizon_planning_primitive.ts` | non-wrapper TS logic | `core/layer1/task` |
| `client/runtime/systems/primitives/canonical_event_log.ts` | non-wrapper TS logic | `core/layer1/storage` |
| `client/runtime/systems/primitives/cognitive_control_primitive.ts` | non-wrapper TS logic | `core/layer2/execution` |
| `client/runtime/systems/primitives/policy_vm.ts` | non-wrapper TS logic | `core/layer1/isolation` |
| `client/runtime/systems/primitives/primitive_catalog.ts` | non-wrapper TS logic | `core/layer1/update` |
| `client/runtime/systems/primitives/primitive_registry.ts` | non-wrapper TS logic | `core/layer1/update` |
| `client/runtime/systems/primitives/replay_verify.ts` | non-wrapper TS logic | `core/layer1/observability` |
| `client/runtime/systems/sensory/temporal_patterns.ts` | legacy wrapper/drift | `core/layer2/execution` |
| `client/runtime/systems/autonomy/ethical_reasoning_organ.ts` | legacy wrapper/drift | `core/layer2/autonomy` |
| `client/runtime/systems/assimilation/memory_evolution_primitive.ts` | legacy wrapper/drift | `core/layer1/memory_runtime` |
| `client/runtime/systems/weaver/arbitration_engine.ts` | legacy wrapper/drift | `core/layer2/execution` |
| `client/runtime/systems/echo/input_purification_gate.ts` | legacy wrapper/drift | `core/layer1/isolation` |
| `client/runtime/systems/assimilation/context_navigation_primitive.ts` | legacy wrapper/drift | `core/layer1/memory_runtime` |

## Primitive Directory Residuals

All `client/runtime/systems/primitives/*.ts` files remain non-wrapper logic in this wave and should be migrated or retired behind thin wrappers in subsequent waves:

- `action_grammar.ts`
- `canonical_event_log.ts`
- `cognitive_control_primitive.ts`
- `effect_type_system.ts`
- `emergent_primitive_synthesis.ts`
- `explanation_auto_emit.ts`
- `explanation_primitive.ts`
- `interactive_desktop_session_primitive.ts`
- `iterative_repair_primitive.ts`
- `long_horizon_planning_primitive.ts`
- `policy_vm.ts`
- `primitive_catalog.ts`
- `primitive_registry.ts`
- `primitive_runtime.ts`
- `replay_verify.ts`
- `runtime_scheduler.ts`

## Evidence Commands (This Wave)

- `cargo test -p task`
- `cargo test -p resource`
- `cargo test -p isolation`
- `cargo test -p protheus-observability-core-v1`
- `./target/debug/protheus-ops contract-check --rust-contract-check-ids=primitive_ts_wrapper_contract`

## Notes

- Layer1 Rust primitive crates are green and deterministic.
- Primitive TS wrapper contract remains intentionally in-progress until the residual set above is migrated to core and TS wrappers are reduced to thin conduit bridges.
