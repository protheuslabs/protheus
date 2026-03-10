# Autophagy Auto-Approval

`V6-ALIVE-001.2` is implemented by the authoritative Rust lane:

- `core/layer2/ops/src/autophagy_auto_approval.rs`
- `core/layer0/ops/src/main.rs` (`protheus-ops autophagy-auto-approval ...`)

Thin client wrapper:

- `client/runtime/systems/autonomy/autophagy_auto_approval.ts`

Policy:

- `client/runtime/config/autophagy_auto_approval_policy.json`

## Commands

```bash
target/debug/protheus-ops autophagy-auto-approval evaluate --proposal-json='{"id":"age-10-fix","title":"Enable async health","type":"ops_remediation","confidence":0.91,"historical_success_rate":0.94,"impact_score":18}' --apply=1

target/debug/protheus-ops autophagy-auto-approval monitor --proposal-id=age-10-fix --drift=0.02 --apply=1

target/debug/protheus-ops autophagy-auto-approval commit --proposal-id=age-10-fix --reason=operator_confirmed

target/debug/protheus-ops autophagy-auto-approval rollback --proposal-id=age-10-fix --reason=manual_regression

target/debug/protheus-ops autophagy-auto-approval status
```

## Behavior

- High-confidence bounded proposals can enter `pending_commit` automatically.
- Pending proposals carry a deterministic rollback deadline.
- `monitor` can auto-rollback on degradation threshold breach or expired rollback window.
- Rollbacks emit a regret/remediation record into the regrets ledger.
