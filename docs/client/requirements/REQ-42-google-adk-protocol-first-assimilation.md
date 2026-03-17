# REQ-42: Google ADK Protocol-First Agent Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Swarm / Interop

## Objective

Assimilate the practical strengths of Google ADK into InfRing without introducing a parallel runtime authority path: A2A protocol-first distributed agents, workflow and `LlmAgent` semantics, multi-language SDK interop, tool ecosystems, HITL confirmation, session rewind, evaluation, sandboxed code execution, and cloud deployment patterns should all map onto existing swarm, workflow, memory, observability, and adapter primitives.

## Source References

- [Google ADK Python repository](https://github.com/google/adk-python)
- [Google ADK docs](https://google.github.io/adk-docs/)
- [Google ADK samples](https://github.com/google/adk-samples)
- [Source doc](https://docs.google.com/document/d/1ijzS46TOklhWpmpvx5OfhQnJ8lKP96BI81s3ERRaUWo/edit?usp=sharing)

## Scope

In scope:
- A2A protocol interop over existing swarm messaging/session/runtime primitives
- Agent and workflow semantics over existing workflow/persona/swarm lanes
- Tool ecosystems, MCP/OpenAPI bridges, and multi-language interop through adapters
- HITL confirmation, session rewind, evaluation, and sandboxed code execution
- Thin `infring assimilate google-adk` operator path
- Optional dev UI and cloud deployment shells as non-authoritative surfaces

Out of scope:
- A separate Google-ADK-owned execution engine
- Moving orchestration or interop authority into app or UI shells
- Treating cloud deployment patterns as a new core substrate rather than adapter-bound integrations

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Multi-language, cloud, MCP, and tool bridges live in `adapters/`
- Optional UI/demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-17: Tool context and messaging assimilation
- REQ-38: Agent orchestration hardening
- REQ-41: Mastra lightweight TypeScript agent assimilation
- Existing SRS families:
  - `V6-SWARM-*`
  - `V6-WORKFLOW-003.*`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`
  - `V6-SUBSTRATE-007.*`

## Requirements

### REQ-42-001: A2A Protocol-First Agent Registry

**Requirement:** Support ADK-style agent-to-agent interop over the authoritative swarm/session/runtime path.

**Acceptance:**
- Remote agent handoffs and interop messages route through governed swarm/session primitives
- Cross-language interoperability is adapter-owned and receipted
- No duplicate message bus or session authority is introduced

---

### REQ-42-002: `LlmAgent` and Workflow Agent Semantics

**Requirement:** Map ADK `LlmAgent` and workflow agent execution onto the authoritative workflow/persona/swarm lanes.

**Acceptance:**
- Sequential, parallel, and loop-style workflow semantics are expressible over existing workflow contracts
- Agent execution emits deterministic receipts
- Existing routing, budget, and safety policies remain authoritative

---

### REQ-42-003: Tool Ecosystem and MCP/OpenAPI Bridge

**Requirement:** Reuse existing adapter/content-skill/tool bridges for ADK prebuilt tools, custom functions, OpenAPI, and MCP integration.

**Acceptance:**
- Imported tools normalize into governed manifests
- Tool invocation emits deterministic receipts and fail-closed denials
- Tool ecosystems do not create client-owned authority surfaces

---

### REQ-42-004: Hierarchical Multi-Agent Coordination

**Requirement:** Support ADK-style coordinator/sub-agent and hierarchical patterns through existing swarm and persona orchestration primitives.

**Acceptance:**
- Nested agent execution is isolated, budgeted, and receipted
- Existing importance queues, session lineage, and context budgets remain enforced
- Pure/tiny-max profiles degrade safely

---

### REQ-42-005: HITL Tool Confirmation Middleware

**Requirement:** Support ADK-style human approval gates for risky tool invocations via existing pause/approval/receipt flows.

**Acceptance:**
- Risky tool calls can require explicit approval before execution
- Approval/denial emits deterministic receipts with operator decision state
- No second approval boundary is introduced outside existing runtime governance

---

### REQ-42-006: Session Rewind and Evaluation Bridge

**Requirement:** Map ADK rewind and evaluation semantics onto existing memory/receipt/observability contracts.

**Acceptance:**
- Rewind restores bounded session state through governed state lanes
- Evaluation metrics persist as native observability artifacts
- Rewind/evaluation paths remain compatible with pure mode and fail closed when unsupported

---

### REQ-42-007: Code Executor Sandbox and Cloud Integrations

**Requirement:** Absorb ADK sandbox and GCP-style integration strengths through existing security, substrate, and adapter governance.

**Acceptance:**
- Code execution remains sandboxed and fail closed
- Cloud integrations are adapter-owned and policy-gated
- Unsupported cloud features degrade explicitly rather than bypassing governance

---

### REQ-42-008: Development UI and Deployment Shells

**Requirement:** Support optional ADK-like dev UI and deployment shells without making them system authority.

**Acceptance:**
- UI and deployment shells are deletable without changing core behavior
- All workflow execution, state mutation, and deployment artifact generation delegate to governed authority lanes
- Deployment artifacts emit deterministic receipts

---

### REQ-42-009: Model-Agnostic and Multi-Language Gateway

**Requirement:** Capture ADK’s model-agnostic and multi-language strengths through adapters and governed runtime contracts.

**Acceptance:**
- Any supported LLM/provider path emits deterministic route and invocation receipts
- Python/TS/Go/Java interop remains bridge-owned rather than runtime-owned
- Tiny-max and pure modes do not regress from unsupported polyglot paths

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-010.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc’s `apps/google-adk/` and `apps/google-adk-ui/` suggestions into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
