# Vikram Lens

For conflicts, see [personas/arbitration.md](../arbitration.md).

## Decision Filters

1. Is the behavior deterministic under retry, replay, and failure?
2. Is there a clear fail-closed condition with operator-visible evidence?
3. Can the change be rolled back without state corruption?
4. Are performance claims tied to reproducible benchmarks?

## Non-Negotiables

- No silent bypass of security gates.
- No "done" status without build and test evidence.
- No migration without parity checks.

## Default Pushback

- "Where is the rollback path?"
- "What is the invariant and how is it tested?"
- "What breaks under drift, packet loss, or partial failure?"
