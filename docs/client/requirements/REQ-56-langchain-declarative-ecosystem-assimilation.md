# REQ-56: LangChain Declarative Ecosystem Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Memory / Integrations

## Objective

Assimilate LangChain's foundational declarative ecosystem into InfRing without introducing a parallel authority path: LCEL chains, Runnable composability, legacy and deep agents, retrieval and memory abstractions, large integration breadth, model interoperability, prompt templating, and LangSmith-style observability should all map onto existing workflow, swarm, Dream Sequencer, content-skill, adapter, inference, receipt, and observability primitives.

## Source References

- [Source doc](https://docs.google.com/document/d/1tghS8K-vKzMb-3-gtHo7byy_W22g92upY-BDom7SbCw/edit?usp=sharing)
- [LangChain upstream](https://github.com/langchain-ai/langchain)

## Scope

In scope:
- LCEL and Runnable-style declarative chain execution
- Legacy agent and deep-agent pattern bridging
- Retrieval, memory, and vector-store abstraction mapping
- Broad integration intake for models, tools, vector DBs, and loaders
- Model-agnostic routing and prompt-template bridging
- LangSmith-style tracing, evals, and debugging
- Stateful chain execution and rapid-iteration workflow semantics

Out of scope:
- A separate LangChain-owned execution engine
- Moving orchestration or integration authority into `apps/langchain/**`
- Bypassing current budget, receipt, memory, or policy governance for chain or agent flows

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Integration, provider, retriever, and loader bridges live in `adapters/`
- Optional demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-39: Haystack modular pipeline and agent assimilation
- REQ-49: LangGraph persistent graph orchestration assimilation
- REQ-53: CAMEL scaling-law agent society assimilation
- REQ-55: DSPy declarative self-improving pipelines assimilation
- Existing SRS families:
  - `V6-WORKFLOW-001.*` through `V6-WORKFLOW-013.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V6-CONTEXT-*`
  - `V9-AUDIT-026`
  - `V6-OBSERVABILITY-*`

## Requirements

### REQ-56-001: LCEL and Runnable Chain Registry

**Requirement:** LCEL and Runnable-style declarative components must route through governed workflow and swarm primitives rather than a separate framework-owned chain engine.

**Acceptance:**
- Declarative chains preserve composition and deterministic receipts through authoritative lanes
- Every chain execution remains lineage-safe and auditable
- No duplicate chain runtime is introduced

---

### REQ-56-002: Legacy and Deep Agent Bridge

**Requirement:** Legacy agent patterns and deep-agent semantics must normalize onto existing swarm and persona orchestration surfaces.

**Acceptance:**
- Agent execution remains deterministic and receipted
- Planning, sub-agent, and file-oriented behaviors stay inside current boundaries
- No separate agent authority path is introduced

---

### REQ-56-003: Retrieval and Memory Abstraction Bridge

**Requirement:** Vector stores, retrievers, and memory abstractions must map onto current Dream Sequencer and memory/runtime lanes.

**Acceptance:**
- Retrieval and memory behaviors remain context-budgeted and receipted
- Existing canonical memory authority stays intact
- Unsupported retrieval backends degrade explicitly rather than bypassing governance

---

### REQ-56-004: Integration Gateway

**Requirement:** LangChain's broad ecosystem of models, tools, vector stores, and document loaders must ingest through governed content-skill and adapter bridges.

**Acceptance:**
- `infring assimilate langchain` or equivalent intake normalizes integration assets into governed manifests
- Every imported component remains provenance-linked and receipted
- Unsupported integrations fail closed with explicit reasons

---

### REQ-56-005: Model Interoperability and Prompt Engine

**Requirement:** Model-agnostic routing and prompt-template semantics must stay inside current inference and streaming authority.

**Acceptance:**
- Drop-in model changes emit deterministic route and invocation receipts
- Prompt template rendering remains auditable
- Tiny-max and pure profiles do not silently regress on unsupported providers

---

### REQ-56-006: LangSmith-Style Observability Bridge

**Requirement:** LangChain tracing, eval, and debugging value must stream through the native observability and evidence stack.

**Acceptance:**
- Traces and eval artifacts are captured natively with deterministic receipts
- Existing dashboards/export paths can render the evidence
- No duplicate telemetry stack is introduced

---

### REQ-56-007: Stateful Workflow and Rapid Prototyping Bridge

**Requirement:** Stateful chain execution and rapid-iteration workflow patterns must normalize onto the authoritative workflow engine and checkpoint surfaces.

**Acceptance:**
- Stateful execution remains deterministic and receipted
- Existing checkpoint and replay lanes remain authoritative
- No second stateful-workflow authority path is introduced

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-014.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - deterministic receipt/state evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/langchain/` idea into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring assimilate langchain` for operator-facing naming.
