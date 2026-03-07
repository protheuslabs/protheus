# Collective Intelligence Lanes

`V3-RACE-153` through `V3-RACE-160` define the collective intelligence stack:

- distributed training orchestration
- contribution contracts + settlement surfaces
- fractal curriculum oversight
- sovereign rollout ladder
- encrypted model artifact archiving
- contributor incentives
- access-tier governance

## Data Scope Contract

- User-specific data:
  - `client/memory/training/**`, `client/memory/economy/**`
  - `client/adaptive/training/**`, `client/adaptive/economy/**`
- Permanent runtime/policy:
  - `client/systems/training/**`, `client/systems/economy/**`
  - `client/config/*training*`, `client/config/*model_access*`

## Enforcement

Run:

```bash
node client/systems/ops/collective_intelligence_contract_check.js check --strict=1
```

Artifacts:

- `state/ops/collective_intelligence_contract_check/latest.json`
- `state/ops/collective_intelligence_contract_check/receipts.jsonl`
