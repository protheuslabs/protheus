# REQ-40: Evolutionary Compaction Governance

Version: 1.0
Date: 2026-03-16
Owner: InfRing Snowball / Runtime Optimization

## Objective

Turn compaction into a governed evolutionary loop: assimilate broadly, measure ruthlessly, keep only what improves real system value, archive discarded ideas for later resurrection, and only promote changes that make InfRing smaller, faster, more reliable, or more intelligent in measurable terms.

## Source References

- [Source doc](https://docs.google.com/document/d/1n1sI-l5diNhOzW1fRhjFKRy6p5nmLf4WLAl2cz6B808/edit?usp=sharing)

## Scope

In scope:
- Metric-gated assimilation review and survivor selection
- Compaction promotion gates tied to real benchmark deltas
- Archival of discarded ideas into governed blob storage
- Prime Directive and compaction-state updates after successful cycles
- README benchmark refresh and evidence-backed before/after summaries

Out of scope:
- Auto-promoting compactions without passing tests and benchmark gates
- Creating a second compaction engine outside the existing Snowball family
- Marketing-only benchmark updates unsupported by receipts

## Related Requirements

- REQ-13: Competitive parity and measured benchmark publication
- REQ-14: Offline-first runtime hardening
- REQ-30: Technical excellence roadmap
- Existing SRS families:
  - `V6-APP-023.*`
  - `V6-COCKPIT-009.3`
  - `V6-CONTEXT-001.*`
  - `V8-DIRECTIVES-001.*`

## Requirements

### REQ-40-001: Metric-Gated Assimilation Fitness Review

**Requirement:** Every newly assimilated pattern must be scored against measurable runtime and system-value criteria before it is promoted into the main system.

**Acceptance:**
- Review lane scores candidate assimilations against at least: cold start, idle memory, install size, throughput, reliability, Tiny-max/Pure impact, and RSI/organism utility
- Non-improving candidates are rejected or demoted to optional extension status
- Review emits deterministic before/after scoring receipts

---

### REQ-40-002: Survivor-Only Compaction Promotion

**Requirement:** Compaction cycles may only promote changes that survive benchmark, regression, and governance gates.

**Acceptance:**
- Full regression suite runs after each compaction cycle
- Promotion requires explicit measurable improvement or justified neutral consolidation with zero benchmark regression outside tolerated variance bounds
- Failed cycles emit rollback pointers and do not advance active state

---

### REQ-40-003: Discarded-Idea Blob Archive

**Requirement:** Discarded or demoted ideas must be persisted in governed blob storage so they can be resurrected later without staying live in the code path.

**Acceptance:**
- Discarded patterns are stored as versioned artifacts with provenance, reason-for-rejection, and resurrection metadata
- Blob entries link to the compaction cycle that rejected them
- Archive writes emit deterministic receipts

---

### REQ-40-004: Benchmark Delta and README Publication Gate

**Requirement:** Every successful compaction cycle must refresh benchmark evidence and publish a deterministic before/after delta summary.

**Acceptance:**
- Compaction cycle emits cold start, idle memory, install size, and throughput deltas from the same benchmark harness family
- README-facing benchmark surfaces are updated only from receipted measured artifacts
- Publication path fails closed when benchmark evidence is stale or missing

---

### REQ-40-005: Prime Directive and Compacted-State Update Contract

**Requirement:** A successful compaction cycle must update the system’s compacted-state ledger and any affected Prime Directive bindings in a controlled, auditable way.

**Acceptance:**
- Compaction cycle records the new compacted state, promoted survivors, discarded artifacts, and active policy deltas
- Any directive-impacting changes flow through existing Prime Directive governance, not ad hoc docs edits
- Update emits deterministic receipts and preserves rollback lineage

## Verification Requirements

- SRS rows for the linked `V6-APP-023.7+` family must parse cleanly
- Any future implementation must include:
  - regression test coverage,
  - at least one governance/security gate,
  - runnable CLI evidence for the compaction cycle,
  - benchmark artifact evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source prompt into the existing Snowball/compaction family instead of creating a duplicate optimization subsystem.
- Use `infring` naming for operator-facing commands in new work; retain legacy alias notes only where necessary.
