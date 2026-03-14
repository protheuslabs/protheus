# Security Policy

## License Context

This repository is distributed under the Protheus Non-Commercial License v1.0 (`LICENSE`). Archived legacy legal artifacts are kept in `docs/client/legal/archive/` for historical audit context.

## Supported Versions

Security maintenance follows the default branch (`main`) and active release artifacts generated from it.

## Reporting a Vulnerability

- Do not file public issues for potential vulnerabilities.
- Report privately to the repository owner/maintainer.
- Include:
  - Impact summary
  - Reproduction steps
  - Affected files/modules
  - Suggested mitigation (if available)

Preferred report envelope:
- Subject: `[SECURITY] <short-title>`
- Include severity estimate (`critical`, `high`, `medium`, `low`)
- Include exploit preconditions and blast radius

## Coordinated Disclosure Process

1. Intake and acknowledgement within 3 business days.
2. Triage classification and reproduction validation within 7 business days.
3. Mitigation plan agreed with reporter before public disclosure.
4. Fix ships with deterministic receipt trail and release notes.
5. Coordinated public advisory published after remediation window.

If there is active exploitation or high-confidence critical impact, emergency response and containment begin immediately, and temporary mitigation guidance is issued before full patch release.

## Response Expectations

- Initial acknowledgement: target within 3 business days
- Triage update: target within 7 business days
- Fix timeline: depends on severity and blast radius

## CVE Readiness

- Security advisories are tracked with versioned release notes and SBOM artifacts.
- Severity, impact, and fixed-version details are required for each confirmed vulnerability.
- Public advisory format is aligned so CVE filing can be completed without reworking evidence.

## Bug Bounty

- Starter bounty program is active (minimum target pool: $500 total per cycle).
- Scope and payout guidance: [docs/client/BUG_BOUNTY.md](docs/client/BUG_BOUNTY.md).

## Hardening References

- [docs/client/SECURITY.md](docs/client/SECURITY.md)
- [docs/client/SECURITY_POSTURE.md](docs/client/SECURITY_POSTURE.md)
- [docs/client/BUG_BOUNTY.md](docs/client/BUG_BOUNTY.md)
- [docs/client/BRANCH_PROTECTION_POLICY.md](docs/client/BRANCH_PROTECTION_POLICY.md)
- [docs/client/COMPLIANCE_POSTURE.md](docs/client/COMPLIANCE_POSTURE.md)
- [docs/client/FUZZ_CHAOS_TRIAGE.md](docs/client/FUZZ_CHAOS_TRIAGE.md)
- [docs/client/security/INDEPENDENT_AUDIT_PUBLICATION_2026Q1.md](docs/client/security/INDEPENDENT_AUDIT_PUBLICATION_2026Q1.md)
- [docs/client/security/INDEPENDENT_AUDIT_REMEDIATION_TRACKER.md](docs/client/security/INDEPENDENT_AUDIT_REMEDIATION_TRACKER.md)
- [docs/client/security/FORMAL_VERIFICATION_EXPANSION_PACK.md](docs/client/security/FORMAL_VERIFICATION_EXPANSION_PACK.md)
