# Protheus

[![CI](https://github.com/protheuslabs/protheus/actions/workflows/ci.yml/badge.svg)](https://github.com/protheuslabs/protheus/actions/workflows/ci.yml)
[![CodeQL](https://github.com/protheuslabs/protheus/actions/workflows/codeql.yml/badge.svg)](https://github.com/protheuslabs/protheus/actions/workflows/codeql.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/protheuslabs/protheus?display_name=tag)](https://github.com/protheuslabs/protheus/releases)
[![npm version](https://img.shields.io/npm/v/protheus)](https://www.npmjs.com/package/protheus)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fprotheuslabs%2Fprotheus-blue)](https://github.com/protheuslabs/protheus/pkgs/container/protheus)
![Coverage](client/docs/badges/coverage.svg)
![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot)

Protheus is an evidence-first Rust kernel for autonomous operations, workflow execution, and policy-governed system evolution.
This repository is maintained under the Protheus Labs operating model.
Protheus is the InfRing substrate: run the same core across desktop/server/embedded while keeping TS as a thin surface layer.

This repository is organized to run like an internal platform team: typed runtime lanes, deterministic receipts, strict governance surfaces, and operational guardrails that are reviewable in-source.

## What This Repo Includes

- Control plane CLI surface (`protheus`, `protheusd`, `protheusctl`, `protheus-top`)
- Policy-backed runtime lanes across `client/systems/` (ops, security, memory, routing, workflow, observability, and more)
- Deterministic state and receipt contracts for auditable execution
- Backlog governance pipeline with generated active/archive/reviewed views
- Docs and runbooks that map directly to executable scripts and checks

## Quick Start

Install with one command (macOS/Linux):

```bash
curl -fsSL https://get.protheus.ai/install | sh
```

Fallback installer URL:

```bash
curl -fsSL https://raw.githubusercontent.com/protheuslabs/protheus/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/protheuslabs/protheus/main/install.ps1 | iex
```

Then verify:

```bash
protheus --help
protheusctl --help
protheusd --help
```

Local source workflow:

```bash
npm ci
npm run build
npm run start
```

## npm Installation (Primary Distribution)

Install the CLI globally:

```bash
npm install -g protheus
```

For local source installs from this repository:

```bash
cd npm
npm install -g .
protheus --help
```

The npm package is a thin wrapper around the Rust `protheus-ops` binary and includes:
- release-binary download on install (when available)
- local Cargo build fallback
- a `protheus` command entrypoint for operator workflows

Then verify the runtime surface:

```bash
protheus status
protheus-top
```

## pip Installation (Thin Wrapper Option)

Install the Python wrapper from PyPI:

```bash
pip install protheus-cli-wrapper
protheus --help
```

Install from this repository:

```bash
pip install ./packages/protheus-py
protheus status --dashboard
```

The Python package is intentionally thin and delegates all kernel authority to Rust (`protheus-ops`).

## Operator Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start local daemon control surface (dev profile) |
| `npm run start` | Start daemon control surface |
| `npm run build` | Build systems + smoke verification |
| `npm run test` | Stable test suite |
| `npm run test:ci` | Deterministic CI-oriented test suite |
| `npm run lint` | Type/system lint gate |
| `npm run typecheck:systems` | Typecheck `client/systems/` lanes |
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

Run `protheus list` (or `protheus --help`) for a categorized command index.

### CLI Discoverability and UX

- `protheus list` and `protheus --help` provide a categorized command index.
- `protheus setup` runs an optional, lightweight first-run wizard (covenant confirmation, interaction mode, notification preference).
- `protheus completion <bash|zsh|fish>` generates shell auto-completion scripts.
- Global flags work across CLI entrypoints: `--json`, `--quiet`, `--help`, `--version`, `--example`.
- Running `protheus` with no args in a TTY opens interactive REPL mode with guided shortcuts/wizards.
  - On first run, setup executes once before REPL unless `--skip-setup` is passed.
- Unknown commands return suggestion hints plus a `protheus list` prompt.
- Long-running research/assimilation flows support spinner/progress indicators in interactive terminals.
- `protheus demo` runs a safe walkthrough (`list`, `version`, examples, setup status).
- `protheus version` and `protheus update` provide version + update channel information.
- Internal operator commands:
  - `protheus status` -> health dashboard (`Rust %`, drift, shadows, heartbeat)
  - `protheus debug` -> parity/security diagnostics + recent log summary
  - `protheus shadow <list|arise|pause|review|status>` -> direct shadow-army operations
  - `protheus diagram ...` -> Mermaid diagram generator

Completion setup examples:

```bash
protheus completion bash > ~/.local/share/bash-completion/completions/protheus
protheus completion zsh > ~/.zfunc/_protheus
protheus completion fish > ~/.client/config/fish/completions/protheus.fish
protheus setup
protheus --skip-setup
protheus demo
protheus research --example
protheus --version
protheus status --json=1
protheus debug --json=1
protheus shadow list --json=1
```

### Persona Lens Command

- `protheus lens <persona> "<query>"` loads `personas/<persona>/{profile.md,correspondence.md,lens.md}` and returns a Markdown response using that persona lens.
- Example: `protheus lens vikram "Should we prioritize memory or security first?"`
- Dedicated arbitration: `protheus arbitrate --between=vikram,priya --issue="sample vs full audit"` resolves disagreements with deterministic arbitration rules.
- Control mode: `protheus lens <persona> --gap=<seconds> [--active=1] [--intercept="<override>"] "<query>"` for cognizance-gap + intercept simulation (`e`=edit, `a`=approve early during gap).
- Emotion toggle: `--emotion=on|off` (default `on`).
- Surprise toggle: `--surprise=on|off` (default `off`) enables deterministic 20% anti-puppet deviation.
- Structured output: `--schema=json` returns machine-readable recommendations (`recommendation`, `confidence`, `time_estimate`, `blockers`, `escalate_to`, `reasoning`).
- Daily internal check-in: `protheus lens checkin --persona=jay_haslam --heartbeat=HEARTBEAT.md`.
- Meta-feedback loop: `protheus lens feedback ...` and `protheus lens feedback-summary` capture utility signals to tune persona weighting over time.

### Persona Orchestration Command

- `protheus orchestrate status` validates policy/schema state and prints artifact counters.
- `protheus orchestrate telemetry --window=20` renders recent orchestration metrics plus a Markdown dashboard table.
- `protheus orchestrate meeting "<topic>" [--approval-note="..."]` runs role-based attendee selection, deterministic arbitration, and writes hash-chained artifacts.
- `protheus orchestrate project "<name>" "<goal>" [--approval-note="..."]` opens a project state machine lane (`proposed -> active/blocked/paused_on_breaker/reviewed/resumed/rolled_back/completed/cancelled`).
- `protheus orchestrate project --id=<project_id> --transition=<state> [--approval-note="..."]` advances project state with receipts.

### Shadow Operator Command

- `protheus shadow status` shows active/paused shadows and governance snapshot.
- `protheus shadow list` shows available personas plus current shadow state.
- `protheus shadow arise <persona>` activates a persona shadow with telemetry receipt.
- `protheus shadow pause <persona>` pauses a persona shadow with telemetry receipt.
- `protheus shadow review [persona] [--note="..."]` queues review checkpoints for audit and memory.

### Assimilation Command

- `protheus assimilate <path|url>` ingests a local file or allowlisted web page, runs research-organ probe + Core-5 persona review, and emits a Codex-ready sprint prompt.
- Safety gates are fail-closed: blocked domains/private hosts are rejected, covenant violation signals stop execution, and `--apply` requires `--confirm-execution=1`.
- Default mode is proposal-only with auditable receipts at `state/tools/assimilate/`.
- Example: `protheus assimilate ./client/docs/cognitive_toolkit.md --dry-run=1`
- Example: `protheus assimilate https://github.com/example/repo`
- Programmatic use for loops/shadows:
  ```js
  const { systemAssimilate } = require('./client/systems/tools/assimilate_api.js');
  const result = systemAssimilate('./client/docs/cognitive_toolkit.md', { dryRun: true, format: 'json' });
  ```

### Research Command

- `protheus research "<query>"` runs research-organ routing (query intake, local hybrid evidence grading, synthesis) and Core-5 review/arbitration.
- Includes covenant fail-closed checks and query token-budget guard (`trim` or `reject` mode).
- Implementation-intent queries automatically include an optional Codex sprint prompt.
- Proactive suggestion mode: when tool/path/URL mentions are detected, the system can suggest assimilation with a natural prompt and optional auto-confirm flags.
- Example: `protheus research "creating a quant trading software" --dry-run=1`
- Example proactive flow: `protheus research "I just used client/docs/cognitive_toolkit.md for this workflow" --dry-run=1 --auto-confirm-assimilate=1`
- Programmatic use for loops/shadows:
  ```js
  const { systemResearch } = require('./client/systems/tools/research_api.js');
  const result = systemResearch('creating a quant trading software', { dryRun: true, format: 'json' });
  ```

### Context-Aware CLI Suggestions (Tutorial Mode)

- The CLI can suggest next commands using context triggers (external tool/path mentions, drift-like signals, and planning intent).
- Suggestions run a light Core-5 safety review before prompting.
- Prompt format: `Would you like to run \`protheus <command>\`? (y/n) — <why>`
- Toggle tutorial mode:
  - `protheus tutorial status`
  - `protheus tutorial on`
  - `protheus tutorial off`
- Example contexts (JSON mode for deterministic output):
  - `node client/systems/tools/cli_suggestion_engine.js suggest --cmd=status --text="I just used client/docs/cognitive_toolkit.md for this workflow." --auto-reject=1 --dry-run=1 --json=1`
  - `node client/systems/tools/cli_suggestion_engine.js suggest --cmd=status --text="drift regression detected in memory lane" --auto-reject=1 --dry-run=1 --json=1`
  - `node client/systems/tools/cli_suggestion_engine.js suggest --cmd=status --text="plan next sprint backlog for rust migration" --auto-reject=1 --dry-run=1 --json=1`

### Cognitive Toolkit Suite

Introducing the Cognitive Toolkit Suite: internal operators tooling for red-teaming and alignment workflows.

- `protheus toolkit list` shows suite tools and routes.
- `protheus toolkit personas ...` routes to persona lens operations.
- `protheus toolkit dictionary [list|term "<name>"]` reads novel concept definitions.
- `protheus toolkit orchestration ...` routes to deterministic meeting/project operations.
- `protheus toolkit blob-morphing [status|verify]` validates blob assets used by fold/unfold paths.
- `protheus toolkit comment-mapper --persona=<id> --query="<text>" [--gap=<seconds>] [--active=1] [--intercept="<override>"]` runs stream-of-thought mapping with optional intercept controls.
- `protheus toolkit assimilate <path|url>` runs the same assimilation flow through the toolkit wrapper.
- `protheus toolkit research "<query>"` runs the research command through the toolkit wrapper.

See [Cognitive Toolkit Suite](client/docs/cognitive_toolkit.md) and `examples/*-demo/` for runnable examples.

## Architecture Map

| Path | Responsibility |
|---|---|
| `client/systems/` | Executable runtime lanes and control-plane modules |
| `client/lib/` | Shared runtime helpers used by lanes |
| `client/config/` | Policy, registries, and lane configuration |
| `client/docs/` | Architecture, governance, runbooks, and contracts |
| `client/memory/tools/tests/` | Deterministic tests and regression harnesses |
| `state/` | Runtime artifacts and receipts (operational output) |

## Quality And Governance Baseline

The project is operated with explicit documentation and governance contracts:

- [Architecture](ARCHITECTURE.md)
- [Getting Started](client/docs/GETTING_STARTED.md)
- [Security Posture](client/docs/SECURITY_POSTURE.md)
- [Security Policy](SECURITY.md)
- [Good First Issues](client/docs/community/GOOD_FIRST_ISSUES.md)
- [InfRing Launch Announcement Template](client/docs/announcements/INFRING_LAUNCH_TEMPLATE.md)
- [Onboarding Playbook](client/docs/ONBOARDING_PLAYBOOK.md)
- [Developer Lane Quickstart](client/docs/DEVELOPER_LANE_QUICKSTART.md)
- [Help](client/docs/HELP.md)
- [UI Surface Maturity Matrix](client/docs/UI_SURFACE_MATURITY_MATRIX.md)
- [UI Surface Inventory](client/docs/UI_SURFACE_INVENTORY.md)
- [UI Accessibility & Interaction Contract](client/docs/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md)
- [Enhanced Reasoning Mirror](client/docs/ENHANCED_REASONING_MIRROR.md)
- [History Cleanliness Program](client/docs/HISTORY_CLEANLINESS.md)
- [Release Discipline Policy](client/docs/RELEASE_DISCIPLINE_POLICY.md)
- [Claim-Evidence Policy](client/docs/CLAIM_EVIDENCE_POLICY.md)
- [Empty Fort Integrity Checklist](client/docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md)
- [Org Code Format Standard](client/docs/ORG_CODE_FORMAT_STANDARD.md)
- [Perception Audit Program](client/docs/PERCEPTION_AUDIT_PROGRAM.md)
- [Public Collaboration Triage Contract](client/docs/PUBLIC_COLLABORATION_TRIAGE.md)
- [Public Collaboration Surface](client/docs/PUBLIC_COLLABORATION_SURFACE.md)
- [Core Migration Bridge](client/docs/CORE_MIGRATION_BRIDGE.md)
- [Community Repo Graduation Pack](client/docs/COMMUNITY_REPO_GRADUATION_PACK.md)
- [Universal Importers](client/docs/UNIVERSAL_IMPORTERS.md)
- [Self-Healing Migration Daemon](client/docs/SELF_HEALING_MIGRATION_DAEMON.md)
- [Post-Migration Completion Report](client/docs/POST_MIGRATION_COMPLETION_REPORT.md)
- [WASI2 Execution Completeness Gate](client/docs/WASI2_EXECUTION_COMPLETENESS_GATE.md)
- [Type-Derived Lane Docs Autogen](client/docs/TYPE_DERIVED_LANE_DOCS_AUTOGEN.md)
- [Rust Authoritative Microkernel Acceleration](client/docs/RUST_AUTHORITATIVE_MICROKERNEL_ACCELERATION.md)
- [ChromeOS/Fuchsia OTA Adapter](client/docs/CHROMEOS_FUCHSIA_DISTRIBUTION_OTA_ADAPTER.md)
- [NGC NVIDIA Distribution Adapter](client/docs/NGC_NVIDIA_ENTERPRISE_DISTRIBUTION_ADAPTER.md)
- [Public Operator Profile](client/docs/PUBLIC_OPERATOR_PROFILE.md)
- [Illusion Integrity Auditor](client/docs/ILLUSION_INTEGRITY_AUDITOR.md)
- [Backlog Governance](client/docs/BACKLOG_GOVERNANCE.md)
- [Branch Protection Policy](client/docs/BRANCH_PROTECTION_POLICY.md)
- [Operator Runbook](client/docs/OPERATOR_RUNBOOK.md)
- [Documentation Hub](client/docs/README.md)
- [Changelog](CHANGELOG.md)

## Contribution Workflow

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Follow the [Code of Conduct](.github/CODE_OF_CONDUCT.md).
3. Keep changes scoped and test-backed.
4. Run quality gates before PR.
5. Link measurable claims to evidence per [Claim-Evidence Policy](client/docs/CLAIM_EVIDENCE_POLICY.md).
6. Update [CHANGELOG.md](CHANGELOG.md) for user-visible behavior/docs changes.
7. Use [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml), [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml), and [Pull request](.github/PULL_REQUEST_TEMPLATE.md) templates.

## Security

- Security policy and disclosure path: [SECURITY.md](SECURITY.md)
- Runtime security lane overview: [client/docs/SECURITY.md](client/docs/SECURITY.md)

## Legal

- License: [LICENSE](LICENSE)
- License details: Apache-2.0
- Archived historical legal docs: [client/legal/archive](client/legal/archive)
