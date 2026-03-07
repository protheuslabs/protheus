# Post-Launch Migration Readiness

This document is the PLM control playbook for `PLM-001..PLM-010`.

## Scope

- Base migration from OpenClaw runtime to extracted Protheus base.
- Preserve governance, replay determinism, and rollback posture.

## Gate Mapping

- `PLM-001`: 30-day operational stability (`execution_reliability_slo`, workflow closure).
- `PLM-002`: 30-day guardrail health (`ci_baseline_guard`, `contract_check`, foundation gate).
- `PLM-003`: JS exception floor (`js_holdout_audit` strict violations == 0).
- `PLM-004`: Primitive/profile coverage (`adapter_defragmentation` profile ratio).
- `PLM-005`: Canonical state portability (`state_kernel_cutover` parity + replay checks).
- `PLM-006`: Dual-run parity harness (`narrow_agent_parity_harness`, profile compatibility).
- `PLM-007`: Cutover + rollback playbook and drill evidence.
- `PLM-008`: Independent bootstrap + packaging readiness (`self_hosted_bootstrap_compiler`, `deployment_packaging`).
- `PLM-009`: Security + secrets migration proof (`secret_rotation_attestation`, heartbeat, supply-chain).
- `PLM-010`: Final signed migration go/no-go review artifact.

## Operational Commands

```bash
node client/systems/ops/post_launch_migration_readiness.js run
node client/systems/ops/post_launch_migration_readiness.js run --strict=1
node client/systems/ops/post_launch_migration_readiness.js final-review --decision=no-go --signed-by=jay --approval-note="pending full pass"
node client/systems/ops/post_launch_migration_readiness.js status
```

## Cutover Plan

1. Keep control-plane in dual-write while all PLM gates are green.
2. Enable read-cutover on canary lanes first.
3. Promote to full read-cutover after parity/replay remain green.
4. Retire legacy readers only after shadow window completes.

## Rollback Plan

1. Freeze new promotions.
2. Flip read path to legacy base.
3. Replay from last known good checkpoint.
4. Re-run integrity, contract, and foundation checks.
5. Publish rollback receipt and incident record.

Rollback template: `client/docs/release/templates/rollback_plan.md`.

## Evidence Artifacts

- `state/ops/post_launch_migration_readiness/latest.json`
- `state/ops/post_launch_migration_readiness/receipts.jsonl`
- `state/ops/post_launch_migration_readiness/final_review.json`

