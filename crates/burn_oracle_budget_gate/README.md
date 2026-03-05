# burn_oracle_budget_gate

Fail-closed burn-oracle budget primitive for foundation contract checks.

## API
- `evaluate_burn_oracle_budget_gate(BurnOracleBudgetRequest) -> BurnOracleBudgetDecision`

## Guarantees
- Budget bound checks are enforced.
- Oracle-unavailable fails closed.
- Deterministic receipt envelope for every decision.
