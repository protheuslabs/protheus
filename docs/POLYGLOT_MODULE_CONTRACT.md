# Polyglot Service Contract (V2-002)

Purpose: allow non-TS modules behind strict, testable contracts with rollback-safe adapters.

## Contract

- Transport: JSON over stdin/stdout
- Request envelope:
  - `schema_version`: string (required, current `1.0`)
  - `task_type`: string
  - `signals`: object (numeric hints)
  - `rollback_token`: string (optional)
- Response envelope:
  - `ok`: boolean (required)
  - `module`: string (required)
  - `contract_version`: string (required)
  - `result`: object (required when `ok=true`)
  - `receipt`: object (required)

## Adapter Rules

- Validate envelope before accepting worker output.
- Enforce worker timeout.
- Emit deterministic fallback (`mode=fallback_baseline`) when worker fails.
- Keep control plane unchanged: only adapter may call worker runtime.

## Pilot

- Adapter: `systems/polyglot/polyglot_service_adapter.ts`
- Worker: `systems/polyglot/pilot_task_classifier.py`
- Policy: `config/polyglot_service_policy.json`
- Test: `memory/tools/tests/polyglot_service_adapter.test.js`

## Rollback Path

- Disable via policy (`enabled=false`) or env (`POLYGLOT_SERVICE_ENABLED=0`).
- Adapter continues returning baseline JS classification.
- No cross-system contract changes required.
