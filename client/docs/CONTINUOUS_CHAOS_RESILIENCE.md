# Continuous Chaos + Adversarial Resilience Loop

`client/systems/ops/continuous_chaos_resilience.ts` implements `V3-061`.

It runs policy-bounded continuous chaos injections using `chaos_program`, tracks deterministic receipts, and enforces a promotion-blocking gate when resilience SLO regresses.

## Commands

- `tick`: execute due chaos scenarios by cadence
- `gate`: evaluate resilience SLO over rolling window
- `status`: report gate state and due scenario count

## Promotion Blocking Contract

`gate` computes:

- pass rate over recent runs
- failed run budget
- recovery p95 duration budget
- sample floor

When any gate fails, `promotion_blocked=true` is emitted with reason codes.

## Receipts

- `state/ops/continuous_chaos_resilience/receipts.jsonl`
- `state/ops/continuous_chaos_resilience/gate_receipts.jsonl`

Each scenario receipt includes runbook linkage (`runbook_action`) and recovery timing.

