# Protheus

Protheus is an evidence-first local control plane for autonomous operations, workflow execution, and policy-governed system evolution.
This repository is maintained under the Protheus Labs operating model.
Protheus is the open substrate for crowdsourcing the singularity — run your own self-improving loop today.

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

### Persona Lens Command

- `protheus lens <persona> "<query>"` loads `personas/<persona>/{profile.md,correspondence.md,lens.md}` and returns a Markdown response using that persona lens.
- Example: `protheus lens vikram "Should we prioritize memory or security first?"`
- Control mode: `protheus lens <persona> --gap=<seconds> [--active=1] [--intercept="<override>"] "<query>"` for cognizance-gap + intercept simulation (`e`=edit, `a`=approve early during gap).
- Emotion toggle: `--emotion=on|off` (default `on`).
- Daily internal check-in: `protheus lens checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md`.

### Persona Orchestration Command

- `protheus orchestrate status` validates policy/schema state and prints artifact counters.
- `protheus orchestrate meeting "<topic>" [--approval-note="..."]` runs role-based attendee selection, deterministic arbitration, and writes hash-chained artifacts.
- `protheus orchestrate project "<name>" "<goal>" [--approval-note="..."]` opens a project state machine lane (`proposed -> active/blocked/completed/cancelled`).
- `protheus orchestrate project --id=<project_id> --transition=<state> [--approval-note="..."]` advances project state with receipts.

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

- [Architecture](ARCHITECTURE.md)
- [Onboarding Playbook](docs/ONBOARDING_PLAYBOOK.md)
- [Developer Lane Quickstart](docs/DEVELOPER_LANE_QUICKSTART.md)
- [Help](docs/HELP.md)
- [UI Surface Maturity Matrix](docs/UI_SURFACE_MATURITY_MATRIX.md)
- [UI Surface Inventory](docs/UI_SURFACE_INVENTORY.md)
- [UI Accessibility & Interaction Contract](docs/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md)
- [Enhanced Reasoning Mirror](docs/ENHANCED_REASONING_MIRROR.md)
- [History Cleanliness Program](docs/HISTORY_CLEANLINESS.md)
- [Release Discipline Policy](docs/RELEASE_DISCIPLINE_POLICY.md)
- [Claim-Evidence Policy](docs/CLAIM_EVIDENCE_POLICY.md)
- [Empty Fort Integrity Checklist](docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md)
- [Org Code Format Standard](docs/ORG_CODE_FORMAT_STANDARD.md)
- [Perception Audit Program](docs/PERCEPTION_AUDIT_PROGRAM.md)
- [Public Collaboration Triage Contract](docs/PUBLIC_COLLABORATION_TRIAGE.md)
- [Public Collaboration Surface](docs/PUBLIC_COLLABORATION_SURFACE.md)
- [Core Migration Bridge](docs/CORE_MIGRATION_BRIDGE.md)
- [Community Repo Graduation Pack](docs/COMMUNITY_REPO_GRADUATION_PACK.md)
- [Universal Importers](docs/UNIVERSAL_IMPORTERS.md)
- [Self-Healing Migration Daemon](docs/SELF_HEALING_MIGRATION_DAEMON.md)
- [Post-Migration Completion Report](docs/POST_MIGRATION_COMPLETION_REPORT.md)
- [WASI2 Execution Completeness Gate](docs/WASI2_EXECUTION_COMPLETENESS_GATE.md)
- [Type-Derived Lane Docs Autogen](docs/TYPE_DERIVED_LANE_DOCS_AUTOGEN.md)
- [Rust Authoritative Microkernel Acceleration](docs/RUST_AUTHORITATIVE_MICROKERNEL_ACCELERATION.md)
- [ChromeOS/Fuchsia OTA Adapter](docs/CHROMEOS_FUCHSIA_DISTRIBUTION_OTA_ADAPTER.md)
- [NGC NVIDIA Distribution Adapter](docs/NGC_NVIDIA_ENTERPRISE_DISTRIBUTION_ADAPTER.md)
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
