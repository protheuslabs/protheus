# InfRing

[![CI](https://github.com/protheuslabs/InfRing/actions/workflows/ci.yml/badge.svg)](https://github.com/protheuslabs/InfRing/actions/workflows/ci.yml)
[![CodeQL](https://github.com/protheuslabs/InfRing/actions/workflows/codeql.yml/badge.svg)](https://github.com/protheuslabs/InfRing/actions/workflows/codeql.yml)
[![License: InfRing-NC-1.0](https://img.shields.io/badge/license-InfRing--NC--1.0-red.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/protheuslabs/InfRing?display_name=tag)](https://github.com/protheuslabs/InfRing/releases)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fprotheuslabs%2Finfring-blue)](https://github.com/protheuslabs/InfRing/pkgs/container/infring)
[![Architecture](https://img.shields.io/badge/architecture-three--plane%20metakernel-0A7A5E)](planes/README.md)
[![ORCID](https://img.shields.io/badge/ORCID-0009--0002--0617--7360-A6CE39?logo=orcid&logoColor=white)](https://orcid.org/0009-0002-0617-7360)
![Coverage](docs/client/badges/coverage.svg)
![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot)

InfRing is an evidence-first Rust kernel for autonomous operations, workflow execution, and policy-governed system evolution.
This repository is maintained under the InfRing operating model.
InfRing is the three-plane metakernel substrate: deterministic safety core, probabilistic cognition userland, and substrate adapters for heterogeneous execution.

> **Clarification:** The term "metakernel" refers to the architectural pattern where the runtime itself operates as a managed system layer, not a traditional monolithic kernel. This enables policy-driven, auditable execution across safety, cognition, and substrate planes.

This repository is organized to run like an internal platform team: typed runtime lanes, deterministic receipts, strict governance surfaces, and operational guardrails that are reviewable in-source.

## What This Repo Includes

- Control plane CLI surface (`infring`, `infringd`, `infringctl`, `infring top`)
- Policy-backed runtime lanes across `client/runtime/systems/` (ops, security, memory, routing, workflow, observability, and more)
- Deterministic state and receipt contracts for auditable execution
- Backlog governance pipeline with generated active/archive/reviewed views
- Docs and runbooks that map directly to executable scripts and checks

## Quick Start

Default install (minimal mode, macOS/Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.sh | sh
```

Install modes (macOS/Linux):

- `--minimal` (default): daemon + CLI wrappers only
- `--pure`: 100% Rust client + daemon, no Node/TS surfaces
- `--tiny-max`: extreme low-resource pure profile
- `--full`: includes optional published client runtime bundle
- `--repair`: clears stale local wrappers/runtime state before install

```bash
# Pure mode
curl -fsSL https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.sh | sh -s -- --pure

# Tiny-max mode
curl -fsSL https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.sh | sh -s -- --tiny-max

# Full mode
curl -fsSL https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.sh | sh -s -- --full

# Repair + reinstall in pure mode
curl -fsSL https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.sh | sh -s -- --repair --pure
```

Install to specific paths (macOS/Linux):

```bash
# Flags
curl -fsSL https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.sh | \
  sh -s -- --pure --install-dir "$HOME/.openclaw/bin" --tmp-dir "$HOME/.openclaw/tmp"

# Equivalent env vars
INFRING_INSTALL_DIR="$HOME/.openclaw/bin" \
INFRING_TMP_DIR="$HOME/.openclaw/tmp" \
curl -fsSL https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.sh | sh -s -- --pure
```

Windows (PowerShell):

```powershell
# Default minimal install
irm https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.ps1 | iex

# Pure / tiny-max / full / repair
irm https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.ps1 | iex -Pure
irm https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.ps1 | iex -TinyMax
irm https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.ps1 | iex -Full
irm https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.ps1 | iex -Repair -Pure
```

Install to specific paths (Windows):

```powershell
irm https://raw.githubusercontent.com/protheuslabs/InfRing/main/install.ps1 | iex -Pure -InstallDir "$HOME\\.openclaw\\bin" -TmpDir "$HOME\\.openclaw\\tmp"
```

Then verify:

```bash
infring --help
infringctl --help
infringd --help
```

Pure Intelligence v1 (Node-free in `--pure` / `--tiny-max`):

```bash
# Minimal research surface (Rust core)
infring research status
infring research fetch --url=https://example.com

# Minimal memory surface (Rust core)
infring memory write --session-id=alpha --text="important note" --tags=pure,intel
infring memory query --session-id=alpha --q=important --limit=5

# Deterministic think primitive (Rust core)
infring think --session-id=alpha --prompt="What should I do next?"
```

## Mode Capability Matrix (Core Shedding Model)

InfRing modes are layered, not forked: `tiny-max` and `pure` use the same Rust core authority, then shed capabilities based on hardware sensing when needed.

`infring capability-profile` shows the active profile and any shed capabilities. You can force a test profile with `--hardware-class=<mcu|legacy|standard|high> --memory-mb=<n> --cpu-cores=<n>`.

| Mode | Primary Goal | Intelligence Surface | Runtime Dependencies | Shedding Behavior |
|---|---|---|---|---|
| `InfRing (rich)` | Full operator UX + integrations | Full core intelligence + rich adapters | Rust + Node/TS client surfaces | Minimal shedding by default |
| `InfRing (pure)` | Rust-only client with high intelligence parity | Core `think`, `research`, `memory`, `orchestration`, `swarm-runtime` | Rust only | Capability shedding only when hardware is constrained |
| `InfRing (tiny-max)` | Run on anything while keeping max feasible intelligence | Same core lanes as pure, bounded by hardware class | Rust only (`no_std` profile lanes available) | Aggressive, explicit shedding (for example persistent swarm or heavy orchestration on MCU-class targets) |

Tiny-max hardware classes:
- `mcu`: strict floor (bounded memory hits, max swarm depth 1, no heavy orchestration ops, no `research fetch`).
- `legacy`: moderate floor (bounded swarm depth, no persistent swarm).
- `standard` / `high`: progressively restores capabilities up to full parity.

Regression recovery runbook: [RUNBOOK-007-pure-tiny-capability-restore](docs/ops/RUNBOOK-007-pure-tiny-capability-restore.md).

Legacy command aliases remain supported with a deprecation notice.

> **Note:** Full CLI surface requires Node.js 22+ (see `package.json#engines`). Rust fallback supports `help`, `list`, `status`, `version`, plus Pure Intelligence v1 commands (`think`, `research status|fetch|diagnostics`, `memory status|write|query`) when Node is unavailable. See `docs/TROUBLESHOOTING.md` for environment setup details.

Local source workflow:

```bash
npm ci
npm run local:init
npm run build
npm run start
```

`npm run local:init` creates any missing instance-local continuity files under `local/workspace/assistant/` from the tracked templates in `docs/workspace/templates/assistant/` and archives deprecated root copies if they still exist.
It also imports legacy root continuity/memory state (`SOUL.md`, `USER.md`, `HEARTBEAT.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `memory/**`, `MEMORY_INDEX.md`, `TAGS_INDEX.md`) into `local/workspace/**` with conflict-safe archiving under `local/workspace/archive/`.
For OpenClaw transitions you can run `npm run local:migrate:openclaw` (alias to the same deterministic migration).

## Benchmark Snapshot

### Refresh Runtime Benchmarks

The repo ships an executable benchmark lane. To refresh the tracked benchmark artifacts:

```bash
npm run -s ops:benchmark:build-release
npm run ops:benchmark:refresh
```

`ops:benchmark:refresh` now fails closed if `target/release/protheus-ops` is missing so benchmark publication does not silently fall back to `cargo run` and contaminate throughput with compile-time load.

This regenerates:
- `docs/client/reports/benchmark_matrix_run_2026-03-06.json`
- `docs/client/reports/benchmark_matrix_run_2026-03-06_full_install.json`

### Current Runtime Measurements (InfRing Instance Modes)

Sources:
- Live control-plane run: `docs/client/reports/benchmark_matrix_run_2026-03-06.json`
- Stabilized multi-run median (2 warmups + 9 runs): `docs/client/reports/benchmark_matrix_stabilized_2026-03-18.json`
- Snapshot/reference baseline: `docs/client/reports/runtime_snapshots/ops/proof_pack/top1_benchmark_snapshot.json`
- Headline runtime metrics below reflect the latest stabilized median benchmark artifact; single-run live refresh details remain in the JSON reports for tail-latency diagnostics.
- Throughput now reflects a shared pre-profile release-binary baseline measured once per run to avoid per-profile contamination from probe order and compile-time load.

| Metric | InfRing (rich) | InfRing (pure) | InfRing (tiny-max) | Snapshot/Reference |
|---|---:|---:|---:|---:|
| Cold start | 12.0 ms | 4.1 ms | 3.1 ms | 74.5 ms |
| Idle memory | 8.2 MB | 1.4 MB | 1.4 MB | 22.1 MB |
| Install size (full) | 11.6 MB | 0.7 MB | 0.5 MB | 126.4 MB |
| Throughput | 65,938.9 ops/sec | 65,938.9 ops/sec | 65,938.9 ops/sec | 7,420.0 ops/sec |

| Capability Counter | InfRing (rich) | InfRing (pure) | InfRing (tiny-max) |
|---|---:|---:|---:|
| Static daemon size (musl + UPX) | 0.4 MB | 0.4 MB | 0.3 MB |
| Rust client binary size (musl + UPX) | n/a | 0.2 MB | 0.2 MB |
| Full binary system set (daemon + pure client + tiny daemon) | 0.9 MB | 0.9 MB | 0.9 MB |
| Security systems | 83 | 83 | 83 |
| Channel adapters | 6 | 0 | 0 |
| LLM providers | 3 | 0 | 0 |

### Competitive Benchmark Matrix (Feb 2026 Snapshot + Live InfRing)

External baseline (OpenFang public table):
<https://raw.githubusercontent.com/RightNow-AI/openfang/main/README.md>

| Project | Install Size (MB) ↓ | Cold Start ↓ | Idle Memory (MB) ↓ | Throughput (ops/sec) ↑ | Static Daemon (MB) ↓ | Security Systems ↑ | Channel Adapters ↑ | LLM Providers ↑ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **InfRing (rich)** | **11.6** | **12.0 ms** | **8.2** | **65,938.9** | **0.4** | **83** | 6 | 3 |
| **InfRing (pure)** | **0.7** | **4.1 ms** | **1.4** | **65,938.9** | **0.4** | **83** | 0 | 0 |
| **InfRing (tiny-max)** | **0.5** | **3.1 ms** | **1.4** | **65,938.9** | **0.3** | **83** | 0 | 0 |
| OpenFang | 32.0 | 180.0 ms | 40.0 | n/p | n/p | 16 | 40 | 27 |
| OpenHands | 95.5 | 1.3 sec | 150.0 | n/p | n/p | 7 | 15 | 5 |
| LangGraph | 150.0 | 2.5 sec | 180.0 | n/p | n/p | 2 | 4 | 15 |
| CrewAI | 100.0 | 3.0 sec | 200.0 | n/p | n/p | 1 | 3 | 10 |
| AutoGen | 200.0 | 4.0 sec | 250.0 | n/p | n/p | 2 | 4 | 8 |

`n/p` means not publicly published with a reproducible method in the referenced sources.

Pure Workspace mode is 100% Rust with no Node/TS runtime surfaces and is designed to run on low-resource hardware.
Pure Workspace Tiny-Max is the low-resource profile for old/embedded targets and keeps the same Rust-only control boundary.
Tiny-max currently ships with a 0.3 MB daemon and a 0.9 MB full binary system set (below the 1.1 MB target envelope), and is the active lane for microcontroller and 1990s-hardware deployment proof.
Tiny-max is the smallest full agentic OS artifact shipped in this repo today and is optimized for microcontroller and 1990s-hardware deployment lanes.

### Tiny-Max Extreme Hardware Proof Status

- `status`: `blocked_external` (physical flash session pending)
- `preflight_artifact`: `core/local/artifacts/mcu_proof_preflight_current.json`
- `preflight_report`: `local/workspace/reports/MCU_PROOF_PREFLIGHT.md`
- `runbook`: `docs/ops/RUNBOOK-005-mcu-proof-sprint.md`
- `human_owner`: `HMAN-092` (`docs/client/HUMAN_ONLY_ACTIONS.md`)
- required evidence targets:
  - `docs/client/reports/hardware/esp32_tiny_max_status_<date>.png`
  - `docs/client/reports/hardware/rp2040_tiny_max_status_<date>.png`
  - `state/ops/evidence/mcu_flash_session_<date>.md`

### Benchmarks: Measured, Not Marketed (ASCII)

```text
Cold Start Time (lower is better)
InfRing (tiny-max) ############################################  3.1 ms
InfRing (pure)     ############################################  4.1 ms
InfRing (rich)     ###########################################-  12.0 ms
OpenFang   ###########################################-  180.0 ms
OpenHands  ###############################-------------  1.3 sec
LangGraph  #################---------------------------  2.5 sec
CrewAI     ############--------------------------------  3.0 sec
AutoGen    #-------------------------------------------  4.0 sec
```

```text
Idle Memory Usage (lower is better)
InfRing (pure)     ############################################  1.4 MB
InfRing (tiny-max) ############################################  1.4 MB
InfRing (rich)     ###########################################-  8.2 MB
OpenFang   #####################################-------  40.0 MB
OpenHands  ####################------------------------  150.0 MB
LangGraph  ##############------------------------------  180.0 MB
CrewAI     ##########----------------------------------  200.0 MB
AutoGen    #-------------------------------------------  250.0 MB
```

```text
Install Size (lower is better)
InfRing (tiny-max) ############################################  0.5 MB
InfRing (pure)     ############################################  0.7 MB
InfRing (rich)     ##########################################--  11.6 MB
OpenFang   #####################################-------  32.0 MB
OpenHands  ###########################-----------------  95.5 MB
CrewAI     ##########################------------------  100.0 MB
LangGraph  #############-------------------------------  150.0 MB
AutoGen    #-------------------------------------------  200.0 MB
```

```text
Security Systems (higher is better)
InfRing    ############################################  83
OpenFang   ########------------------------------------  16
OpenHands  ###-----------------------------------------  7
AutoGen    #-------------------------------------------  2
LangGraph  #-------------------------------------------  2
CrewAI     #-------------------------------------------  1
```

```text
Throughput (ops/sec, higher is better)
InfRing (rich)     ############################################  65,938.9
InfRing (pure)     ############################################  65,938.9
InfRing (tiny-max) ############################################  65,938.9
OpenFang   n/p
OpenHands  n/p
LangGraph  n/p
CrewAI     n/p
AutoGen    n/p
```

## Alpha Readiness Checklist

Use this sequence for a clean alpha trial on a fresh workspace:

```bash
npm ci
npm run local:migrate:openclaw
npm run local:status
npm run build
npm run test:ci
infring alpha-check --strict=1 --run-gates=1
```

Recommended preflight gates:

```bash
npm run -s ops:repo-surface:audit
npm run -s ops:root-surface:check
cargo test --manifest-path core/layer0/ops/Cargo.toml optimize_receipt_emits_cost_savings_plan -- --test-threads=1
cargo test --manifest-path core/layer0/ops/Cargo.toml enable_bedrock_produces_sigv4_private_profile -- --test-threads=1
```

## npm Installation (Primary Distribution)

Install the CLI globally:

```bash
npm install -g ./packages/*-npm
```

For local source installs from this repository:

```bash
npm install -g .
infring --help
```

The npm package is a thin wrapper around the Rust operator runtime and includes:
- release-binary download on install (when available)
- local Cargo build fallback
- `infring` / `infringd` command entrypoints for operator workflows
- backward compatibility aliases for legacy scripts

Then verify the runtime surface:

```bash
infring status
infring top
```

## pip Installation (Thin Wrapper Option)

Install the Python wrapper from PyPI:

```bash
pip install ./packages/*-py
infring --help
```

Install from this repository with editable mode:

```bash
pip install -e ./packages/*-py
infring status --dashboard
```

The Python package is intentionally thin and delegates all kernel authority to Rust.

## Operator Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start local daemon control surface (dev profile) |
| `npm run start` | Start daemon control surface |
| `npm run build` | Build systems + smoke verification |
| `npm run test` | Stable test suite |
| `npm run test:ci` | Deterministic CI-oriented test suite |
| `npm run lint` | Type/system lint gate |
| `npm run typecheck:systems` | Typecheck `client/runtime/systems/` lanes |
| `npm run guard:merge` | Merge guard for core quality/security gates |
| `npm run ops:backlog:registry:sync` | Regenerate backlog registry/views from source backlog |
| `npm run ops:backlog:registry:check` | Validate generated backlog artifacts are in sync |

## Control Surface CLI

| CLI | Purpose |
|---|---|
| `infring` | Primary control-plane interface |
| `infringd` | Daemon lifecycle wrapper |
| `infringctl` | Job and control-plane operations |
| `infring top` | Live operator observability surface |

Compatibility aliases remain available for legacy scripts.

Run `infring list` (or `infring --help`) for a categorized command index.

### CLI Discoverability and UX

- `infring list` and `infring --help` provide a categorized command index.
- `infring setup` runs an optional, lightweight first-run wizard (covenant confirmation, interaction mode, notification preference).
- `infring completion <bash|zsh|fish>` generates shell auto-completion scripts.
- Global flags work across CLI entrypoints: `--json`, `--quiet`, `--help`, `--version`, `--example`.
- Running `infring` with no args in a TTY opens interactive REPL mode with guided shortcuts/wizards.
  - On first run, setup executes once before REPL unless `--skip-setup` is passed.
- Unknown commands return suggestion hints plus an `infring list` prompt.
- Long-running research/assimilation flows support spinner/progress indicators in interactive terminals.
- `infring demo` runs a safe walkthrough (`list`, `version`, examples, setup status).
- `infring version` and `infring update` provide version + update channel information.
- Internal operator commands:
  - `infring status` -> health dashboard (`Rust %`, drift, shadows, heartbeat)
  - `infring debug` -> parity/security diagnostics + recent log summary
  - `infring shadow <list|arise|pause|review|status>` -> direct shadow-army operations
  - `infring diagram ...` -> Mermaid diagram generator

Completion setup examples:

```bash
infring completion bash > ~/.local/share/bash-completion/completions/infring
infring completion zsh > ~/.zfunc/_infring
infring completion fish > ~/.client/runtime/config/fish/completions/infring.fish
infring setup
infring --skip-setup
infring demo
infring research --example
infring --version
infring status --json=1
infring debug --json=1
infring shadow list --json=1
```

### Persona Lens Command

- `infring lens <persona> "<query>"` loads `personas/<persona>/{profile.md,correspondence.md,lens.md}` and returns a Markdown response using that persona lens.
- Example: `infring lens vikram "Should we prioritize memory or security first?"`
- Dedicated arbitration: `infring arbitrate --between=vikram,priya --issue="sample vs full audit"` resolves disagreements with deterministic arbitration rules.
- Control mode: `infring lens <persona> --gap=<seconds> [--active=1] [--intercept="<override>"] "<query>"` for cognizance-gap + intercept simulation (`e`=edit, `a`=approve early during gap).
- Emotion toggle: `--emotion=on|off` (default `on`).
- Surprise toggle: `--surprise=on|off` (default `off`) enables deterministic 20% anti-puppet deviation.
- Structured output: `--schema=json` returns machine-readable recommendations (`recommendation`, `confidence`, `time_estimate`, `blockers`, `escalate_to`, `reasoning`).
- Daily internal check-in: `infring lens checkin --persona=<persona_id> --heartbeat=local/workspace/assistant/HEARTBEAT.md`.
- Meta-feedback loop: `infring lens feedback ...` and `infring lens feedback-summary` capture utility signals to tune persona weighting over time.

### Persona Orchestration Command

- `infring orchestrate status` validates policy/schema state and prints artifact counters.
- `infring orchestrate telemetry --window=20` renders recent orchestration metrics plus a Markdown dashboard table.
- `infring orchestrate meeting "<topic>" [--approval-note="..."]` runs role-based attendee selection, deterministic arbitration, and writes hash-chained artifacts.
- `infring orchestrate project "<name>" "<goal>" [--approval-note="..."]` opens a project state machine lane (`proposed -> active/blocked/paused_on_breaker/reviewed/resumed/rolled_back/completed/cancelled`).
- `infring orchestrate project --id=<project_id> --transition=<state> [--approval-note="..."]` advances project state with receipts.

### Shadow Operator Command

- `infring shadow status` shows active/paused shadows and governance snapshot.
- `infring shadow list` shows available personas plus current shadow state.
- `infring shadow arise <persona>` activates a persona shadow with telemetry receipt.
- `infring shadow pause <persona>` pauses a persona shadow with telemetry receipt.
- `infring shadow review [persona] [--note="..."]` queues review checkpoints for audit and memory.

### Assimilation Command

- `infring assimilate <path|url>` ingests a local file or allowlisted web page, runs research-organ probe + Core-5 persona review, and emits a Codex-ready sprint prompt.
- Safety gates are fail-closed: blocked domains/private hosts are rejected, covenant violation signals stop execution, and `--apply` requires `--confirm-execution=1`.
- Default mode is proposal-only with auditable receipts at `local/state/tools/assimilate/`.
- Example: `infring assimilate ./docs/client/cognitive_toolkit.md --dry-run=1`
- Example: `infring assimilate https://github.com/example/repo`
- Programmatic use for loops/shadows:
  ```js
  const { systemAssimilate } = require('./client/runtime/systems/tools/assimilate_api.ts');
  const result = systemAssimilate('./docs/client/cognitive_toolkit.md', { dryRun: true, format: 'json' });
  ```

### Research Command

- `infring research "<query>"` runs research-organ routing (query intake, local hybrid evidence grading, synthesis) and Core-5 review/arbitration.
- Includes covenant fail-closed checks and query token-budget guard (`trim` or `reject` mode).
- Implementation-intent queries automatically include an optional Codex sprint prompt.
- Proactive suggestion mode: when tool/path/URL mentions are detected, the system can suggest assimilation with a natural prompt and optional auto-confirm flags.
- Example: `infring research "creating a quant trading software" --dry-run=1`
- Example proactive flow: `infring research "I just used docs/client/cognitive_toolkit.md for this workflow" --dry-run=1 --auto-confirm-assimilate=1`
- Programmatic use for loops/shadows:
  ```js
  const { systemResearch } = require('./client/runtime/systems/tools/research_api.ts');
  const result = systemResearch('creating a quant trading software', { dryRun: true, format: 'json' });
  ```

### Context-Aware CLI Suggestions (Tutorial Mode)

- The CLI can suggest next commands using context triggers (external tool/path mentions, drift-like signals, and planning intent).
- Suggestions run a light Core-5 safety review before prompting.
- Prompt format: `Would you like to run \`infring <command>\`? (y/n) — <why>`
- Toggle tutorial mode:
  - `infring tutorial status`
  - `infring tutorial on`
  - `infring tutorial off`
- Example contexts (JSON mode for deterministic output):
  - `node client/runtime/systems/tools/cli_suggestion_engine.ts suggest --cmd=status --text="I just used docs/client/cognitive_toolkit.md for this workflow." --auto-reject=1 --dry-run=1 --json=1`
  - `node client/runtime/systems/tools/cli_suggestion_engine.ts suggest --cmd=status --text="drift regression detected in memory lane" --auto-reject=1 --dry-run=1 --json=1`
  - `node client/runtime/systems/tools/cli_suggestion_engine.ts suggest --cmd=status --text="plan next sprint backlog for rust migration" --auto-reject=1 --dry-run=1 --json=1`

### Cognitive Toolkit Suite

Introducing the Cognitive Toolkit Suite: internal operators tooling for red-teaming and alignment workflows.

- `infring toolkit list` shows suite tools and routes.
- `infring toolkit personas ...` routes to persona lens operations.
- `infring toolkit dictionary [list|term "<name>"]` reads novel concept definitions.
- `infring toolkit orchestration ...` routes to deterministic meeting/project operations.
- `infring toolkit blob-morphing [status|verify]` validates blob assets used by fold/unfold paths.
- `infring toolkit comment-mapper --persona=<id> --query="<text>" [--gap=<seconds>] [--active=1] [--intercept="<override>"]` runs stream-of-thought mapping with optional intercept controls.
- `infring toolkit assimilate <path|url>` runs the same assimilation flow through the toolkit wrapper.
- `infring toolkit research "<query>"` runs the research command through the toolkit wrapper.

See [Cognitive Toolkit Suite](docs/client/cognitive_toolkit.md) and `apps/examples/*-demo/` for runnable examples.

## Architecture Map

| Path | Responsibility |
|---|---|
| `planes/` | Three-plane architecture contracts and schemas |
| `client/runtime/systems/` | Executable runtime lanes and control-plane modules |
| `client/runtime/lib/` | Shared runtime helpers used by lanes |
| `client/runtime/config/` | Policy, registries, and lane configuration |
| `client/observability/` | Reports, runbooks, dashboard specs, and research artifacts |
| `apps/` | User-facing/internal app layers and runnable example suites |
| `client/cli/developer/` | Developer templates and scaffolding assets |
| `docs/client/` | Architecture, governance, runbooks, and contracts |
| `tests/client-memory-tools/` | Deterministic tests and regression harnesses |
| `client/runtime/local/`, `core/local/` | Instance-local runtime artifacts and receipts |

### Three-Plane Filesystem Alignment

- `planes/` is the architecture contract surface (`safety`, `cognition`, `substrate`).
- `core/` and `client/` are the only source-code roots.
- `client/runtime/local/` and `core/local/` are the only mutable runtime roots.
- Root stays intentionally clean so runtime churn does not pollute source history.

## Quality And Governance Baseline

The project is operated with explicit documentation and governance contracts:

- [Architecture](ARCHITECTURE.md)
- [Getting Started](docs/client/GETTING_STARTED.md)
- [Security Posture](docs/client/SECURITY_POSTURE.md)
- [Security Policy](SECURITY.md)
- [Good First Issues](docs/client/community/GOOD_FIRST_ISSUES.md)
- [InfRing Launch Announcement Template](docs/client/announcements/INFRING_LAUNCH_TEMPLATE.md)
- [Onboarding Playbook](docs/client/ONBOARDING_PLAYBOOK.md)
- [Developer Lane Quickstart](docs/client/DEVELOPER_LANE_QUICKSTART.md)
- [Help](docs/client/HELP.md)
- [UI Surface Maturity Matrix](docs/client/UI_SURFACE_MATURITY_MATRIX.md)
- [UI Surface Inventory](docs/client/UI_SURFACE_INVENTORY.md)
- [UI Accessibility & Interaction Contract](docs/client/UI_ACCESSIBILITY_INTERACTION_CONTRACT.md)
- [Enhanced Reasoning Mirror](docs/client/ENHANCED_REASONING_MIRROR.md)
- [History Cleanliness Program](docs/client/HISTORY_CLEANLINESS.md)
- [Release Discipline Policy](docs/client/RELEASE_DISCIPLINE_POLICY.md)
- [Claim-Evidence Policy](docs/client/CLAIM_EVIDENCE_POLICY.md)
- [Empty Fort Integrity Checklist](docs/client/EMPTY_FORT_INTEGRITY_CHECKLIST.md)
- [Org Code Format Standard](docs/client/ORG_CODE_FORMAT_STANDARD.md)
- [Perception Audit Program](docs/client/PERCEPTION_AUDIT_PROGRAM.md)
- [Public Collaboration Triage Contract](docs/client/PUBLIC_COLLABORATION_TRIAGE.md)
- [Public Collaboration Surface](docs/client/PUBLIC_COLLABORATION_SURFACE.md)
- [Core Migration Bridge](docs/client/CORE_MIGRATION_BRIDGE.md)
- [Community Repo Graduation Pack](docs/client/COMMUNITY_REPO_GRADUATION_PACK.md)
- [Universal Importers](docs/client/UNIVERSAL_IMPORTERS.md)
- [Self-Healing Migration Daemon](docs/client/SELF_HEALING_MIGRATION_DAEMON.md)
- [Post-Migration Completion Report](docs/client/POST_MIGRATION_COMPLETION_REPORT.md)
- [WASI2 Execution Completeness Gate](docs/client/WASI2_EXECUTION_COMPLETENESS_GATE.md)
- [Type-Derived Lane Docs Autogen](docs/client/TYPE_DERIVED_LANE_DOCS_AUTOGEN.md)
- [Rust Authoritative Microkernel Acceleration](docs/client/RUST_AUTHORITATIVE_MICROKERNEL_ACCELERATION.md)
- [ChromeOS/Fuchsia OTA Adapter](docs/client/CHROMEOS_FUCHSIA_DISTRIBUTION_OTA_ADAPTER.md)
- [NGC NVIDIA Distribution Adapter](docs/client/NGC_NVIDIA_ENTERPRISE_DISTRIBUTION_ADAPTER.md)
- [Public Operator Profile](docs/client/PUBLIC_OPERATOR_PROFILE.md)
- [Illusion Integrity Auditor](docs/client/ILLUSION_INTEGRITY_AUDITOR.md)
- [Backlog Governance](docs/client/BACKLOG_GOVERNANCE.md)
- [Branch Protection Policy](docs/client/BRANCH_PROTECTION_POLICY.md)
- [Operator Runbook](docs/client/OPERATOR_RUNBOOK.md)
- [Documentation Hub](docs/client/README.md)
- [Changelog](docs/workspace/CHANGELOG.md)

### Public Automation Disclosure

- `empty-fort-pulse` is an optional low-risk maintenance automation constrained by declared service-account policy in [`client/runtime/config/empty_fort_pulse_policy.json`](client/runtime/config/empty_fort_pulse_policy.json).
- Pulse runs are audit-logged and bounded by explicit daily caps before any PR creation attempt (`tests/tooling/scripts/empty_fort_pulse_scheduler.js`, `.github/workflows/empty-fort-pulse.yml`).

## Contribution Workflow

1. Read [CONTRIBUTING.md](docs/workspace/CONTRIBUTING.md).
2. Follow the [Code of Conduct](.github/CODE_OF_CONDUCT.md).
3. Keep changes scoped and test-backed.
4. Run quality gates before PR.
5. Link measurable claims to evidence per [Claim-Evidence Policy](docs/client/CLAIM_EVIDENCE_POLICY.md).
6. Update [CHANGELOG.md](docs/workspace/CHANGELOG.md) for user-visible behavior/docs changes.
7. Use [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml), [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml), and [Pull request](.github/PULL_REQUEST_TEMPLATE.md) templates.

## Security

- Security policy and disclosure path: [SECURITY.md](SECURITY.md)
- Runtime security lane overview: [docs/client/SECURITY.md](docs/client/SECURITY.md)

## Legal

- License: [LICENSE](LICENSE)
- License details: InfRing Non-Commercial License v1.0
- Archived historical legal docs: [docs/client/legal/archive](docs/client/legal/archive)

## Platform Compatibility Notes

### Path Conventions

> **Note:** Log and configuration paths shown in documentation use standard Unix
> conventions (`/var/log/...`, `/etc/...`). Windows deployments automatically
> translate these to `%PROGRAMDATA%` equivalents via the adapter layer. No
> manual path translation is required by operators.

### Tested Environments

| Platform | Version | Status |
|----------|---------|--------|
| macOS | 14.x | ✅ Tested |
| Ubuntu | 22.04, 24.04 | ✅ Tested |
| Windows | Server 2022 | ⚠️ Known path quirks |
| Windows | 11 (WSL2) | ✅ Tested |
