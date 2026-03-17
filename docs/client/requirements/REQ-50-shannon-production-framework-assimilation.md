# REQ-50: Shannon Production Framework Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Replay / Policy / Observability

## Objective

Assimilate the practical strengths of Shannon into InfRing without introducing a parallel production-runtime authority path: orchestration patterns, hard token-budget fallback, hierarchical and vector memory, deterministic replay, HITL middleware, sandbox and multi-tenant isolation, observability bridges, OpenAI-compatible gateway semantics, skills/MCP registry behavior, cron scheduling, desktop surfaces, and P2P swarm reliability should all map onto existing workflow, swarm, memory, observability, security, and adapter primitives.

## Source References

- [Shannon repository](https://github.com/Kocoro-lab/Shannon)
- [Source doc](https://docs.google.com/document/d/17JIvRFQ5zUh1ml3Bhu1IItY2VJIefqT4swMaQ8PmMMw/edit?usp=sharing)

## Scope

In scope:
- Workflow/orchestration pattern intake over existing workflow and swarm lanes
- Budget/fallback, replay, memory, cron, and OpenAI-compat semantics over current core authority
- Sandbox, multi-tenant isolation, and P2P swarm reliability over existing security/substrate primitives
- Observability, skills/MCP, and desktop ergonomics as thin surfaces over native lanes
- Thin `infring assimilate shannon` operator path

Out of scope:
- A separate Shannon-owned orchestrator, gateway, or desktop authority path
- Moving replay, memory, sandbox, or policy authority into app-owned shells
- Treating UI or compat surfaces as justification for bypassing conduit/runtime governance

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Security, gateway, sandbox, and compatibility bridges live in `adapters/`
- Optional desktop/demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-17: Tool context and messaging assimilation
- REQ-38: Agent orchestration hardening
- REQ-49: LangGraph persistent graph orchestration assimilation
- Existing SRS families:
  - `V6-WORKFLOW-002.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V6-OBSERVABILITY-*`
  - `V6-SUBSTRATE-007.*`

## Requirements

### REQ-50-001: Orchestration Pattern Registry

**Requirement:** Model Shannon multi-strategy orchestration patterns over the authoritative workflow and swarm/runtime lanes.

**Acceptance:**
- Pattern execution remains deterministic and receipted
- No duplicate orchestration authority is introduced
- Pure/tiny-max compatibility rules remain explicit

---

### REQ-50-002: Token Budget and Auto-Fallback Guard

**Requirement:** Reuse existing budget and routing primitives for Shannon-style hard budgets and automatic model fallback.

**Acceptance:**
- Budget breach and fallback decisions emit deterministic receipts
- Hard budget enforcement remains fail closed
- No bypass path exists outside current budget authority

---

### REQ-50-003: Hierarchical and Vector Memory Bridge

**Requirement:** Map Shannon-style session workspaces and semantic/recent retrieval behavior onto Dream Sequencer, auto-recall, and governed memory lanes.

**Acceptance:**
- Memory retrieval remains receipted and context-budgeted
- Deduplication and workspace continuity stay within canonical memory authority
- No second memory system is introduced

---

### REQ-50-004: Deterministic Replay Engine

**Requirement:** Reuse existing receipt and replay primitives for Shannon-style full execution replay.

**Acceptance:**
- Replay/export operations emit deterministic receipts
- Replayed executions remain auditable and policy-governed
- No separate replay authority is introduced

---

### REQ-50-005: Human-in-the-Loop Middleware

**Requirement:** Support Shannon-style mandatory human review points through current pause, approval, and shadow/operator surfaces.

**Acceptance:**
- Approval state is receipted deterministically
- Existing HITL boundaries remain authoritative
- No second approval system is introduced

---

### REQ-50-006: Sandbox and Multi-Tenant Isolation

**Requirement:** Express Shannon-style WASI/Firecracker, read-only, and isolation semantics through existing substrate, security, and tenancy primitives.

**Acceptance:**
- Execution remains fail closed
- Multi-tenant separation stays within current security authority
- Destructive operations remain policy-gated and auditable

---

### REQ-50-007: Observability Bridge

**Requirement:** Fold Shannon Prometheus, OpenTelemetry, and Temporal-style debugging semantics into the native observability and receipt stack.

**Acceptance:**
- All events stream as native observability artifacts
- Existing dashboards/export paths can render Shannon-assimilated evidence
- No duplicate telemetry stack is introduced

---

### REQ-50-008: OpenAI-Compatible Gateway

**Requirement:** Support Shannon-style `/v1` compatibility through existing inference and streaming authority primitives.

**Acceptance:**
- Compatibility paths emit deterministic route and invocation receipts
- Existing gateway and provider boundaries remain authoritative
- Unsupported modes degrade explicitly rather than bypassing governance

---

### REQ-50-009: Skills and MCP Tool Registry

**Requirement:** Reuse content-skill and adapter bridges for Shannon-style skills and MCP tool registration.

**Acceptance:**
- Skills and MCP tools normalize into governed manifests
- Registration and invocation emit deterministic receipts
- Unsafe tool paths fail closed

---

### REQ-50-010: Cron and Scheduled Execution

**Requirement:** Map Shannon recurring execution semantics onto existing workflow, initiative, and scheduling primitives.

**Acceptance:**
- Scheduled runs emit deterministic receipts
- Existing budget and priority controls remain authoritative
- No duplicate scheduler authority is introduced

---

### REQ-50-011: Desktop Surface Extension

**Requirement:** Support Shannon-style desktop tray, notification, and offline-history ergonomics only as thin shells over current authority lanes.

**Acceptance:**
- Desktop shells are deletable without changing core behavior
- Desktop actions delegate to governed authority surfaces
- Notification/history actions emit deterministic receipts

---

### REQ-50-012: P2P Swarm Reliability

**Requirement:** Reuse current swarm primitives for Shannon-style deduplication, version gates, and P2P reliability checks.

**Acceptance:**
- P2P reliability events emit deterministic receipts
- Deduplication and version gates stay within swarm/security authority
- No separate P2P control plane is introduced

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-001.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/shannon/` and `apps/shannon-desktop/` suggestions into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring` naming for operator surfaces.
