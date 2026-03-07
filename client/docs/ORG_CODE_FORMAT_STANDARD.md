# Org Code Format Standard

Applies to all first-party source and documentation assets.

## Baseline Rules

- Line endings: LF
- Charset: UTF-8
- Trailing whitespace: prohibited
- Tabs: prohibited in `.ts`, `.js`, `.rs`, `.md`, `.sh`
- Files end with a newline
- Keep commits scoped; one logical change per commit

## TypeScript / JavaScript

- Use `'use strict';` and explicit shebang in executable scripts.
- Prefer `const` by default; use `let` only when reassignment is required.
- Use deterministic JSON output (`JSON.stringify(..., null, 2)`).
- Keep CLI usage docs in each executable lane file.

## Rust

- `rustfmt`-compliant formatting.
- Public APIs use explicit types and predictable error surfaces.
- Keep crate-level docs concise and operational.

## Markdown

- Title first, then short purpose section.
- Keep sections stable to reduce diff noise.
- Use fenced code blocks with language hints where practical.

## Shell

- Start executable scripts with `#!/usr/bin/env bash` or `zsh` as needed.
- Prefer quoted vars and fail-fast mode when script semantics allow.
- Keep commands idempotent when used in CI/hooks.

## Guardrails

- Verification engine: `client/systems/ops/org_code_format_guard.ts`
- Local pre-commit gate (changed files only): `npm run ops:format:check:staged` + `npm run lint`
- CI gate (full repository scope): `npm run ops:format:check` + `npm run lint` + `npm run test`
- Hook activation: `git config core.hooksPath .githooks`

## Enforcement Model (Fortune-100 Style)

- Layer 1 (Developer workstation): deterministic pre-commit checks block bad changes before push.
- Layer 2 (CI required checks): pull requests cannot merge if format/lint/test fails.
- Layer 3 (Branch protection): require signed commits, linear history, and required status checks on `main`.
- Layer 4 (Ownership and review): `CODEOWNERS` enforces reviewer accountability for guarded surfaces.

## Exception Process

- No silent bypass. Exceptions require a tracked issue with:
- reason for temporary waiver,
- blast radius,
- explicit expiry date,
- owner accountable for removal.
- Expired waivers are treated as policy violations.
