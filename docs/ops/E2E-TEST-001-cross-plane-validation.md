# E2E-TEST-001 Cross-Plane End-to-End Validation

## Objective
Provide a dedicated end-to-end suite proving business -> nexus -> security -> enterprise flow under conduit-governed Rust-core authority with deterministic receipts.

## Test Suite
- `core/layer0/ops/tests/e2e_cross_plane_contract_flow.rs`

The suite executes:
1. Business taxonomy operation (`V7-BUSINESS-001.1`)
2. Nexus bridge operation (`V7-NEXUS-001.2`)
3. Security injection scan and blast-radius sentinel (`V6-SEC-010`, `V6-SEC-012`)
4. Enterprise zero-trust profile + guarded ops bridge (`V7-F100-002.3`, `V7-F100-002.4`)

## Acceptance Signals
- Each plane writes `latest.json` receipt state under `core/local/state/ops/<plane>/`.
- Claim evidence IDs are present for each operation.
- `enterprise_hardening` payload includes `cross_plane_jwt_guard.guard_ok=true` during strict cross-plane execution.

## Runnable Command
`cargo test --manifest-path core/layer0/ops/Cargo.toml --test e2e_cross_plane_contract_flow -- --test-threads=1`
