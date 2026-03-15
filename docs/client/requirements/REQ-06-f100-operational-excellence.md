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

21. `REQ-06-021` Enabled cron jobs must use explicit announce delivery to the main operator channel.
Acceptance: every enabled job in `client/runtime/config/cron_jobs.json` has `delivery.mode=announce` and `delivery.channel=main`.

22. `REQ-06-022` Status dashboard must expose measurable SLO metrics, not only pass/fail checks.
Acceptance: `protheus-ops status --dashboard` emits `slo.metrics` entries for spine success rate, receipt latency, assimilation pain score, cron health, and PQTS slippage MAPE.

23. `REQ-06-023` Runtime model recovery policy must include deterministic retries plus explicit fallback routing for degraded families.
Acceptance: `client/runtime/config/model_health_recovery_policy.json` and `client/runtime/config/model_health_auto_recovery_policy.json` define bounded backoff and fallback model bindings for `llama3.2:*`.

24. `REQ-06-024` Hosted runtime paths must prefer optimized release binaries when available.
Acceptance: conduit lane bridge launchers check `target/release/*` before debug/cargo fallback and release build validation is documented in operator workflow.

25. `REQ-06-025` Secret rotation compliance must be enforced on a fixed cadence with auditable attestations.
Acceptance: scheduled secret-rotation attestation job exists in `client/runtime/config/cron_jobs.json` and emits deterministic remediation output when stale.

26. `REQ-06-026` Memory continuity index maintenance must be operationalized.
Acceptance: `tests/tooling/scripts/memory/rebuild_exclusive.ts` is part of the recurring operational schedule and produces refreshed index artifacts without archive leakage.

27. `REQ-06-027` SDLC risk-class governance must be fail-closed at merge time.
Acceptance: `protheus-ops sdlc-change-control run --strict=1` rejects PRs that understate risk class or lack required RFC/ADR/approver/rollback evidence for `major`/`high-risk` changes.

28. `REQ-06-028` Release supply-chain provenance must be enforced before publish.
Acceptance: `protheus-ops supply-chain-provenance-v2 run --strict=1` verifies per-artifact SBOM/signature/hash parity, dependency vulnerability SLA budget, and rollback-to-last-known-good contract from release provenance bundle.

## Enforcement

Runtime gate:
- `protheus-ops enterprise-hardening run --strict=1`
- `protheus-ops f100-reliability-certification run --strict=1`
- `protheus-ops sdlc-change-control run --strict=1`
- `protheus-ops supply-chain-provenance-v2 run --strict=1`

Policy file:
- `client/runtime/config/f100_enterprise_hardening_policy.json`

Expected output contract:
- deterministic JSON receipt
- `claim_evidence[]`
- `receipt_hash`
- fail-closed exit code when strict and any control fails

## CI Gate

`Required Checks` must execute this gate on every protected merge path:
- `cargo run --quiet --manifest-path core/layer0/ops/Cargo.toml --bin protheus-ops -- enterprise-hardening run --strict=1`
- `cargo run --quiet --manifest-path core/layer0/ops/Cargo.toml --bin protheus-ops -- sdlc-change-control run --strict=1 --policy=client/runtime/config/sdlc_change_control_policy.json --pr-body-path=state/ops/sdlc_change_control/pr_body.md --changed-paths-path=state/ops/sdlc_change_control/changed_paths.txt`

## Backlog Mapping

This requirement document operationalizes the queued Fortune controls `V6-F100-001..V6-F100-015` by converting them into one enforceable hardening surface while preserving existing lane-specific implementations.
