# REQ-45: OpenAI Swarm Lightweight Handoff Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Swarm / Context Routing

## Objective

Assimilate the practical strengths of OpenAI Swarm into InfRing without introducing a parallel orchestration authority path: lightweight agent handoffs, mutable context propagation, automatic JSON-schema tool generation, streaming with agent delimiters, multi-turn execution, REPL-style iteration, composable agent networks, and error-recovery ergonomics should all map onto existing swarm, workflow, memory, observability, and adapter primitives.

## Source References

- [OpenAI Swarm repository](https://github.com/openai/swarm)
- [Source doc](https://docs.google.com/document/d/1rOMGeqiWLK71_J-pIgSMvAQvg8aFh-HsDpm_t7mqtbo/edit?usp=sharing)

## Scope

In scope:
- Handoff-driven orchestration over existing swarm and workflow lanes
- Mutable context propagation over Dream Sequencer and auto-recall primitives
- Automatic JSON-schema tool generation through existing content-skill and polyglot bridges
- Streaming delimiters and multi-turn execution over native inference and orchestration paths
- Optional REPL/demo shells as deletable, non-authoritative surfaces
- Thin `infring assimilate swarm` operator path

Out of scope:
- A separate Swarm-owned execution engine
- Moving handoff, context, or tool authority into app-owned shells
- Treating REPL ergonomics as justification for bypassing conduit/runtime governance

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Polyglot/tool bridges live in `adapters/`
- Optional demo/REPL shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-17: Tool context and messaging assimilation
- REQ-38: Agent orchestration hardening
- REQ-44: Semantic Kernel enterprise agent assimilation
- Existing SRS families:
  - `V6-SWARM-*`
  - `V6-WORKFLOW-003.*`
  - `V6-MEMORY-*`
  - `V6-CONTEXT-*`
  - `V6-OBSERVABILITY-*`

## Requirements

### REQ-45-001: Agent Handoff Registry

**Requirement:** Model OpenAI Swarm handoff semantics over the authoritative swarm and workflow/runtime lanes.

**Acceptance:**
- Handoffs route through governed orchestration paths
- Control transfer preserves lineage, importance, and deterministic receipts
- No duplicate handoff authority is introduced

---

### REQ-45-002: Context Variable Propagation

**Requirement:** Support Swarm-style mutable context propagation through Dream Sequencer, auto-recall, and context-budget enforcement primitives.

**Acceptance:**
- Dynamic context state persists and routes through governed memory/context lanes
- Context-budget guards remain authoritative
- Pure/tiny-max profiles degrade safely rather than bypassing governance

---

### REQ-45-003: Automatic JSON-Schema Tool Bridge

**Requirement:** Reuse content-skill and adapter bridges for automatic function-to-tool normalization and schema generation.

**Acceptance:**
- Function imports normalize into governed tool manifests
- Tool registration and invocation emit deterministic receipts
- Unsupported or unsafe tool paths fail closed

---

### REQ-45-004: Streaming with Agent Delimiters

**Requirement:** Map Swarm streaming event delimiters and agent-boundary semantics onto native inference and observability paths.

**Acceptance:**
- Streaming outputs preserve agent boundary events through governed streaming lanes
- Every delimited chunk is receipt-anchored
- Existing live observability surfaces can render the stream without a parallel trace stack

---

### REQ-45-005: Multi-Turn Execution and Error Recovery

**Requirement:** Support Swarm-style multi-turn execution and error recovery through existing workflow, swarm, and safety lanes.

**Acceptance:**
- Execution can continue across tool turns until completion under governed orchestration
- Errors emit deterministic receipts and fail-closed policy outcomes
- No client-side bypass path is introduced for recovery

---

### REQ-45-006: REPL and Demo Loop Ergonomics

**Requirement:** Support lightweight REPL/demo iteration as a thin shell over existing authority lanes.

**Acceptance:**
- Optional REPL/demo shells are deletable without changing core behavior
- Every turn delegates to governed authority surfaces and emits deterministic receipts
- REPL ergonomics do not force Node or app-owned authority into pure/tiny-max profiles

---

### REQ-45-007: Composable Agent Networks

**Requirement:** Treat Swarm-style composable agents as orchestrated participants over existing swarm/session/persona primitives.

**Acceptance:**
- Agent networks remain isolated, budgeted, and receipted
- Existing attention/importance and session lineage semantics remain authoritative
- Composability does not create a second orchestration runtime

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-007.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/swarm/` suggestion into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
