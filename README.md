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
protheus completion fish > ~/.config/fish/completions/protheus.fish
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
- Example: `protheus assimilate ./docs/cognitive_toolkit.md --dry-run=1`
- Example: `protheus assimilate https://github.com/example/repo`
- Programmatic use for loops/shadows:
  ```js
  const { systemAssimilate } = require('./systems/tools/assimilate_api.js');
  const result = systemAssimilate('./docs/cognitive_toolkit.md', { dryRun: true, format: 'json' });
  ```

### Research Command

- `protheus research "<query>"` runs research-organ routing (query intake, local hybrid evidence grading, synthesis) and Core-5 review/arbitration.
- Includes covenant fail-closed checks and query token-budget guard (`trim` or `reject` mode).
- Implementation-intent queries automatically include an optional Codex sprint prompt.
- Proactive suggestion mode: when tool/path/URL mentions are detected, the system can suggest assimilation with a natural prompt and optional auto-confirm flags.
- Example: `protheus research "creating a quant trading software" --dry-run=1`
- Example proactive flow: `protheus research "I just used docs/cognitive_toolkit.md for this workflow" --dry-run=1 --auto-confirm-assimilate=1`
- Programmatic use for loops/shadows:
  ```js
  const { systemResearch } = require('./systems/tools/research_api.js');
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
  - `node systems/tools/cli_suggestion_engine.js suggest --cmd=status --text="I just used docs/cognitive_toolkit.md for this workflow." --auto-reject=1 --dry-run=1 --json=1`
  - `node systems/tools/cli_suggestion_engine.js suggest --cmd=status --text="drift regression detected in memory lane" --auto-reject=1 --dry-run=1 --json=1`
  - `node systems/tools/cli_suggestion_engine.js suggest --cmd=status --text="plan next sprint backlog for rust migration" --auto-reject=1 --dry-run=1 --json=1`

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

See [Cognitive Toolkit Suite](docs/cognitive_toolkit.md) and `examples/*-demo/` for runnable examples.

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
