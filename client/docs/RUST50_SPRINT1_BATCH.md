# Rust50 Sprint 1 Batch Runner

`client/systems/ops/rust50_sprint1_batch.ts` provides the conformance runner for `V6-RUST50-CONF-003`.

## Contract
- Requires enforcer preamble acknowledgment before strict pass.
- Builds `wasm32-unknown-unknown --release` for:
  - `core/layer2/execution`
  - `core/layer0/pinnacle`
  - `core/layer0/vault`
  - `core/layer0/red_legion`
- Runs regression parity tests across the four crates.
- Runs sovereignty/security checks.
- Verifies mobile battery guard (`<= 5% / 24h`) from mobile adapter status.
- Captures tracked `.rs` and `.ts` line counts.
- Supports optional Rust share gate via policy (`rust_share_min_pct` over tracked `.rs` + `.ts`).

## Commands
```bash
node client/systems/ops/rust50_sprint1_batch.js run \
  --enforcer-active=1 \
  --preamble-text="ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST." \
  --strict=1 --apply=1

node client/systems/ops/rust50_sprint1_batch.js status
```

## Outputs
- Latest receipt:
  - `state/ops/rust50_sprint1_batch/latest.json`
- History:
  - `state/ops/rust50_sprint1_batch/history.jsonl`
- Per-run artifact snapshots:
  - `state/ops/rust50_sprint1_batch/artifacts/*.json`
