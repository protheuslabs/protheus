# Branch Protection Policy

Purpose: make critical guards non-bypass for merges to `main`.

## Required Branch Settings (GitHub)

Apply to `main`:

1. Require a pull request before merging.
2. Require approvals: `1`.
3. Require review from Code Owners: enabled.
4. Require status checks to pass before merging.
5. Require branches to be up to date before merging.
6. Do not allow bypassing the above requirements.

## Required Status Checks

From workflow `Required Checks`:

- `contract_check`
- `schema_contract_check`
- `adaptive_layer_guard_strict`
- `ci_suite`

## Code Owner Enforcement

`CODEOWNERS` includes:

- `/systems/`
- `/config/`
- `/lib/`
- `/adaptive/`
- `/.github/workflows/`

All matching pull requests require owner review before merge.

## Local Pre-PR Gate

Run before opening/merging PRs:

`npm run guard:merge`

Fast variant without full test suite:

`npm run guard:merge:fast`

## Notes

- `guard:merge` is a local non-bypass operator routine; branch protection is the remote merge gate.
- Policy changes to required checks or code owner scopes must be reviewed by code owners.

