# Contributing

Thanks for contributing.

## Workflow

1. Create a feature branch from `main`.
2. Make focused changes with tests.
3. Run local checks before opening a PR:
   - `npm run ops:format:check:staged` (code enforcer on staged files)
   - `npm run lint`
   - `npm run test`
4. Open a pull request and wait for CI + review.

## Community Standards

- [Code of Conduct](.github/CODE_OF_CONDUCT.md)

For full-repository enforcement (same scope as CI), run `npm run ops:format:check`.

## Required Reading

- [Onboarding Playbook](client/docs/ONBOARDING_PLAYBOOK.md)
- [Enterprise Onboarding Pack](client/docs/ENTERPRISE_ONBOARDING_PACK.md)
- [Developer Lane Quickstart](client/docs/DEVELOPER_LANE_QUICKSTART.md)
- [History Cleanliness Program](client/docs/HISTORY_CLEANLINESS.md)
- [Release Discipline Policy](client/docs/RELEASE_DISCIPLINE_POLICY.md)
- [Documentation Program Governance](client/docs/DOCUMENTATION_PROGRAM_GOVERNANCE.md)
- [Claim-Evidence Policy](client/docs/CLAIM_EVIDENCE_POLICY.md)
- [Empty Fort Integrity Checklist](client/docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md)
- [Org Code Format Standard](client/docs/ORG_CODE_FORMAT_STANDARD.md)
- [Perception Audit Program](client/docs/PERCEPTION_AUDIT_PROGRAM.md)
- [Code Enforcer Engine](client/systems/ops/org_code_format_guard.ts)
- [Public Collaboration Triage Contract](client/docs/PUBLIC_COLLABORATION_TRIAGE.md)
- [Public Collaboration Surface](client/docs/PUBLIC_COLLABORATION_SURFACE.md)
- [Changelog](CHANGELOG.md)

## Public Collaboration Entry Points

- [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md)
- [Security Report Template](.github/ISSUE_TEMPLATE/security_report.md)
- [Good First Issues Pack](client/docs/community/GOOD_FIRST_ISSUES.md)

## Good First Issues

If you are new to the repo, start with the curated starter pack:

- [Good First Issues (10 scoped tasks)](client/docs/community/GOOD_FIRST_ISSUES.md)

Maintainers can seed GitHub issues from this pack with labels:

```bash
node client/systems/ops/good_first_issue_seed.js --apply=1
```

Dry-run (no GitHub writes):

```bash
node client/systems/ops/good_first_issue_seed.js --apply=0
```

## Commit Style

- Use clear, specific commit messages.
- Prefer conventional prefixes when practical (for example: `feat:`, `fix:`, `docs:`, `chore:`).

## Pull Request Checklist

- [ ] Scope is clear and minimal.
- [ ] Behavior changes are documented.
- [ ] Tests added or updated where relevant.
- [ ] Changelog updated when behavior/docs changed.
- [ ] Any measurable/public claim has linked evidence.
- [ ] No secrets or local machine paths were committed.

## Security

Do not open public issues for potential vulnerabilities. Use the private reporting guidance in [SECURITY.md](SECURITY.md).
