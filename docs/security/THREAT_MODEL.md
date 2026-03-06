# Threat Model

## Scope

- Rust kernel control plane
- Conduit bridge ingress/egress
- Policy/constitution enforcement paths
- Release promotion and rollback surfaces

## Primary Threat Classes

- Unauthorized command ingress
- Policy bypass and state mutation outside Rust authority
- Supply-chain artifact tampering
- Secrets exfiltration and stale key reuse
- Silent operational failures that degrade safety gates

## Required Review Updates

- Threat model must be reviewed every security cycle (90 days).
- New architecture-impacting changes require threat deltas.
- Critical findings must map to remediation owner and SLA.
