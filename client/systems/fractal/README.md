# Fractal Engine v1 - Self-Evolution Substrate

`V3-RACE-019` adds a persistent fractal meta-organ under `client/systems/fractal/`.

## Modules

- `engine.ts`: orchestrates the full cycle (`telemetry -> critique -> mutate -> shadow -> two-gate -> reversion`).
- `telemetry_aggregator.ts`: snapshots burn, stream authority, drift, and receipt signals.
- `critic.ts`: computes confidence and proposes bounded mutation domains.
- `mutator.ts`: materializes candidate mutations and runs constitution hooks.
- `shadow_trial_runner.ts`: runs candidate proposals through shadow primitives.
- `two_gate_applier.ts`: enforces tier and approval gates.
- `reversion_drill.ts`: schedules and executes rollback drills.
- `constitution_hooks.ts`: invariant checks before trial/apply.
- `fractal_state.json`: persistent state/soul anchor file.

## Hard Invariants

1. Mutations stay at tier `<= 2` until confidence reaches `>= 0.997`.
2. Mutation lifecycle events are event-sourced through the control-plane stream.
3. Successful applies refresh the soul vector and update the anchor cipher.
4. Tier `3+` changes require explicit human second-gate approval.

## Notes

- This implementation is TypeScript-first (`.ts`) and does not add new `.js` files.
- Runtime execution in this repository typically uses JS bootstrap wrappers; this lane is prepared for source/dist TypeScript execution paths.
