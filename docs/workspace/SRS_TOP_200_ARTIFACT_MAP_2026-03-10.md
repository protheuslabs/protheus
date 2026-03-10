# SRS Top-200 Artifact Map (2026-03-10)

Purpose:
- Provide explicit non-backlog artifact footprints for top-priority queued items.
- Make regression audits deterministic by linking each high-priority ID to concrete target surfaces.

## Memory Low-Burn Contract Cluster

| ID | Target Layer | Target Surface | Notes |
|---|---|---|---|
| V6-MEMORY-013 | core/layer1 | `core/layer1/memory_runtime/src/query_guard.rs` | Enforce index-first + node-only retrieval gate. |
| V6-MEMORY-014 | core/layer1 | `core/layer1/memory_runtime/src/hydration_policy.rs` | Dynamic hydration deferral policy and ceiling contract. |
| V6-MEMORY-015 | core/layer1 | `core/layer1/memory_runtime/src/token_slo_gate.rs` | `<200` query-path burn SLO gate with fail-closed thresholds. |
| V6-MEMORY-016 | core/layer1 | `core/layer1/memory_runtime/src/recall_budget.rs` | Default recall budget and strict/reject cap mode. |
| V6-MEMORY-017 | core/layer1 | `core/layer1/memory_runtime/src/matrix_invariants.rs` | Matrix/sequencer/auto-recall ranking invariants. |
| V6-MEMORY-018 | core/layer1 | `core/layer1/memory_runtime/src/index_freshness.rs` | Stale index/read prevention contract. |
| V6-MEMORY-019 | core/layer1 + docs | `core/layer1/memory_runtime/src/lensmap_annotations.rs`, `docs/client/requirements/REQ-36-smart-memory-low-burn-regression-contract.md` | LensMap tags/nodes/jots annotation schema gate. |
| V6-MEMORY-021 | core/layer1 | `core/layer1/memory_runtime/src/token_telemetry.rs` | Per-query token-burn attribution by retrieval mode. |

## LLMN Integrity Cluster

| ID | Target Layer | Target Surface | Notes |
|---|---|---|---|
| V6-LLMN-001 | core/layer2 | `core/layer2/execution/src/llmn_mode_registry.rs` | Canonical mode registry + alias normalization. |
| V6-LLMN-002 | core/layer2 | `core/layer2/execution/src/llmn_router_parity.rs` | Router/strategy parity for all modes. |
| V6-LLMN-003 | core/layer2 + client wrapper | `core/layer2/execution/src/llmn_entrypoint_contract.rs`, `client/cli/bin/protheus` | CLI mode-critical entrypoint restoration via core contract. |
| V6-LLMN-004 | core/layer0/ops | `core/layer0/ops/src/llmn_conformance_smoke.rs` | LLMN conformance smoke pack + CI gate receipts. |

## Dual-Agent Cockpit Cluster

| ID | Target Layer | Target Surface | Notes |
|---|---|---|---|
| V6-COCKPIT-009.1 | core/layer2 | `core/layer2/execution/src/dual_agent_orchestrator.rs` | Planner/Executor split + deterministic handoff receipts. |
| V6-COCKPIT-009.2 | core/layer2 | `core/layer2/execution/src/lazy_tool_discovery.rs` | On-demand tool loading and manifest deferral contract. |
| V6-COCKPIT-009.3 | core/layer1 + core/layer2 | `core/layer1/memory_runtime/src/context_compaction_policy.rs`, `core/layer2/execution/src/context_compactor.rs` | Adaptive compaction at token-pressure thresholds. |
| V6-COCKPIT-009.4 | core/layer2 | `core/layer2/execution/src/event_driven_reminders.rs` | Anti-drift reminder injection on step/time cadence. |
| V6-COCKPIT-009.5 | core/layer1 | `core/layer1/memory_runtime/src/session_persistence.rs` | Cross-session memory reconstruction + rollback pointers. |
| V6-COCKPIT-009.6 | core/layer1 + core/layer0 | `core/layer1/security/src/autonomous_safety.rs`, `core/layer0/ops/src/safety_execution_gate.rs` | Strict safety controls for autonomous operations. |

## Additional Top-200 Artifact Anchors

| ID | Target Layer | Target Surface | Notes |
|---|---|---|---|
| V7-META-012 | core/layer1 + core/layer2 | `core/layer1/security/src/autonomous_safety.rs`, `core/layer2/execution/src/dual_agent_orchestrator.rs` | Neural/consent-kernel scaffold dependency anchor for metakernel intake path. |
| V6-COCKPIT-015.1 | core/layer1/memory_runtime + core/layer2 | `core/layer1/memory_runtime/src/session_persistence.rs`, `core/layer2/execution/src/context_compactor.rs` | Context engine plugin baseline for long-thread retention. |
| V6-COCKPIT-015.2 | core/layer2/ops | `core/layer2/ops/src/lib.rs`, `core/layer0/ops/src/daemon_control.rs` | Persistent channel binding runtime anchor through daemon control contracts. |
| V6-COCKPIT-015.4 | core/layer2/ops + core/layer2/execution | `core/layer0/ops/src/spawn_broker.rs`, `core/layer2/execution/src/lib.rs` | Non-blocking parallel swarm message fan-out anchor (scheduler + execution lane split). |
| V6-COCKPIT-009.5 | core/layer1/memory_runtime | `core/layer1/memory_runtime/src/lib.rs`, `core/layer0/memory_runtime/src/lane_contracts.rs` | Persistent memory across sessions anchor for deferred cockpit memory continuity. |
| V7-META-004 | core/layer2/conduit + planes/contracts | `core/layer2/conduit/src/lib.rs`, `planes/contracts/conduit_envelope.schema.json`, `planes/contracts/README.md` | WIT/component ABI registry anchor and conduit contract mapping surface. |

## Notes

- This file is an artifact map, not a completion claim.
- Execution ordering remains governed by `docs/workspace/SRS_TOP_200_REGRESSION_2026-03-10.md`.
- Client surfaces remain wrappers/UX only; authority stays in core.
