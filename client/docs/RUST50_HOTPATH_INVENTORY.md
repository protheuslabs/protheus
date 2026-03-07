# Rust50 Hotpath Inventory

Use the inventory tool to rank migration order by measured TypeScript line concentration.

## Commands

```bash
node client/systems/ops/rust_hotpath_inventory.js run
node client/systems/ops/rust_hotpath_inventory.js status
```

## Outputs

- Latest snapshot: `state/ops/rust_hotpath_inventory/latest.json`
- History ledger: `state/ops/rust_hotpath_inventory/history.jsonl`

Each run emits:

- `tracked_ts_lines` / `tracked_rs_lines` / `rust_percent`
- top directories by line volume
- top files by line volume
- milestone math (`additional_rs_lines_needed`) for target percentages

This keeps Rust migration sequencing anchored to measured impact, not ad-hoc prioritization.

## RUST60 Ranked Queue

Generated execution artifacts:

- Full ranked TS hotpaths (all files): `client/docs/generated/RUST60_TS_HOTPATHS_RANKED_FULL.csv`
- Full ranked TS hotpaths (markdown): `client/docs/generated/RUST60_TS_HOTPATHS_RANKED_FULL.md`
- 60% execution queue (rank 1-261): `client/docs/generated/RUST60_EXECUTION_QUEUE_261.json`
- 60% execution queue (markdown): `client/docs/generated/RUST60_EXECUTION_QUEUE_261.md`

Queue policy:

- Process lanes strictly in rank order.
- Commit and push each lane independently.
- Keep lane diffs isolated to minimize rollback scope.
