# REQ-11: Low-Resource Edge Inference Engine Assimilation

Version: 1.1  
Date: 2026-03-06
Repo Reference: https://github.com/RightNow-AI/picolm

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
  - Preserve core 10-command contract by using typed edge messages over `start_agent` transport (`edge_status`, `edge_inference:*`, or `edge_json:{...}`).

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

## Phase-1 Implementation (2026-03-06)

- Implemented in `core/layer2/conduit`:
  - Typed edge messages: `EdgeBridgeMessage::{edge_inference, edge_status}`.
  - Kernel lane handler integration: parses typed edge transport over `start_agent`.
  - Deterministic receipt hash attached to every edge status/inference response.
  - Compile-time feature gate: `conduit` crate feature `edge` (default off).
  - Fail-closed behavior when `edge` feature is disabled.
- Added tests:
  - `kernel_lane_handler_returns_edge_status_payload`
  - `kernel_lane_handler_accepts_edge_json_inference_contract`

## Next Batch (Phase-2)

- Resource primitive hardware-profile selector for edge fallback routing (`REQ-11-003`).
- Edge-on/edge-off build matrix proof (`REQ-11-004`).

## Phase-2 Implementation (2026-03-06)

- Implemented in `core/layer1/resource`:
  - Added constrained-hardware selector (`is_constrained_hardware`) with deterministic thresholds.
  - Added backend routing receipt (`select_inference_backend`) with explicit override modes for deterministic testing.
  - Added coverage for constrained/unconstrained/no-MMU and override paths.
- Added feature-matrix CI:
  - `.github/workflows/conduit-edge-matrix.yml` now runs conduit tests in both edge-off and edge-on profiles.
  - Local matrix script added: `npm run -s ops:conduit:edge-matrix`.
