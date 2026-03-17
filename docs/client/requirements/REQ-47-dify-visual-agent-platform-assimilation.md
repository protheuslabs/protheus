# REQ-47: Dify Visual Agent Platform Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Knowledge / Visual Operator Surfaces

## Objective

Assimilate the practical strengths of Dify into InfRing without introducing a parallel no-code or workflow authority path: visual drag-and-drop workflow building, knowledge-base and RAG ergonomics, multi-modal agents, plugin/MCP tools, team collaboration, deployment dashboards, and broad LLM-provider compatibility should all map onto existing workflow, swarm, memory, observability, and adapter primitives.

## Source References

- [Dify repository](https://github.com/langgenius/dify)
- [Source doc](https://docs.google.com/document/d/1uI9TXxygz4NC_gpwHzU3pNgO73u18D0YT4-ihbQTwPY/edit?usp=sharing)

## Scope

In scope:
- Visual canvas and drag-and-drop orchestration over existing workflow and swarm lanes
- Knowledge-base and RAG patterns over Dream Sequencer, auto-recall, and retrieval primitives
- Agentic apps, multi-modal tools, plugins, and MCP surfaces through governed adapters
- Team collaboration and deployment dashboards as thin, deletable shells
- Broad provider compatibility through existing inference and routing primitives
- Thin `infring assimilate dify` operator path

Out of scope:
- A separate Dify-owned orchestration or deployment authority path
- Moving canvas, knowledge, or deployment authority into app-owned shells
- Treating no-code UX as justification for bypassing conduit/runtime governance

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Provider, plugin, MCP, and deployment bridges live in `adapters/`
- Optional visual/demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-17: Tool context and messaging assimilation
- REQ-39: Haystack modular pipeline and agent assimilation
- REQ-43: LlamaIndex RAG and agentic workflow assimilation
- REQ-46: MetaGPT software company simulation assimilation
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`
  - `V6-SUBSTRATE-007.*`

## Requirements

### REQ-47-001: Visual Canvas and Drag-and-Drop Workflow Registry

**Requirement:** Model Dify’s visual workflow canvas semantics over the authoritative workflow and swarm/runtime lanes.

**Acceptance:**
- Visual workflows route through governed orchestration paths
- Node/edge execution emits deterministic receipts
- No duplicate visual-workflow authority is introduced

---

### REQ-47-002: Knowledge Base and RAG Bridge

**Requirement:** Reuse Dream Sequencer, auto-recall, and governed retrieval primitives for Dify-style knowledge bases and RAG flows.

**Acceptance:**
- Knowledge-base retrieval remains receipted and context-budgeted
- Multi-modal ingestion routes through governed adapter-owned paths
- Pure/tiny-max profiles degrade explicitly when unsupported

---

### REQ-47-003: Agentic App and Multi-Modal Tool Registry

**Requirement:** Support Dify-style agents, plugins, and multimodal tools through existing workflow, inference, and adapter bridges.

**Acceptance:**
- Agents and tools normalize into governed manifests and execution paths
- Tool invocation emits deterministic receipts and fail-closed denials
- Multi-modal support remains substrate-policy aware

---

### REQ-47-004: Team Collaboration and Deployment Dashboard Shells

**Requirement:** Support Dify-style team collaboration and deployment dashboards only as thin shells over existing authority lanes.

**Acceptance:**
- Collaboration/dashboard shells are deletable without changing core behavior
- Publishing, monitoring, and deployment actions delegate to governed authority surfaces
- Dashboard actions emit deterministic receipts

---

### REQ-47-005: 100+ LLM Integration Gateway

**Requirement:** Capture Dify’s broad provider compatibility through existing inference and routing authority primitives.

**Acceptance:**
- Provider route and invocation semantics emit deterministic receipts
- Adapter-owned provider shims remain the only integration boundary
- No regression is introduced for pure/tiny-max unsupported providers

---

### REQ-47-006: Orchestration and Conditional Flow Engine

**Requirement:** Support Dify-style conditional branches, loops, and agent handoffs through the canonical workflow and initiative engine.

**Acceptance:**
- Conditional logic stays deterministic and fail closed
- Existing checkpoints, routing, and handoff semantics remain authoritative
- No second flow engine is introduced

---

### REQ-47-007: Observability and Audit Bridge

**Requirement:** Fold Dify logging, metrics, and debugging traces into the native observability and receipt stack.

**Acceptance:**
- Workflow and deployment events stream as native observability artifacts
- Existing dashboards/export paths can render Dify-assimilated evidence
- Tracing does not create a duplicate telemetry stack

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-005.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/dify/` and `apps/dify-canvas/` suggestions into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
