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

- `systems/conduit/conduit-client.ts` (thin conduit client)
- `systems/ui/**`
- `systems/marketplace/**`
- `extensions/**`
- external source collectors where fast schema churn is expected, if they stay outside kernel authority

## High-ROI TS candidates for Rust migration (kernel truth paths)

These are the largest TS files tied to control, cognition, policy, orchestration, and signal routing.

1. `systems/assimilation/assimilation_controller.ts` (1800)
2. `systems/continuum/continuum_core.ts` (1791)
3. `systems/sensory/focus_controller.ts` (1781)
4. `systems/weaver/weaver_core.ts` (1734)
5. `systems/identity/identity_anchor.ts` (1072)
6. `systems/dual_brain/coordinator.ts` (1009)
7. `lib/strategy_resolver.ts` (982)
8. `lib/duality_seed.ts` (951)
9. `systems/autonomy/pain_signal.ts` (913)
10. `systems/budget/system_budget.ts` (903)
11. `systems/security/guard.ts` (895)
12. `systems/echo/heroic_echo_controller.ts` (841)
13. `systems/helix/helix_controller.ts` (793)
14. `systems/assimilation/group_evolving_agents_primitive.ts` (729)
15. `systems/autonomy/self_documentation_closeout.ts` (717)
16. `lib/directive_resolver.ts` (715)
17. `systems/redteam/ant_colony_controller.ts` (655)
18. `systems/attribution/value_attribution_primitive.ts` (634)
19. `systems/assimilation/capability_profile_compiler.ts` (624)
20. `systems/autonomy/multi_agent_debate_orchestrator.ts` (571)
21. `systems/primitives/long_horizon_planning_primitive.ts` (536)
22. `systems/sensory/temporal_patterns.ts` (517)
23. `systems/autonomy/ethical_reasoning_organ.ts` (515)
24. `systems/adaptive/core/layer_store.ts` (485)
25. `systems/adaptive/sensory/eyes/focus_trigger_store.ts` (468)
26. `systems/assimilation/memory_evolution_primitive.ts` (460)
27. `systems/weaver/arbitration_engine.ts` (432)
28. `systems/echo/input_purification_gate.ts` (425)
29. `systems/assimilation/test_time_memory_evolution_primitive.ts` (421)
30. `systems/assimilation/collective_reasoning_primitive.ts` (408)
31. `systems/assimilation/context_navigation_primitive.ts` (405)
32. `systems/assimilation/environment_evolution_layer.ts` (400)
33. `systems/assimilation/generative_meta_model_primitive.ts` (395)
34. `systems/spine/spine_safe_launcher.ts` (393)
35. `systems/assimilation/generative_simulation_mode.ts` (380)
36. `systems/sensory/collector_driver.ts` (368)
37. `systems/assimilation/adaptive_ensemble_routing_primitive.ts` (362)
38. `systems/assimilation/self_teacher_distillation_primitive.ts` (360)
39. `systems/assimilation/candidacy_ledger.ts` (353)
40. `systems/weaver/monoculture_guard.ts` (339)
41. `systems/weaver/metric_schema.ts` (335)

## Migration rule for these candidates

For each candidate lane:

1. Move logic to Rust crate/domain first.
2. Keep TS file as a thin conduit client/wrapper only (or delete if unused).
3. Add parity tests (Rust output == previous TS output fixture).
4. Enforce through contract-check token gates.
5. Emit deterministic receipt on every crossing.

## Top 8 Ops/Security lanes migrated in this batch

Highest-impact files from `systems/ops` + `systems/security` by tracked TS line count:

1. `systems/ops/execution_yield_recovery.ts` (1437) -> `protheus-ops execution-yield-recovery`
2. `systems/ops/protheus_control_plane.ts` (1257) -> `protheus-ops protheus-control-plane`
3. `systems/ops/rust50_migration_program.ts` (1214) -> `protheus-ops rust50-migration-program`
4. `systems/security/venom_containment_layer.ts` (1197) -> `protheus-ops venom-containment-layer`
5. `systems/ops/dynamic_burn_budget_oracle.ts` (1104) -> `protheus-ops dynamic-burn-budget-oracle`
6. `systems/ops/backlog_registry.ts` (1026) -> `protheus-ops backlog-registry`
7. `systems/ops/rust_enterprise_productivity_program.ts` (1021) -> `protheus-ops rust-enterprise-productivity-program`
8. `systems/ops/backlog_github_sync.ts` (998) -> `protheus-ops backlog-github-sync`

Migration shape:

- TS/JS files are now thin wrappers through `lib/rust_lane_bridge.js`.
- Runtime authority is in `crates/ops` rust domains.
- Each crossing emits deterministic claim-evidence receipts.

## Regeneration command

To refresh the ranked TS list:

```bash
git ls-files '*.ts' | while read -r f; do printf "%8d %s\n" "$(wc -l < "$f")" "$f"; done | sort -nr
```
