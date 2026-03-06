# REQ-06: Fortune-100 Operational Excellence Hardening

Version: 1.0  
Date: 2026-03-05  
Owner: Protheus Core (Rust TCB)

## Objective

Codify and enforce the operational controls needed to move the platform from B+/startup-ops posture to A-grade enterprise posture, while preserving Rust as the only kernel source of truth.

## Scope

In scope:
- Reliability, alerting, incident response, runbooks, release safety, and governance controls
- Rust-enforced hardening gate in `protheus-ops`
- CI required-check integration for hardening policy
- Deterministic receipts for hardening evaluations

Out of scope:
- Rewriting existing subsystems
- Adding new TypeScript ownership for kernel authority

## Source-of-Truth Rule

Kernel authority remains Rust. TypeScript is limited to wrappers, UX/dev surfaces, and integration ergonomics. Any control that affects safety, policy, constitution, or release gating must be enforceable from Rust.

## Control Requirements

1. `REQ-06-001` Reliability error-budget policy must be defined and machine-checkable.
Acceptance: control `f100_reliability_error_budget_gate` passes.

2. `REQ-06-002` Cron delivery cannot silently drop alerts.
Acceptance: control `f100_cron_delivery_integrity` passes and no enabled isolated job is missing valid announce delivery.

3. `REQ-06-003` Dashboard health path must be Rust-authoritative.
Acceptance: control `f100_status_dashboard_contract` passes.

4. `REQ-06-004` Model routing must include explicit circuit-breaker policy.
Acceptance: control `f100_model_circuit_breakers` passes.

5. `REQ-06-005` Durable state and secret channel boundaries must be explicit.
Acceptance: control `f100_durable_state_channels` passes.

6. `REQ-06-006` Multi-region DR contract must specify RTO/RPO and drill cadence.
Acceptance: control `f100_multi_region_dr_contract` passes.

7. `REQ-06-007` Secret rotation/migration attestation must exist and be auditable.
Acceptance: control `f100_secret_rotation_attestation` passes.

8. `REQ-06-008` RBAC/least-privilege policy must be encoded.
Acceptance: control `f100_rbac_access_policy` passes.

9. `REQ-06-009` Deterministic claim-evidence receipt chain must remain intact.
Acceptance: control `f100_deterministic_receipt_chain` passes.

10. `REQ-06-010` Full pipeline hardening contract must exist for E2E integrity.
Acceptance: control `f100_full_pipeline_e2e_contract` passes.

11. `REQ-06-011` Chaos resilience policy must include minimum pass-rate gate.
Acceptance: control `f100_chaos_resilience_contract` passes.

12. `REQ-06-012` On-call runbook must include critical incident playbooks.
Acceptance: control `f100_oncall_runbook_contract` passes.

13. `REQ-06-013` Postmortem policy must enforce prevention and verification references.
Acceptance: control `f100_postmortem_policy` passes.

14. `REQ-06-014` Scale release safety must enforce canary and kill-switch requirements.
Acceptance: control `f100_scale_release_safety` passes.

15. `REQ-06-015` Rust source-of-truth policy must be explicit and checked.
Acceptance: control `f100_rust_source_of_truth_contract` passes.

16. `REQ-06-016` Release promotion gate policy must be present.
Acceptance: control `f100_release_promotion_gate` passes.

17. `REQ-06-017` Branch protection contract must include non-bypass check policy.
Acceptance: control `f100_branch_protection_contract` passes.

18. `REQ-06-018` Interface lifecycle registry must be versioned and tracked.
Acceptance: control `f100_interface_lifecycle_registry` passes.

19. `REQ-06-019` SRE observability runbook must include baseline SLOs and drills.
Acceptance: control `f100_sre_observability_runbook` passes.

20. `REQ-06-020` Conduit command capability/message-budget constraints must be policy-bound.
Acceptance: control `f100_conduit_policy_budget` passes.

## Enforcement

Runtime gate:
- `protheus-ops enterprise-hardening run --strict=1`

Policy file:
- `config/f100_enterprise_hardening_policy.json`

Expected output contract:
- deterministic JSON receipt
- `claim_evidence[]`
- `receipt_hash`
- fail-closed exit code when strict and any control fails

## CI Gate

`Required Checks` must execute this gate on every protected merge path:
- `cargo run --quiet --manifest-path crates/ops/Cargo.toml --bin protheus-ops -- enterprise-hardening run --strict=1`

## Backlog Mapping

This requirement document operationalizes the queued Fortune controls `V6-F100-001..V6-F100-012` by converting them into one enforceable hardening surface while preserving existing lane-specific implementations.
