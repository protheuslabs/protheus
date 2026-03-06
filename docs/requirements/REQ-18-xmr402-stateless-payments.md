# REQ-18: XMR402 Stateless Payment Protocol Integration

Version: 1.0  
Date: 2026-03-06

## Objective

Add privacy-preserving, stateless HTTP 402 payment gating for agent-accessed resources using XMR402-style challenge/proof flow, while preserving Protheus covenant and receipt governance.

## Scope

In scope:
- HTTP 402 challenge/authorization flow with nonce binding.
- Server-side transaction proof verification integration path.
- Agent/runtime support for autonomous payment initiation under policy approval.
- Stateless middleware and replay-protection controls.

Out of scope:
- Replacing existing fiat/other blockchain payment rails.
- Unapproved spend authority bypassing existing governance controls.

## Requirements

1. `REQ-18-001` Stateless HTTP 402 challenge middleware
- Acceptance:
  - Protected routes can emit `402 Payment Required` with typed challenge metadata.
  - Challenge includes deterministic nonce/message binding and amount/address parameters.
  - Middleware is configurable per endpoint/policy profile.

2. `REQ-18-002` XMR402 authorization proof path
- Acceptance:
  - Client authorization header path supports tx/proof payload submission.
  - Server verifies proof against nonce-bound challenge and payment criteria.
  - Verification outcomes are receipt logged with fail-closed deny behavior.

3. `REQ-18-003` Replay protection and spend-safety controls
- Acceptance:
  - Nonce/challenge replay attempts are blocked deterministically.
  - Zero-conf policy handling and double-spend mitigation rules are explicit.
  - Security decisions are auditable by policy + receipt trail.

4. `REQ-18-004` Agent payment initiation governance
- Acceptance:
  - Agents/shadows can initiate payment requests only through governed approval path.
  - Spend policies include limits, allowed destinations, and risk escalation thresholds.
  - Payment initiation and approval chain are persisted as evidence receipts.

5. `REQ-18-005` Config + integration surfaces
- Acceptance:
  - Config includes RPC endpoint, wallet/address strategy, nonce secret/key policy.
  - Dynamic subaddress/session strategy is supported where policy enables.
  - CLI/API surfaces expose deterministic payment status and diagnostics.

6. `REQ-18-006` Deep-link and operator UX support
- Acceptance:
  - Payment challenge can emit wallet deep-link metadata for supported clients.
  - Runtime handles local/operator payment confirmation path with clear state transitions.
  - UX path remains optional and policy-gated.

## Verification Requirements

- Unit tests for challenge generation, nonce binding, and replay rejection.
- Integration tests for successful proof verify + denied proof + timeout/retry.
- Governance tests to ensure unauthorized payments fail closed.
- Invariants remain green after integration.

## Execution Notes

- Implement as additive protocol lane under payments subsystem.
- Keep all spend decisions inside existing covenant/governance controls.
