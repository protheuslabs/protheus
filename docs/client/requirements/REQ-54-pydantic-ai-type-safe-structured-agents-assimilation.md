# REQ-54: Pydantic AI Type-Safe Structured Agents Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Validation / Observability

## Objective

Assimilate Pydantic AI's production strengths into InfRing without introducing a parallel runtime authority path: type-safe agents, guaranteed structured outputs, tool and dependency validation, MCP/A2A/UI protocols, durable execution, HITL approval, graph control flow, model-agnostic streaming, and evaluation flows should all map onto existing workflow, swarm, Dream Sequencer, content-skill, adapter, receipt, and observability primitives.

## Source References

- [Source doc](https://docs.google.com/document/d/1QijtkfhfaFMbtBuV-PGlTmbL2uoeKtGccbEAAKra9uE/edit?usp=sharing)
- [Pydantic AI upstream](https://github.com/pydantic/pydantic-ai)

## Scope

In scope:
- Type-safe agent registration over existing workflow/swarm lanes
- Structured output validation and retry/reflection flows
- Tool registration and dependency-injection bridging
- MCP, A2A, and UI protocol interop
- Durable execution and resume/retry semantics
- Human-in-the-loop approval middleware
- Logfire/OTel-style observability mapping
- Graph control flow and stepped execution
- Model-agnostic provider routing and structured streaming
- Built-in evaluations over native observability surfaces

Out of scope:
- A separate Pydantic-AI-owned agent runtime
- Moving validation or execution authority into `apps/pydantic-ai/**`
- Bypassing current budget, receipt, safety, or provider-governance boundaries

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Protocol, provider, and tool bridges live in `adapters/`
- Optional demo or UI shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-38: Agent orchestration hardening
- REQ-42: Google ADK protocol-first agent assimilation
- REQ-49: LangGraph persistent graph orchestration assimilation
- REQ-53: CAMEL scaling-law agent society assimilation
- Existing SRS families:
  - `V6-SWARM-*`
  - `V6-WORKFLOW-001.*` through `V6-WORKFLOW-013.*`
  - `V6-MEMORY-*`
  - `V9-AUDIT-026`
  - `V6-OBSERVABILITY-*`

## Requirements

### REQ-54-001: Type-Safe Agent Registry

**Requirement:** Type-safe agent definitions must route through governed workflow and swarm primitives rather than a second framework-owned execution model.

**Acceptance:**
- Agent definitions preserve type-safe inputs, outputs, and dependency descriptions through authoritative lanes
- Agent execution emits deterministic receipts and lineage
- No duplicate agent runtime is introduced

---

### REQ-54-002: Structured Output and Validation Engine

**Requirement:** Structured output guarantees and validation/retry behavior must normalize onto current memory, receipt, and inference primitives.

**Acceptance:**
- Outputs validate before final return
- Validation failures emit deterministic retry or rejection receipts
- Structured-output enforcement degrades explicitly on unsupported profiles

---

### REQ-54-003: Tool and Dependency Injection Bridge

**Requirement:** Tool registration, validated arguments, and dependency injection must route through content-skill and adapter-owned bridges.

**Acceptance:**
- Tool schemas and dependency contexts remain governed and receipted
- Invalid arguments fail closed with explicit validation evidence
- No client-owned tool authority is introduced

---

### REQ-54-004: MCP / A2A / UI Protocol Bridge

**Requirement:** Pydantic AI protocol strengths must map onto existing swarm/session and interop surfaces.

**Acceptance:**
- MCP, A2A, and UI event flows remain adapter- or swarm-owned and receipted
- Existing messaging, lineage, and policy constraints remain authoritative
- Unsupported protocol features degrade explicitly

---

### REQ-54-005: Durable Execution and Retry Engine

**Requirement:** Durable agents and resume/retry semantics must build on current receipt, checkpoint, and workflow runtime lanes.

**Acceptance:**
- Resumed runs preserve deterministic lineage and compatible receipt hashes
- Long-running or interrupted executions remain restart-safe
- No second persistence or retry authority is introduced

---

### REQ-54-006: Human-in-the-Loop Approval Middleware

**Requirement:** Tool approval and deferred execution must remain inside existing pause, approval, and shadow/operator surfaces.

**Acceptance:**
- Approval and denial decisions emit deterministic receipts
- HITL remains fail closed for risky operations
- No new approval boundary is introduced

---

### REQ-54-007: Logfire / OTel Observability Bridge

**Requirement:** Pydantic AI observability strengths must map into the native observability stack.

**Acceptance:**
- All events, traces, and cost/evaluation metrics stream through existing observability lanes
- No duplicate telemetry stack is introduced
- Native dashboards/export paths can render the evidence

---

### REQ-54-008: Graph Control Flow Bridge

**Requirement:** Graph-defined control flow and stepped execution must normalize onto the authoritative workflow engine.

**Acceptance:**
- Graph stepping and transitions remain deterministic and receipted
- Graph execution preserves existing budget, checkpoint, and lineage controls
- No duplicate graph authority path is introduced

---

### REQ-54-009: Model-Agnostic Gateway and Structured Streaming

**Requirement:** Provider-agnostic routing and validated streaming must flow through current inference and streaming primitives.

**Acceptance:**
- Model swaps emit deterministic route and invocation receipts
- Streaming chunks remain receipt-anchored and validation-aware
- Tiny-max and pure profiles do not regress silently on unsupported providers

---

### REQ-54-010: Evaluation Framework Bridge

**Requirement:** Pydantic AI evals must run over the native evidence and observability stack.

**Acceptance:**
- Eval runs emit deterministic receipts and feed native metrics surfaces
- Evaluation artifacts remain replayable and provenance-linked
- No parallel eval authority is introduced

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-015.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - deterministic receipt/state evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/pydantic-ai/` idea into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring assimilate pydantic-ai` for operator-facing naming.
