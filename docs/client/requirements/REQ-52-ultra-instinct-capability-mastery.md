# REQ-52: Ultra Instinct Capability Mastery

Version: 1.0
Date: 2026-03-17
Owner: InfRing Organism / Capability Registry / Persona

## Objective

Create an always-on instinct layer that gives InfRing an immediate, governed understanding of its own capability surface from cold start: the system should know what tools, modes, adapters, memory lanes, and hardware-sensitive profiles are available, select strong defaults proactively, and refine that self-model over time without introducing a second authority path outside existing capability, scheduler, memory, and blob-history primitives.

## Source References

- [Source doc](https://docs.google.com/document/d/1wUXF1VxkWC55LWEnc4LjYaHkmlVBaY5R5NlpSkpgnfk/edit?usp=sharing)

## Scope

In scope:
- A persistent capability-self-model spanning skills, tools, adapters, memory lanes, modes, and hardware-sensitive runtime profiles
- Proactive capability activation on boot and context changes
- Continuous refinement of capability understanding from real usage, RSI feedback, and blob-history evidence
- Deterministic receipts for instinct decisions and capability-profile changes

Out of scope:
- A parallel cognition or scheduler authority path outside existing organism/runtime primitives
- Ungoverned self-activation that bypasses policy, privacy, budget, or substrate controls
- Hand-written app-owned “instinct” logic replacing existing core capability discovery and routing surfaces

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin operator/runtime surfaces remain in `client/runtime/systems/**`
- Any substrate or platform bridges remain in `adapters/`
- Optional `apps/` shells may expose controls or visualizations, but must remain deletable and non-authoritative

## Related Requirements

- REQ-38: Agent orchestration hardening
- REQ-40: Evolutionary compaction governance
- REQ-51: Phone-specific optimizations
- Existing SRS families:
  - `V10-ULTIMATE-001.*`
  - `V9-ORGANISM-025.*`
  - `V6-COCKPIT-020.3`
  - `V8-SWARM-012.8`
  - `V6-APP-023.7` through `V6-APP-023.11`

## Requirements

### REQ-52-001: Persistent Ultra Instinct Core

**Requirement:** InfRing must maintain a persistent, always-available self-model of its capability surface and expose it through governed organism/capability primitives.

**Acceptance:**
- Capability registry covers tools, skills, adapters, memory lanes, runtime modes, and hardware-sensitive profiles
- Cold-start self-model activation emits deterministic receipts
- No second planner, scheduler, or persona authority path is introduced

---

### REQ-52-002: Automatic Capability Activation

**Requirement:** On boot and major context changes, InfRing must proactively activate the strongest valid combination of features and profiles within current policy, hardware, and budget constraints.

**Acceptance:**
- Runtime chooses among profiles such as pure, tiny-max, swarm, provenance, memory, or degraded modes through existing authority lanes
- Activation decisions remain policy-bounded and receipted
- Unsupported activations fail closed with explicit degraded-mode reasons

---

### REQ-52-003: Instinct Evolution and Refinement

**Requirement:** The instinct layer must improve over time using real usage, blob-history evidence, and RSI feedback without bypassing governance.

**Acceptance:**
- Refinement flow consumes blob-history and runtime evidence through governed lanes
- Updated capability understanding preserves lineage and rollbackability
- Evolution emits deterministic receipts and does not mutate live policy without existing governance gates

## Verification Requirements

- SRS rows for the linked `V10-ULTIMATE-002.*` family must parse cleanly
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - deterministic receipt/state evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `protheus instinct ...` language to `infring instinct ...` for operator-facing surfaces.
- Build this on top of existing capability discovery, organism scheduling, blob history, and compaction governance instead of inventing a parallel “instinct engine” subsystem.
