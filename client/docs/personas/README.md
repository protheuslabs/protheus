# Personas Docs

## Bootstrap vs Dynamic Context Guard

`protheus lens` now separates context into two tiers before every invocation:

- Bootstrap context (always-on): profile highlights, core lens constraints, values constraints, and non-negotiables.
- Dynamic context (query-scoped): correspondence recall, feed signals, system-passed entries, and memory recall.

### Budget Policy

- Default budget cap: `2000` estimated tokens.
- Override with `--max-context-tokens=<n>`.
- Mode control:
  - `--context-budget-mode=trim` (default): trims dynamic context first.
  - `--context-budget-mode=reject`: fail-closed when over budget.

### Audit Trail

Over-budget events are logged to:

- `personas/organization/telemetry.jsonl` with `metric=context_budget_guard`
- `personas/<id>/correspondence.md` with `Re: context budget guard`

### Loop Hook Integration

Shadow Conclave invocations in RSI/inversion loops pass explicit budget flags:

- `--max-context-tokens=...`
- `--context-budget-mode=trim`
