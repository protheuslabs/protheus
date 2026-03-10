# TODO (Priority + ROI + Dependency Ordered)

Updated: 2026-03-10 (security TODO execution tranche applied)

## Ordering policy
- Priority first (`P0` > `P1` > `P2` > `P3`)
- Then ROI (higher unblock value first)
- Then dependency chain (prerequisites before dependents)

## Backlog snapshot
- Source: `docs/workspace/SRS.md` + `client/runtime/config/backlog_registry.json`
- Latest actionable report: `artifacts/backlog_actionable_report_2026-03-10_post_security_todo.json`
- Counts: `queued=371`, `in_progress=2`, `blocked=42`, `done=2228`

## Ordered execution queue

1. `MAINT-001` `P0` `ROI=10/10` `DEP=none` Refresh TODO from live SRS/backlog state. `STATUS: COMPLETE`
- Exit criteria:
- TODO reflects current SRS statuses and dependency-aware ordering.
- Completion evidence:
- `docs/workspace/TODO.md`
- `artifacts/backlog_actionable_report_2026-03-10_todo_refresh.json`

2. `V6-SEC-008` `P0` `ROI=10/10` `DEP=V6-SEC-003` Continuous Fuzzing + Chaos Suite closure. `STATUS: COMPLETE`
- Exit criteria:
- Nightly workflow emits deterministic fuzz/chaos report artifacts.
- Triage policy exists and is linked in security policy.
- Completion evidence:
- `.github/workflows/nightly-fuzz-chaos.yml`
- `scripts/ci/nightly_fuzz_chaos_report.mjs`
- `docs/client/FUZZ_CHAOS_TRIAGE.md`
- `SECURITY.md`
- `artifacts/nightly_fuzz_chaos_report_latest.json`

3. `MAINT-002` `P0` `ROI=9/10` `DEP=001,002` Post-change gate/regression pass. `STATUS: COMPLETE`
- Exit criteria:
- Primitive wrapper contract gate passes.
- Coreization static audit passes.
- Rust-share gate remains above 60%.
- `verify.sh` passes.
- Completion evidence:
- `./target/debug/protheus-ops contract-check --rust-contract-check-ids=primitive_ts_wrapper_contract`
- `artifacts/coreization_wave1_static_audit_2026-03-10_todo_refresh.json`
- `npm run -s metrics:rust-share:gate` (`64.849%`)
- `./verify.sh`

4. `MAINT-003` `P1` `ROI=8/10` `DEP=003` Refresh actionable backlog artifact after tranche execution. `STATUS: COMPLETE`
- Exit criteria:
- New actionable artifact generated from current SRS/TODO.
- Completion evidence:
- `artifacts/backlog_actionable_report_2026-03-10_todo_refresh.json`

5. `V6-SEC-001` `P1` `ROI=9/10` `DEP=V6-F100-003` Audited Release + SBOM bundle (`v0.2.0`). `STATUS: IN_PROGRESS`
- Current state:
- Required scaffolding already exists:
  - `.github/workflows/release-security-artifacts.yml`
  - `docs/client/RELEASE_SECURITY_CHECKLIST.md`
  - `docs/client/releases/v0.2.0_migration_guide.md`
- Readiness evidence:
  - `artifacts/release_security_readiness_latest.json`
- Remaining closure condition:
- Human-authorized tagged release publication and artifact verification record (`HMAN-030`).

6. `COREIZATION-NEXT-001` `P1` `ROI=9/10` `DEP=003` Deep authority migration (core-first) for remaining TS heavy surfaces. `STATUS: COMPLETE`
- Scope:
- `client/runtime/lib/strategy_resolver.ts` -> `core/layer2/execution` authoritative path
- `client/runtime/lib/duality_seed.ts` -> `core/layer2/autonomy` authoritative path
- Exit criteria:
- TS files reduced to thin conduit wrappers only.
- Rust crate lanes carry source-of-truth behavior and pass parity tests.
- Completion evidence:
- `core/layer0/ops/src/strategy_resolver.rs`
- `core/layer0/ops/src/duality_seed.rs`
- `client/runtime/lib/strategy_resolver.ts`
- `client/runtime/lib/duality_seed.ts`
- `artifacts/coreization_wave1_static_audit_2026-03-10_coreization_next_001.json`

7. `V6-SEC-004` `P2` `ROI=7/10` `DEP=V6-SEC-001,V6-SEC-003` Independent security audit publication. `STATUS: IN_PROGRESS`
- Current state:
- Publication + remediation pack scaffolded in-repo:
  - `docs/client/security/INDEPENDENT_AUDIT_PUBLICATION_2026Q1.md`
  - `docs/client/security/INDEPENDENT_AUDIT_REMEDIATION_TRACKER.md`
- Remaining closure condition:
- External auditor-authored report publication (human/external dependency).

8. `V6-SEC-005` `P2` `ROI=7/10` `DEP=V6-SEC-002,V6-SEC-004` Formal verification expansion package. `STATUS: COMPLETE`
- Completion evidence:
  - `docs/client/security/FORMAL_VERIFICATION_EXPANSION_PACK.md`
  - `scripts/ci/formal_verification_expansion_report.mjs`
  - `artifacts/formal_verification_expansion_latest.json`

9. `V6-F100-025` `P2` `ROI=6/10` `DEP=human cadence` Weekly chaos evidence cadence contract. `STATUS: BLOCKED`
- Blocker:
- Requires sustained weekly operational cadence + human-owned evidence publication.

10. `V7-META-FOUNDATION` `P3` `ROI=8/10` `DEP=coreization-next` Metakernel foundation wave (`V7-META-001..015`). `STATUS: QUEUED`
- Notes:
- Keep queued until `COREIZATION-NEXT-001` is closed to avoid splitting authority lanes.

11. `MAINT-004` `P1` `ROI=9/10` `DEP=coreization+security` Client layer boundary lock (wrapper-only runtime systems + explicit residual allowlist). `STATUS: COMPLETE`
- Exit criteria:
- Full `client/runtime/systems` source scan has zero unexpected non-wrapper files.
- Explicit policy tracks residual developer/app surfaces still in client.
- Completion evidence:
- `client/runtime/config/client_layer_boundary_policy.json`
- `scripts/ci/client_layer_boundary_audit.mjs`
- `artifacts/client_layer_boundary_audit_2026-03-10.json`
- `npm run -s ops:client-layer:boundary`

12. `MAINT-005` `P1` `ROI=8/10` `DEP=004` Repo surface policy codified (`core/client/apps/adapters/tests`). `STATUS: COMPLETE`
- Exit criteria:
- Repo topology and language policy are documented and enforced by audit.
- `/apps`, `/adapters`, and `/tests` surfaces are explicitly defined.
- Completion evidence:
- `docs/client/architecture/LAYER_RULEBOOK.md`
- `client/runtime/config/repo_surface_policy.json`
- `scripts/ci/repo_surface_policy_audit.mjs`
- `apps/README.md`
- `adapters/README.md`
- `tests/README.md`
- `artifacts/repo_surface_policy_audit_2026-03-10.json`

13. `MAINT-006` `P1` `ROI=9/10` `DEP=005` Client legacy language debt burn-down (`JS/Python/Shell -> TS/client or apps/adapters/tests`). `STATUS: QUEUED`
- Current baseline:
- `client` legacy debt tracked by repo-surface audit:
  - `js=5392`
  - `sh=19`
  - `py=11`
  - `ps1=1`
- Exit criteria:
- Client reaches TS/TSX + HTML/CSS target state except explicitly-approved installer/package shims.
- App/adaptor/test candidates are relocated out of `client`.

## Commands used in this tranche
- `node scripts/ci/nightly_fuzz_chaos_report.mjs`
- `./target/debug/protheus-ops contract-check --rust-contract-check-ids=primitive_ts_wrapper_contract`
- `node scripts/ci/coreization_wave1_static_audit.mjs --out artifacts/coreization_wave1_static_audit_2026-03-10_todo_refresh.json`
- `node scripts/ci/coreization_wave1_static_audit.mjs --out artifacts/coreization_wave1_static_audit_2026-03-10_coreization_next_001.json`
- `node scripts/ci/release_security_readiness_report.mjs`
- `node scripts/ci/formal_verification_expansion_report.mjs`
- `node scripts/ci/client_layer_boundary_audit.mjs --strict=1 --out=artifacts/client_layer_boundary_audit_2026-03-10.json`
- `node scripts/ci/repo_surface_policy_audit.mjs --strict=1 --out=artifacts/repo_surface_policy_audit_2026-03-10.json`
- `npm run -s metrics:rust-share:gate`
- `./verify.sh`
- `node scripts/ci/backlog_actionable_report.mjs > artifacts/backlog_actionable_report_2026-03-10_post_security_todo.json`
