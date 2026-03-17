# REQ-48: CrewAI Role-Based Hierarchical Crews Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Swarm / Hierarchical Delegation

## Objective

Assimilate the practical strengths of CrewAI into InfRing without introducing a parallel crew-orchestration authority path: role-based agents and crews, sequential and hierarchical processes, event-driven flows, unified memory, YAML and decorator-based configs, dynamic delegation, human-in-the-loop pauses, broad provider compatibility, and AMP-style observability should all map onto existing workflow, swarm, memory, observability, and adapter primitives.

## Source References

- [CrewAI repository](https://github.com/crewAIInc/crewAI)
- [Source doc](https://docs.google.com/document/d/10jW_kdehmfj5Cpg9l2tVSwvHhFtkWcvqAxHTgR0pKlY/edit?usp=sharing)

## Scope

In scope:
- Role-based agents and crews over existing workflow and swarm lanes
- Sequential and hierarchical processes over authoritative orchestration primitives
- Event-driven flows, unified memory, and YAML/decorator-based config intake
- Dynamic delegation, HITL checkpoints, and broad provider/local-model compatibility
- AMP-style observability and control-plane semantics as thin surfaces over native telemetry
- Thin `infring assimilate crewai` operator path

Out of scope:
- A separate CrewAI-owned runtime or control plane
- Moving crew, flow, memory, or provider authority into app-owned shells
- Treating decorator/YAML ergonomics as justification for bypassing conduit/runtime governance

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Provider, tool, and local-model bridges live in `adapters/`
- Optional demo/visual shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-38: Agent orchestration hardening
- REQ-46: MetaGPT software company simulation assimilation
- REQ-47: Dify visual agent platform assimilation
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`
  - `V6-SUBSTRATE-007.*`

## Requirements

### REQ-48-001: Role-Based Agent and Crew Registry

**Requirement:** Model CrewAI role, goal, and crew semantics over the authoritative workflow, swarm, and persona orchestration lanes.

**Acceptance:**
- Crew execution remains isolated, budgeted, and receipted
- Role specialization preserves lineage and deterministic orchestration semantics
- No duplicate crew authority is introduced

---

### REQ-48-002: Sequential and Hierarchical Process Engine

**Requirement:** Support CrewAI-style sequential and manager-led hierarchical processes through existing workflow and initiative primitives.

**Acceptance:**
- Hierarchical delegation and validation remain deterministic and receipted
- Existing checkpoint, routing, and budget controls remain authoritative
- No parallel process engine is introduced

---

### REQ-48-003: Event-Driven Flows and Decorator Bridge

**Requirement:** Reuse governed workflow and conduit lanes for CrewAI-style event-driven flows, routers, listeners, and decorator-based flow definitions.

**Acceptance:**
- Flow routing emits deterministic receipts
- Conditional logic remains fail closed
- Flow semantics do not create a second state-management authority path

---

### REQ-48-004: Unified Memory Bridge

**Requirement:** Map CrewAI unified memory semantics onto Dream Sequencer, auto-recall, and governed memory primitives.

**Acceptance:**
- Persistent state remains receipted and context-budgeted
- Existing memory authority remains canonical
- Crew-level and agent-level continuity can render through current memory surfaces

---

### REQ-48-005: YAML and Declarative Crew Config Bridge

**Requirement:** Support CrewAI-style YAML configs and decorator-driven crew definitions through governed content-skill and intake bridges.

**Acceptance:**
- `infring assimilate crewai` can normalize YAML/config assets into governed manifests
- Config-driven execution emits deterministic receipts
- Unsupported config surfaces fail closed with explicit reasons

---

### REQ-48-006: Dynamic Delegation and Tool Routing

**Requirement:** Map CrewAI-style dynamic delegation and tool routing onto authoritative swarm, importance, and tool-invocation primitives.

**Acceptance:**
- Delegation decisions remain receipted and importance-aware
- Tool execution emits deterministic receipts and fail-closed denials
- Pure/tiny-max profiles degrade explicitly when unsupported

---

### REQ-48-007: Human-in-the-Loop Middleware

**Requirement:** Support CrewAI-style human review and intervention through existing pause, approval, and shadow/operator control surfaces.

**Acceptance:**
- Review and approval actions emit deterministic receipts with operator state
- Existing approval boundaries remain authoritative
- No separate HITL authority is introduced

---

### REQ-48-008: AMP-Style Observability and Control Plane

**Requirement:** Fold CrewAI tracing, metrics, logs, and control-plane semantics into the native observability and receipt stack.

**Acceptance:**
- Crew and flow events stream as native observability artifacts
- Existing dashboards/export paths can render CrewAI-assimilated evidence
- No duplicate control-plane or telemetry stack is introduced

---

### REQ-48-009: Performance and Standalone Runtime Parity

**Requirement:** Capture CrewAI’s lean standalone runtime advantages through existing inference, streaming, and benchmark lanes.

**Acceptance:**
- Performance claims route through current benchmark/receipt paths
- No regression is introduced for tiny-max baselines without evidence
- Runtime parity remains measurable through governed benchmark lanes

---

### REQ-48-010: Multimodal and Local Model Gateway

**Requirement:** Support CrewAI-style multimodal and local-model compatibility through substrate and inference adapters.

**Acceptance:**
- Multimodal and local-model invocations emit deterministic route and invocation receipts
- Adapter-owned bridges remain the only integration boundary
- Unsupported pure/tiny-max paths degrade explicitly rather than bypassing governance

## Verification Requirements

- SRS regression must parse and accept the normalized `V6-WORKFLOW-004.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- The source doc proposes `V6-WORKFLOW-003.*`, but that family is already occupied in this repo. Normalize this intake to `V6-WORKFLOW-004.*` to avoid contract collision.
- Normalize the source doc's `apps/crewai/` suggestion into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
