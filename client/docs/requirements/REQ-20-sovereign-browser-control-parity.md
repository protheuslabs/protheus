# REQ-20: Sovereign Browser Control Operational Parity (Pinchtab-Class, Rust-Authoritative)

Version: 1.0  
Date: 2026-03-06

## Objective

Deliver a Rust-authoritative browser-control plane that matches pinchtab-class operational features (zero-config startup, token-efficient text/diff snapshots, persistent sessions, multi-instance orchestration) while preserving Protheus covenant, receipt, and sovereignty guarantees.

## Scope

In scope:
- Zero-config daemon bootstrap for browser control.
- Token-efficient `/text` and `/diff` snapshot APIs with deterministic references.
- Multi-instance browser orchestration plus real-time operator dashboard.
- Stealth + headed handoff (human-assisted checkpoints such as 2FA).
- Encrypted session persistence with blob continuity/morph support.
- Multi-browser profile path (Chrome first, policy-gated Firefox/Edge fallback).
- Shadow/persona orchestration integration with drift telemetry and breaker hooks.

Out of scope:
- Bypassing policy/constitution/covenant gates for browser actions.
- Allowing TypeScript to become source-of-truth for browser governance logic.

## Requirements

1. `REQ-20-001` Zero-config browser daemon bootstrap
- Acceptance:
  - Browser daemon starts with minimal/no manual configuration in hosted profile.
  - Health/status endpoint reports daemon + browser readiness with receipts.
  - Startup path remains deterministic and fail-closed on missing dependencies.

2. `REQ-20-002` Token-efficient text snapshot and diff endpoints
- Acceptance:
  - Add AI-optimized text snapshot endpoint designed for low token footprint.
  - Add diff endpoint returning changes since last snapshot for the same session/page.
  - Snapshot/diff responses include deterministic selectors/refs for follow-on actions.

3. `REQ-20-003` Multi-instance orchestration and dashboard
- Acceptance:
  - Runtime can manage multiple concurrent browser instances under policy caps.
  - Operator dashboard reports instance state, active sessions, and queue pressure.
  - Every instance lifecycle transition is receipt logged.

4. `REQ-20-004` Stealth mode and human handoff controls
- Acceptance:
  - Add policy-gated stealth profile for anti-bot-sensitive workflows.
  - Support headed handoff flow where human can intervene (e.g., MFA/2FA) then return control.
  - Mode transitions are auditable with explicit allow/deny reason receipts.

5. `REQ-20-005` Encrypted blob-backed session continuity
- Acceptance:
  - Browser sessions are persisted as encrypted continuity artifacts with integrity checks.
  - Session restore/morph paths fail closed on tamper or policy violations.
  - Resume behavior is deterministic across daemon restart/reboot.

6. `REQ-20-006` Multi-browser fallback profile
- Acceptance:
  - Chrome remains baseline provider; add profile contract for Firefox/Edge fallback.
  - Fallback selection is policy-driven and hardware/profile aware.
  - Unsupported provider requests return typed, receipt-backed failures.

7. `REQ-20-007` Shadow/persona bridge with drift/breaker instrumentation
- Acceptance:
  - `protheus browser` orchestration can route through persona/shadow governance.
  - Browser interaction drift metrics are emitted and breaker thresholds are enforceable.
  - High-risk browser actions can escalate to review with explicit governance receipts.

## Verification Requirements

- End-to-end tests for zero-config startup, snapshot/diff, and multi-instance lifecycle.
- Deny-path tests for stealth/handoff policy violations and blocked domains/actions.
- Session tamper tests validating encrypted continuity fail-closed behavior.
- Drift/breaker tests confirming escalation and auto-block at configured thresholds.
- Invariants remain green after integration.

## Execution Notes

- This requirement extends `REQ-16` by adding operational parity features and stronger runtime observability/orchestration contracts.
- Rust remains the source of truth for governance, policy, and receipt generation; TS stays thin-client only.
