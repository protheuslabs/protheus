# REQ-39: Haystack Modular Pipeline and Agent Assimilation

Version: 1.0
Date: 2026-03-16
Owner: InfRing Workflow / Assimilation

## Objective

Assimilate the production strengths of Haystack v2.25.x into InfRing without introducing parallel authority paths: modular component pipelines, agent tool use, searchable toolsets, Jinja-style prompt templating, context-engineered RAG, multimodal flows, evaluation, tracing, and connector breadth should all map onto existing workflow, swarm, memory, observability, and adapter primitives.

## Source References

- [Haystack repository](https://github.com/deepset-ai/haystack)
- [Source doc](https://docs.google.com/document/d/1eqzU0knBOiWTNv4MiaMD2HSIiLyKB9Jg0-CBBL8rfwI/edit?usp=sharing)

## Scope

In scope:
- Modular component and pipeline composition over existing workflow/swarm lanes
- Agent tool use and searchable toolsets over existing swarm/inference/runtime bridges
- Prompt/template ingestion for Haystack-style dynamic prompt rendering
- RAG pipeline bridging onto Dream Sequencer, memory runtime, and content-skill graph
- Conditional routing, ranking, evaluation, tracing, and connector assimilation
- Thin `infring assimilate haystack` operator flow

Out of scope:
- Creating a parallel pipeline engine outside existing workflow authority
- Duplicating retrieval, routing, memory, or observability primitives already present in core
- Treating Haystack as a standalone app under `apps/`

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin operator/runtime surfaces remain in `client/runtime/systems/**`
- Connector shims and external-system bindings live in `adapters/`
- Optional demos or playgrounds may exist in `apps/`, but the Haystack assimilation itself is not app-owned

## Related Requirements

- REQ-14: Offline-first runtime hardening
- REQ-17: Tool context and messaging assimilation
- REQ-36: Smart memory low-burn regression contract
- REQ-38: Agent orchestration hardening
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-SWARM-033` through `V6-SWARM-038`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`

## Requirements

### REQ-39-001: Modular Component and Pipeline Registry

**Requirement:** Model Haystack-style components and explicit pipelines as receipted compositions over the existing workflow lane and swarm runtime.

**Acceptance:**
- Pipeline stages are declared as governed components with typed inputs/outputs
- Retrieval, routing, memory, and generation stages execute with deterministic receipts
- No new parallel core primitive is introduced for pipeline execution
- Pure mode and tiny-max degrade safely through existing capability gates

---

### REQ-39-002: Agent + Searchable Toolset Runtime

**Requirement:** Support Haystack-style agent execution and searchable tool selection through existing swarm and inference primitives.

**Acceptance:**
- Agents can invoke governed tools through the existing swarm/session authority path
- Searchable toolset behavior reduces context/tool fan-out before execution
- Tool selection and invocation emit deterministic receipts
- Hard token budgets and direct messaging remain enforced

---

### REQ-39-003: Template and Prompt Bridge

**Requirement:** Ingest Haystack-style dynamic prompt templates as first-class, receipted artifacts without moving prompt authority into the client.

**Acceptance:**
- Template artifacts are versioned and provenance-linked
- Rendered prompt outputs emit receipts with source-template references
- `infring assimilate haystack` can ingest template assets into governed storage
- Client wrappers remain display/launch surfaces only

---

### REQ-39-004: RAG and Document Store Bridge

**Requirement:** Map Haystack RAG and document-store patterns onto Dream Sequencer, auto-recall, and existing retrieval/runtime primitives.

**Acceptance:**
- Retrieval pipelines route through existing memory/research/runtime lanes
- Context budgets remain enforced end-to-end
- Connector/document-store usage is adapter-owned, not client-owned
- Edge/pure/tiny-max modes degrade through capability profiling rather than bypassing governance

---

### REQ-39-005: Conditional Routing and Ranker Orchestration

**Requirement:** Support conditional routing, rankers, and metadata-driven branch selection through deterministic workflow contracts.

**Acceptance:**
- Routing decisions are explicit, receipted, and replayable
- Ranker and router components integrate without bypassing existing workflow gates
- Fail-closed behavior is preserved for unsupported models/connectors
- Existing checkpoint and orchestration contracts remain authoritative

---

### REQ-39-006: Multimodal and Evaluation Assimilation

**Requirement:** Fold Haystack multimodal pipelines and evaluation surfaces into existing substrate adapters and observability lanes.

**Acceptance:**
- Multimodal stages emit typed artifacts and deterministic receipts
- Evaluation outputs are persisted as governed evidence objects
- Metrics stream through existing observability surfaces
- No separate evaluation subsystem is introduced

---

### REQ-39-007: Tracing and Production Observability Parity

**Requirement:** Expose Haystack-style step visibility and traceability using the existing receipt and observability stack.

**Acceptance:**
- Every pipeline stage, tool call, and branch decision is traceable
- Existing dashboards/export paths can render Haystack-assimilated runs
- Trace storage remains lossless under configured policy bounds
- Receipt contracts remain the source of truth

---

### REQ-39-008: Integration Gateway and Assimilation Entry Point

**Requirement:** Provide a thin operator path to ingest Haystack connectors and pipeline assets while preserving adapter/core authority.

**Acceptance:**
- `infring assimilate haystack` exists as a governed intake path
- Imported connectors are normalized into adapter-owned manifests
- Unsupported integrations fail closed with explicit reasons
- Import actions emit deterministic provenance receipts

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-012.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only. No status in SRS should imply implementation.
- Normalize the source doc's `apps/haystack/` suggestion into core/client/adapters placement unless a later task explicitly scopes a deletable demo app.
- Prefer `infring` naming in operator surfaces; legacy `protheus` aliases may be referenced only where backward compatibility matters.
