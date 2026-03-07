# Perception Audit Program

`V4-FORT-007`

## Objective

Run a monthly repo-surface audit to keep documentation, quality gates, and collaboration metadata aligned with enterprise-grade expectations.

## Cadence

- Monthly (max interval: 31 days)
- Trigger on release branch cut as a supplemental checkpoint

## Audit Scope

- README / docs hub / contributing surface coherence
- CI + pre-commit quality gates
- PR/issue/release template metadata quality
- Claim-evidence and integrity checklist visibility

## Commands

```bash
npm run ops:perception:audit
npm run ops:perception:verify
```

## Receipts

- Latest audit: `state/ops/polish_perception_program/audit_latest.json`
- Audit history: `state/ops/polish_perception_program/audit_history.jsonl`
- Verification latest: `state/ops/polish_perception_program/latest.json`

## Remediation Tracking

- Every audit finding must have a remediation ID and owner.
- Remediation completion is captured in the next audit receipt.
