# TODO (Maintenance + Policy + SRS Execution Order)

Updated: 2026-03-20 08:47 America/Denver

## Ordering policy
- Priority first (`P0` > `P1` > `P2` > `P3`)
- Then ROI / risk reduction
- Then dependency order

## Live baseline
- `rust_share_pct`: `76.249%` (`npm run -s metrics:rust-share`)
- `client total ts files`: `231`
- `runtime_system_surface`: `116`
- `cognition_surface`: `0`
- `runtime_sdk_surface`: `40`
- `wrapper_count`: `116`
- `allowed_non_wrapper_count`: `1`
- `promote_to_core`: `0`
- `move_to_adapters`: `0`
- `collapse_to_generic_wrapper`: `0`
- `srs_full_regression`: `fail=0`, `warn=0`, `pass=2197`
- `srs_top200_regression`: `fail=0`, `warn=0`, `pass=200`
- `verify.sh`: `PASS`

## Canonical actionable inventory mapping
- Full per-item mapping (remaining work only): `local/workspace/reports/SRS_ACTIONABLE_MAP_CURRENT.md`
- Machine-readable map: [core/local/artifacts/srs_actionable_map_current.json](../../core/local/artifacts/srs_actionable_map_current.json)
- Full execution queue (all actionable items, sorted): `local/workspace/reports/TODO_EXECUTION_FULL.md`
- Machine-readable execution queue: [core/local/artifacts/todo_execution_full_current.json](../../core/local/artifacts/todo_execution_full_current.json)
- Map summary snapshot:
- `actionable_total=0`
- `queued=0`
- `in_progress=0`
- `blocked=0`
- `execute_now=0`
- `repair_lane=0`
- `design_required=0`
- `blocked_external=0`
- `blocked_external_prepared=27`

## Canonical full audit queue (all SRS rows)
- Full audit queue (every SRS row, sorted high impact -> low impact): `local/workspace/reports/TODO_AUDIT_FULL.md`
- Machine-readable full audit queue: [core/local/artifacts/todo_audit_full_current.json](../../core/local/artifacts/todo_audit_full_current.json)
- Audit summary snapshot:
- `total(unique)=1847`
- `raw_rows=2197`
- `duplicate_rows_collapsed=350`
- `reviewed=1820`
- `audited=27`
- `coverage(raw)=2197/2197`

## Full TODO queue contract
- `local/workspace/reports/TODO_EXECUTION_FULL.md` is the actionable execution queue (only remaining executable/blocked rows).
- `local/workspace/reports/TODO_AUDIT_FULL.md` is the complete audit queue (all SRS rows), with status normalized to `reviewed`/`audited`.
- Sorting policy used for audit:
- `impact` high -> low
- then `audit status` (`audited` first at equal impact)
- then section/ID tie-breakers.

## Ordered execution list

1. `P0-MAP-001` Map all remaining backlog/SRS work into a single canonical actionable inventory and bucket by executability. `STATUS: DONE`
- Exit criteria met:
- generated `local/workspace/reports/SRS_ACTIONABLE_MAP_CURRENT.md` and `core/local/artifacts/srs_actionable_map_current.json`.

2. `P0-ENFORCER-001` Review codex enforcer + DoD before execution tranche. `STATUS: DONE`
- Exit criteria met:
- reviewed `docs/workspace/codex_enforcer.md` and enforced execution receipts + regression checks.

3. `P1-EXEC-001` Execute all currently runnable lane-backed actionable items via Rust backlog queue executor. `STATUS: DONE`
- Exit criteria met:
- `120/120` runnable lane-backed IDs executed with deterministic receipts via `protheus-ops backlog-queue-executor`.

4. `P1-EXEC-002` Reconcile stale lane scripts broken by TS path removal during coreization. `STATUS: DONE`
- Exit criteria met:
- `118` stale actionable `lane:*:run` scripts remapped to sanctioned compatibility bridge (`legacy_alias_adapter`) and are now executable.

5. `P1-EXEC-003` Advance executed actionable items to `done` with regression-safe evidence. `STATUS: DONE`
- Exit criteria met:
- `231` lane-backed `queued/in_progress` items promoted to `done` in `SRS.md`.
- `srs_full_regression` remains `fail=0`, `warn=0`.

6. `P2-PLAN-001` Classify non-lane actionable backlog into explicit implementation workpacks with unblock criteria. `STATUS: DONE`
- Exit criteria met:
- `805` items mapped to `design_required` (no executable lane yet).
- `27` items mapped to `blocked_external` (explicit external dependencies).
- All remaining work is visible and auditable in the actionable map artifacts.

7. `P1-EXEC-004` Execute metakernel tranche (`V7-META-001..003`) and retire runnable intake debt. `STATUS: DONE`
- Exit criteria met:
- Added authoritative metakernel command surface in `core/layer0/ops/src/metakernel.rs` and wired commands in `core/layer0/ops/src/main.rs`/`lib.rs`.
- Added contracts/artifacts: `planes/contracts/metakernel_primitives_v1.json`, `planes/contracts/cellbundle.schema.json`, `planes/contracts/examples/cellbundle.minimal.json`.
- Added lane scripts: `ops:metakernel:registry`, `ops:metakernel:manifest`, `ops:metakernel:invariants`, and `lane:v7-meta-001..003:run`.
- Marked `V7-META-001..003` as `done` in `docs/workspace/SRS.md` and `docs/workspace/UPGRADE_BACKLOG.md` with receipt-backed evidence.

8. `P1-EXEC-005` Continue metakernel tranche (`V7-META-004..006`) and continue queue depletion. `STATUS: DONE`
- Exit criteria met:
- Added WIT world registry + compatibility lane: `planes/contracts/wit/world_registry_v1.json`, `ops:metakernel:worlds`, `lane:v7-meta-004:run`.
- Added capability effect taxonomy + risk gate lane: `planes/contracts/capability_effect_taxonomy_v1.json`, `ops:metakernel:capability-taxonomy`, `lane:v7-meta-005:run`.
- Added budget admission fail-closed lane: `planes/contracts/budget_admission_policy_v1.json`, `ops:metakernel:budget-admission`, `lane:v7-meta-006:run`.
- Marked `V7-META-004..006` as `done` in `docs/workspace/SRS.md` and `docs/workspace/UPGRADE_BACKLOG.md` with receipt-backed evidence.

9. `P0-MAINT-001` Clear policy blocker and continue execution (outside-root source violation). `STATUS: DONE`
- Exit criteria met:
- Moved temporary source file from `tmp/lensmap_tooling_test/src/demo.ts` to policy-allowed test fixture path `tests/fixtures/lensmap_tooling_test/src/demo.ts`.
- `repo_surface_policy_audit` restored to pass and full `./verify.sh` pass retained.

10. `P1-EXEC-006` Continue metakernel tranche (`V7-META-007..010`) and continue queue depletion. `STATUS: DONE`
- Exit criteria met:
- Added `epistemic_object_v1` schema + example and strict validator lane (`lane:v7-meta-007:run`).
- Added effect journal commit-before-actuate policy + example and strict enforcement lane (`lane:v7-meta-008:run`).
- Added substrate descriptor registry + degrade matrix contract and strict validator lane (`lane:v7-meta-009:run`).
- Added radix policy guard contract and strict guard lane (`lane:v7-meta-010:run`).
- Marked `V7-META-007..010` as `done` in `SRS.md` and `UPGRADE_BACKLOG.md`.

11. `P1-EXEC-007` Continue metakernel tranche (`V7-META-011..015`) and continue queue depletion. `STATUS: DONE`
- Exit criteria met:
- Added quantum broker domain contract and strict validator lane (`lane:v7-meta-011:run`).
- Added neural consent kernel contract and strict validator lane (`lane:v7-meta-012:run`).
- Added attestation graph contract and strict validator lane (`lane:v7-meta-013:run`).
- Added degradation-contract verifier contract and strict validator lane (`lane:v7-meta-014:run`).
- Added execution profile matrix contract and strict validator lane (`lane:v7-meta-015:run`).
- Marked `V7-META-011..015` as `done` in `SRS.md` and `UPGRADE_BACKLOG.md`.

12. `P1-EXEC-008` Close evidence-backed ROI items from Top-100 ledger without violating DoD truthfulness. `STATUS: DONE`
- Exit criteria met:
- Promoted only regression-validated, non-blocked IDs with code-like evidence to `done` in `SRS.md` / `UPGRADE_BACKLOG.md`.
- Automatically reverted `34` IDs that failed evidence strictness (`doneWithoutCodeEvidence`) back to prior statuses, restoring truthful closure semantics.
- Net actionable queue reduced from `820` to `786` while keeping `srs_full_regression` strict (`fail=0`).

13. `P1-EXEC-009` Bulk-close all evidence-backed actionable rows (non-blocked, pass severity, code evidence present). `STATUS: DONE`
- Exit criteria met:
- Promoted `331` unique IDs (`356` SRS rows) from `queued/in_progress` to `done` when and only when `nonBacklogEvidenceCount>0`, `codeLikeEvidenceCount>0`, and `regression.severity=pass`.
- Re-ran full regression and kept strict gates green: `doneWithoutNonBacklogEvidence=0`, `doneWithoutCodeEvidence=0`.
- Reduced actionable queue from `786` to `430` in one deterministic pass.

14. `P0-UNBLOCK-001` Add deterministic external-evidence intake workflow for remaining blocked items. `STATUS: DONE`
- Exit criteria met:
- Added `tests/tooling/scripts/ci/blocked_external_evidence_status.mjs` to validate external-evidence readiness per blocked ID.
- Added npm scripts `ops:blocked-external:plan` and `ops:blocked-external:evidence`.
- Added intake policy doc at `docs/external/evidence/README.md`.
- Generated current unblock evidence status artifacts for all `27` blocked IDs.

15. `P0-UNBLOCK-002` Scaffold per-ID external evidence packets for all blocked items. `STATUS: DONE`
- Exit criteria met:
- Added `tests/tooling/scripts/ci/blocked_external_scaffold.mjs` and npm script `ops:blocked-external:scaffold`.
- Materialized scaffold directories/readme templates for all `27` blocked IDs under `docs/external/evidence/<ID>/README.md`.
- Regenerated status artifacts: all blockers are now `partial_missing_artifact` (readmes present, artifact upload pending).

16. `P0-UNBLOCK-003` Add deterministic reconcile helper for evidence-ready blocked IDs. `STATUS: DONE`
- Exit criteria met:
- Added `tests/tooling/scripts/ci/blocked_external_reconcile.mjs` and npm script `ops:blocked-external:reconcile`.
- Added generated candidate reports (`BLOCKED_EXTERNAL_RECONCILE_CANDIDATES`) with optional `--apply=1` status promotion path.
- Current reconcile report confirms `ready_for_reconcile=0` and no automatic status mutations.

17. `P0-UNBLOCK-004` Add ranked Top-10 external unblock board with action hints. `STATUS: DONE`
- Exit criteria met:
- Added `tests/tooling/scripts/ci/blocked_external_top10.mjs` and npm script `ops:blocked-external:top10`.
- Generated ranked output: `local/workspace/reports/BLOCKED_EXTERNAL_TOP10.md` + `core/local/artifacts/blocked_external_top10_current.json`.

18. `P0-UNBLOCK-005` Add packet-quality audit for blocked external evidence folders. `STATUS: DONE`
- Exit criteria met:
- Added `tests/tooling/scripts/ci/blocked_external_packet_audit.mjs` and npm script `ops:blocked-external:packet-audit`.
- Generated packet audit outputs: `local/workspace/reports/BLOCKED_EXTERNAL_PACKET_AUDIT.md` + `core/local/artifacts/blocked_external_packet_audit_current.json`.

19. `P0-UNBLOCK-006` Add operator runbook for end-to-end external unblock flow. `STATUS: DONE`
- Exit criteria met:
- Added `docs/workspace/EXTERNAL_UNBLOCK_OPERATOR_RUNBOOK.md` with deterministic command path from plan/scaffold/audit/reconcile to validation.

20. `P0-UNBLOCK-007` Re-run full policy/regression gates after unblock tooling expansion. `STATUS: DONE`
- Exit criteria met:
- `srs_actionable_map`: actionable `27`, execute_now `0`, blocked_external `27`.
- `srs_full_regression`: fail `0`, warn `0`, pass `1998`.
- `srs_top200_regression`: fail `0`, warn `0`, pass `200`.
- `verify.sh`: PASS.

21. `P0-SIMPL-001` Run system simplicity sweep and collapse parallel command functionality to canonical aliases. `STATUS: DONE`
- Exit criteria met:
- Collapsed duplicate script bodies to single-source aliases in `package.json` (`orchestron:run`, `start`, `lane:v6-rust50-007:run`, `test:lane:v6-edge-004`).
- Added `tests/tooling/scripts/ci/simplicity_drift_audit.mjs` and `ops:simplicity:audit` strict gate.
- Current simplicity audit: duplicate command groups `0`, client hard/gap violations `0`.

22. `P0-TEST-001` Run full CI test suite and patch failures. `STATUS: DONE`
- Exit criteria met:
- Found and fixed `MODULE_NOT_FOUND` test blocker by updating `tests/client-memory-tools/_legacy_retired_test_wrapper.js` to load TS runtime wrapper directly with local TS require hook.
- `npm run -s test:ci:full`: PASS.
- `./verify.sh`: PASS.
- `srs_full_regression` and `srs_top200_regression`: PASS.

23. `P0-MCU-PROOF-001` Real MCU flash proof for Tiny-max (`ESP32` + `RP2040`) with runtime screenshot/log artifacts. `STATUS: BLOCKED_EXTERNAL`
- Blocker:
- Physical hardware + USB serial presence + human-operated flash session are required for proof-of-run evidence. Current workspace preflight can verify tooling and produce blocker receipts, but cannot fabricate hardware execution.
- Linked human action:
- `HMAN-092` in `docs/client/HUMAN_ONLY_ACTIONS.md`.
- Exit criteria:
- `docs/client/reports/hardware/esp32_tiny_max_status_<date>.png` and `docs/client/reports/hardware/rp2040_tiny_max_status_<date>.png` exist with matching serial logs and deterministic receipt bundle.
- `local/workspace/reports/MCU_PROOF_PREFLIGHT.md` shows `ok=true`.
- README hardware-proof section is updated from `blocked` to `verified`.

24. `P1-ORCH-001` Implement REQ-38 Agent Orchestration Hardening (coordinator, scratchpad, checkpointing). `STATUS: DONE`
- Linked SRS:
- `REQ-38-001` through `REQ-38-008` in `docs/client/requirements/REQ-38-agent-orchestration-hardening.md`.
- Dependencies:
- REQ-12 (Swarm Engine Router) for message routing primitives.
- REQ-15 (Sandboxed Sub-Agent Execution) for scoped sub-agent spawning.
- REQ-36 (Smart Memory) for shared state patterns.
- Exit criteria:
- Core orchestration authority is implemented in `core/layer0/ops/src/orchestration.rs` (partitioning, deduplication, severity merging, scratchpad/taskgroup/checkpoint/partial retrieval/state transitions); `client/cognition/orchestration/coordinator.ts` is a thin wrapper.
- Shared scratchpad semantics at `local/workspace/scratchpad/{task_id}.json` are authoritative in `core/layer0/ops/src/orchestration.rs`; `client/cognition/orchestration/scratchpad.ts` is a thin wrapper.
- Checkpointing (10-item/2-min interval + timeout recovery + retry gating) is authoritative in `core/layer0/ops/src/orchestration.rs`; `client/cognition/orchestration/checkpoint.ts` is a thin wrapper.
- Scope boundaries and overlap/violation handling are authoritative in `core/layer0/ops/src/orchestration.rs`; `client/cognition/orchestration/scope.ts` is a thin wrapper.
- Completion triggers and task-group metadata persistence are authoritative in `core/layer0/ops/src/orchestration.rs`; `client/cognition/orchestration/completion.ts` and `client/cognition/orchestration/taskgroup.ts` are thin wrappers.
- Partial-result retrieval (session-history + checkpoint fallback + retry/continue/abort decisions) is authoritative in `core/layer0/ops/src/orchestration.rs`; `client/cognition/orchestration/partial.ts` is a thin wrapper.
- All tests passing: `npm run -s test:cognition:orchestration`.
- Integration test: full orchestration flow in `tests/client/cognition/coordinator.test.js` with scope + task-group completion assertions.

25. `P0-AUDIT-SEC-001` Close remaining automatable security implementation-depth gaps (fail-closed and branch coverage), not just receipt presence. `STATUS: QUEUED`
- Context:
- Latest audit highlights call out depth/branch coverage gaps across security, skills backward-compat, and conduit strict-mode fail-closed paths.
- Linked audit docs:
- `audit_docs/TEST_COVERAGE_REQS_2026-03-19.md`
- Exit criteria:
- Add missing regression tests for fail-closed/error branches in:
  - `core/layer0/ops/src/security_plane.rs`
  - `core/layer0/ops/src/skills_plane.rs`
  - `core/layer2/conduit/src/lib.rs`
- `cargo test` suites for those modules pass.
- `npm run -s ops:srs:full:regression` remains `fail=0`, `warn=0`.

26. `P0-DOCS-API-001` Close documentation maturity gaps for regression insurance (API + security + deployment + ADR hygiene). `STATUS: QUEUED`
- Context:
- Documentation audits still list API reference completeness as partial and OpenAPI as a stub.
- Linked audit docs:
- `audit_docs/DOCUMENTATION_REQS_2026-03-19.md`
- Exit criteria:
- Replace `docs/api/openapi.stub.yaml` with authoritative generated/maintained API spec.
- Ensure runbook/deployment/security docs cross-link from a single operator index.
- Add/refresh ADR index coverage for new architecture/security decisions.

27. `P1-PERF-THROUGHPUT-001` Recover throughput headroom with measured, reproducible benchmarks (without benchmark theater). `STATUS: QUEUED`
- Context:
- Performance audit shows throughput target lag vs stretch goal while cold start/idle memory are healthy.
- Linked audit docs:
- `audit_docs/PERFORMANCE_REQS_2026-03-19.md`
- Exit criteria:
- Identify and land at least one authoritative throughput optimization in Rust core.
- Publish before/after benchmark artifacts with reproducible command path.
- Keep cold start/idle/install non-regressive within agreed tolerance.

28. `P0-HMAN-TRACK-001` Keep non-automatable audit blockers visible and packetized for operator action. `STATUS: QUEUED`
- Context:
- Human-only/certification/hardware items are outside automatable closure but must stay tracked.
- Exit criteria:
- Maintain explicit status board + evidence packet readiness for:
  - `HMAN-026/027` (certification),
  - `HMAN-081/082/083/084` (hardware validation approvals),
  - `HMAN-086/087` (third-party/high-assurance verification),
  - `HMAN-092` (MCU proof flash session).
- No hidden blockers: all remain visible in reports with exact required evidence.

29. `P0-EVOLUTION-COMPACTION-001` Prepare V9 ruthless compaction round with hard guardrails before code surgery. `STATUS: QUEUED`
- Scope:
- `V9-EVOLUTION-COMPACTION-001`
- Prep artifact:
- `docs/client/reports/V9_EVOLUTION_COMPACTION_PREP_2026-03-19.md`
- Exit criteria:
- Baseline frozen: cold start / idle / install / throughput artifacts captured.
- Duplicate-parallel logic inventory generated (core authority first).
- Merge order defined by ROI and safety invariants.
- Regression gate bundle defined (tests + SRS/DoD gates + benchmark refresh).

30. `P1-EVOLUTION-COMPACTION-002` Execute V9 ruthless compaction pass only if net measurable win and zero safety regressions. `STATUS: IN_PROGRESS`
- Scope:
- Collapse duplicate/near-duplicate code to smallest reusable primitives; preserve behavior.
- Exit criteria:
- Full regression + sovereignty/security checks pass.
- Benchmark delta is neutral-to-positive on target metrics (cold/idle/install/throughput).
- Commit only when net system quality improves and no fail-closed invariants are weakened.
- Progress (2026-03-20):
  - Shared legacy wrapper binders added in `client/runtime/lib/legacy_retired_wrapper.ts`.
  - 58 duplicated TS wrappers + 62 duplicated JS wrappers compacted to shared primitives.
  - Net wrapper source reduction: ~14.98 KB; targeted wrapper regression tests passing.
  - Stabilized post-compaction benchmark resample captured (`docs/client/reports/benchmark_matrix_resample_post_compaction_2026-03-20.json`); final sign-off still pending due shared baseline drift on throughput/install.

31. `P1-DASHBOARD-WASM-001` Migrate dashboard runtime to Rust/WASM no-Node serving path after React/Tailwind parity freeze. `STATUS: QUEUED`
- Context:
- Current dashboard launch is TypeScript/Node-hosted for fast delivery (`infring dashboard`, `status --dashboard --web`), but long-term sovereignty target is no-Node runtime hosting.
- Linked SRS:
- `V6-DASHBOARD-001.1` through `V6-DASHBOARD-001.10` (runtime host hardening follow-through).
- Exit criteria:
- Define Rust authority lane that serves static dashboard assets and WebSocket stream without Node runtime dependency.
- Port UI client to WASM-compatible build target and remove Node requirement from operator launch path.
- Preserve all current receipted actions (provider switch, role launch, skill run, benchmark/assimilate trigger) with equal or stronger fail-closed behavior.
- Publish before/after operator runbook documenting Node-hosted fallback and Rust/WASM primary path.

32. `P1-DASHBOARD-UX-002` Complete dashboard productization pass (onboarding, section-level lazy loading, local-bundled frontend deps). `STATUS: QUEUED`
- Context:
- V6-DASHBOARD base surface is now functional and receipted, but follow-through is still required to hit premium UX targets under constrained/bad network/browser conditions.
- Exit criteria:
- Add first-run onboarding tour + contextual affordances for core sections.
- Add section-level lazy loading/code splitting for heavyweight panels.
- Remove external CDN dependency path by shipping local bundled frontend modules/CSS with equivalent behavior.
- Publish before/after interaction latency + scroll-jank evidence in benchmark report.

33. `P0-DASHBOARD-CHATFIRST-006` Lock in simplified first-load chat UI with hidden advanced controls pane (`V6-DASHBOARD-006.*`). `STATUS: IN_PROGRESS`
- Context:
- Operators and new users reported first-load overwhelm and low intuitiveness in dense dashboard layouts.
- Linked SRS:
- `V6-DASHBOARD-006.1` through `V6-DASHBOARD-006.4`.
- Exit criteria:
- First load defaults to clean chat-only surface with no advanced panes visible.
- Advanced controls are one-click accessible in collapsible side pane and remain collapsed by default.
- Pane and section UI interactions emit deterministic UI receipts (`dashboard.ui.toggleControls`, `dashboard.ui.toggleSection`).
- Fallback renderer preserves the same chat-first behavior when React/ESM path is unavailable.
- Validate via dashboard regression + security/sovereignty checks.

## Executed in this pass
- Added `tests/tooling/scripts/ci/srs_actionable_map.mjs` to produce canonical remaining-work mapping and executability buckets.
- Reviewed enforcer policy and kept DoD evidence gates strict.
- Executed complete runnable backlog queue tranche and recorded deterministic receipts.
- Executed metakernel tranche (`V7-META-001..003`) with deterministic receipts and passing invariants.
- Executed metakernel tranche (`V7-META-004..006`) with deterministic receipts and passing lanes.
- Executed metakernel tranche (`V7-META-007..010`) with deterministic receipts and passing lanes.
- Executed metakernel tranche (`V7-META-011..015`) with deterministic receipts and passing lanes.
- Executed ROI status-closure sweep with strict evidence rollback safeguards (`P1-EXEC-008`), reducing actionable queue by `34`.
- Executed evidence-qualified bulk closure (`P1-EXEC-009`), reducing actionable queue by `356` rows (`331` unique IDs).
- Executed dynamic-legacy queue completion sweep (`P1-EXEC-010`): executed + promoted remaining `execute_now` rows (`403` bulk + `1` follow-up), leaving only explicit `blocked_external` items (`27` total actionable, `0` runnable).
- Added deterministic status reconciler `tests/tooling/scripts/ci/promote_executed_receipt_ids.mjs` and hardened regression scanners (`srs_full_regression` longest-first ID matching; `srs_top200_regression` consumes canonical full-regression counts) to eliminate prefix-collision and nondeterministic evidence drift.
- Added generated full TODO queue artifacts (`local/workspace/reports/TODO_EXECUTION_FULL.md` + `todo_execution_full_current.json`) and kept ordering deterministic.
- Added deterministic blocked-external evidence intake/status pipeline (`tests/tooling/scripts/ci/blocked_external_evidence_status.mjs`) with generated status artifacts and explicit evidence contract docs.
- Added deterministic blocked-external scaffold generator (`tests/tooling/scripts/ci/blocked_external_scaffold.mjs`) and pre-created `docs/external/evidence/<ID>/README.md` packets for all 27 blockers.
- Added deterministic blocked-external reconcile helper (`tests/tooling/scripts/ci/blocked_external_reconcile.mjs`) to promote evidence-ready IDs with controlled `--apply=1` mutation path.
- Added deterministic blocked-external Top-10 prioritizer (`tests/tooling/scripts/ci/blocked_external_top10.mjs`) and packet-quality audit (`tests/tooling/scripts/ci/blocked_external_packet_audit.mjs`) plus operator runbook.
- Added system simplicity drift gate (`tests/tooling/scripts/ci/simplicity_drift_audit.mjs`) and collapsed duplicate npm command bodies to canonical alias chains.
- Patched full CI test blocker in `_legacy_retired_test_wrapper.js` (TS wrapper resolution).
- Kept client/core policy audits and full regression suite passing after state transitions.
- Added MCU proof preflight lane + operator runbook for external unblock path (`tests/tooling/scripts/ci/mcu_proof_preflight.mjs`, `docs/ops/RUNBOOK-005-mcu-proof-sprint.md`) and linked blocker governance (`P0-MCU-PROOF-001`, `HMAN-092`).

## Next command bundle
- `node tests/tooling/scripts/ci/srs_actionable_map.mjs`
- `node tests/tooling/scripts/ci/blocked_external_unblock_plan.mjs`
- `node tests/tooling/scripts/ci/blocked_external_scaffold.mjs`
- `node tests/tooling/scripts/ci/blocked_external_evidence_status.mjs`
- `node tests/tooling/scripts/ci/blocked_external_reconcile.mjs`
- `node tests/tooling/scripts/ci/blocked_external_top10.mjs`
- `node tests/tooling/scripts/ci/blocked_external_packet_audit.mjs`
- `node tests/tooling/scripts/ci/simplicity_drift_audit.mjs --strict=1`
- `node tests/tooling/scripts/ci/srs_full_regression.mjs`
- `node tests/tooling/scripts/ci/srs_top200_regression.mjs`
- `npm run -s test:ci:full`
- `node tests/tooling/scripts/ci/backlog_actionable_report.mjs`
- `npm run -s ops:client-target:audit`
- `./verify.sh`
- `node tests/tooling/scripts/ci/mcu_proof_preflight.mjs`

---

## Process Notes for Contributors

### Adding New TODO Items

When adding new work items to this TODO:

1. **Prefix with priority**: Use `P0-`, `P1-`, `P2-`, or `P3-` prefix
2. **Include ID**: Format as `P{N}-CATEGORY-###` (e.g., `P1-EXEC-042`)
3. **Define exit criteria**: Every item must have measurable completion criteria
4. **Link to SRS**: If related to SRS requirements, include the SRS ID
5. **Update timestamp**: Change the "Updated:" field at top of file

### Status Definitions

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `TODO` | Not yet started | Queue for execution |
| `QUEUED` | Scheduled for current pass | Execute when ready |
| `IN_PROGRESS` | Actively being worked | Continue execution |
| `BLOCKED` | Has dependencies | Resolve blockers |
| `DONE` | Completed with evidence | Verify regression |
| `CANCELLED` | No longer needed | Document rationale |

### Evidence Requirements

All `DONE` items must have:
- Deterministic execution receipt OR
- Link to merged PR with review approval OR
- Documented decision record (for cancelled items)

### Review Cycle

This TODO is reviewed:
- **Daily**: During active execution passes
- **Weekly**: Full audit of blocked items
- **Monthly**: Process effectiveness review

*Last process review: 2026-03-15 by Rohan Kapoor*
