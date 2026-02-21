# Upgrade Backlog

Purpose: track future upgrades without mixing them into active implementation threads.

Status legend:
- `todo` not started
- `doing` actively in progress
- `blocked` waiting on dependency/decision
- `done` completed

## P0

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-001 | done | External temp-data backup pipeline (outside git) | Preserve high-churn runtime/state data without repo noise | `systems/ops/state_backup.js` + `config/state_backup_policy.json`, optional daily spine hook (`STATE_BACKUP_ENABLED=1`), retention policy encoded |
| BL-002 | done | Skill quarantine enforcement in all install paths | Prevent unreviewed skill install bypasses | Strict enforcer scans `systems/`, `habits/`, `skills/`, and `memory/tools/` (tests excluded), blocks direct installer patterns (shell + spawn/exec forms), and requires wrapper + quarantine structure to pass |
| BL-003 | done | Autonomy receipt dashboard/summary | Make pass/fail verification visible without raw log digging | Daily summary command/report shows receipt pass rate + top failure reasons |
| BL-013 | done | AGI security/governance hardening pack | Prevent capability-overhang failures as model capability increases | Dual-control approval for strategy mode escalation + non-bypass budget/risk caps + immutable policy/kernel verification + one-command emergency stop path tested |
| BL-017 | done | Autonomous skill-add with necessity justification gate | Allow Protheus to add skills safely only when operationally justified | `install_skill_safe.js` enforces necessity scoring for `--autonomous=1` installs using policy-defined structured justification (`problem`, `repeat_frequency`, `expected_time_or_token_savings`, `risk_class`, `why_existing_habits_or_skills_insufficient`); novelty-only reasons are blocked with receipts |

## P1

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-004 | done | Policy for tracked vs ignored state streams | Keep audit logs intentional and reduce accidental tracking drift | One doc defines tracked state classes and `.gitignore` alignment |
| BL-005 | done | Habit promotion quality hardening | Prevent no-op scaffolds from promoting without real value | Promotion checks include measured savings/effect threshold |
| BL-006 | done | Automated stale-state cleanup helper | Reduce local churn from old generated artifacts | Non-destructive cleanup command with dry-run and allowlist |
| BL-009 | done | Hardware-aware local model planner | Keep local routing aligned with actual machine capacity | Router can detect CPU/RAM/VRAM class, recommend/update eligible local models, and log changes before activation |
| BL-010 | done | Model variant profiles (`:thinking` and base) | Use reasoning variants only when justified to control cost/latency | Routing policy defines when to use thinking variants, with auto-return to anchor model and measurable quality gain |
| BL-011 | todo | Swarm verification mode for deep-thinker | Multi-agent cross-check for high-stakes reasoning once swarm capability exists | Deep-thinker can run parallel model checks with quorum/consensus policy and bounded token budget |
| BL-012 | done | Strategy profile layer + architecture genericity guard | Keep specialization out of `systems/` while enabling adaptive policy | `config/strategies/` active profile loaded by autonomy gates; architecture guard available in audit/strict modes; initial rollout uses `execution_policy.mode=score_only` |
| BL-014 | todo | Phased TypeScript migration for `systems/` + `lib/` | Reduce contract drift and runtime breakage in high-permanence layers without rewriting architecture | `tsconfig` added; `systems/` + `lib/` run type-check clean in CI (`--noEmit`); migration done file-by-file with compatibility wrappers and zero behavior regressions |
| BL-015 | todo | Optional reflex sub-layer under habits (fast micro-routines) | Improve adaptation latency for frequent tiny tasks without promoting permanent system changes | Add `habits/reflexes/` runtime path and tiny-model executor; reflex generation/degradation mirrors habit promotion/decay rules; router can prefer reflex before habit when confidence and latency budget are met |
| BL-016 | todo | Cross-device active-state continuity layer | Preserve in-flight autonomy/routing context when switching active shell/device without split-brain | Add `systems/continuity/` with lease-based active writer election, checkpoint + delta replay state transfer, takeover on lease expiry, and secret-safe payload policy (no raw creds in continuity artifacts) |
| BL-018 | done | Proposal admission + queue hygiene hardening | Reduce duplicate/stub/unknown-eye noise before autonomy selection | `sensory_queue` dedupes by `proposal_id`, static gate filters stub/unknown-eye eye-attributed proposals, lifecycle status normalized (`filtered` instead of `unknown`), and tests cover quality + dedupe behavior |
| BL-019 | todo | Optional habit cell-pool executor (parallelized by demand + hardware caps) | Extend reflex-style dynamic concurrency to habit execution only if measured ROI justifies complexity | Add bounded habit worker pool with hysteresis/cooldowns, per-habit safety gates, and rollback-safe default-off rollout |
| BL-020 | todo | Ignore memory snapshots after backup channels are verified | Keep repo clean once adaptive/normal memory have reliable off-repo backup/restore | Define backup integrity checks for memory snapshots, then add scoped `.gitignore` rules for backup-only memory artifacts without ignoring source/config/governance files |
| BL-021 | done | End-to-end pipeline integration tests (`eyes -> insight -> queue -> execute -> receipt -> score`) | Catch regressions that unit tests miss in autonomous flow handoffs | Added deterministic E2E handoff test covering generated + filtered proposals, actuation bridge wiring, dry-run execution, and contract receipt assertions (`memory/tools/tests/pipeline_handoffs.integration.test.js`) |
| BL-022 | done | Two-phase autonomous change execution with automatic rollback | Prevent partial/bad self-changes from persisting | Added `improvement_controller.js start-validated` implementing deterministic `plan -> apply(commit-on-head) -> verify(core checks) -> commit(trial start)` flow; failed verify triggers optional auto-revert and writes contract receipts with root cause (`state/autonomy/improvements/phase_receipts/`) |
| BL-023 | done | Unified global budget governor across reflex/autonomy/focus/dream/spawn | Prevent resource contention and runaway loops under concurrent adaptive workloads | Spawn token budgeting now shares global `system_budget` state/events path by default, autonomy reads same global state dir, focus controller enforces per-run budget gating + writes allow/degrade/deny decisions, and all contention decisions are auditable in centralized budget events |
| BL-024 | done | Event/state schema versioning + validators + migrations | Eliminate silent JSON/JSONL contract drift over time | All persisted contracts carry `schema_version`; reads validate; controlled migrations exist for version bumps |
| BL-025 | todo | Outcome-linked routing learning by task type | Improve model selection quality beyond availability/latency signals | Router maintains `task_type x model` success matrix and uses it in ranking/escalation decisions with measurable uplift |
| BL-026 | todo | Ops visibility dashboard + SLO alerts for autonomy health | Make drift/stalls visible before they degrade autonomy quality | Daily/weekly report includes dark-eye, proposal starvation, loop stall, and drift SLOs with thresholded alerts |
| BL-027 | todo | Execution-worthiness scoring at queue admission | Prioritize proposals that are concrete and executable, not meta-coordination noise | Queue admission computes deterministic execution-worthiness score (objective clarity, command concreteness, verification strength, rollback quality) and blocks low-scoring proposals with explicit reasons |
| BL-028 | todo | Outcome calibration by proposal type | Tune admission thresholds using per-type shipped/no-change outcomes | Weekly calibrator updates bounded threshold offsets per proposal type (`collector_remediation`, `opportunity_capture`, etc.) and writes audit receipts for every change |
| BL-029 | todo | Weekly strategy synthesis from executed outcomes | Ensure strategy layer learns from realized outcomes instead of raw proposal volume | Scheduled synthesis summarizes executed proposals, winners/losers, and recommended strategy weight updates with deterministic trace to receipts |
| BL-030 | todo | Secret broker isolation + scoped credential handles | Prevent high-capability models from directly reading raw secrets from disk during autonomous changes | Introduce broker API that returns time-scoped handles instead of raw secret values; autonomous flows use handles only; all secret reads audited with caller/scope |
| BL-031 | todo | Network egress choke point for autonomous actions | Reduce exfiltration/abuse blast radius by forcing all outbound actions through a policy gate | All autonomous external calls route through one egress gateway with allowlisted domains/methods, per-scope rate caps, and deny/audit receipts |
| BL-032 | todo | Signed startup attestation + integrity check at run boot | Detect tampering before autonomy loops execute | Boot path emits signed attestation over critical policy/config hashes; autonomy refuses execute/canary when attestation fails or is stale |
| BL-033 | todo | Quorum validator for high-tier self-modification proposals | Add independent cross-check before risky self-edits are applied | High-tier mutation proposals require deterministic second-pass validator agreement before admission; disagreement blocks with explainable receipt |
| BL-034 | done | Operator runbook for incidents + rollback drills | Reduce time-to-recover and remove tribal-knowledge dependency during failures | Implemented in `docs/OPERATOR_RUNBOOK.md` with top incident classes (routing degraded, schema drift, sensory starvation, autonomy stall), deterministic remediation, rollback drill, and verification artifacts |
| BL-035 | done | Required-Checks branch protection policy | Prevent contract/security regressions from merging without gates | Implemented `.github/CODEOWNERS`, `.github/workflows/required-checks.yml`, `docs/BRANCH_PROTECTION_POLICY.md`, and local `npm run guard:merge` gates requiring `test:ci`, `contract_check`, `schema_contract_check`, and adaptive guard strict checks |

## P2

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-007 | todo | Backup integrity checks | Catch silent backup corruption | Scheduled hash verification and alert on mismatch |
| BL-008 | todo | Repo hygiene CI check for generated artifacts | Prevent noisy files slipping into PRs | CI fails if generated paths are staged unexpectedly |

## Notes

- Keep this file focused on upgrades (not daily tasks).
- Prefer adding one line per upgrade with concrete exit criteria.
- When an item starts, switch `Status` to `doing` and link the implementation commit(s).
- Tier policy: keep 3 tiers by default; add extra tiers only if telemetry shows persistent misrouting or cost/latency pressure that role-specialization cannot solve.
