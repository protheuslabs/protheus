# Claim-Evidence Policy

## Purpose

Prevent credibility and legal risk by requiring proof for all public claims.

## Rule

If a statement is measurable, comparative, security-sensitive, or customer-impacting, it must have linked evidence in-repo.

## Claim Classes

### Performance Claims

Examples:
- throughput
- latency
- cost efficiency

Required evidence:
- benchmark method
- raw or summarized results
- environment context
- timestamp

### Security Claims

Examples:
- hardened
- formally verified
- compliant

Required evidence:
- policy or control document
- verification run output or audit artifact
- scope and limitations

### Reliability Claims

Examples:
- high availability
- resilient failover
- deterministic recovery

Required evidence:
- incident drill records or test artifacts
- reproduction steps
- observed outcomes

## Prohibited Patterns

- "Industry-leading" without benchmark source
- "Proven at scale" without load or production evidence
- "Fully autonomous" when approval gates remain active
- Unqualified percentages with no measurement method

## Review Gate

Before merging public-facing client/docs/release text:
- List each claim in the PR summary.
- Attach evidence links for each claim.
- Mark unproven statements as roadmap intent, not current capability.

## Evidence Locations

- `CHANGELOG.md`
- `client/docs/` policy and benchmark pages
- `state/` receipts and artifacts (when versioned and shareable)

