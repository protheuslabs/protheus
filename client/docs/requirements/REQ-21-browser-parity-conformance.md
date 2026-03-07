# REQ-21: Browser Parity Conformance and Efficiency Gates (Pinch Benchmark Track)

Version: 1.0  
Date: 2026-03-06

## Objective

Add explicit parity and conformance gates so Protheus browser control can be measured against Pinch-class expectations with deterministic receipts (API compatibility, token efficiency, zero-config startup, and portable binary footprint).

## Scope

In scope:
- HTTP API parity/conformance harness for browser control primitives.
- Token-efficiency targets for text/diff snapshots.
- Zero-config startup and binary footprint verification gates.
- Cross-language usability contracts (curl/HTTP-first docs + fixtures).
- Comparative benchmark artifacts with reproducible methodology.

Out of scope:
- Copying third-party implementation internals.
- Relaxing sovereignty gates for parity demos.

## Requirements

1. `REQ-21-001` Browser API conformance harness
- Acceptance:
  - Create deterministic conformance suite for core browser endpoints (`navigate`, `click`, `type`, `scroll`, `snapshot/text`, `diff`, `session`).
  - Each run emits pass/fail receipts with fixture IDs and error classes.
  - Harness supports local replay for regression and CI gating.

2. `REQ-21-002` Snapshot token-efficiency SLO gates
- Acceptance:
  - Define and enforce token-budget SLOs for text snapshots and diff responses.
  - Add deterministic size/token metrics in benchmark artifacts and receipts.
  - Gate fails closed when snapshot or diff responses exceed configured budget envelope.

3. `REQ-21-003` Zero-config startup and footprint verification
- Acceptance:
  - Add benchmark lane that measures daemon cold start, first control action latency, and resident memory.
  - Add binary footprint gate with profile targets (release artifact size budget).
  - Publish regression deltas in versioned benchmark artifacts.

4. `REQ-21-004` Cross-language integration contract
- Acceptance:
  - Provide curl-first integration fixtures and language-agnostic API examples.
  - Validate API behavior from non-TS clients in integration tests.
  - Ensure all examples preserve receipt and policy metadata fields.

5. `REQ-21-005` Comparative benchmark publication lane
- Acceptance:
  - Generate reproducible benchmark matrix including methodology and hardware profile.
  - Include explicit “measured, not marketed” receipts/artifacts per run.
  - Surface parity status in ops dashboard and release notes workflow.

## Verification Requirements

- CI conformance suite for browser API endpoints.
- Performance tests validating snapshot/diff SLO thresholds.
- Release-profile size check and startup benchmark checks.
- Invariants remain green after enabling parity gates.

## Execution Notes

- This extends `REQ-20` with measurable parity gates rather than feature-only scope.
- Rust remains source-of-truth for policy, receipts, and benchmark evidence contracts.
