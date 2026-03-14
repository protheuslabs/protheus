# Direct Wiring Audit (2026-03-07)

## Removed in this sprint

- `client/core_memory_compat/` (deprecated memory compatibility shim)
- `client/core/memory/compat_bridge.ts` (duplicate shim entrypoint)
- `tests/client-memory-tools/core_memory_compat_bridge.test.js` (shim-only test)
- `client/runtime/state` symlink (legacy runtime alias)
- root `local/` runtime leakage (migrated into `client/runtime/local/state/*`)

## Canonical runtime roots

- Client runtime/user data: `client/runtime/local/*`
- Core runtime/node-local data: `core/local/*`

## Enforced blocked legacy surfaces

- `state`
- `client/runtime/state`
- `local`

Enforced by:

- `client/runtime/systems/ops/runtime_state_surface_guard.ts`
- `client/runtime/systems/ops/migrate_cleanup.ts`

## Remaining intentional exceptions

- Tracked bootstrap material is limited to blank templates:
  - `docs/workspace/templates/assistant/*.md`
- Live instance data now sits outside the tracked docs surface:
  - `local/workspace/assistant/*.md`
  - `local/workspace/memory/*.md`
  - `local/workspace/reports/*.md`
