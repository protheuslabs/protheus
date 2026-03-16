# INTEGRATION-001 Cross-Component Integration Architecture

## Scope
This document defines the production integration contract between business, nexus, security, and enterprise hardening planes under Rust-core authority.

## Authority Boundaries
- `core/layer0/ops/src/business_plane.rs` is authoritative for business taxonomy/persona/continuity flows.
- `core/layer0/ops/src/nexus_plane.rs` is authoritative for cross-domain bridging, receipt schema, and compliance ledger.
- `core/layer0/ops/src/security_plane.rs` is authoritative for injection scanning, auto-remediation, blast-radius controls, and secrets federation.
- `core/layer0/ops/src/enterprise_hardening.rs` is authoritative for enterprise profile and cross-plane zero-trust guard enforcement.
- Client and adapter surfaces remain thin wrappers and do not own policy authority.

## Cross-Component Data Flow
1. Business intent enters `business_plane` and emits deterministic business receipts.
2. Domain handoff enters `nexus_plane` bridge/receipt contracts and emits domain-aware receipts.
3. Security controls execute scan/sentinel/remediation on the same run context and emit deterministic security receipts.
4. Enterprise hardening validates cross-plane JWT/CMEK/private-link posture before external-ops bridge execution.

## Deterministic Evidence Paths
- `core/local/state/ops/business_plane/latest.json`
- `core/local/state/ops/nexus_plane/latest.json`
- `core/local/state/ops/security_plane/latest.json`
- `core/local/state/ops/enterprise_hardening/latest.json`

## Verification Commands
- `cargo test --manifest-path core/layer0/ops/Cargo.toml --test v7_business_domain_integration -- --test-threads=1`
- `cargo test --manifest-path core/layer0/ops/Cargo.toml --test v7_nexus_domain_integration -- --test-threads=1`
- `cargo test --manifest-path core/layer0/ops/Cargo.toml --test v6_security_hardening_integration -- --test-threads=1`
- `cargo test --manifest-path core/layer0/ops/Cargo.toml --test e2e_cross_plane_contract_flow -- --test-threads=1`
