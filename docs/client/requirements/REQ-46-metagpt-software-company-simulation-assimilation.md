# REQ-46: MetaGPT Software Company Simulation Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Swarm / Product-to-Code Orchestration

## Objective

Assimilate the practical strengths of MetaGPT into InfRing without introducing a parallel company-simulation authority path: role-based software-company orchestration, SOP-driven product-to-code pipelines, code generation and execution, PR-style review, structured debate, requirements decomposition, and human oversight hooks should all map onto existing workflow, swarm, memory, observability, and adapter primitives.

## Source References

- [MetaGPT repository](https://github.com/geekan/MetaGPT)
- [Source doc](https://docs.google.com/document/d/1ZTJWRdQpXzsKnXXJ9nvJqA0Dr_Q1kGgexNa6o2_G9y4/edit?usp=sharing)

## Scope

In scope:
- Company-style role orchestration over existing workflow and swarm lanes
- SOP-driven structured pipelines for product-to-code execution
- Code generation, sandboxed execution, and PR/review simulation over governed runtime and substrate paths
- Debate/review loops, requirements analysis, and task breakdown over existing memory and orchestration primitives
- Human oversight hooks through existing pause/approval surfaces
- Thin `infring assimilate metagpt` operator path

Out of scope:
- A separate MetaGPT-owned execution engine
- Moving company orchestration, code execution, or review authority into app-owned shells
- Treating product-to-code simulation as a reason to bypass current sandbox, receipt, or policy gates

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Sandboxed execution and integration bridges live in `adapters/`
- Optional demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-38: Agent orchestration hardening
- REQ-45: OpenAI Swarm lightweight handoff assimilation
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`
  - `V6-SUBSTRATE-007.*`

## Requirements

### REQ-46-001: Role-Based Company Simulation Registry

**Requirement:** Model MetaGPT’s specialized company roles over the authoritative workflow, swarm, and persona orchestration lanes.

**Acceptance:**
- Simulated role execution remains isolated, budgeted, and receipted
- Role specialization preserves lineage and deterministic orchestration semantics
- No duplicate company-orchestration authority is introduced

---

### REQ-46-002: SOP-Driven Pipeline Engine

**Requirement:** Support MetaGPT-style standard operating procedure pipelines through existing workflow and initiative primitives.

**Acceptance:**
- Multi-stage SOP flows remain deterministic and receipted
- Existing checkpoint, routing, and budget guards remain authoritative
- No parallel pipeline engine is introduced

---

### REQ-46-003: Code Generation, Execution, and PR Simulation

**Requirement:** Reuse governed inference, sandbox, and review lanes for MetaGPT-style code writing, execution, and PR-style simulation.

**Acceptance:**
- Generated code and execution paths emit deterministic receipts
- Sandboxed execution remains fail closed and adapter/substrate owned
- Review/PR simulation does not bypass policy or safety gates

---

### REQ-46-004: Multi-Agent Debate and Review Mechanism

**Requirement:** Map MetaGPT debate and peer-review semantics onto existing swarm, persona, and review primitives.

**Acceptance:**
- Debate/review rounds remain isolated, budgeted, and receipted
- Existing attention, importance, and context-budget controls remain authoritative
- No duplicate review runtime is introduced

---

### REQ-46-005: Product Management and Requirements Bridge

**Requirement:** Reuse Dream Sequencer, content-skill, and governed memory primitives for MetaGPT-style requirements analysis and task breakdown.

**Acceptance:**
- Requirements and task artifacts persist through governed memory lanes
- Auto-recall and product-to-task decomposition remain receipted and auditable
- No second requirements authority path is introduced

---

### REQ-46-006: Human Oversight and Intervention Hooks

**Requirement:** Support MetaGPT-style human review points through existing pause, approval, and shadow/operator control surfaces.

**Acceptance:**
- Intervention and approval decisions emit deterministic receipts with operator state
- Existing approval boundaries remain authoritative
- No separate review authority is introduced

---

### REQ-46-007: Observability and Pipeline Tracing

**Requirement:** Fold MetaGPT workflow tracing and debugging into the native observability and receipt stack.

**Acceptance:**
- Simulation and pipeline events stream as native observability artifacts
- Existing dashboards/export paths can render MetaGPT-assimilated evidence
- Tracing does not create a duplicate telemetry stack

---

### REQ-46-008: YAML/Config and Extensibility Bridge

**Requirement:** Absorb MetaGPT declarative configs and extension surfaces through existing content-skill and adapter-owned intake bridges.

**Acceptance:**
- `infring assimilate metagpt` can normalize config assets into governed manifests
- Config-driven execution emits deterministic receipts
- Unsupported config or extension paths fail closed with explicit reasons

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-006.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/metagpt/` suggestion into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
