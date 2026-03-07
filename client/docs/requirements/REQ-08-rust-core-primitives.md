# REQ-08: Rust-Core Primitive Source-Of-Truth Program

Version: 1.0  
Date: 2026-03-06  
Owner: Protheus Core Kernel

## Objective

Enforce Rust as the only source of truth for the seven core primitives required for portable, auditable, and substrate-swappable Protheus runtime.

Core primitives:
- `task`
- `resource`
- `isolation`
- `ipc`
- `storage`
- `observability`
- `update`

## Source-Of-Truth Rule

- All primitive logic, invariants, policy, and deterministic receipts live in Rust crates.
- TypeScript is limited to thin client/wrapper surfaces and must route through conduit only.
- Legacy TypeScript primitive logic must be migrated or deprecated.

## Requirements

1. `REQ-08-001` Primitive crate ownership
- Acceptance: `core/layer1/task`, `core/layer1/resource`, `core/layer1/isolation`, `core/layer1/ipc`, `core/layer1/storage`, `core/layer1/observability`, `core/layer1/update` exist and compile in workspace.

2. `REQ-08-002` TS primitive wrapper contract
- Acceptance: designated primitive TS files are thin conduit wrappers only and include no legacy bridge references.

3. `REQ-08-003` Primitive logic parity migration
- Acceptance: each primitive has Rust-native deterministic behavior with tests proving fail-closed or bounded execution semantics.

4. `REQ-08-004` Contract enforcement gate
- Acceptance: `contract_check` validates primitive wrapper contract and fails closed on drift.

5. `REQ-08-005` Migration audit artifact
- Acceptance: periodic report lists remaining primitive-like TS files that are not conduit wrappers.

## Current Batch Scope

Implemented in this batch:
- Added primitive TS wrapper contract enforcement in Rust `contract_check`.
- Migrated an additional primitive-adjacent wrapper batch to direct conduit.
- Migrated remaining legacy `client/systems/primitives/*` wrapper lanes to direct conduit (`canonical_event_log`, `cognitive_control_primitive`, `policy_vm`, `primitive_catalog`, `primitive_registry`, `replay_verify`).
- Upgraded `ipc`, `storage`, and `update` crates from scaffolds to deterministic primitive baselines.

Deferred to next batches:
- Complete migration of remaining primitive-like TS files.
- Deep parity mappings from legacy TS runtime behavior into crate-level Rust APIs where still outstanding.
