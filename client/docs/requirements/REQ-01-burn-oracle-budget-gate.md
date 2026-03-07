# REQ-01 Burn Oracle Budget Gate

## Objective
- Enforce a fail-closed budget gate for burn-oracle-backed spend decisions.

## Contract
- `requested_burn_units` must be `> 0`.
- `requested_burn_units` must be `<= max_allowed_burn_units`.
- Oracle availability is required. Oracle-unavailable evaluates to deny.
- Oracle remaining budget must cover the request.

## Determinism
- Every evaluation emits a deterministic receipt envelope with:
  - `schema_id`
  - `check_id`
  - `ok`
  - `code`
  - budget fields
  - `deterministic_key` derived from canonical field order
