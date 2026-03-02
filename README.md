# Protheus

Protheus is an evidence-first local control plane for autonomous operations, workflow execution, and policy-governed system evolution.

This repository is organized to run like an internal platform team: typed runtime lanes, deterministic receipts, strict governance surfaces, and operational guardrails that are reviewable in-source.

## What This Repo Includes

- Control plane CLI surface (`protheus`, `protheusd`, `protheusctl`, `protheus-top`)
- Policy-backed runtime lanes across `systems/` (ops, security, memory, routing, workflow, observability, and more)
- Deterministic state and receipt contracts for auditable execution
- Backlog governance pipeline with generated active/archive/reviewed views
- Docs and runbooks that map directly to executable scripts and checks

## Quick Start

```bash
npm ci
npm run build
npm run start
```

Then verify the runtime surface:

```bash
protheus status
protheus-top
```

## Operator Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start local daemon control surface (dev profile) |
| `npm run start` | Start daemon control surface |
| `npm run build` | Build systems + smoke verification |
| `npm run test` | Stable test suite |
| `npm run test:ci` | Deterministic CI-oriented test suite |
| `npm run lint` | Type/system lint gate |
| `npm run typecheck:systems` | Typecheck `systems/` lanes |
| `npm run guard:merge` | Merge guard for core quality/security gates |
| `npm run ops:backlog:registry:sync` | Regenerate backlog registry/views from source backlog |
| `npm run ops:backlog:registry:check` | Validate generated backlog artifacts are in sync |

## Control Surface CLI

| CLI | Purpose |
|---|---|
| `protheus` | Primary control-plane interface |
| `protheusd` | Daemon lifecycle wrapper |
| `protheusctl` | Job and control-plane operations |
| `protheus-top` | Live operator observability surface |

## Architecture Map

| Path | Responsibility |
|---|---|
| `systems/` | Executable runtime lanes and control-plane modules |
| `lib/` | Shared runtime helpers used by lanes |
| `config/` | Policy, registries, and lane configuration |
| `docs/` | Architecture, governance, runbooks, and contracts |
| `memory/tools/tests/` | Deterministic tests and regression harnesses |
| `state/` | Runtime artifacts and receipts (operational output) |

## Quality And Governance Baseline

The project is operated with explicit documentation and governance contracts:

- [Onboarding Playbook](docs/ONBOARDING_PLAYBOOK.md)
- [UI Surface Maturity Matrix](docs/UI_SURFACE_MATURITY_MATRIX.md)
- [History Cleanliness Program](docs/HISTORY_CLEANLINESS.md)
- [Claim-Evidence Policy](docs/CLAIM_EVIDENCE_POLICY.md)
- [Public Collaboration Triage Contract](docs/PUBLIC_COLLABORATION_TRIAGE.md)
- [Public Operator Profile](docs/PUBLIC_OPERATOR_PROFILE.md)
- [Illusion Integrity Auditor](docs/ILLUSION_INTEGRITY_AUDITOR.md)
- [Backlog Governance](docs/BACKLOG_GOVERNANCE.md)
- [Branch Protection Policy](docs/BRANCH_PROTECTION_POLICY.md)
- [Operator Runbook](docs/OPERATOR_RUNBOOK.md)
- [Documentation Hub](docs/README.md)
- [Changelog](CHANGELOG.md)

## Contribution Workflow

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Keep changes scoped and test-backed.
3. Run quality gates before PR.
4. Link measurable claims to evidence per [Claim-Evidence Policy](docs/CLAIM_EVIDENCE_POLICY.md).
5. Update [CHANGELOG.md](CHANGELOG.md) for user-visible behavior/docs changes.

## Security

- Security policy and disclosure path: [SECURITY.md](SECURITY.md)
- Runtime security lane overview: [docs/SECURITY.md](docs/SECURITY.md)

## Legal

- License: [LICENSE](LICENSE)
- Contribution terms: [CONTRIBUTING_TERMS.md](CONTRIBUTING_TERMS.md)
- Terms of service: [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md)
- End-user license: [EULA.md](EULA.md)
