# Orchestron Candidate Generator Contract

Status: active (`RM-011`)

Source implementation:
- `client/systems/workflow/orchestron/candidate_generator.ts`

## Bounded Candidate Count

`generateCandidates(input)` enforces:
- minimum output count: `3`
- maximum output count: `8`

Input values outside that range are clamped into the `3..8` envelope.

## Required Candidate Contract Fields

Every generated candidate (and nested child candidate) must include:

1. `tradeoffs`
- `speed_weight`
- `robustness_weight`
- `cost_weight`
- normalized to approximately `1.0`

2. `risk_policy`
- `max_risk_per_action`
- `allowed_risks[]`

3. `metadata.explicit_tradeoffs`
- normalized tradeoffs snapshot for downstream auditing.

4. `metadata.cost_profile`
- `estimated_tokens`
- `cost_weight`
- `tier` (`low|medium|high`)

5. `metadata.risk_profile`
- `level` (`low|medium|high`)
- `max_risk_per_action`
- `allowed_risks[]`

## Verification

```bash
node client/memory/tools/tests/orchestron_candidate_generator_contract.test.js
node client/memory/tools/tests/orchestron_candidate_generator_emergence.test.js
node client/systems/spine/contract_check.js
```
