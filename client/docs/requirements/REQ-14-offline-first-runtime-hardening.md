# REQ-14: Offline-First Runtime Hardening and Output Contracts

Version: 1.0  
Date: 2026-03-06

## Objective

Close remaining runtime-hardening gaps for offline-first operation, strict structured outputs, and per-shadow fairness controls while keeping Rust governance as source of truth.

## Scope

In scope:
- Strict schema enforcement for persona/lens outputs.
- Per-shadow token/compute budget controls.
- Explicit offline-mode behavior and degraded-path handling for research/assimilation lanes.
- Hardware-aware local-model routing policy hardening and operator visibility.

Out of scope:
- Replacing existing model catalog/router foundations.
- Bypassing governance, constitution, or receipt constraints.

## Requirements

1. `REQ-14-001` Strict structured output contracts
- Acceptance:
  - Persona/lens command outputs are validated against explicit schemas in strict mode.
  - Invalid outputs fail closed with deterministic error receipts.
  - CLI exposes schema mode and validation result metadata.
- Implementation (2026-03-06):
  - Rust lane: `core/layer0/ops/src/persona_schema_contract.rs`
  - CLI surface: `protheus-ops persona-schema-contract <validate|status>`
  - Deterministic fail-closed receipts + state artifact at `state/ops/persona_schema_contract/latest.json`
  - Coverage: unit tests in `core/layer0/ops/src/persona_schema_contract.rs`

2. `REQ-14-002` Per-shadow budget governance
- Acceptance:
  - Define per-shadow token/compute budget policy limits and burst controls.
  - Runtime enforces shadow-level quotas without starving system-critical lanes.
  - Budget decisions are receipt-logged with policy references.
- Implementation (2026-03-06):
  - Policy contract: `client/config/shadow_budget_governance_policy.json`
  - Runtime lane: `core/layer0/ops/src/shadow_budget_governance.rs`
  - CLI surface: `protheus-ops shadow-budget-governance <evaluate|status>`
  - Deterministic decision receipts include fairness/reserve metadata and policy path references.

3. `REQ-14-003` Offline mode detection + degraded execution
- Acceptance:
  - Runtime detects offline state and switches to local-only/cached paths deterministically.
  - Research/assimilation flows degrade gracefully instead of hard-failing.
  - CLI clearly indicates offline mode and capability limits.
- Implementation (2026-03-06):
  - Policy contract: `client/config/offline_runtime_guard_policy.json`
  - Runtime lane: `core/layer0/ops/src/offline_runtime_guard.rs`
  - CLI surface: `protheus-ops offline-runtime-guard <evaluate|status>`
  - Deterministic offline reasons + degraded capability map emitted in receipts and persisted to state.

4. `REQ-14-004` Hardware-aware local model routing hardening
- Acceptance:
  - Hardware profile detection is integrated into model selection path at runtime.
  - Micro-task vs deep-task routing adapts to profile constraints under policy.
  - Routing decisions include profile and fallback reasoning in receipts.
- Implementation (2026-03-06):
  - Policy contract: `client/config/hardware_route_hardening_policy.json`
  - Runtime lane: `core/layer0/ops/src/hardware_route_hardening.rs`
  - CLI surface: `protheus-ops hardware-route-hardening <evaluate|status>`
  - Receipts include resolved profile, requested task class, selected model, and deterministic fallback reasons.

## Verification Requirements

- Offline integration tests: network-down scenarios for research/assimilation/lens commands.
- Structured output reject-path tests for malformed responses.
- Budget fairness tests validating one shadow cannot starve others.
- Invariants remain green with these controls enabled.

## Execution Notes

- Many base components already exist; this requirement focuses on deterministic hardening and consistent operator-visible behavior.
