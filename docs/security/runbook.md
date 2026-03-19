# Security Runbook

This runbook is the operational entrypoint for runtime security handling.

## Critical References

- Incident response: `docs/ops/RUNBOOK-001-incident-response.md`
- Security review checklist: `docs/client/security/SECURITY_REVIEW_CHECKLIST.md`
- Threat model: `docs/client/security/THREAT_MODEL.md`
- Security layer inventory: `docs/client/security/SECURITY_LAYER_INVENTORY.md`
- Independent audit publication: `docs/client/security/INDEPENDENT_AUDIT_PUBLICATION_2026Q1.md`
- Remediation tracker: `docs/client/security/INDEPENDENT_AUDIT_REMEDIATION_TRACKER.md`

## Immediate Incident Actions

1. Contain: disable affected lane/capability path and preserve state artifacts.
2. Verify: run strict security checks and confirm fail-closed posture.
3. Record: capture deterministic receipts and append event history.
4. Escalate: follow incident severity and operator communication policy.
5. Recover: apply remediations, re-run security gates, and document evidence.

## Standard Security Verification Commands

```bash
npm run -s test:security:truth-gate
npm run -s ops:srs:full:regression
cargo run -p protheus-ops-core --bin protheus-ops -- contract-check status --rust-contract-check-ids=rust_source_of_truth_contract
```

## Escalation and Ownership

- Runtime security authority: `core/layer1/security` and `core/layer0/ops/src/security_plane.rs`
- Thin wrappers only: `client/runtime/systems/security/**`
- Any strict-mode failure is a release blocker until resolved.

## Forensics and Evidence

- Preserve `latest.json` and `history.jsonl` artifacts for affected lanes.
- Store command outputs tied to `receipt_hash` values.
- Treat missing or broken receipt lineage as a security incident.
