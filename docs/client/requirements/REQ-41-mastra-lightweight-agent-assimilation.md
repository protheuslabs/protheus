# REQ-41: Mastra Lightweight TypeScript Agent Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / TS Runtime

## Objective

Assimilate the practical strengths of Mastra into InfRing without creating a parallel framework authority path: graph workflows, lightweight TypeScript DX, memory and RAG ergonomics, MCP interoperability, human-in-the-loop suspend/resume, evals/tracing, model routing, and dev-studio/full-stack integration should all reuse existing workflow, swarm, memory, observability, and adapter primitives.

## Source References

- [Mastra repository](https://github.com/mastra-ai/mastra)
- [Source doc](https://docs.google.com/document/d/1QDZnA7Ezfjn5Ez4xcKyz00hpfy5Rbj9FI1XW-x-OAgI/edit?usp=sharing)

## Scope

In scope:
- Graph workflow syntax and orchestration patterns over existing workflow/swarm lanes
- Lightweight TS-native agent and tool reasoning patterns
- Memory/RAG/HITL/MCP/eval/tracing/model-routing assimilation
- Thin `infring assimilate mastra` operator path
- Optional dev-studio/full-stack UX surfaces as non-authoritative shells

Out of scope:
- Creating a second workflow engine outside existing core authority
- Moving orchestration or memory authority into app-owned or studio-owned code
- Treating Mastra compatibility as a new standalone system rather than an intake over current primitives

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime and developer-facing UX remain in `client/runtime/systems/**`
- Connector and protocol bridges live in `adapters/`
- Optional demo/playground surfaces may exist in `apps/`, but only as deletable UI shells with no system authority

## Related Requirements

- REQ-17: Tool context and messaging assimilation
- REQ-38: Agent orchestration hardening
- REQ-39: Haystack modular pipeline and agent assimilation
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-SWARM-033` through `V6-SWARM-038`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`
  - `V6-SUBSTRATE-007.*`

## Requirements

### REQ-41-001: Graph Workflow Engine

**Requirement:** Support Mastra-style graph workflow composition over the existing workflow lane and swarm runtime.

**Acceptance:**
- Workflow graph stages support chaining, branching, and parallelism over governed runtime contracts
- Control-flow visibility is preserved with deterministic receipts
- No duplicate execution engine is introduced

---

### REQ-41-002: Agent and Tool Reasoning Runtime

**Requirement:** Map Mastra’s agent/tool reasoning model onto the authoritative swarm/session and persona orchestration paths.

**Acceptance:**
- Agent loops and tool selection emit deterministic receipts
- Existing budget, safety, and direct-messaging constraints remain enforced
- No client-owned orchestration authority is introduced

---

### REQ-41-003: Memory, Semantic Recall, and RAG Bridge

**Requirement:** Reuse Dream Sequencer, auto-recall, and governed retrieval lanes for Mastra-style memory, semantic recall, and RAG.

**Acceptance:**
- Conversation history, working memory, semantic recall, and RAG route through existing memory/runtime contracts
- Context budgets remain enforced
- Pure/tiny-max profiles degrade safely through capability profiling

---

### REQ-41-004: Human-in-the-Loop Suspend/Resume

**Requirement:** Support Mastra-style suspend/resume and approval flows via existing state persistence and receipt contracts.

**Acceptance:**
- Workflow state can persist across pause/resume boundaries
- Human approval/review events emit deterministic receipts with approval state
- Suspend/resume does not create a second persistence boundary outside existing runtime state lanes

---

### REQ-41-005: MCP Server and Interop Bridge

**Requirement:** Expose Mastra-style MCP interoperability through adapter-owned protocol bridges and existing content/skill surfaces.

**Acceptance:**
- MCP server/tool/resource exposure routes through conduit-backed bridges
- Unsupported interop paths fail closed
- Interop events and resource use emit deterministic receipts

---

### REQ-41-006: Evals and Tracing Observability

**Requirement:** Fold Mastra evals, traces, logs, and token/performance telemetry into the native observability stack.

**Acceptance:**
- Evaluation and tracing outputs persist as governed observability artifacts
- Existing dashboards/export paths can render Mastra-assimilated runs
- No separate observability subsystem is introduced

---

### REQ-41-007: Model Routing Compatibility

**Requirement:** Map Mastra-style 40+ LLM routing ergonomics onto the existing inference and routing authority lanes.

**Acceptance:**
- Route decisions remain deterministic and receipted
- Provider compatibility surfaces are adapter-owned or inference-owned, not studio-owned
- Tiny-max and pure modes do not regress from unsupported routing paths

---

### REQ-41-008: Dev Studio and Full-Stack Shells

**Requirement:** Support optional Mastra-like dev-studio and full-stack UI shells without making them the source of truth.

**Acceptance:**
- Optional studio/playground surfaces are deletable without changing system behavior
- All mutations and workflow execution delegate to conduit-backed authority only
- Full-stack UI integration remains thin-shell only

---

### REQ-41-009: Lightweight TypeScript Ergonomics Intake

**Requirement:** Capture Mastra’s TS-first developer ergonomics as thin scaffolding and intake flows, not as a separate runtime authority.

**Acceptance:**
- `infring assimilate mastra` can ingest or scaffold Mastra-style project surfaces into governed InfRing structures
- Type-safe TS ergonomics exist as wrappers/templates over existing authority lanes
- Pure/tiny-max profiles do not inherit Node dependency from this intake

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-011.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only. Nothing here should be treated as implemented.
- Normalize the source doc’s `apps/mastra/` and `apps/mastra-studio/` suggestion into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
