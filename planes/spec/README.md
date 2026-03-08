# Three-Plane Formal Spec Surface

This directory is the machine-checkable formal-spec surface for three-plane boundary rules.

## Scope
- Safety plane authority must remain immutable from cognition/substrate surfaces.
- Conduit is the only permitted cross-plane transport primitive.
- Degradation contracts must preserve fail-closed behavior.

## Current specs
- `tla/three_plane_boundary.tla`
- `tla/three_plane_boundary.cfg`

## CI contract
`npm run -s ops:formal-spec:check` verifies that required specs and invariants are present.
