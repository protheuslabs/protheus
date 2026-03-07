# Pre-Neuralink Interface

## Purpose

`pre_neuralink_interface` is a governed non-invasive intent lane for:

- `voice`
- `attention`
- `haptic`

It stays local-first, requires explicit consent to route, and pushes all actuation decisions through the Eye kernel.

## Commands

```bash
node client/systems/symbiosis/pre_neuralink_interface.js ingest --channel=voice --signal="plan next sprint" --consent-state=granted
node client/systems/symbiosis/pre_neuralink_interface.js route --apply=0
node client/systems/symbiosis/pre_neuralink_interface.js handoff-contract --write=1
node client/systems/symbiosis/pre_neuralink_interface.js status
```

## Guardrails

- `local_first=true` by default.
- `require_explicit_consent=true` and routing only when consent state is in `route_allowed_states`.
- `shadow_only=true` by default to keep routing advisory unless explicitly promoted.
- Route requests are evaluated via `client/systems/eye/eye_kernel.js`.

## Handoff Contract

The interface emits a handoff contract at:

`state/symbiosis/pre_neuralink_interface/handoff_contract.json`

This contract defines modality family, consent envelope, and routing semantics so future neural interfaces can bind without refactoring this lane.
