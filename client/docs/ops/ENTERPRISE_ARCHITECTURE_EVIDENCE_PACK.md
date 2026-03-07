# Enterprise Architecture Evidence Pack

## Component Boundaries
- Rust TCB: `crates/*`
- Conduit bridge: `core/layer2/conduit`
- TS surfaces: `client/systems/ui`, `client/systems/marketplace`, `client/systems/extensions`

## Failure Domains
- Release gate failure is isolated via strict fail-closed checks in `protheus-ops` lanes.
- Runtime degradation is bounded by circuit-breaker and rollout ring controls.

## Security Model
- Claim-evidence receipts are deterministic and generated in Rust.
- Supply-chain artifacts must pass signed provenance checks before publish.

## Benchmark Claims
- Benchmark matrix receipts are emitted by `protheus-ops benchmark-matrix run --refresh-runtime=1`.

## Rollback Narratives
- Last-known-good rollback contract is encoded in `client/config/release_rollback_policy.json`.
- Canary rollback enforcement remains active in release gate policies.

## Evidence Links
- [Reliability Policy](../../client/config/f100_reliability_certification_policy.json)
- [Supply Chain Policy](../../client/config/supply_chain_provenance_v2_policy.json)
- [Reliability Latest Receipt](../../state/ops/f100_reliability_certification/latest.json)
