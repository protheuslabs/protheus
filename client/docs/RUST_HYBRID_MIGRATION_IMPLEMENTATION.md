# Rust Hybrid Migration Implementation

This document defines the executable implementation for `V5-RUST-HYB-001..010`.
It is part of the Protheus Labs runtime migration program.

## Runtime Surface

- Rust core crate: `client/systems/hybrid/rust`
- Ops executor: `client/systems/ops/rust_hybrid_migration_program.ts`
- Policy: `client/config/rust_hybrid_migration_program_policy.json`
- Receipts: `state/ops/rust_hybrid_migration_program/`

## Lane Coverage

1. `V5-RUST-HYB-001`: language-share scan and target-band evaluation (`hybrid-plan`).
2. `V5-RUST-HYB-002`: memory scheduler + compression + sqlite checksum hotpath (`memory-hotpath`).
3. `V5-RUST-HYB-003`: deterministic execution replay receipt digest (`execution-replay`).
4. `V5-RUST-HYB-004`: security/vault fail-closed attestation + key rotation (`security-vault`).
5. `V5-RUST-HYB-005`: CRDT merge engine convergence (`crdt-merge`).
6. `V5-RUST-HYB-006`: economics/crypto integrity path with checked arithmetic (`econ-crypto`).
7. `V5-RUST-HYB-007`: Red Legion deterministic chaos acceleration benchmark (`red-chaos`).
8. `V5-RUST-HYB-008`: telemetry emitter aggregate parity sample (`telemetry-emit`).
9. `V5-RUST-HYB-009`: WASM adapter manifest validation (`wasm-bridge`).
10. `V5-RUST-HYB-010`: hybrid guardrail envelope and migration action gate (`hybrid-envelope`).

## Commands

```bash
node client/systems/ops/rust_hybrid_migration_program.js list
node client/systems/ops/rust_hybrid_migration_program.js run --id=V5-RUST-HYB-001 --apply=1 --strict=1
node client/systems/ops/rust_hybrid_migration_program.js run-all --apply=1 --strict=1
node client/systems/ops/rust_hybrid_migration_program.js status
```

## Guardrails

- Fail-closed lane receipts on missing client/docs/policy contracts.
- Strict mode fails if any lane check is not satisfied.
- All lane outputs are machine-readable JSON receipts.
- Rust core remains focused on hotpath and safety-critical logic; TS keeps operator/control surfaces.
