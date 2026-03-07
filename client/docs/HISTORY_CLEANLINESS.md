# History Cleanliness Program

## Objective

Keep repository history auditable, searchable, and release-ready under high change volume.

## Core Rules

- `main` history is append-only in normal operation.
- No force-push to protected branches.
- One pull request should represent one logical change set.
- Generated artifacts should be produced by the documented generator command, not manual editing.

## Commit Hygiene Standard

- Prefer concise, explicit commit titles.
- Conventional prefixes are recommended:
  - `feat:`
  - `fix:`
  - `docs:`
  - `chore:`
  - `test:`
  - `refactor:`
- Avoid "mixed intent" commits that combine unrelated changes.

## Pull Request Hygiene

Every PR should include:
- clear summary of behavior changes
- validation evidence (`lint`, `test`, or equivalent lane checks)
- risks and compatibility notes
- changelog update when user-visible behavior/docs changed

## Release Notes Discipline

- Any release-facing change must have:
  - backlog ID(s) or explicit rationale
  - operator impact statement
  - rollback notes when applicable
- Document final outcomes in `CHANGELOG.md`.

## Allowed History Rewrites

Rewrite only when required for safety/compliance:
- secret exposure
- client/legal/takedown requirements
- corrupted binary/large-file incidents

When rewrite is required:
- capture incident reason
- capture affected refs
- document remediation in postmortem and changelog

## Cleanliness Checks

- Weekly:
  - scan for noisy/unscoped commit patterns
  - verify changelog drift against merged PRs
- Monthly:
  - review template adherence
  - identify recurring hygiene regressions and update policy

