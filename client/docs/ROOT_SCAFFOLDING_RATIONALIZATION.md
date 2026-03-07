# Root Scaffolding Rationalization

`V4-CLEAN-004` classifies root scaffold directories before any move:

- `runtime_required`: source/runtime-adjacent scaffolds that stay at root
- `docs_required`: editorial/reference scaffolds that stay at root
- `internal_only`: operator-private scaffolds that may be moved into `.internal/`

## Current Classification

- `drafts/` -> `docs_required`
- `notes/` -> `docs_required`
- `client/patches/` -> `runtime_required`
- `research/` -> `runtime_required`

No `internal_only` directories are currently designated for migration.

## Contract-First Workflow

1. Run rationalization check:
   - `node client/systems/ops/root_scaffolding_rationalization.js run --strict=1`
2. If any directory is marked `internal_only`, move only through the lane:
   - `node client/systems/ops/root_scaffolding_rationalization.js run --apply=1 --move_internal=1 --strict=1`
3. Verify downstream contracts:
   - `node client/systems/ops/root_surface_contract.js check --strict=1`
   - `node client/systems/ops/docs_surface_contract.js check --strict=1`

## Data-Scope Boundary

`.internal/` is reserved for local/internal-only working material and is intentionally gitignored.
