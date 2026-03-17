# REQ-51: Phone-Specific Optimizations for InfRing

Version: 1.0
Date: 2026-03-17
Owner: InfRing Runtime / Substrate / Organism Scheduler

## Objective

Optimize InfRing for modern and older phones running as a background daemon or lightweight app, without introducing new core primitives: battery-aware scheduling, phone sensor integration, low-latency voice and text interaction, ultra-low-drain background execution, and phone-specific tiny-max tuning should all extend existing substrate, scheduler, sensory, and runtime primitives.

## Source References

- [Source doc](https://docs.google.com/document/d/1FZ7cB3gvTrit1TEClP5dBK0mqUoz4d4lgn2QFpLFMB0/edit?usp=sharing)
- Internal phone compatibility discussion, March 2026

## Scope

In scope:
- Battery-aware scheduling and automatic mode adaptation
- Phone sensor ingestion through existing Eyes and sensory primitives
- Low-latency voice/text interaction surfaces for phone use
- Background daemon behavior with low idle drain and wake semantics
- Phone-specific tiny-max detection and tuning

Out of scope:
- A separate phone-only runtime authority path
- Moving scheduling, sensor, or daemon authority into app-owned shells
- Treating phone UX shells as justification for bypassing current safety, receipt, or substrate governance

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Mobile/platform bridges live in `adapters/`
- Optional mobile-app shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-38: Agent orchestration hardening
- REQ-50: Shannon production framework assimilation
- Existing SRS families:
  - `V7-PURE-WORKSPACE-*`
  - `V9-PURE-INTEL-*`
  - `V6-SUBSTRATE-007.*`
  - `V6-EYES-*`
  - `V6-SENSORY-*`

## Requirements

### REQ-51-001: Battery-Aware Scheduling Engine

**Requirement:** Extend the existing organism scheduler to adapt throughput, shadows, and mode selection based on phone battery state.

**Acceptance:**
- Low-battery mode changes emit deterministic receipts
- Non-critical work can be reduced or paused under policy thresholds
- No second scheduler authority is introduced

---

### REQ-51-002: Phone Sensor Integration

**Requirement:** Extend existing sensory and Eyes primitives to support governed phone sensor ingestion such as GPS, camera, and microphone.

**Acceptance:**
- Sensor ingest remains receipted and policy-gated
- Existing privacy and safety boundaries remain authoritative
- Unsupported sensors degrade explicitly rather than bypassing governance

---

### REQ-51-003: Low-Latency Voice and Text Interaction Mode

**Requirement:** Support phone-optimized voice and text interaction over existing inference, sensory, and notification primitives.

**Acceptance:**
- Voice/text interactions emit deterministic receipts
- Low-latency paths remain bounded by current runtime and policy controls
- No phone-specific interaction authority is introduced outside existing surfaces

---

### REQ-51-004: Background Daemon Mode with Minimal Drain

**Requirement:** Reuse existing daemon and runtime primitives to support phone background operation with explicit wake and pause behavior.

**Acceptance:**
- Wake, pause, and background transitions emit deterministic receipts
- Idle-drain optimization remains within current runtime authority
- Platform-specific behavior remains bridge-owned rather than app-owned

---

### REQ-51-005: Phone-Specific Tiny-max Optimizations

**Requirement:** Auto-detect phone hardware and apply existing tiny-max/pure profile degradations and capability shedding appropriately.

**Acceptance:**
- `--phone` or equivalent phone profile selection remains receipted
- Hardware-sensitive capability shedding is deterministic and policy-bounded
- Old phones degrade explicitly instead of silently bypassing constraints

## Verification Requirements

- SRS regression must parse and accept the `V10-PHONE-001.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `client/apps/phone-optim/` idea into thin runtime/operator surfaces under `client/runtime/systems/**`; any optional app shell must remain deletable and non-authoritative.
- Prefer `infring` naming for operator surfaces.
