# Drift-Aware Revenue Optimizer

`V3-BRG-003` tunes workflow and budget routing for value growth while keeping drift under cap and execution SLO healthy.

## Commands

```bash
node client/systems/weaver/drift_aware_revenue_optimizer.js optimize
node client/systems/weaver/drift_aware_revenue_optimizer.js optimize --strict=1
node client/systems/weaver/drift_aware_revenue_optimizer.js status --days=30
```

## Inputs

- `state/ops/execution_reliability_slo.json`
- `state/client/adaptive/workflows/high_value_play/latest.json`
- `state/client/adaptive/workflows/high_value_play/history.jsonl`

## Output

- `state/weaver/drift_aware_revenue_optimizer/latest.json`
- `state/weaver/drift_aware_revenue_optimizer/history.jsonl`
- `state/weaver/drift_aware_revenue_optimizer/receipts.jsonl`

The optimizer emits:
- signal summary (`drift_30d`, reward/confidence, execution_slo_pass)
- mode (`conservative` or `balanced_growth`)
- recommended workflow mix + budget routing
- reason codes for enforcement decisions
