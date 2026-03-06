# REQ-07: Security Credibility And Verification Program

Version: 1.0  
Date: 2026-03-06  
Owner: Protheus Security + Platform

## Objective

Close external trust gaps by pairing architectural security strengths with independently verifiable operational evidence.

## Source-Of-Truth Rule

Rust remains the only kernel source of truth for constitution, policy, claim-evidence, and receipts. TypeScript is restricted to thin surfaces and conduit clients.

## Requirements

### Phase 1: Immediate Credibility (1–2 weeks)

1. `REQ-07-001` First audited release package must be publishable with SBOM and signed notes.
- Acceptance: release workflow emits CycloneDX SBOM + checksum for `v*` tags.

2. `REQ-07-002` Public security posture must be documented and linked from root docs.
- Acceptance: `docs/SECURITY_POSTURE.md` exists and is referenced from `README.md`.

3. `REQ-07-003` Baseline security hygiene automation must be active.
- Acceptance: Dependabot config and CodeQL workflow exist and are runnable in CI.

### Phase 2: Hard Evidence (2–4 weeks)

4. `REQ-07-004` Independent third-party security audit must be scoped and published.
- Acceptance: public audit report exists with remediation tracker.

5. `REQ-07-005` Formal verification coverage must include constitution and receipt-chain invariants.
- Acceptance: machine-checkable proofs for constitution + receipt chain are versioned in repo.

6. `REQ-07-006` Coordinated vulnerability disclosure policy must be explicit and operational.
- Acceptance: root `SECURITY.md` includes response SLA, intake route, severity handling, and bounty policy link.

### Phase 3: Battle Testing (1–3 months)

7. `REQ-07-007` Public dogfooding program must provide deployment trust history.
- Acceptance: external deployment program and periodic public reliability/security metrics.

8. `REQ-07-008` Continuous fuzzing and chaos testing must run on schedule.
- Acceptance: scheduled CI workflow exists and produces fuzz/chaos evidence artifacts.

9. `REQ-07-009` Government/high-assurance readiness profile must be documented.
- Acceptance: air-gapped profile + STIG-like checklist + evidence bundle path.

## Current Implementation Status

- Implemented in this batch:
  - `REQ-07-001` (release SBOM workflow scaffolding)
  - `REQ-07-002`
  - `REQ-07-003`
  - `REQ-07-006`
  - `REQ-07-008` (initial scheduled workflow baseline)
- Remaining items tracked in `SRS.md` (compatibility alias: `UPGRADE_BACKLOG.md`) under the Security Credibility section.
