# Heroic Echo Value Anchor Renewal

`systems/echo/value_anchor_renewal.ts` recalibrates long-horizon value anchors from constitution + first-principles evidence and emits reversible, auditable updates.

## Guarantees

- Periodic renewal proposals with drift scoring
- High-drift and high-impact shifts flagged for explicit review
- Apply path requires approval metadata when review is required
- Reversible history snapshots for rollback-safe value updates
- Immutable proposal/apply receipts

## Policy

Policy file: `config/value_anchor_renewal_policy.json`

State outputs:

- `state/autonomy/echo/value_anchor/current.json`
- `state/autonomy/echo/value_anchor/proposals.jsonl`
- `state/autonomy/echo/value_anchor/history.jsonl`
- `state/autonomy/echo/value_anchor/receipts.jsonl`

## Commands

```bash
# Propose renewal (no apply)
node systems/echo/value_anchor_renewal.js run --apply=0

# Apply renewal with explicit review metadata when required
node systems/echo/value_anchor_renewal.js run --apply=1 --approved-by=operator --approval-note="reviewed"

# Inspect status
node systems/echo/value_anchor_renewal.js status
```
