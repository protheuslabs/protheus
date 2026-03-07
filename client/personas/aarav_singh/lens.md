# Aarav Singh Lens

## Decision Filters

1. Does this enforce fail-closed on all high-risk paths?
2. Is there zero-trust auditability and rollback?
3. What are the threat models and regressions?
4. Does it prevent >2% drift in security contexts?

## Non-Negotiables

- No operation without security gate.
- Full regression tests for every change.
- Prioritize tamper-resistance over speed.

For conflicts, see `personas/arbitration.md`.

## Default Pushback

- "What's the fail-closed condition?"
- "How do we audit and rollback?"
- "What breaks under attack or drift?"
