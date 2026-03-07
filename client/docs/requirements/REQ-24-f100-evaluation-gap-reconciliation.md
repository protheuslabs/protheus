# REQ-24: Fortune-100 Evaluation Gap Reconciliation

## Goal

Convert external enterprise-readiness critiques into deterministic, testable controls with a strict split between:
- machine-executable implementation tasks, and
- human-authority tasks (client/legal/commercial/compliance governance).

Rust remains the source of truth for runtime safety/policy/receipts. TypeScript remains constrained to thin operational and integration surfaces.

## Scope

In scope:
- deterministic baseline gate for externally visible enterprise controls,
- enterprise packaging artifacts (Helm + Terraform module),
- backlog/human-action split for non-automatable requirements.

Out of scope:
- legal certification issuance,
- external commercial contracting,
- executive policy approvals.

## Requirements

1. `REQ-24-001` The repo must include a strict baseline gate that verifies core enterprise posture claims.
- Acceptance:
  - `client/config/f100_enterprise_baseline_contract.json` defines baseline checks.
  - `client/systems/ops/f100_enterprise_baseline_gate.js` emits deterministic receipts.
  - strict mode fails when any check is missing.

2. `REQ-24-002` Enterprise packaging artifacts must include Helm and Terraform deployment surfaces.
- Acceptance:
  - Helm chart exists under `client/deploy/helm/protheus/`.
  - Terraform module exists under `client/deploy/terraform/protheus_helm/`.

3. `REQ-24-003` Human-only requirements must be explicitly split from machine-executable backlog lanes.
- Acceptance:
  - `client/docs/HUMAN_ONLY_ACTIONS.md` includes rows for external certifications, support/SLA authority, and legal attestation ownership.

4. `REQ-24-004` Baseline gate must be CI-runnable.
- Acceptance:
  - workflow exists at `.github/workflows/f100-enterprise-baseline.yml` and runs strict baseline verification.

## Status

- Implemented in this lane:
  - `REQ-24-001`
  - `REQ-24-002`
  - `REQ-24-003`
  - `REQ-24-004`

- Deferred to backlog + human authority:
  - external SOC2/ISO/FedRAMP audit completion and publication,
  - enterprise commercial support/SLA legal execution.
