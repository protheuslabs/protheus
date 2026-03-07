# REQ-16: Native Browser Control (Rust Daemon + Direct CDP)

Version: 1.0  
Date: 2026-03-06

## Objective

Add a native browser-control path as a Rust daemon speaking direct CDP to reduce runtime overhead and improve persistent browser automation reliability.

## Scope

In scope:
- Native Rust browser daemon mode.
- Direct Chrome DevTools Protocol control path (without Node abstraction in native mode).
- Persistent encrypted profiles/sessions.
- AI-friendly snapshots with stable refs.
- Security policies (domain allowlist/action confirmation) under covenant fail-closed gates.

Out of scope:
- Replacing all existing browser paths immediately.
- Bypassing governance or receipt contracts.

## Requirements

1. `REQ-16-001` Single native Rust daemon binary
- Acceptance:
  - Native browser controller runs as one Rust daemon process in native mode.
  - Daemon can persist across multiple CLI invocations.
  - Startup/health state is exposed via deterministic status command and receipts.

2. `REQ-16-002` Direct CDP integration
- Acceptance:
  - Native mode uses direct CDP connection path for browser control operations.
  - Core operations (navigate/click/type/evaluate/snapshot) are supported in native mode.
  - Error paths produce typed, receipt-backed failures.

3. `REQ-16-003` Encrypted profile/session persistence
- Acceptance:
  - Named profiles/sessions can save and restore browser state.
  - Sensitive persisted session state is encrypted under approved key policy.
  - Restore failures fail closed with explicit operator diagnostics.

4. `REQ-16-004` AI snapshot references
- Acceptance:
  - Snapshot command returns deterministic element references for downstream agent actions.
  - Annotated screenshot output supports stable mapping from refs to visual targets.
  - Snapshot metadata is receipt-linked for replay/debug.

5. `REQ-16-005` Browser security policy controls
- Acceptance:
  - Domain allowlist and action confirmation policies are enforceable in native mode.
  - Unauthorized domain/action attempts are blocked fail-closed.
  - Every blocked/allowed decision is policy/receipt logged.

6. `REQ-16-006` CLI + shadow integration
- Acceptance:
  - Add native browser CLI path (`protheus browser --native ...`) with daemon controls.
  - Shadow/persona orchestration can invoke native browser tasks through governed interfaces.
  - Integration tests cover native navigation + snapshot + session restore flow.

## Verification Requirements

- Native daemon lifecycle tests (start/status/stop/reconnect).
- Direct CDP operation tests in native mode.
- Security deny-path tests for disallowed domains/actions.
- Invariants remain green with native path enabled.

## Execution Notes

- Implement as additive path first; retain fallback path until native mode maturity gate passes.
