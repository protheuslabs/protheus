# Capital Allocation Organ

`V3-BRG-002` provides a governed reinvestment loop with simulation gating and drawdown protection.

## Commands

```bash
node systems/budget/capital_allocation_organ.js seed --balance=1000
node systems/budget/capital_allocation_organ.js simulate --bucket=compute --amount=100 --expected-return=0.2 --risk-score=0.2
node systems/budget/capital_allocation_organ.js allocate --bucket=compute --amount=100 --simulation-id=<id> --strict=1
node systems/budget/capital_allocation_organ.js settle --allocation-id=<id> --actual-return=0.08
node systems/budget/capital_allocation_organ.js evaluate --days=30 --strict=1
```

## Governance Controls

- Allocation requires a passing simulation (`score >= min_simulation_score`)
- Bucket max share caps are enforced
- Drawdown stop is enforced per bucket
- Evaluation reports risk-adjusted return over rolling window
- Strict mode fails closed when target is missed

## State

- `state/budget/capital_allocation/state.json`
- `state/budget/capital_allocation/latest.json`
- `state/budget/capital_allocation/receipts.jsonl`
