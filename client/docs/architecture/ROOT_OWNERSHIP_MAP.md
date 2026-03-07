# Root Ownership Map

Defines ownership intent for repository-root entries after the core/client split.

## Source Code Directories

- `core/`: core authority implementation (Rust and low-level layer0 native code).
- `client/`: surface implementation (TS/JS/Python/Shell/PowerShell + tests).
- `planes/`: architecture contracts (safety/cognition/substrate) and schemas.

## Infrastructure/Metadata Directories

- `.github/`: CI workflows and branch policy.
- `.githooks/`: local hook helpers.
- `.private-lenses/`: local/private config surface.
- `.clawhub/`: local workspace lock and helper metadata.
- `dist/`: generated build output.
- `state/`: compatibility symlink to `client/local/state` (legacy callers only).
- `target/`: Rust build artifacts.
- `tmp/`: scratch/runtime transient files.
- `node_modules/`: npm dependency cache.

## Root File Classes

- Governance + narrative: `SRS.md`, `TODO.md`, `UPGRADE_BACKLOG.md`, `AGENTS.md`, `AGENT-CONSTITUTION.md`.
- Product/repo metadata: `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- Build and package manifests: `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`.
- Runtime/infra bootstrap: `Dockerfile`, `docker-compose.yml`, `install.sh`, `install.ps1`, `tsconfig*.json`, `vitest.config.ts`.

## Guarding Rules

1. New source code must land under `core/` or `client/` only.
2. Legacy root runtime folders (`adaptive`, `memory`, `habits`, `logs`, `patches`, `reports`, `research`, `secrets`) are disallowed.
3. Runtime mutable data belongs in `client/local/*` and `core/local/*`.
4. Root allowances are enforced by `ops:root-surface:check` and `ops:source-runtime:check`.
