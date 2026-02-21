# Adaptive Layer

Purpose: keep policy/state that should evolve from evidence, while leaving `systems/` as stable execution + safety infrastructure.

## Sub-layers

- `adaptive/reflex/`
  Fast micro-routine policy and tuning notes.
- `adaptive/habits/`
  Repeat-derived routine lifecycle policy.
- `adaptive/strategy/`
  Strategy scoring/promotion policy and learned scorecards.

## Boundary

- `adaptive/*` stores changeable policy + learned state shape.
- `systems/*` enforces deterministic gates, execution, and security controls.
- Domain-specific implementations remain in `skills/` or `habits/`.
