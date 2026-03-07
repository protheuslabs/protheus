# Rust50 Migration Implementation

This document defines the executable contract for `V6-RUST50-001..007`.

## Runtime Surface

- Program: `client/systems/ops/rust50_migration_program.ts`
- Policy: `client/config/rust50_migration_program_policy.json`
- Mobile adapter: `client/systems/hybrid/mobile/protheus_mobile_adapter.ts`
- Rust core: `client/systems/hybrid/rust/src/*.rs`

## Commands

```bash
node client/systems/ops/rust50_migration_program.js list
node client/systems/ops/rust50_migration_program.js run-all --apply=1 --strict=0
node client/systems/ops/rust50_migration_program.js run --id=V6-RUST50-007 --apply=1 --strict=1
node client/systems/ops/rust50_migration_program.js status
```

## Receipts and State

- Latest: `state/ops/rust50_migration_program/latest.json`
- Lane receipts: `state/ops/rust50_migration_program/receipts.jsonl`
- Lane states: `state/ops/rust50_migration_program/items/V6-RUST50-00X.json`
- Artifacts: `state/ops/rust50_migration_program/artifacts/*.json`
- Governance gate: `state/ops/rust50_migration_program/rust50_gate_state.json`

## Lane Intent

- `V6-RUST50-001`: memory hotpath benchmarks and WASM binding checks.
- `V6-RUST50-002`: deterministic execution replay metrics and drift checks.
- `V6-RUST50-003`: CRDT convergence + suspend/resume + merge latency checks.
- `V6-RUST50-004`: vault fail-closed and seal-latency/heap checks.
- `V6-RUST50-005`: chaos + telemetry merged overhead checks.
- `V6-RUST50-006`: mobile adapter build matrix and background-service manifest.
- `V6-RUST50-007`: enforced critical-module weighted Rust share gate with explicit `PAUSED` state when below threshold.

## Fail-Closed Behavior

`V6-RUST50-007` enforces:

- weighted critical Rust share threshold (`>=50%` target by policy),
- required evidence refs for each lane,
- prerequisite lane completion (`001..006`).

In strict mode (`--strict=1`), gate failure returns non-zero and writes:

- `status: "PAUSED"`
- blocker reason set
- module-level weighted share breakdown

This prevents false completion claims while preserving full auditability.
