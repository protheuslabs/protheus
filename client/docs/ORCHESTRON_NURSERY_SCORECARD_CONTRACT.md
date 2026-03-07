# Orchestron Nursery Scorecard Contract

Status: active (`RM-012`)

Source implementation:
- `client/systems/workflow/orchestron/nursery_tester.ts`

## Deterministic Scorecard Fields

Each candidate scorecard must include:
- `predicted_yield_delta`
- `predicted_drift_delta`
- `safety_score`
- `regression_risk`
- `composite_score`
- `pass`
- `reasons[]`

Scorecards are sorted deterministically by:
1. `composite_score` descending
2. `candidate_id` ascending (tie-break)

## Blocking Behavior

Nursery output separates candidates into:
- `passing[]`: candidates eligible for promotion (bounded by `max_promotions_per_run`)
- `blocked[]`: failing candidates (or pass-candidates blocked by failed parent lineage)

Each blocked row includes:
- `candidate_id`
- `predicted_yield_delta`
- `predicted_drift_delta`
- `safety_score`
- `regression_risk`
- `composite_score`
- `reasons[]`

## Envelope Contract

`evaluateCandidates(input)` returns:
- `type: "orchestron_nursery_scorecard"`
- `contract_version: "1.0"`
- `summary` (`scorecards`, `passing`, `blocked`, `pass_rate`)
- `scorecards[]`
- `blocked[]`
- `passing[]`

## Verification

```bash
node client/memory/tools/tests/orchestron_nursery_scorecard_contract.test.js
node client/memory/tools/tests/orchestron_adaptive_controller.test.js
node client/systems/spine/contract_check.js
```
