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

## Snowball Execution Contract (One Page)

Reference method: [Snowball Method](https://github.com/protheuslabs/Snowball-Method)

### Purpose

Run high-velocity change waves without losing correctness, architecture integrity, or auditability.

### Hard Architecture Constraints

1. Rust core is authoritative for truth, policy, execution, receipts, and security decisions.
2. Client is thin by design and exists only for:
   - building apps
   - connecting existing apps through adapters
   - exposing intentionally public/non-proprietary developer surfaces
   - exposing intended user-facing surfaces
   - providing interaction mechanisms with the system
3. All core-client information flow is conduit-only and schema-governed.
4. Schema transfer must remain bounded by the scrambler boundary between client and core.
5. Wrapper/bridge code is transitional; migrate durable logic into Rust core and retire extra wrappers.

### Snowball Cycle

1. `Intake (Snow)`: collect all viable improvements in backlog/ROI ledgers.
2. `Drop`: inject a bounded but broad change wave across priority items.
3. `Melt`: aggressively refine for clarity, cohesion, and fail-closed behavior.
4. `Validate`: run full regression and governance gates.
5. `Freeze`: merge only when the system "sings" (clean + verifiable + maintainable).
6. `Archive/Learn`: capture new invariants, receipts, and migration lessons.

### What "Sings" Means In This Repo

1. Required tests/gates are green (`cargo test --workspace --all-targets`, `npm run -s test:ci:full`, `./verify.sh`).
2. Conduit-only and boundary policies pass.
3. Module cohesion policy passes (no new structural violations).
4. DoD evidence is concrete (code/tests/artifacts), not status text.
5. Rust authority increased or remained authoritative for touched critical paths.

### Execution Rules

1. Split by boundary, not arbitrary size; keep core modules cohesive and client adapters thin.
2. Prefer primitive extraction in Rust over client-side orchestration growth.
3. Preserve behavior unless an explicit breaking change is requested.
4. Add/maintain parity and regression checks whenever logic migrates coreward.
5. Treat security/governance paths as fail-closed by default.

### Blocked Anti-Patterns

1. Direct client-to-core bypass outside conduit.
2. Permanent business/policy logic in wrappers or bridges.
3. Marking items `done` without passing validation and evidence.
4. Silent weakening of constitution, safety, or boundary controls.

### Required Outputs Per Snowball

1. Change evidence (diff + file-level proof).
2. Validation evidence (test/gate output).
3. Updated ledger status with truthful `done`/`existing-coverage-validated` usage.
4. SRS update only when net-new features are added (not for pure hardening/refactor).

## Community Standards

- [Code of Conduct](.github/CODE_OF_CONDUCT.md)

For full-repository enforcement (same scope as CI), run `npm run ops:format:check`.

## Required Reading

- [Onboarding Playbook](docs/client/ONBOARDING_PLAYBOOK.md)
- [Enterprise Onboarding Pack](docs/client/ENTERPRISE_ONBOARDING_PACK.md)
- [Developer Lane Quickstart](docs/client/DEVELOPER_LANE_QUICKSTART.md)
- [History Cleanliness Program](docs/client/HISTORY_CLEANLINESS.md)
- [Release Discipline Policy](docs/client/RELEASE_DISCIPLINE_POLICY.md)
- [Documentation Program Governance](docs/client/DOCUMENTATION_PROGRAM_GOVERNANCE.md)
- [Claim-Evidence Policy](docs/client/CLAIM_EVIDENCE_POLICY.md)
- [Module Cohesion and Split Policy](docs/client/MODULE_COHESION_POLICY.md)
- [Empty Fort Integrity Checklist](docs/client/EMPTY_FORT_INTEGRITY_CHECKLIST.md)
- [Org Code Format Standard](docs/client/ORG_CODE_FORMAT_STANDARD.md)
- [Perception Audit Program](docs/client/PERCEPTION_AUDIT_PROGRAM.md)
- [Code Enforcer Engine](client/runtime/systems/ops/org_code_format_guard.ts)
- [Public Collaboration Triage Contract](docs/client/PUBLIC_COLLABORATION_TRIAGE.md)
- [Public Collaboration Surface](docs/client/PUBLIC_COLLABORATION_SURFACE.md)
- [Changelog](CHANGELOG.md)

## Public Collaboration Entry Points

- [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md)
- [Security Report Template](.github/ISSUE_TEMPLATE/security_report.md)
- [Good First Issues Pack](docs/client/community/GOOD_FIRST_ISSUES.md)

## Good First Issues

If you are new to the repo, start with the curated starter pack:

- [Good First Issues (10 scoped tasks)](docs/client/community/GOOD_FIRST_ISSUES.md)

Maintainers can seed GitHub issues from this pack with labels:

```bash
node client/runtime/systems/ops/good_first_issue_seed.ts --apply=1
```

Dry-run (no GitHub writes):

```bash
node client/runtime/systems/ops/good_first_issue_seed.ts --apply=0
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
