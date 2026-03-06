# Changelog

All notable changes to this repository are documented in this file.

This project follows a strict evidence-backed changelog model:
- Every entry must map to merged code/docs in the same date window.
- Public-facing claims must reference verifiable artifacts.
- Backlog IDs should be included when work is driven by roadmap tracks.

## [Unreleased]

### Added
- `V4-SELF-001` self-audit lane baseline:
  - Rust scanner core: `systems/self_audit/illusion_integrity_auditor.rs`
  - Lane orchestrator: `systems/self_audit/illusion_integrity_lane.ts`
  - Policy and docs surface:
    - `config/illusion_integrity_auditor_policy.json`
    - `docs/ILLUSION_INTEGRITY_AUDITOR.md`
  - Control-plane trigger integration (`startup`, `promotion`, `protheusctl audit illusion`)

### Changed
- Replaced root `README.md` with an evidence-first control-plane overview aligned to the Empty Fort artifact standard (operator onboarding, governance surfaces, and quality/security gates mapped to real scripts/docs).
- OSS readiness uplift:
  - Apache-2.0 legal posture finalized across root/npm package manifests.
  - Governance links surfaced in `README.md` (Code of Conduct + issue/PR templates).
  - Added release-prep version bump to `0.2.0` for first public semantic release gating.

## [2026-03-02]

### Added
- V4-FORT artifact baseline for enterprise-grade presentation:
  - UI surface maturity matrix and update cadence (`docs/UI_SURFACE_MATURITY_MATRIX.md`)
  - Role-based onboarding playbook (`docs/ONBOARDING_PLAYBOOK.md`)
  - History cleanliness and release hygiene policy (`docs/HISTORY_CLEANLINESS.md`)
  - Public collaboration triage contract (`docs/PUBLIC_COLLABORATION_TRIAGE.md`)
  - Claim-evidence policy guard (`docs/CLAIM_EVIDENCE_POLICY.md`)
  - GitHub issue templates for bug/feature/security routing (`.github/ISSUE_TEMPLATE/*`)

### Changed
- Repository navigation docs updated to surface launch-polish artifacts:
  - `README.md`
  - `CONTRIBUTING.md`
  - `.github/pull_request_template.md`

### Governance
- Backlog source-of-truth expanded with `V4-FORT-001..006` in `UPGRADE_BACKLOG.md`.
