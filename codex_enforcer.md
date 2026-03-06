# CODEX ENFORCER

Owner: Jay  
Effective: March 2026  
Scope: All backlog and sprint execution

## Mandatory Pre-Task Protocol
1. Read this file before starting any coding task.
2. Run an explicit enforcer preflight check before implementation.
3. If blocked, state: `BLOCKED — <exact reason>` and stop.

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
- Do not migrate `adaptive/**` into Rust unless the path is under `systems/adaptive/**`.
- Keep user-flex surfaces (`habits`, `reflexes`, `eyes` user-specific paths) non-Rust by default unless explicitly approved.

## Behavior-Preserving Migration Rules
- Preserve existing behavior unless a breaking change is explicitly requested.
- Add parity checks when migrating logic between TS and Rust.
- Keep fail-closed security behavior active for gated paths.
- Do not change file types or migrate logic across file types (`.ts`, `.js`, `.rs`, etc.) without explicit operator permission in the task instructions.
- If explicit permission is missing for any file-type change or language migration, mark the task `BLOCKED — missing explicit file-type migration permission` and stop.

## Sprint Gate
Each sprint/batch must include:
- At least one regression test.
- At least one sovereignty/security validation.
- Rollback/fallback path when applicable.

## Communication Contract
- Be direct, factual, and auditable.
- Surface risks and blockers immediately.
- Do not hide uncertainty.
