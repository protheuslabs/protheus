# Repository Access Control (SEC-M01)

This repository uses a policy-driven access audit lane to keep source visibility and collaborator permissions constrained.

## Policy

- `config/repository_access_policy.json`
- Expected default posture:
  - `visibility_expected=private`
  - `least_privilege.default_role=read`
  - bounded admin count (`max_admins`)
  - quarterly review cadence (`review.interval_days >= 90`)

## Commands

```bash
node systems/security/repository_access_auditor.js status --strict=1
node systems/security/repository_access_auditor.js status --strict=1 --remote=1
node systems/security/repository_access_auditor.js review-plan --apply=1
```

Package scripts:

```bash
npm run security:repo-access:status
npm run security:repo-access:review-plan
```

## Notes

- Remote checks use GitHub CLI (`gh`) only when `--remote=1` is provided.
- If remote API access is unavailable, the auditor remains deterministic in local-only mode and still enforces policy contracts.
- Quarterly review artifacts are written to:
  - `state/security/repo_access_review/latest.json`
  - `state/security/repo_access_review/history.jsonl`
