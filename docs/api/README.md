# API Reference

This directory is the canonical API reference surface for InfRing/OpenClaw runtime operators and integrators.

## Scope

- CLI command surfaces (`protheus-ops`, `protheusd`)
- Runtime bridge contracts (client runtime lane wrappers)
- State/receipt artifact interfaces
- Compatibility and versioning notes

## Primary Interfaces

1. `protheus-ops` command families
2. `protheusd` daemon command/router surfaces
3. Thin runtime wrappers under `client/runtime/systems/**`
4. Adapter bridges under `adapters/**`

## Source-of-Truth Pointers

- Ops CLI usage: `core/layer0/ops/src/ops_main_usage.rs`
- Route dispatch: `core/layer0/ops/src/protheusctl_routes.rs`
- Runtime wrappers: `client/runtime/systems/`
- Rust authority contracts: `core/layer0/ops/src/contract_check.rs`

## Response Shape Conventions

Most command/status surfaces return JSON with:

- `ok` (`true`/`false`)
- `type` (lane/type discriminator)
- `claim_evidence` (when contract-backed)
- `receipt_hash` (deterministic receipt hash)
- `strict` (if strict mode evaluated)

## Error Model

Fail-closed lanes typically emit:

- `ok: false`
- `type: <lane>_error` or lane-specific denial type
- `errors: [...]` and/or `code`

## Versioning and Compatibility

- Compatibility-sensitive lanes should pin explicit versions in payloads/contracts.
- Backward-compatibility controls must fail closed in strict mode.

See also: [OpenAPI Stub](./openapi.stub.yaml)
