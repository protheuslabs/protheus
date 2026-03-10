# REQ-35 — LLMN Mode Integrity and Compatibility Contract

Status: proposed  
Owner: Runtime + Cognition  
Updated: 2026-03-09

## Objective

Restore and lock the five operator-facing LLMN modes so they remain callable, deterministic, and backward-compatible across routing, strategy, and CLI surfaces:

- `standard`
- `creative`
- `deep thinking`
- `narrative`
- `hyper creative`

## Scope

- Canonical mode registry + alias normalization.
- Router/strategy mode mapping parity.
- CLI wrapper/path compatibility for mode entrypoints.
- Regression tests and CI gate for mode resolution.

## Non-Goals

- No change to risk-policy semantics beyond mode alias/normalization.
- No model-provider policy rewrite.
- No new mode families beyond the five required operator modes.

## Functional Requirements

### REQ-35-001 Canonical mode registry
- Add a canonical mode registry contract in runtime config that defines the five primary operator modes and normalized internal keys.
- Required aliases:
  - `standard` -> `normal`
  - `deep thinking` / `deep-thinking` / `deep_thinking` -> `deep-thinker`
  - `hyper creative` / `hyper-creative` / `hyper_creative` -> `hyper-creative`

### REQ-35-002 Router mode normalization and parity
- `model_router` must resolve all aliases deterministically and emit the normalized mode in route receipts.
- Existing behavior for `creative`, `narrative`, `hyper-creative`, and `deep-thinker` must remain unchanged after alias normalization.

### REQ-35-003 Strategy mode compatibility
- Strategy generation mode stores must accept the same alias set and persist normalized values.
- Existing strategy artifacts using prior mode tokens must remain loadable without migration loss.

### REQ-35-004 Runtime entrypoint integrity
- Runtime mode entrypoints (`model_router`, `route_task`, `strategy_mode`, `strategy_mode_governor`) must be executable via current client/runtime paths and must not rely on removed `client/systems/*` paths.
- JS wrappers must resolve to TS/dist sources through `ts_bootstrap` without missing-source failures in normal source mode.

### REQ-35-005 Legacy path drift guard
- Add a static guard that fails when mode-critical tests or scripts reference deprecated path roots (`client/systems/*` for mode/router entrypoints).

### REQ-35-006 Mode conformance test pack
- Add/maintain a mode conformance suite that validates:
  - all five user-facing modes resolve,
  - aliases normalize to canonical keys,
  - route receipts include stable mode fields,
  - no mode call fails with module-not-found/path errors.

## Safety Requirements

1. Fail closed on unknown mode keys unless explicit fallback policy allows `standard` -> `normal` only.
2. Preserve conduit-only boundary for any mode-driven runtime action.
3. Do not allow alias resolution to bypass high-risk policy gates.

## Acceptance Criteria

1. `model_router` route invocations succeed for: `standard`, `creative`, `deep thinking`, `narrative`, `hyper creative`.
2. Mode receipts always contain normalized canonical mode values.
3. Mode-related runtime commands/tests run without missing-module errors from stale paths.
4. CI guard fails if deprecated mode entrypoint paths reappear.
