# Dist Runtime Cutover (V2-003)

Purpose: run runtime entrypoints from deterministic `dist/` output while preserving rollback to source-mode wrappers.

## Commands

- `node systems/ops/dist_runtime_cutover.js status`
- `node systems/ops/dist_runtime_cutover.js set-mode --mode=dist`
- `node systems/ops/dist_runtime_cutover.js set-mode --mode=source`
- `node systems/ops/dist_runtime_cutover.js verify --build=1 --strict=1`

## Runtime Resolution

`lib/ts_bootstrap.js` now resolves mode in this order:

1. `PROTHEUS_RUNTIME_MODE` env (`dist|source`)
2. `state/ops/runtime_mode.json` (`set-mode` writes this)
3. fallback `source`

In `dist` mode, wrappers compile from `dist/<same-path>.js` when present. If missing and `PROTHEUS_RUNTIME_DIST_REQUIRED=1`, startup fails closed.

## Guardrails

- `systems/spine/contract_check.js` now fails if runtime mode resolves to `dist` while `PROTHEUS_RUNTIME_DIST_REQUIRED` is not `1`.
- Optional strict wrapper coverage check:
  - `CONTRACT_CHECK_DIST_WRAPPER_STRICT=1 node systems/spine/contract_check.js`
  - Fails if any TS bootstrap wrapper lacks its `dist/` counterpart.

## Rollback

- Immediate rollback: `set-mode --mode=source`
- Emergency one-shot rollback: run process with `PROTHEUS_RUNTIME_MODE=source`

## Validation

`verify` runs:

1. `npm run build:systems:verify` (optional)
2. `contract_check` under `PROTHEUS_RUNTIME_MODE=dist`
3. `schema_contract_check` under `PROTHEUS_RUNTIME_MODE=dist`
