# REQ-04 Persona Dispatch Security Gate

## Objective
- Enforce fail-closed persona dispatch gating before command dispatch.

## Contract
- Covenant violation or tamper signal blocks dispatch.
- Blocked paths are denied deterministically.
- Lens resolution:
  - Use requested lens when valid.
  - Fallback to first valid lens when requested lens is invalid.
  - Deny when no valid lens exists.

## Determinism
- Emit deterministic security envelope fields:
  - `schema_id`
  - `check_id`
  - `code`
  - normalized script path
  - requested/selected lens
  - `fallback_used`
  - `deterministic_key`
