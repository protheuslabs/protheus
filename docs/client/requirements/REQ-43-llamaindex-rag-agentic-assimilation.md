# REQ-43: LlamaIndex RAG and Agentic Workflow Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Memory / Retrieval

## Objective

Assimilate the practical strengths of LlamaIndex into InfRing without introducing a parallel RAG or agent framework authority path: indexes, retrievers, query engines, agentic workflows, multi-modal ingestion, memory stores, evaluations, and connector breadth should all map onto the existing Dream Sequencer, auto-recall, workflow, swarm, observability, and adapter primitives.

## Source References

- [LlamaIndex repository](https://github.com/run-llama/llama_index)
- [Source doc](https://docs.google.com/document/d/1DXI7-djrWFMxL_R1MlPNNXs8LDB3UFjaC0yM8nwzh8A/edit?usp=sharing)

## Scope

In scope:
- RAG pipelines, indexes, retrievers, and query engines over existing memory/runtime primitives
- Agentic workflows and tool-calling over existing workflow/swarm/content-skill lanes
- Multi-modal ingestion and connector intake through adapters
- Memory-store and evaluation assimilation through observability and receipt contracts
- Thin `infring assimilate llamaindex` operator path

Out of scope:
- Creating a second indexing/retrieval authority path
- Moving retrieval or workflow authority into app-owned shells
- Treating LlamaIndex as a standalone app instead of an intake over current primitives

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Connectors and ingestion bridges live in `adapters/`
- Optional demos or explorer shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-17: Tool context and messaging assimilation
- REQ-39: Haystack modular pipeline and agent assimilation
- REQ-41: Mastra lightweight TypeScript agent assimilation
- REQ-42: Google ADK protocol-first agent assimilation
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-MEMORY-*`
  - `V6-RESEARCH-*`
  - `V6-CONTEXT-*`
  - `V6-OBSERVABILITY-*`

## Requirements

### REQ-43-001: RAG Pipeline and Query Engine Registry

**Requirement:** Model LlamaIndex indexes, retrievers, and query engines over the authoritative Dream Sequencer and workflow/runtime lanes.

**Acceptance:**
- RAG queries route through governed retrieval/runtime paths
- Hybrid, vector, and graph retrieval patterns are expressible without new authority primitives
- Query execution emits deterministic receipts

---

### REQ-43-002: Agentic Workflow and Tool-Calling Bridge

**Requirement:** Support LlamaIndex-style agentic workflows and tool-calling through existing workflow, swarm, and tool bridge primitives.

**Acceptance:**
- ReAct/tool-agent style flows route through authoritative orchestration paths
- Tool invocation is receipted and fail closed
- Existing handoff, role, and budget semantics remain enforced

---

### REQ-43-003: Multi-Modal Indexing and Data Loader Bridge

**Requirement:** Normalize LlamaIndex multi-modal loaders and connector breadth onto substrate adapters and governed ingestion/runtime paths.

**Acceptance:**
- Multi-modal ingestion uses adapter-owned loaders and connectors
- Context-budget and degraded-mode rules remain enforced
- Pure/tiny-max profiles degrade safely rather than bypassing governance

---

### REQ-43-004: Memory Store and Evaluation Assimilation

**Requirement:** Reuse existing memory runtime, auto-recall, and observability lanes for LlamaIndex memory-store and evaluation patterns.

**Acceptance:**
- Memory-store semantics map onto existing state and retrieval contracts
- Evaluation outputs persist as governed observability artifacts
- Existing dashboards/export paths can render LlamaIndex-assimilated evidence

---

### REQ-43-005: Workflow Orchestration and Conditional Routing

**Requirement:** Map LlamaIndex workflow orchestration and conditional handoff behavior onto existing workflow and initiative primitives.

**Acceptance:**
- Conditional routing and workflow transitions remain deterministic and receipted
- Existing checkpoint and orchestration guards remain authoritative
- No parallel workflow engine is introduced

---

### REQ-43-006: Observability and Tracing Bridge

**Requirement:** Fold LlamaIndex tracing and debugging surfaces into the native receipt and observability stack.

**Acceptance:**
- Query and workflow traces persist as native observability artifacts
- Zero-loss capture remains enforceable
- Tracing does not create a duplicate telemetry stack

---

### REQ-43-007: Connector and Integration Gateway

**Requirement:** Absorb LlamaIndex connector breadth through adapter-owned ingestion and integration manifests.

**Acceptance:**
- `infring assimilate llamaindex` can normalize connector assets into governed manifests
- Load/query actions emit deterministic receipts
- Unsupported connectors fail closed with explicit reasons

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-009.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc’s `apps/llamaindex/` suggestion into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
