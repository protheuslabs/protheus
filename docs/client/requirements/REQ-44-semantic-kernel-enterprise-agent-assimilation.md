# REQ-44: Semantic Kernel Enterprise Agent Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Swarm / Enterprise Interop

## Objective

Assimilate the practical strengths of Microsoft Semantic Kernel into InfRing without introducing a parallel orchestration authority path: kernel-style orchestration, plugin ecosystems, multi-agent collaboration, planners, vector memory connectors, enterprise observability, multimodal connectors, structured output, Azure integrations, and .NET parity should all map onto existing workflow, swarm, memory, observability, and adapter primitives.

## Source References

- [Microsoft Semantic Kernel repository](https://github.com/microsoft/semantic-kernel)
- [Source doc](https://docs.google.com/document/d/1nkybisybRVTONzYR4I347wC07gzLNZoorKec0W4d4KU/edit?usp=sharing)

## Scope

In scope:
- Kernel-style orchestration and service/plugin registration over existing workflow and swarm lanes
- Plugin ecosystems spanning native functions, prompt assets, OpenAPI imports, and MCP surfaces
- Multi-agent collaboration and planner semantics over existing coordination primitives
- Vector memory connectors, semantic retrieval, and enterprise observability integration
- Multimodal/model connector compatibility through governed adapters
- Thin `infring assimilate semantic-kernel` operator path
- Optional .NET shells and enterprise integration shells as deletable, non-authoritative surfaces

Out of scope:
- A second Semantic-Kernel-owned orchestration engine
- Moving plugin, planning, or memory authority into app-owned shells
- Treating Azure or .NET integration as justification for bypassing existing runtime governance

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Plugin, OpenAPI, MCP, Azure, and polyglot bridges live in `adapters/`
- Optional demo/UI shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-17: Tool context and messaging assimilation
- REQ-38: Agent orchestration hardening
- REQ-39: Haystack modular pipeline and agent assimilation
- REQ-41: Mastra lightweight TypeScript agent assimilation
- REQ-42: Google ADK protocol-first agent assimilation
- REQ-43: LlamaIndex RAG and agentic workflow assimilation
- Existing SRS families:
  - `V6-WORKFLOW-003.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`
  - `V6-SUBSTRATE-007.*`

## Requirements

### REQ-44-001: Kernel Orchestration Registry

**Requirement:** Model Semantic Kernel's central kernel orchestration and service registration semantics over the authoritative workflow and swarm/runtime lanes.

**Acceptance:**
- Kernel-style execution and service registration route through governed orchestration paths
- Every orchestration step emits deterministic receipts
- No duplicate orchestration authority is introduced

---

### REQ-44-002: Plugin Ecosystem Bridge

**Requirement:** Reuse existing content-skill and adapter bridges for Semantic Kernel native functions, prompt assets, OpenAPI imports, and MCP plugins.

**Acceptance:**
- Plugin assets normalize into governed manifests
- Plugin registration and invocation emit deterministic receipts
- Unsupported or unsafe plugin paths fail closed

---

### REQ-44-003: Agent Framework and Multi-Agent Collaboration

**Requirement:** Map Semantic Kernel chat/custom agents and collaboration patterns onto authoritative swarm, session, and persona orchestration paths.

**Acceptance:**
- Multi-agent collaboration remains isolated, budgeted, and receipted
- Handoff and routing semantics preserve existing lineage and policy controls
- No framework-owned side channel is introduced for collaboration

---

### REQ-44-004: Planner and Structured Reasoning Engine

**Requirement:** Support Semantic Kernel planner semantics through existing workflow, tool-selection, and orchestration primitives.

**Acceptance:**
- Multi-step planning and function selection emit deterministic plan receipts
- Existing conditional routing, checkpoints, and orchestration guards remain authoritative
- No parallel planner runtime is introduced

---

### REQ-44-005: Vector Memory and Semantic Connector Bridge

**Requirement:** Map Semantic Kernel vector memory and semantic connector patterns onto Dream Sequencer, auto-recall, and adapter-owned retrieval bridges.

**Acceptance:**
- Azure AI Search, Chroma, Elasticsearch, and similar connectors remain adapter-owned
- Retrieval and memory flows preserve context-budget enforcement and deterministic receipts
- Pure/tiny-max profiles degrade explicitly when unsupported rather than bypassing governance

---

### REQ-44-006: LLM Connectors and Multimodal Gateway

**Requirement:** Capture Semantic Kernel connector breadth and multimodal support through governed inference and adapter surfaces.

**Acceptance:**
- Azure OpenAI, Ollama, Hugging Face, NVIDIA, and similar connectors emit deterministic route and invocation receipts
- Vision/audio multimodal paths remain policy-gated
- Unsupported connectors fail closed with explicit reasons

---

### REQ-44-007: Structured Output and Process Framework

**Requirement:** Reuse receipt, schema, and policy lanes for Semantic Kernel structured output and business-process modeling semantics.

**Acceptance:**
- Structured outputs are schema-validated and receipt-anchored
- Fail-closed enforcement remains authoritative on schema or policy violations
- Process modeling does not create a second state machine authority path

---

### REQ-44-008: Enterprise Observability and Azure Integration

**Requirement:** Fold Semantic Kernel observability, logging, security, and Azure deployment strengths into native observability and adapter governance.

**Acceptance:**
- Traces, logs, and policy events stream as native observability artifacts
- Enterprise/Azure integrations remain adapter-owned and receipted
- Existing dashboards/export paths can render Semantic-Kernel-assimilated evidence

---

### REQ-44-009: .NET Interop Surface

**Requirement:** Support Semantic Kernel’s .NET-heavy enterprise footprint through thin interop bridges rather than app-owned authority.

**Acceptance:**
- C#/.NET plugin and agent invocations route through governed interop bridges
- Cross-language parity remains receipted and auditable
- Optional .NET shells are deletable without changing core behavior

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-008.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/semantic-kernel/` and `apps/semantic-kernel-dotnet/` suggestions into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
