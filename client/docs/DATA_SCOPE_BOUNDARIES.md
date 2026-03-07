# Data Scope Boundaries

This repository enforces a strict scope split:

- User-specific data:
  - `client/memory/` for user-owned records, preferences, and histories.
  - `client/adaptive/` for learned heuristics/tuning tied to user behavior.
- Permanent/shared implementation:
  - `client/systems/` for runtime logic.
  - `client/config/` for policy contracts.
  - `client/docs/` for operator contracts and runbooks.
- Internal-only local scaffolding:
  - `.internal/` for non-runtime private working material that must not ship.

## Hard Rules

1. `client/memory/` and `client/adaptive/` must not contain executable `.ts` or `.js` runtime modules.
2. Canonical implementation files must live under `client/systems/` (with config in `client/config/`).
3. `.internal/` content is never a source-of-truth runtime path and should remain local-only.
4. New feature lanes must declare:
   - user paths (`client/memory/`, `client/adaptive/`)
   - permanent runtime paths (`client/systems/`, `client/config/`)
   - check coverage in `client/systems/ops/data_scope_boundary_check.ts`

## Integration Touchpoints (V3-RACE-136)

- Soul vector: `client/systems/symbiosis/soul_vector_substrate.ts`
- Economy tithe lane: `client/systems/economy/tithe_engine.ts`
- Spawn broker: `client/systems/spawn/spawn_broker.ts`
- Guard path: `client/systems/security/guard.ts`
- Fractal engine + complexity warden:
  - `client/systems/fractal/engine.ts`
  - `client/systems/fractal/warden/complexity_warden_meta_organ.ts`
- Jigsaw receipts: `client/systems/security/jigsaw/attackcinema_replay_theater.ts`

## Enforcement

- `node client/systems/ops/data_scope_boundary_check.js check --strict=1`
- Latest receipt: `state/ops/data_scope_boundary_check/latest.json`
