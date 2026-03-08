# Root Ownership Map

Defines ownership intent for repository-root entries after the core/client split.

## Source Code Directories

- `core/`: core authority implementation (Rust and low-level layer0 native code).
- `client/`: surface implementation (TS/JS/Python/Shell/PowerShell + tests).
- `planes/`: architecture contracts (safety/cognition/substrate) and schemas.
- `apps/`: optional top-of-client application/tool workspaces (default local-first, explicitly allowlisted tools may be tracked).

## Infrastructure/Metadata Directories

- `.github/`: CI workflows and branch policy.
- `.githooks/`: local hook helpers.
- `dist/`: generated build output.
- `target/`: Rust build artifacts.
- `node_modules/`: npm dependency cache.
- `client/local/workspaces/`: relocated local-only sidecars/scratch workspaces (ignored).

## Root File Classes

- Governance + narrative: `SRS.md`, `TODO.md`, `UPGRADE_BACKLOG.md`, `AGENTS.md`, `AGENT-CONSTITUTION.md`.
- Product/repo metadata: `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- Build and package manifests: `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`.
- Runtime/infra bootstrap: `Dockerfile`, `docker-compose.yml`, `install.sh`, `install.ps1`, `tsconfig*.json`, `vitest.config.ts`.
- Bootstrap identity/memory docs (intentionally tracked root exceptions): `MEMORY.md`, `MEMORY_INDEX.md`, `TAGS_INDEX.md`, `SOUL.md`, `USER.md`, `HEARTBEAT.md`, `IDENTITY.md`, `TOOLS.md`.

## Root Exception Rationale

- The bootstrap identity/memory docs are intentionally kept at root because agent startup and regression tests resolve them by canonical root paths.
- These files are explicitly allowlisted in `client/config/root_surface_contract.json` and validated by `root_surface_contract` checks.
- This is a policy exception, not a loophole: new runtime data must still live under `client/local/*` or `core/local/*`.

## Guarding Rules

1. New source code must land under `core/` or `client/` only.
2. Legacy root runtime folders (`adaptive`, `memory`, `habits`, `logs`, `patches`, `reports`, `research`, `secrets`, `state`, `.clawhub`, `.private-lenses`) are disallowed.
3. Root sidecar/scratch dirs (`agent-holo-viz`, `pqts`, `projects`, `rohan-*`, `tmp`) are disallowed and must live under `client/local/workspaces/`.
4. Runtime mutable data belongs in `client/local/*` and `core/local/*`.
5. Root allowances are enforced by `ops:root-surface:check` and `ops:source-runtime:check`.
