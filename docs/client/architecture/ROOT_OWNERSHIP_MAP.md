# Root Ownership Map

Defines ownership intent for repository-root entries after the core/client split.

## Source Code Directories

- `core/`: core authority implementation (`layer_minus_one`, `layer0`, `layer1`, `layer2`, `layer3`).
- `client/`: surface implementation (TS/JS/Python/Shell/PowerShell + tests).
- `planes/`: architecture contracts (safety/cognition/substrate) and schemas.
- `examples/apps/`: optional top-of-client application/tool workspaces (default local-first, explicitly allowlisted tools may be tracked).

## Infrastructure/Metadata Directories

- `.github/`: CI workflows and branch policy.
- `.githooks/`: local hook helpers.
- `tools/`: internal support tooling and vendored helper repos that are not product entrypoints.
- `dist/`: generated build output.
- `target/`: Rust build artifacts.
- `node_modules/`: npm dependency cache.
- `client/runtime/local/workspaces/`: relocated local-only sidecars/scratch workspaces (ignored).

## Root File Classes

- Governance + narrative: `docs/workspace/SRS.md`, `docs/workspace/TODO.md`, `docs/workspace/UPGRADE_BACKLOG.md`, `docs/workspace/AGENTS.md`, `docs/workspace/AGENT-CONSTITUTION.md`.
- Product/repo metadata: `README.md`, `LICENSE`, `docs/workspace/CONTRIBUTING.md`, `SECURITY.md`, `docs/workspace/CHANGELOG.md`.
- Build and package manifests: `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`.
- Runtime/infra bootstrap: `Dockerfile`, `docker-compose.yml`, `install.sh`, `install.ps1`, `tsconfig*.json`, `vitest.config.ts`.
- Bootstrap assistant templates: `docs/workspace/templates/assistant/*.md`.
- Live assistant continuity + reports: `local/workspace/assistant/*.md`, `local/workspace/memory/*.md`, `local/workspace/reports/*.md`.

## Root Exception Rationale

- The repository tracks only blank assistant templates under `docs/workspace/templates/assistant/`.
- Live identity, user, heartbeat, tools, and memory files are instance-specific and must live under `local/workspace/**`.
- This is enforced by root/docs-surface contracts so fresh clones stay copyable without carrying operator data.

## Guarding Rules

1. New source code must land under `core/` or `client/` only.
2. Legacy root runtime folders (`adaptive`, `config`, `memory`, `habits`, `logs`, `ops-toolkit`, `patches`, `reports`, `research`, `secrets`, `state`, `.clawhub`, `.private-lenses`) are disallowed.
3. Root sidecar/scratch dirs (`agent-holo-viz`, `pqts`, `projects`, `rohan-*`, `tmp`) are disallowed and must live under `client/runtime/local/workspaces/`.
4. Runtime mutable data belongs in `client/runtime/local/*` and `core/local/*`.
5. Root allowances are enforced by `ops:root-surface:check` and `ops:source-runtime:check`.
