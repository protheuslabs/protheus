# OpenClaw Workspace

This repository is an agent-operations workspace: orchestration, governed habits, memory indices, and runtime state.

## Architecture Map

- `systems/`  
  Infrastructure/control-plane layer. Contains spine, security, routing, and autonomy controllers.
- `habits/`  
  Dynamic semi-permanent routines with lifecycle governance (`candidate -> active -> disabled -> archived`).
- `skills/`  
  Task-specific skill packs and scripts.
- `config/`  
  Control-plane config (directives, routing, trust lists, budgets).
- `memory/`  
  Indexed memory graph and tooling for traversal/maintenance.
- `state/`  
  Runtime outputs and ledgers (high churn).
- `lib/`  
  Shared utility modules.
- `docs/` and `patches/`  
  Design notes and implementation patches.

## Core Commands

```bash
# Validate script CLI contracts used by spine
node systems/spine/contract_check.js

# Validate habit governance + trust gates
node habits/scripts/doctor.js

# Run sensing pipeline
node systems/spine/spine.js eyes [YYYY-MM-DD] [--max-eyes=N]

# Run daily orchestration pipeline
node systems/spine/spine.js daily [YYYY-MM-DD] [--max-eyes=N]
```

## Clearance Tiers

- `CLEARANCE=1`: state data operations (`state/`).
- `CLEARANCE=2`: habits/reflexes (`habits/`).
- `CLEARANCE=3`: infrastructure/config/memory tooling (`systems/`, `config/`, `memory/`, default).
- `CLEARANCE=4`: explicitly protected core files (if declared in guard policy).

## Git Hygiene

`.gitignore` now excludes high-churn runtime artifacts (raw sensory streams, run ledgers, daily state dumps, tool raw logs, backups, temp files) so source-level diffs stay reviewable.
