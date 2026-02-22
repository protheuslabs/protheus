# TS/JS Runtime Policy (Migration Safety)

Purpose: prevent drift while `systems/` + `lib/` are in phased TypeScript migration.

## Decision

1. `*.ts` is the canonical source for files that have both `*.ts` and `*.js`.
2. `*.js` remains runtime-required in V1 because:
   - current entrypoints call `node .../*.js`
   - contract checks reference `.js` interfaces
3. No direct “JS-only” edits are allowed for paired files.
4. No direct “TS-only” edits are allowed for paired files unless runtime JS is updated in the same change.

## Enforcement

- `systems/security/repo_hygiene_guard.js` now fails strict mode when a changed file in `systems/` or `lib/` has a TS/JS twin and only one side changed.
- Escape hatch for emergency use only:
  - `--allow-ts-pair-drift`

## What Counts As “Old Pre-Migration JS”

1. **Paired JS (`foo.js` + `foo.ts`)**:
   - keep for runtime compatibility in V1
   - treated as compatibility artifacts that must stay in sync with TS
2. **Unpaired JS (`foo.js` only)**:
   - still active migration targets (BL-014/V2-001)
   - migrate in waves, not by mass rewrite

## Retirement Plan (V2)

1. Add deterministic build output (`dist/`) for runtime JS.
2. Move runtime entrypoints and contract checks to `dist/`.
3. Remove in-tree paired compatibility JS from source paths after parity verification.
