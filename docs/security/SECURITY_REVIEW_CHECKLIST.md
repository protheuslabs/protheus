# Security Review Checklist

## Review Inputs

- Current threat model (`docs/security/THREAT_MODEL.md`)
- Latest hardening receipt (`protheus-ops enterprise-hardening run --strict=1`)
- Conduit policy and source-of-truth contracts

## Required Checks

- Constitution and policy gates remain fail-closed.
- Rust is still authoritative for kernel decisions.
- No active cron/scheduler silent-delivery configuration.
- Release gates block unresolved critical security findings.
- Secrets rotation and exception records are current.

## Review Outputs

- Signed review summary with reviewer IDs.
- Findings with severity and owner.
- Remediation deadlines aligned to policy SLA.
- Exception approvals with explicit expiry.
