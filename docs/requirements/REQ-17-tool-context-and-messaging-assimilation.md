# REQ-17: Tool Context + Messaging Assimilation (Targeted Composio Patterns)

Version: 1.0  
Date: 2026-03-06

## Objective

Assimilate high-ROI operational patterns for secure tool-context execution and always-on low-power messaging without compromising sovereignty or governance controls.

## Scope

In scope:
- Dynamic tool context routing and sandboxed tool execution.
- Low-power notification hooks for heartbeat/breaker events.
- Shadow/persona integration for governed tool + notification actions.
- Optional advanced orchestration track (reaction engine + isolated worktree execution).

Out of scope:
- GitHub-specific tracker lock-in.
- Unbounded external tool authority.

## Requirements

1. `REQ-17-001` Tool context management plane
- Acceptance:
  - Add a tool-context layer for dynamic tool selection and context passing.
  - Tool runs are capability-scoped and policy-gated.
  - Tool execution emits deterministic receipts including selected tool and context hash.

2. `REQ-17-002` Sandboxed external tool execution
- Acceptance:
  - Tool invocations can run in bounded sandbox profile when required by policy.
  - Sandbox deny-path is fail-closed with explicit reason receipts.
  - No ambient external access outside policy-scoped permissions.

3. `REQ-17-003` Low-power messaging integration
- Acceptance:
  - Add notification surface suitable for heartbeat/breaker-triggered updates.
  - Messaging actions are policy-gated and auditable.
  - Delivery failures route through deterministic retry/escalation policy.

4. `REQ-17-004` Shadow/persona bridge for tools + notifications
- Acceptance:
  - Persona/shadow orchestration can trigger tool context and notifications via governed APIs.
  - High-risk actions escalate to review lanes per policy.
  - End-to-end tests validate tool-call + notification workflow.

5. `REQ-17-005` Optional reactions/worktree operations track
- Acceptance:
  - Define optional reaction-engine contract for event-driven auto-handling (CI/review/error events).
  - Define optional isolated worktree execution policy for parallel coding lanes.
  - Track remains gated behind explicit enable policy until approved.

## Verification Requirements

- Unit tests for tool selection/context normalization.
- Integration tests for sandboxed tool call and notification dispatch.
- Governance tests for fail-closed deny paths and escalation.
- Invariants remain green after integration.

## Execution Notes

- Prioritize `REQ-17-001..004` as core track.
- Keep `REQ-17-005` optional and policy-gated to avoid scope creep.
