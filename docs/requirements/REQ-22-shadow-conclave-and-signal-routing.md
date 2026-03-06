# REQ-22: Shadow Conclave and Eyes-to-Shadow Autonomous Routing

Version: 1.0  
Date: 2026-03-06

## Objective

Implement a governed multi-persona conclave mechanism and automated eyes-to-shadow routing pipeline so external signals can be classified, dispatched, debated, and converted into reviewable proposals without manual mediation.

## Scope

In scope:
- Scheduled and ad-hoc shadow conclave runs with structured outputs.
- Asynchronous conclave transcript/workspace path for multi-step synthesis.
- Signal-type classifier from sensory queue events into shadow routing classes.
- Shadow dispatch/notification lane with reliability controls (ack/retry/escalation).
- Autonomous shadow proposal generation with Core-5 review handoff.
- Drift/covenant fail-closed gates on auto-routed execution intents.

Out of scope:
- Bypassing human approval where policy requires escalation.
- Unbounded autonomous execution without receipt and policy checks.

## Requirements

1. `REQ-22-001` Structured shadow conclave runtime
- Acceptance:
  - Add conclave command path (scheduled or ad-hoc topic) with explicit participant set.
  - Output includes per-persona position, point/counterpoint, and synthesized recommendation.
  - Every conclave run emits deterministic receipts with participant and policy metadata.

2. `REQ-22-002` Asynchronous conclave workspace contract
- Acceptance:
  - Add persistent conclave topic workspace for incremental persona append flows.
  - Transcript format is deterministic and replayable for audit/review.
  - Final synthesis can be regenerated from transcript state without data loss.

3. `REQ-22-003` Eyes signal classifier and routing map
- Acceptance:
  - Classify incoming sensory signals into governed categories (security, ops, measurement, performance, product, etc.).
  - Map categories to default shadow/persona targets with policy-overridable routing rules.
  - Classification/routing decisions are receipt logged with confidence and reason fields.

4. `REQ-22-004` Shadow dispatch/notification bus
- Acceptance:
  - Dispatch layer notifies target shadows and tracks ack/timeout/retry state.
  - Failed dispatches escalate deterministically to operator queue.
  - Queue semantics are idempotent to avoid duplicate shadow execution.

5. `REQ-22-005` Autonomous shadow consumption and proposal bridge
- Acceptance:
  - Shadows can consume routed signals and produce structured proposals automatically.
  - Proposals are funneled into Core-5 review path before execution when required.
  - Proposal artifacts preserve traceability to originating eye signals and conclave evidence.

6. `REQ-22-006` Runtime health gating for routing/conclave reliability
- Acceptance:
  - Auto-routing and conclave workflows are health-gated by runtime readiness checks.
  - Degraded runtime paths fail closed or route to manual review mode.
  - Health-gate transitions are surfaced in operator status with deterministic receipts.

## Verification Requirements

- Integration tests for scheduled/ad-hoc conclave output schema and replay.
- End-to-end tests for eyes input -> classifier -> dispatch -> proposal -> review linkage.
- Retry/escalation tests for dispatch failure/timeout behavior.
- Degraded-runtime deny-path tests validating fail-closed/manual fallback behavior.
- Invariants remain green after integration.

## Execution Notes

- Existing parser/helper migrations around conclave text handling are complementary, but this requirement defines full workflow orchestration and automation contracts.
- Rust remains source of truth for policy gates, receipt generation, and routing verdicts.
