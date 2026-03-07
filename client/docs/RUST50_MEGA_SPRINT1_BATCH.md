# Rust50 Mega Sprint 1 Batch Runner

`client/systems/ops/rust50_sprint1_batch.ts` can execute `V6-RUST50-CONF-004` by loading:

- `client/config/rust50_mega_sprint1_batch_policy.json`

## Contract
- Requires enforcer preamble acknowledgment.
- Builds `wasm32-unknown-unknown --release` for 8 crates:
  - `execution`, `pinnacle`, `vault`, `red_legion`
  - `observability`, `graph`, `swarm`, `mobile`
- Runs regression parity tests across all 8 crates.
- Runs sovereignty/security checks.
- Verifies mobile battery guard (`<= 5% / 24h`).
- Enforces tracked Rust share threshold (`>= 50%` across tracked `.rs` + `.ts` lines).

## Commands
```bash
node client/systems/ops/rust50_sprint1_batch.js run \
  --policy=client/config/rust50_mega_sprint1_batch_policy.json \
  --enforcer-active=1 \
  --preamble-text="ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST." \
  --strict=1 --apply=1

node client/systems/ops/rust50_sprint1_batch.js status \
  --policy=client/config/rust50_mega_sprint1_batch_policy.json
```

## Outputs
- Latest receipt:
  - `state/ops/rust50_mega_sprint1_batch/latest.json`
- History:
  - `state/ops/rust50_mega_sprint1_batch/history.jsonl`
- Per-run snapshots:
  - `state/ops/rust50_mega_sprint1_batch/artifacts/*.json`
