# Rust Kernel Migration Candidates

Date: 2026-03-06
Branch: main

## Why the percentage is not rising fast

Measured tracked line totals in this repo snapshot:

- Rust: 82,949
- TypeScript: 61,680
- JavaScript: 147,038

To hit 70% Rust by code movement alone, Rust needs about +121,218 lines.

Even if every TS line is migrated to Rust, Rust reaches about 49.6%, and about 59,538 JS lines would still need migration/removal from the denominator.

## What TS should remain TS

Keep as TS/client surface (non-kernel source of truth):

- `client/systems/conduit/conduit-client.ts` (thin conduit client)
- `client/systems/ui/**`
- `client/systems/marketplace/**`
- `extensions/**`
- external source collectors where fast schema churn is expected, if they stay outside kernel authority

## High-ROI TS candidates for Rust migration (kernel truth paths)

These are the largest TS files tied to control, cognition, policy, orchestration, and signal routing.

1. `client/systems/assimilation/assimilation_controller.ts` (1800)
2. `client/systems/continuum/continuum_core.ts` (1791)
3. `client/systems/sensory/focus_controller.ts` (1781)
4. `client/systems/weaver/weaver_core.ts` (1734)
5. `client/systems/identity/identity_anchor.ts` (1072)
6. `client/systems/dual_brain/coordinator.ts` (1009)
7. `client/lib/strategy_resolver.ts` (982)
8. `client/lib/duality_seed.ts` (951)
9. `client/systems/autonomy/pain_signal.ts` (913)
10. `client/systems/budget/system_budget.ts` (903)
11. `client/systems/security/guard.ts` (895)
12. `client/systems/echo/heroic_echo_controller.ts` (841)
13. `client/systems/helix/helix_controller.ts` (793)
14. `client/systems/assimilation/group_evolving_agents_primitive.ts` (729)
15. `client/systems/autonomy/self_documentation_closeout.ts` (717)
16. `client/lib/directive_resolver.ts` (715)
17. `client/systems/redteam/ant_colony_controller.ts` (655)
18. `client/systems/attribution/value_attribution_primitive.ts` (634)
19. `client/systems/assimilation/capability_profile_compiler.ts` (624)
20. `client/systems/autonomy/multi_agent_debate_orchestrator.ts` (571)
21. `client/systems/primitives/long_horizon_planning_primitive.ts` (536)
22. `client/systems/sensory/temporal_patterns.ts` (517)
23. `client/systems/autonomy/ethical_reasoning_organ.ts` (515)
24. `client/systems/adaptive/core/layer_store.ts` (485)
25. `client/systems/adaptive/sensory/eyes/focus_trigger_store.ts` (468)
26. `client/systems/assimilation/memory_evolution_primitive.ts` (460)
27. `client/systems/weaver/arbitration_engine.ts` (432)
28. `client/systems/echo/input_purification_gate.ts` (425)
29. `client/systems/assimilation/test_time_memory_evolution_primitive.ts` (421)
30. `client/systems/assimilation/collective_reasoning_primitive.ts` (408)
31. `client/systems/assimilation/context_navigation_primitive.ts` (405)
32. `client/systems/assimilation/environment_evolution_layer.ts` (400)
33. `client/systems/assimilation/generative_meta_model_primitive.ts` (395)
34. `client/systems/spine/spine_safe_launcher.ts` (393)
35. `client/systems/assimilation/generative_simulation_mode.ts` (380)
36. `client/systems/sensory/collector_driver.ts` (368)
37. `client/systems/assimilation/adaptive_ensemble_routing_primitive.ts` (362)
38. `client/systems/assimilation/self_teacher_distillation_primitive.ts` (360)
39. `client/systems/assimilation/candidacy_ledger.ts` (353)
40. `client/systems/weaver/monoculture_guard.ts` (339)
41. `client/systems/weaver/metric_schema.ts` (335)

## Migration rule for these candidates

For each candidate lane:

1. Move logic to Rust crate/domain first.
2. Keep TS file as a thin conduit client/wrapper only (or delete if unused).
3. Add parity tests (Rust output == previous TS output fixture).
4. Enforce through contract-check token gates.
5. Emit deterministic receipt on every crossing.

## Top 8 Ops/Security lanes migrated in this batch

Highest-impact files from `client/systems/ops` + `client/systems/security` by tracked TS line count:

1. `client/systems/ops/execution_yield_recovery.ts` (1437) -> `protheus-ops execution-yield-recovery`
2. `client/systems/ops/protheus_control_plane.ts` (1257) -> `protheus-ops protheus-control-plane`
3. `client/systems/ops/rust50_migration_program.ts` (1214) -> `protheus-ops rust50-migration-program`
4. `client/systems/security/venom_containment_layer.ts` (1197) -> `protheus-ops venom-containment-layer`
5. `client/systems/ops/dynamic_burn_budget_oracle.ts` (1104) -> `protheus-ops dynamic-burn-budget-oracle`
6. `client/systems/ops/backlog_registry.ts` (1026) -> `protheus-ops backlog-registry`
7. `client/systems/ops/rust_enterprise_productivity_program.ts` (1021) -> `protheus-ops rust-enterprise-productivity-program`
8. `client/systems/ops/backlog_github_sync.ts` (998) -> `protheus-ops backlog-github-sync`

Migration shape:

- TS/JS files are now thin wrappers through `client/lib/rust_lane_bridge.js`.
- Runtime authority is in `core/layer0/ops` rust domains.
- Each crossing emits deterministic claim-evidence receipts.

## Regeneration command

To refresh the ranked TS list:

```bash
git ls-files '*.ts' | while read -r f; do printf "%8d %s\n" "$(wc -l < "$f")" "$f"; done | sort -nr
```
