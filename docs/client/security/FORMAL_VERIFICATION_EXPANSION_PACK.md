# Formal Verification Expansion Pack (`V6-SEC-005`)

Updated: 2026-03-10

## Objective

Provide one externally auditable, reproducible evidence pack showing machine-checkable verification coverage for:

- Constitution invariants
- Receipt-chain integrity
- Conduit command-surface formal validation

## Reproducible Command

```bash
node tests/tooling/scripts/ci/formal_verification_expansion_report.mjs
```

## Evidence Artifacts

- `core/local/artifacts/formal_verification_expansion_latest.json`
- `core/local/artifacts/formal_verification_expansion_*.json`
- `docs/client/reports/runtime_snapshots/ops/proof_pack/formal_proof_runtime_latest.json`

## Coverage Mapping

1. Constitution invariants
- `npm run -s formal:invariants:run`
- `npm run -s test:critical:path:formal`

2. Receipt-chain integrity + proof-pack thresholds
- `npm run -s ops:formal-proof:run`
- `npm run -s ops:proof-pack:gate`

3. Conduit command-surface formal suite
- `npm run -s ops:formal-suite:run`

## Gate Rule

`V6-SEC-005` is considered satisfied only when the report shows:

- `ok: true`
- `coverage.constitution_invariants: true`
- `coverage.receipt_chain_validation: true`
- `coverage.conduit_command_surface_validation: true`

## Notes

This pack uses the existing formal runtime lanes and proof-pack gate surfaces already wired into CI, and consolidates them into a single auditable artifact for security credibility tracking.
