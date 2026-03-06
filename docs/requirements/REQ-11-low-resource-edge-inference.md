# REQ-11: Low-Resource Edge Inference Engine Assimilation

Version: 1.0  
Date: 2026-03-06

## Objective

Add an optional ultra-low-resource inference backend for extreme legacy targets while preserving Rust kernel governance authority (constitution, policy, receipts, capabilities).

## Scope

In scope:
- Optional edge inference provider integration via conduit.
- Resource-layer backend selection for constrained hardware profiles.
- Deterministic receipts and policy validation preserved for all edge invocations.
- Documentation for activation and capability limits on legacy profiles.

Out of scope:
- Replacing primary model/runtime paths on modern hardware.
- Bypassing conduit or Rust governance checks.
- TS direct invocation of edge backend.

## Requirements

1. `REQ-11-001` Conduit edge provider adapter
- Acceptance:
  - Add edge provider surface under conduit provider namespace.
  - Typed message contracts include `edge_inference` and `edge_status`.
  - Every edge request produces deterministic receipt metadata.

2. `REQ-11-002` Rust-authoritative governance path
- Acceptance:
  - Constitution + policy validation occurs in Rust before edge backend invocation.
  - Edge backend receives only explicit capability-scoped payloads.
  - No TS lane calls edge backend directly (conduit-only path).

3. `REQ-11-003` Resource-tier backend auto-selection
- Acceptance:
  - Resource primitive detects constrained hardware profiles.
  - Backend routing supports automatic edge fallback for Tier-D/legacy profiles.
  - Explicit override mode exists for deterministic testing.

4. `REQ-11-004` Optional feature-gated integration
- Acceptance:
  - Edge backend is compile-time optional (feature-gated, default-off for primary builds or explicit profile-driven inclusion).
  - Build matrix documents edge-enabled/edge-disabled profiles.
  - Binary/runtime behavior is deterministic when feature is disabled.

5. `REQ-11-005` Lifecycle validation
- Acceptance:
  - Integration tests cover edge provider lifecycle (`status`, invoke, failure/timeout, fallback).
  - Substrate-swap check confirms core still runs without TS layer and with edge backend enabled.
  - Formal invariants remain green after integration.

6. `REQ-11-006` Portability documentation
- Acceptance:
  - Portability tier docs include an “extreme legacy / edge inference mode” section.
  - Activation conditions, limits, and operational expectations are explicitly documented.

## Execution Notes

- Treat this backend as specialized fallback for constrained environments, not primary inference path.
- Keep all trust-critical behavior in Rust TCB and maintain conduit as sole bridge.
