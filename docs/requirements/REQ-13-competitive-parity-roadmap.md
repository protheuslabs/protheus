# REQ-13: Competitive Parity and Evidence-Led Overtake Roadmap

Version: 1.0  
Date: 2026-03-06

## Objective

Close remaining execution-gap surfaces against top agent-OS competitors while preserving Protheus differentiators: Rust-authoritative governance, claim-evidence receipts, and auditable control plane behavior.

## Scope

In scope:
- Packaging/release cadence parity signals.
- Benchmark counter-suite with reproducible methodology.
- Migration importer for competitor format onboarding.
- Evidence-first audit UX and enterprise trust surfaces.

Out of scope:
- Marketing claims without verifiable artifacts.
- Any rollback of Rust-authoritative source-of-truth posture.

## Requirements

1. `REQ-13-001` Release cadence + install parity evidence
- Acceptance:
  - Release workflow supports repeatable semantic release cadence.
  - `cargo install` and curl installer flows remain validated in CI/release checks.
  - Release notes include binary + SBOM + install verification artifacts.

2. `REQ-13-002` Competitive benchmark matrix (measured, reproducible)
- Acceptance:
  - Add benchmark harness inputs/outputs under `benchmarks/` with reproducible commands.
  - Include cold start, idle memory, install size, and evidence-verification latency metrics.
  - Publish result snapshots with timestamped receipts; no unverifiable claims.

3. `REQ-13-003` Migration importer (`protheus migrate --from openfang`)
- Acceptance:
  - Add importer command path to ingest competitor config artifacts into Protheus governance format.
  - Import path is fail-closed with schema validation and explicit conversion receipts.
  - Migration docs include rollback/retry steps.

4. `REQ-13-004` Evidence-first audit dashboard UX
- Acceptance:
  - Add operator surface to traverse claim -> evidence -> receipt chain quickly.
  - Dashboard supports incident drill-down and export for audit workflows.
  - Metrics and receipt links are deterministic and policy-backed.

5. `REQ-13-005` Security-layer accounting with evidence links
- Acceptance:
  - Publish security-layer inventory with concrete implementation references and runtime checks.
  - Each listed layer links to enforceable code path or policy contract plus test coverage.

## Verification Requirements

- CI validation for release artifact completeness and benchmark artifact schema.
- End-to-end test for competitor migration command happy-path + reject-path.
- Invariant gate remains green with new migration and dashboard surfaces.

## Execution Notes

- Treat parity metrics as trust contracts: measurable, reproducible, and receipt-backed.
- Prefer operational proof over claims language in docs.
