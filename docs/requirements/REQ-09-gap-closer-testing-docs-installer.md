# REQ-09: Testing + Documentation + Curl Installer Gap Closer

Version: 1.0  
Date: 2026-03-06

## Objective

Close the highest-visibility completeness gaps with a focused implementation wave:

- Production-ready one-line installer (`curl ... | sh` + PowerShell path)
- Test and coverage uplift with visible badge + CI gate
- Architecture/onboarding documentation refresh for fast operator adoption

## Requirements

1. `REQ-09-001` Installer parity
- Acceptance:
  - Root [install.sh](../../install.sh) exists and provisions `protheus`, `protheusctl`, and `protheusd`.
  - Root [install.ps1](../../install.ps1) exists with equivalent Windows behavior.
  - [docs/GETTING_STARTED.md](../GETTING_STARTED.md) includes one-line install commands.

2. `REQ-09-002` Coverage pipeline and badge
- Acceptance:
  - Vitest coverage and Rust `cargo llvm-cov` are wired in scripts/CI.
  - Combined coverage artifact is generated with a coverage badge.
  - README displays a coverage badge.
  - CI coverage gate enforces `combined_lines_pct >= 75`.

3. `REQ-09-003` Architecture and onboarding polish
- Acceptance:
  - Root [ARCHITECTURE.md](../../ARCHITECTURE.md) includes a Mermaid system map with conduit and 7 primitives.
  - [README.md](../../README.md) provides an install-first quickstart.
  - [docs/GETTING_STARTED.md](../GETTING_STARTED.md) provides a <2 minute path.

4. `REQ-09-004` Optional Python packaging path must remain thin and Rust-authoritative
- Acceptance:
  - A dedicated Python package exists under `packages/protheus-py`.
  - `pip install` exposes a `protheus` CLI entrypoint that delegates to `protheus-ops`.
  - No kernel logic is re-implemented in Python; wrapper only forwards command execution.

## Execution Notes (Current Batch)

Implemented in this batch:
- Added root installers (`install.sh`, `install.ps1`) with release-binary provisioning and CLI wrappers.
- Added vitest + llvm-cov coverage scripts, CI workflow, and combined coverage badge generation.
- Added/updated docs: `ARCHITECTURE.md`, `README.md`, and `docs/GETTING_STARTED.md`.
