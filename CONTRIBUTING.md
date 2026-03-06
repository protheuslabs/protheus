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

- [Onboarding Playbook](docs/ONBOARDING_PLAYBOOK.md)
- [Enterprise Onboarding Pack](docs/ENTERPRISE_ONBOARDING_PACK.md)
- [Developer Lane Quickstart](docs/DEVELOPER_LANE_QUICKSTART.md)
- [History Cleanliness Program](docs/HISTORY_CLEANLINESS.md)
- [Release Discipline Policy](docs/RELEASE_DISCIPLINE_POLICY.md)
- [Documentation Program Governance](docs/DOCUMENTATION_PROGRAM_GOVERNANCE.md)
- [Claim-Evidence Policy](docs/CLAIM_EVIDENCE_POLICY.md)
- [Empty Fort Integrity Checklist](docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md)
- [Org Code Format Standard](docs/ORG_CODE_FORMAT_STANDARD.md)
- [Perception Audit Program](docs/PERCEPTION_AUDIT_PROGRAM.md)
- [Code Enforcer Engine](systems/ops/org_code_format_guard.ts)
- [Public Collaboration Triage Contract](docs/PUBLIC_COLLABORATION_TRIAGE.md)
- [Public Collaboration Surface](docs/PUBLIC_COLLABORATION_SURFACE.md)
- [Changelog](CHANGELOG.md)

## Public Collaboration Entry Points

- [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md)
- [Security Report Template](.github/ISSUE_TEMPLATE/security_report.md)

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
