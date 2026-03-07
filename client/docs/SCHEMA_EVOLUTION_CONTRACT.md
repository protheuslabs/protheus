# Schema Evolution Contract

`client/systems/ops/schema_evolution_contract.ts` enforces versioned schema compatibility for primitive/profile/event lanes and emits migration receipts.

## Guarantees

- N-2 compatibility checks (configurable per lane)
- Deterministic lane scans over JSON and JSONL stores
- Optional auto-migration for minor-version drift (same major)
- Immutable migration receipts and run summaries
- Strict fail-closed mode for CI/release gates

## Policy

Policy file: `client/config/schema_evolution_policy.json`

Each lane defines:

- `format`: `json` or `jsonl`
- `version_field`
- `target_version` or `target_version_ref`
- `target_paths`
- `n_minus_minor`
- `allow_missing_targets`

## Commands

```bash
# Verify only (strict fail closed)
node client/systems/ops/schema_evolution_contract.js run --strict=1 --apply=0

# Apply allowed migrations (auto minor drift)
node client/systems/ops/schema_evolution_contract.js run --strict=1 --apply=1

# Inspect latest run
node client/systems/ops/schema_evolution_contract.js status
```
