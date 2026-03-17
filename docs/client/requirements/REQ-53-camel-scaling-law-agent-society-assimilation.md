# REQ-53: CAMEL Scaling-Law Agent Society Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Swarm / Workflow / Memory / Observability

## Objective

Assimilate CAMEL's large-scale multi-agent society value into InfRing without introducing a parallel authority path: role-playing societies, large-scale coordination, OASIS-style world simulation, synthetic dataset ingestion, code-as-prompt stateful conversations, CRAB-style evaluation, tool ecosystems, and emergent scaling-law observability should all map onto existing swarm, workflow, Dream Sequencer, context-budget, content-skill, adapter, and observability primitives.

## Source References

- [Source doc](https://docs.google.com/document/d/18JoI69ZnPTtAqsp3QtKyLJ8NNRWDXqWcOW8RkwwgQEU/edit?usp=sharing)
- [CAMEL upstream](https://github.com/camel-ai/camel)

## Scope

In scope:
- Role-playing society execution over existing swarm/workflow lanes
- Large-scale society coordination and emergent behavior observation
- OASIS-style world simulation over current memory/simulation surfaces
- Synthetic dataset ingestion for society/evaluation workloads
- Stateful code-as-prompt and multi-turn conversation routing
- CRAB-style evaluation and benchmark bridging
- Tool integration routing through conduit-owned bridges
- Native observability for scaling-law and societal dynamics

Out of scope:
- A separate CAMEL-owned orchestration or memory runtime
- Moving authority into `apps/camel/**`
- Bypassing current budget, receipt, policy, or substrate governance for society workloads

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Connector, dataset, and tool bridges live in `adapters/`
- Optional society/demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-38: Agent orchestration hardening
- REQ-39: Haystack modular pipeline and agent assimilation
- REQ-42: Google ADK protocol-first agent assimilation
- REQ-45: OpenAI Swarm lightweight handoff assimilation
- REQ-49: LangGraph persistent graph orchestration assimilation
- Existing SRS families:
  - `V6-SWARM-*`
  - `V6-WORKFLOW-001.*` through `V6-WORKFLOW-012.*`
  - `V6-MEMORY-*`
  - `V6-CONTEXT-*`
  - `V9-AUDIT-026`

## Requirements

### REQ-53-001: Role-Playing Society Registry

**Requirement:** Role-specialized agent societies must route through governed swarm and workflow primitives rather than a parallel framework-owned society engine.

**Acceptance:**
- Society roles such as task creator, critic, reviewer, or specialist map to authoritative swarm/session primitives
- Society execution emits deterministic receipts and preserved lineage
- No second role-routing authority is introduced

---

### REQ-53-002: Scalable Multi-Agent Society Execution

**Requirement:** Large-scale society coordination must extend existing swarm primitives with explicit budget, isolation, and observability boundaries.

**Acceptance:**
- Large society runs preserve isolated receipts, importance queues, and context-budget enforcement
- Capability shedding and degraded-mode behavior remain explicit for pure/tiny-max profiles
- Scaling runs remain fail closed under unsupported capacity or budget conditions

---

### REQ-53-003: OASIS World Simulation Bridge

**Requirement:** OASIS-style social/world simulation must build on current Dream Sequencer, memory, and context primitives.

**Acceptance:**
- Simulation state persists through authoritative memory/runtime lanes
- Information-spread and world-state transitions emit deterministic receipts
- Pure and tiny-max unsupported paths degrade explicitly rather than silently bypassing policy

---

### REQ-53-004: Synthetic Dataset Ingestion

**Requirement:** CAMEL-style society and domain datasets must ingest through content-skill and adapter-owned artifact paths.

**Acceptance:**
- Dataset import runs through `infring assimilate camel` or equivalent governed intake
- Training/eval artifacts are provenance-linked and receipted
- Unsupported dataset or tooling paths fail closed with explicit reasons

---

### REQ-53-005: Code-as-Prompt and Stateful Conversation Routing

**Requirement:** Stateful code-as-prompt and multi-turn conversation patterns must normalize onto current inference, streaming, and swarm/session lanes.

**Acceptance:**
- Stateful conversations preserve deterministic receipts and context lineage
- Multilingual or multi-turn traces remain visible in native observability surfaces
- No separate conversation state authority is introduced

---

### REQ-53-006: CRAB Benchmark and Evaluation Bridge

**Requirement:** CAMEL evaluation and benchmark value must flow into the native observability and evidence stack.

**Acceptance:**
- CRAB-style evaluations emit deterministic benchmark receipts
- Metrics stream through native observability paths with no duplicate evaluation stack
- Benchmark artifacts remain replayable and provenance-linked

---

### REQ-53-007: Tool Ecosystem and Real-World Integration Gateway

**Requirement:** CAMEL tool integrations must route through governed conduit, content-skill, and adapter paths.

**Acceptance:**
- External tools such as search, crawling, OCR, email, or chat integrations remain adapter-owned and fail closed
- Tool registration and invocation emit deterministic receipts
- No app-owned integration authority is introduced

---

### REQ-53-008: Emergent Scaling-Law Observability

**Requirement:** Emergent behavior and scaling-law analysis must be captured through native observability primitives.

**Acceptance:**
- Society dynamics, scaling metrics, and emergent-risk observations stream through current observability lanes
- Metrics can be exported without creating a parallel telemetry stack
- Observability remains compatible with already-queued AMP/LangSmith-style lanes

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-013.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - deterministic receipt/state evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/camel/` and `apps/camel-oasis/` ideas into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring assimilate camel` for operator-facing naming.
