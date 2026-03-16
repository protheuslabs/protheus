# CODEX ENFORCER

Owner: Jay  
Effective: March 2026  
Scope: All backlog and sprint execution

## Mandatory Pre-Task Protocol
1. Read this file before starting any coding task.
2. Run an explicit enforcer preflight check before implementation.
3. If blocked, state: `BLOCKED — <exact reason>` and stop.

## Definition of Done Reference
- Canonical DoD policy: `docs/workspace/DEFINITION_OF_DONE.md`
- `done` claims must satisfy both this enforcer and the DoD policy.
- If there is any conflict, use the stricter rule.

## Prompt-Start Review Hook
For every incoming user prompt:
1. Re-read this enforcer before implementation.
2. Emit marker: `[codex_enforcer] reviewed`
3. Then continue with preflight + execution.

## Standard Implementation Rules (Mandatory)
- Implement all requested items as production code, not receipt scaffolds.
- Authorized modification scope includes `core/`, `client/`, `apps/`, `adapters/`, `tests/`, and `docs/`.
- You may add crates/packages, change schemas, and remove/replace placeholder flows when needed.
- Enforce Rust-core authority and thin-client boundaries on every implementation.
- Do not mark any item `done` unless acceptance criteria are proven by:
  - behavior tests,
  - integration tests,
  - runnable CLI evidence.
- If blocked by missing secrets/tools, stop immediately and report the exact blocker.

## Honesty and Completion Rules
- Never mark any backlog item `done` unless it is fully implemented in code and verified.
- Never claim work that was not implemented.
- Never use placeholders, theater, or status-only updates as completion.
- If implementation is partial, mark it as partial/in-progress with exact remaining gaps.

## Required Proof for Every Completed Task
Completion requires all of the following:
1. Visible `git diff` summary for changed files.
2. Successful build output for relevant targets.
3. Successful test output including:
   - At least 1 regression test.
   - At least 1 sovereignty/security check.
4. Runtime/functionality evidence (CLI output, artifact path, or state output).

## Backlog Discipline
- Do not move queued work to `done` without proof and operator audit readiness.
- Do not close items based on inferred completion.
- Keep failed or blocked items visible with explicit reasons.

## Rust Migration Rules
- Use real public-source metrics only (tracked source files), not weighted/internal metrics.
- Report `.rs` vs `.ts` lines from tracked files.
- Treat the 50% Rust target as repository-wide source composition, not core-only subsets.
- Do not inflate Rust percentage with stubs/scaffolding.
- Before adding any **new file** (`git add` path that did not previously exist), run a projected Rust composition check.
- If the projected repository Rust percentage would drop below **70.0%**, the change is blocked.
- Block message format: `BLOCKED — projected Rust % would fall below 70.0 after adding new files`.
- Do not migrate `client/cognition/adaptive/**` into Rust unless the path is under `client/runtime/systems/adaptive/**`.
- Keep user-flex surfaces (`habits`, `reflexes`, `eyes` user-specific paths) non-Rust by default unless explicitly approved.
- Treat these TCB prefixes as Rust-authoritative migration targets: `client/runtime/systems/security/`, `client/runtime/systems/ops/`, `client/runtime/systems/memory/`, `client/runtime/systems/sensory/`, `client/runtime/systems/autonomy/`, `client/runtime/systems/assimilation/`.
- Keep these surface prefixes TypeScript-first unless explicitly overridden: `client/runtime/systems/ui/`, `client/runtime/systems/marketplace/`, `client/runtime/systems/extensions/`.

## Behavior-Preserving Migration Rules
- Preserve existing behavior unless a breaking change is explicitly requested.
- Add parity checks when migrating logic between TS and Rust.
- Keep fail-closed security behavior active for gated paths.
- Do not change file types or migrate logic across file types (`.ts`, `.js`, `.rs`, etc.) without explicit operator permission in the task instructions.
- If explicit permission is missing for any file-type change or language migration, mark the task `BLOCKED — missing explicit file-type migration permission` and stop.

## Repository Placement Rules (Mandatory)
- Canonical code locations are limited to: `core/`, `client/`, `tests/`, and `adapters/`.
- `apps/` is app-only. It may contain only standalone apps that run on top of the client/runtime boundary.
- Any path under `apps/` must be deletable without changing core/client/adapters/tests behavior.
- System code must not import from `apps/**`. If system code needs shared logic, move that logic into `core/`, `client/`, `tests/`, or `adapters/` first.
- `apps/` is never a script/tool dump. Shared helpers, wrappers, and runtime bridges are prohibited in `apps/`.
- Top-level `scripts/` is prohibited. Do not create or reintroduce it.
- CI/dev/test tooling scripts must live under `tests/tooling/scripts/`.
- Runtime/operator utilities must live under `client/runtime/systems/**` (or `core/**` when authoritative).
- If initialization/bootstrap installers need a dedicated surface, use `setup/` as the only root-level exception.
- Placement decision rule:
  - system authority/runtime path => `core/` (or `client/runtime/systems/**` only as thin runtime/client surface)
  - developer/user operational scripts => `client/`
  - test/CI tooling => `tests/`
  - integration bridges for external software => `adapters/`
  - standalone deletable products only => `apps/`
  - initialization/bootstrap only => `setup/`

## Git Hygiene Rules (Mandatory)
- Do not leave path migrations as unstaged delete+untracked churn.
- For any directory/file relocation, stage as one atomic move set immediately (`git add -A <old> <new>` or `git mv`).
- Before reporting completion, run `npm run -s ops:churn:guard`; unresolved move-pair churn is a hard fail.
- If churn guard reports likely unstaged moves, stop and resolve staging before any further feature work.

## Sprint Gate
Each sprint/batch must include:
- At least one regression test.
- At least one sovereignty/security validation.
- Rollback/fallback path when applicable.

## Communication Contract
- Be direct, factual, and auditable.
- Surface risks and blockers immediately.
- Do not hide uncertainty.
