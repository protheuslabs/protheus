# ADR Enforcement Policy

This policy defines fail-closed ADR requirements for architecture-impacting changes.

## Status Lifecycle

- `proposed`: draft ADR exists and is linked from the change set.
- `accepted`: decision is approved and active.
- `superseded`: decision replaced by a newer accepted ADR.

## Enforcement Contract

- Architecture-impacting changes must link an ADR entry from `docs/adr/INDEX.md`.
- Enforcement is fail-closed when ADR linkage is missing.
- Enforcement is fail-closed when ADR status is invalid or stale per policy.
- Required ADR sections:
  - Context
  - Decision
  - Consequences
  - Rollback

## CI Gate

Primary enforcement is validated by the enterprise hardening gate:

```bash
cargo run --quiet --manifest-path crates/ops/Cargo.toml --bin protheus-ops -- enterprise-hardening run --strict=1
```

If this gate fails, release/promotion is blocked until ADR policy compliance is restored.
