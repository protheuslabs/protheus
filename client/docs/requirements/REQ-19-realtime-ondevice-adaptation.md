# REQ-19: Real-Time On-Device Adaptation and Persistence Continuity

Version: 1.0  
Date: 2026-03-06

## Objective

Implement interaction-triggered, on-device adaptation loops that continuously improve local behavior while preserving “never forgets” persistence guarantees and sovereignty controls.

## Scope

In scope:
- Real-time adaptation triggered by heartbeats/interactions.
- On-device-only adaptation path with low-power throttling profile.
- Persistence of adaptation deltas across reboot/session boundaries.
- Drift/covenant gates around adaptation updates.
- Apple-silicon profile as first-class optimization target (with portable fallback).

Out of scope:
- Unbounded model mutation without policy checks.
- Cloud-dependent tuning as primary path for this requirement.

## Requirements

1. `REQ-19-001` Interaction-triggered adaptation loop
- Acceptance:
  - Adaptation can be triggered by runtime interactions and heartbeat cadence.
  - Trigger policy enforces bounded cadence and resource ceilings.
  - Every adaptation cycle emits deterministic receipts.
  - Layer placement default: authoritative primitive in `core/layer2`; `client` is conduit-facing surface/tests only.

2. `REQ-19-002` On-device low-power adaptation profile
- Acceptance:
  - Adaptation path runs locally without mandatory cloud dependency.
  - Low-power throttling profile supports always-on background safety limits.
  - Hardware profile metadata is included in adaptation decisions/receipts.
  - Layer placement default: low-power policy authority in `core/layer2`; `client` is conduit-facing surface/tests only.

3. `REQ-19-003` Persistent adaptation state continuity
- Acceptance:
  - Adaptation deltas are persisted and recoverable across restarts.
  - Recovery path validates integrity before applying persisted deltas.
  - “Never forgets” claim is represented as explicit continuity contract checks.
  - Layer placement default: continuity/integrity authority in `core/layer2`; `client` is conduit-facing surface/tests only.

4. `REQ-19-004` Covenant + drift fail-closed gates
- Acceptance:
  - Adaptation updates are blocked when covenant/drift gates are violated.
  - Drift threshold and violation reason are logged in receipts.
  - Blocked updates are reversible and operator-inspectable.

5. `REQ-19-005` Persona/shadow review path for adaptation changes
- Acceptance:
  - High-impact adaptation changes route through persona/shadow review policy.
  - Approval/reject decisions are retained as evidence-linked receipts.
  - CLI/status surface exposes current adaptation state and review queue.

6. `REQ-19-006` Apple-silicon acceleration profile + portable fallback
- Acceptance:
  - Add optimized adaptation profile for Apple silicon class devices.
  - Provide deterministic fallback profile for non-Apple ARM/x86 targets.
  - Profile selection is policy-driven and test-covered.

## Verification Requirements

- Integration test for interaction-triggered adaptation + reboot recovery.
- Drift-gate deny-path test for adaptation update rejection.
- Low-power profile test validating bounded resource behavior.
- Invariants remain green after integration.

## Execution Notes

- Existing fine-tuning lanes provide baseline trainer substrate; this requirement adds real-time continuity + governance hardening around runtime adaptation.
- Regression guard: if implementation appears in `client` for bootstrap velocity, treat it as temporary compatibility-only and open a core-port backlog item immediately.
