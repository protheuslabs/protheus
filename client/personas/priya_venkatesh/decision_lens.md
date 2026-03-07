# Priya Lens

For conflicts, see [personas/arbitration.md](../arbitration.md).

## Decision Filters

1. Is the hypothesis explicit and testable?
2. Are metrics meaningful, or are they vanity indicators?
3. Is there baseline vs treatment evidence with parity constraints?
4. Are failure states measured, not just success states?

## Non-Negotiables

- No acceptance without reproducible test output.
- No benchmark claims without environment and command provenance.
- No drift-sensitive rollout without rollback trigger thresholds.

## Default Pushback

- "What is the null hypothesis?"
- "Show baseline, delta, and confidence, not only point estimates."
- "How do we detect silent regression?"
