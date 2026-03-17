# REQ-49: LangGraph Persistent Graph Orchestration Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Checkpoints / Graph Execution

## Objective

Assimilate the practical strengths of LangGraph into InfRing without introducing a parallel graph-orchestration authority path: stateful graph execution, checkpoints and time-travel replay, conditional edges and cycles, human-in-the-loop state inspection, subgraph and multi-agent coordination, streaming, and LangSmith-style tracing should all map onto existing workflow, swarm, memory, observability, and adapter primitives.

## Source References

- [LangGraph repository](https://github.com/langchain-ai/langgraph)
- [Source doc](https://docs.google.com/document/d/1PKuE-cGAatgZ4ahBnf0tK0KK8hM1OYJ8WDIcA-FMJb8/edit?usp=sharing)

## Scope

In scope:
- Graph nodes, edges, cycles, and conditional execution over existing workflow and swarm lanes
- Checkpoint persistence and replay over existing receipt and memory primitives
- HITL state inspection through pause, shadow, and operator surfaces
- Subgraph nesting and multi-agent coordination over existing swarm/session primitives
- Streaming and LangSmith-style trace compatibility over native observability lanes
- Thin `infring assimilate langgraph` operator path

Out of scope:
- A separate LangGraph-owned execution engine
- Moving graph, checkpoint, or replay authority into app-owned shells
- Treating graph ergonomics as justification for bypassing conduit/runtime governance

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Optional trace/export bridges live in `adapters/`
- Optional visual/demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-38: Agent orchestration hardening
- REQ-45: OpenAI Swarm lightweight handoff assimilation
- REQ-48: CrewAI role-based hierarchical crews assimilation
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`

## Requirements

### REQ-49-001: Graph Node and Edge Registry

**Requirement:** Model LangGraph nodes, edges, conditional branches, and cycles over the authoritative workflow and swarm/runtime lanes.

**Acceptance:**
- Graph execution remains deterministic and receipted
- Cycles and branch routing remain bounded by current policy controls
- No duplicate graph-execution authority is introduced

---

### REQ-49-002: Checkpoint Persistence and Time-Travel Replay

**Requirement:** Reuse existing receipt and memory primitives for LangGraph-style checkpoint export, restore, and replay.

**Acceptance:**
- Checkpoint export and replay are receipted and auditable
- Restored state remains governed by existing context and policy controls
- No second persistence authority is introduced

---

### REQ-49-003: Human-in-the-Loop State Inspection

**Requirement:** Support LangGraph-style runtime state inspection and modification through existing pause, shadow, and operator-control surfaces.

**Acceptance:**
- State inspection and intervention emit deterministic receipts
- Existing approval and pause boundaries remain authoritative
- No separate HITL boundary is introduced

---

### REQ-49-004: Subgraph and Multi-Agent Coordination

**Requirement:** Map LangGraph-style subgraphs and multi-agent nesting onto existing swarm, session, and persona primitives.

**Acceptance:**
- Nested graphs remain isolated, budgeted, and receipted
- Existing lineage, context-budget, and importance semantics remain authoritative
- No duplicate nesting runtime is introduced

---

### REQ-49-005: LangSmith-Style Observability Bridge

**Requirement:** Fold LangGraph graph traces, state transitions, and evaluation-friendly telemetry into the native observability and receipt stack.

**Acceptance:**
- Graph traces stream as native observability artifacts
- Existing dashboards/export paths can render LangGraph-assimilated evidence
- No duplicate telemetry stack is introduced

---

### REQ-49-006: Streaming and Conditional Execution Guard

**Requirement:** Support LangGraph-style streaming and conditional edge evaluation through existing inference, workflow, and policy primitives.

**Acceptance:**
- Streaming remains receipt-anchored
- Conditional logic stays deterministic and fail closed
- Unsupported paths degrade explicitly rather than bypassing governance

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-002.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/langgraph/` suggestion into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
