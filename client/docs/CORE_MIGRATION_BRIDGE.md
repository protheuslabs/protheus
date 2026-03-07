# Core Migration Bridge

`V4-MIGR-001` introduces a deterministic migration bridge with signed receipts, rollback checkpoints, and a first-class operator command:

- `protheusctl migrate --to=<org/repo|url> [--workspace=<path>]`

## Scope

The lane transfers the required operational surfaces from the current workspace to a target workspace:

- `client/config/`
- `client/habits/` (if present)
- `client/secrets/vault/` (if present)
- `client/memory/`
- scientific receipts under `state/science/` and related receipt lanes

Each run emits signed receipts to:

- `state/migration/core_bridge/latest.json`
- `state/migration/core_bridge/receipts.jsonl`

## Runbook

```bash
# Plan only (default)
protheusctl migrate --to=acme/protheus-core --workspace=../protheus-core

# Apply transfer + remote update
protheusctl migrate --to=acme/protheus-core --workspace=../protheus-core --apply=1

# Inspect latest state
protheusctl migrate status

# Roll back a migration (requires approval note)
protheusctl migrate rollback --migration-id=<id> --apply=1 --approval-note="operator_approved"
```

## Safety Model

- Required-surface gate: migration fails strict checks if required surfaces are missing.
- Checkpointing: each run stores `checkpoint.json` with touched files and target preexisting backups.
- Rollback-safe: rollback restores overwritten files from checkpoint backups and removes newly introduced files.
- Signed receipts: each run/rollback receipt includes deterministic signature metadata (`key_id`, `signature`) for attestation trails.

## Rust Bridge Artifact

`client/systems/migration/bridge.rs` defines deterministic target normalization and receipt-signing primitives that mirror the operator lane semantics for future native cutover.
