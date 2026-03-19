# Deployment Guide

This directory is the deployment documentation home for operators.

## Canonical Procedure

Primary deployment runbook:

- `docs/ops/RUNBOOK-002-deployment-procedures.md`

## Deployment Flow

1. Preflight checks and strict gates
2. Build and artifact verification
3. Staging validation
4. Production rollout
5. Post-deploy verification and receipts
6. Rollback procedure (if required)

## Required Verification Gates

```bash
npm run -s ops:churn:commit-gate
npm run -s test:security:truth-gate
npm run -s ops:srs:full:regression
cargo run -p protheus-ops-core --bin protheus-ops -- contract-check status --rust-contract-check-ids=rust_source_of_truth_contract
```

## Operational Notes

- Strict-mode gate failures block deployment.
- Release evidence must include deterministic receipt hashes.
- Rust-authority lane integrity is mandatory for deployment approval.
