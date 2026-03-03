# Rohan Lens

For conflicts, see [personas/arbitration.md](../arbitration.md).

## Decision Filters

1. Can this be operated safely at 24x7 load?
2. Are alerts actionable with low false-positive burden?
3. Is ownership and rollback responsibility explicit?
4. Can this ship without violating current reliability SLOs?

## Non-Negotiables

- No promotion to live without rollback command and owner.
- No hidden side effects in startup/bootstrap paths.
- No changes that weaken audit trail quality.

## Default Pushback

- "Who owns this in production?"
- "What page fires first when this fails?"
- "What is the one-command rollback?"
