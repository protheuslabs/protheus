# Public Operator Profile

This document defines the external, operator-facing surface for OpenClaw.

## What OpenClaw Is

OpenClaw is a local automation and orchestration runtime for macOS/Linux with typed control-plane lanes, policy contracts, and deterministic receipts.

## Public-First Entry Points

- `README.md` for overview and quick start
- `docs/client/README.md` for navigation
- `docs/client/OPERATOR_RUNBOOK.md` for incident/operations procedures
- `docs/workspace/CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` for contribution and policy posture

## Internal Artifact Handling

Assistant bootstrap templates are tracked under `docs/workspace/templates/assistant/`, while live instance-specific copies stay under `local/workspace/assistant/`.

Persona- and memory-heavy internal aliases are mirrored under `docs/client/internal/persona/`.

The canonical internal aliases are:

- `docs/workspace/AGENT-CONSTITUTION.md` -> `docs/client/internal/persona/AGENT-CONSTITUTION.md`
- `docs/workspace/templates/assistant/IDENTITY.md` -> `docs/client/internal/persona/IDENTITY.md`
- `docs/workspace/templates/assistant/SOUL.md` -> `docs/client/internal/persona/SOUL.md`
- `docs/workspace/templates/assistant/USER.md` -> `docs/client/internal/persona/USER.md`
- `docs/workspace/templates/assistant/MEMORY.md` -> `docs/client/internal/persona/MEMORY.md`
- `codex.helix` -> `docs/client/internal/persona/CODEX_HELIX.md`

## Regression Gates

Public-surface regressions are enforced by:

- `npm run -s ops:docs-surface:check`
- `npm run -s ops:root-surface:check`
- `npm run -s ops:path-contract:check`
