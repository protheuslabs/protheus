# Definition Of Done (DoD)

## Purpose

Prevent false completion claims and keep execution ledgers truthful.

## Status Contract

- `queued`: scoped, not started.
- `in_progress`: actively being implemented.
- `blocked`: cannot proceed due to an explicit blocker.
- `done`: newly implemented in this repo revision with evidence.
- `existing-coverage-validated`: verified as already implemented before this revision; not a new implementation claim.

## Hard DoD Requirements For `done`

An item may be marked `done` only if all checks are true:

1. Authority change exists in the correct layer (core by default; client only thin UX/wrapper).
2. Evidence points to non-backlog files (code/tests/scripts/artifacts), not only TODO/SRS text.
3. Evidence paths resolve:
   - concrete file path exists, or
   - glob evidence matches at least one file.
4. Validation exists and passes (`verify.sh`, lane test, or targeted regression command).
5. No conflict with unchecked TODO state for the same ID.

## Prohibited

- Marking regression-only confirmations as `done`.
- Treating `existing-coverage-validated` as code implementation.
- Claiming completion without non-backlog evidence.

## CI Enforcement

The following gates enforce this policy:

- `ops:srs:full:regression` (done/evidence/status consistency across SRS rows).
- `ops:dod:gate` (ROI execution ledger truthfulness and evidence existence).
- `verify.sh` runs `ops:dod:gate` as a required step.

## Operational Rule

If evidence is missing, downgrade status immediately (`done -> in_progress` or `existing-coverage-validated`) and patch the ledger before continuing.
