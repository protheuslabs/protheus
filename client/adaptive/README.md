# Adaptive Layer

Purpose: keep policy/state that should evolve from evidence, while leaving `client/systems/` as stable execution + safety infrastructure.

## Sub-layers

- `client/adaptive/reflex/`
  Fast micro-routine policy and tuning notes.
- `client/adaptive/client/habits/`
  Repeat-derived routine lifecycle policy.
- `client/adaptive/strategy/`
  Strategy scoring/promotion policy and learned scorecards.

## Boundary

- `client/adaptive/*` stores changeable policy + learned state shape.
- `client/systems/*` enforces deterministic gates, execution, and security controls.
- Domain-specific implementations remain in `client/skills/` or `client/habits/`.
