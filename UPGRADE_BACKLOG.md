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
| BL-036 | done | Strategic alignment oracle (weekly) | Keep unattended autonomy optimizing for T1 outcomes instead of infrastructure churn | `systems/autonomy/alignment_oracle.js` writes weekly `alignment_score` artifacts (`state/autonomy/alignment_oracle/`), links to proposal/receipt evidence, emits deduped `autonomy_human_escalation` rows on low-streak escalation, and is executed by spine via `SPINE_ALIGNMENT_ORACLE_ENABLED` |
| BL-037 | done | Exception novelty classifier + recovery policy | Prevent retry spirals and route genuinely new failures to human review quickly | Classifier stores signature memory and now applies deterministic recovery decisions from `config/autonomy_exception_recovery_policy.json`; autonomy exception telemetry includes action/cooldown/playbook fields, and novel signatures route to escalation policy |
| BL-038 | todo | Global cost governor + autopause guardrails | Enforce hard resource boundaries across autonomy/reflex/focus/dream paths | Unified daily/monthly budget policies apply to all adaptive executors, burn-rate spike and low-credit thresholds trigger automatic pause/degrade actions, and every block/allow decision is audit-logged with reason |
| BL-039 | done | Dream-to-upstream signal bridge | Ensure dream outputs influence proposal/admission/ranking instead of remaining passive artifacts | Proposal enrichment/autonomy ranking ingest dream tokens/themes (bounded influence + audit fields), and runs emit measurable dream-hit attribution in proposal metadata |
| BL-040 | done | Adaptive dream-model failover + cooldown memory | Prevent repeated `smallthinker` timeout loops and keep dream cycle resilient | Idle/REM model selection records per-model timeout/error history, applies cooldown/backoff, auto-fails over to alternate local models, and logs fallback reasons deterministically |

## P1

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-004 | done | Policy for tracked vs ignored state streams | Keep audit logs intentional and reduce accidental tracking drift | One doc defines tracked state classes and `.gitignore` alignment |
| BL-005 | done | Habit promotion quality hardening | Prevent no-op scaffolds from promoting without real value | Promotion checks include measured savings/effect threshold |
| BL-006 | done | Automated stale-state cleanup helper | Reduce local churn from old generated artifacts | Non-destructive cleanup command with dry-run and allowlist |
| BL-009 | done | Hardware-aware local model planner | Keep local routing aligned with actual machine capacity | Router can detect CPU/RAM/VRAM class, recommend/update eligible local models, and log changes before activation |
| BL-010 | done | Model variant profiles (`:thinking` and base) | Use reasoning variants only when justified to control cost/latency | Routing policy defines when to use thinking variants, with auto-return to anchor model and measurable quality gain |
| BL-011 | done | Swarm verification mode for deep-thinker | Multi-agent cross-check for high-stakes reasoning once swarm capability exists | Deep-thinker can run parallel model checks with quorum/consensus policy and bounded token budget |
| BL-012 | done | Strategy profile layer + architecture genericity guard | Keep specialization out of `systems/` while enabling adaptive policy | `config/strategies/` active profile loaded by autonomy gates; architecture guard available in audit/strict modes; initial rollout uses `execution_policy.mode=score_only` |
| BL-014 | doing | Phased TypeScript migration for `systems/` + `lib/` | Reduce contract drift and runtime breakage in high-permanence layers without rewriting architecture | Phase 0-1 scaffold landed (`tsconfig.base.json`, `tsconfig.systems.json`, `npm run typecheck:systems`) with initial `@ts-check`+JSDoc subset; continue file-by-file until `systems/` + `lib/` type-check clean (`--noEmit`) |
| BL-015 | done | Optional reflex sub-layer under habits (fast micro-routines) | Improve adaptation latency for frequent tiny tasks without promoting permanent system changes | Add `habits/reflexes/` runtime path and tiny-model executor; reflex generation/degradation mirrors habit promotion/decay rules; router can prefer reflex before habit when confidence and latency budget are met |
| BL-016 | done | Cross-device active-state continuity layer | Preserve in-flight autonomy/routing context when switching active shell/device without split-brain | Add `systems/continuity/` with lease-based active writer election, checkpoint + delta replay state transfer, takeover on lease expiry, and secret-safe payload policy (no raw creds in continuity artifacts) |
| BL-018 | done | Proposal admission + queue hygiene hardening | Reduce duplicate/stub/unknown-eye noise before autonomy selection | `sensory_queue` dedupes by `proposal_id`, static gate filters stub/unknown-eye eye-attributed proposals, lifecycle status normalized (`filtered` instead of `unknown`), and tests cover quality + dedupe behavior |
| BL-019 | done | Optional habit cell-pool executor (parallelized by demand + hardware caps) | Extend reflex-style dynamic concurrency to habit execution only if measured ROI justifies complexity | Add bounded habit worker pool with hysteresis/cooldowns, per-habit safety gates, and rollback-safe default-off rollout |
| BL-020 | done | Ignore memory snapshots after backup channels are verified | Keep repo clean once adaptive/normal memory have reliable off-repo backup/restore | Define backup integrity checks for memory snapshots, then add scoped `.gitignore` rules for backup-only memory artifacts without ignoring source/config/governance files |
| BL-021 | done | End-to-end pipeline integration tests (`eyes -> insight -> queue -> execute -> receipt -> score`) | Catch regressions that unit tests miss in autonomous flow handoffs | Added deterministic E2E handoff test covering generated + filtered proposals, actuation bridge wiring, dry-run execution, and contract receipt assertions (`memory/tools/tests/pipeline_handoffs.integration.test.js`) |
| BL-022 | done | Two-phase autonomous change execution with automatic rollback | Prevent partial/bad self-changes from persisting | Added `improvement_controller.js start-validated` implementing deterministic `plan -> apply(commit-on-head) -> verify(core checks) -> commit(trial start)` flow; failed verify triggers optional auto-revert and writes contract receipts with root cause (`state/autonomy/improvements/phase_receipts/`) |
| BL-023 | done | Unified global budget governor across reflex/autonomy/focus/dream/spawn | Prevent resource contention and runaway loops under concurrent adaptive workloads | Spawn token budgeting now shares global `system_budget` state/events path by default, autonomy reads same global state dir, focus controller enforces per-run budget gating + writes allow/degrade/deny decisions, and all contention decisions are auditable in centralized budget events |
| BL-024 | done | Event/state schema versioning + validators + migrations | Eliminate silent JSON/JSONL contract drift over time | All persisted contracts carry `schema_version`; reads validate; controlled migrations exist for version bumps |
| BL-025 | done | Outcome-linked routing learning by task type | Improve model selection quality beyond availability/latency signals | Router maintains `task_type x model` success matrix and uses it in ranking/escalation decisions with measurable uplift |
| BL-026 | done | Ops visibility dashboard + SLO alerts for autonomy health | Make drift/stalls visible before they degrade autonomy quality | Daily/weekly report includes dark-eye, proposal starvation, loop stall, and drift SLOs with thresholded alerts |
| BL-027 | done | Execution-worthiness scoring at queue admission | Prioritize proposals that are concrete and executable, not meta-coordination noise | Queue admission computes deterministic execution-worthiness score (objective clarity, command concreteness, verification strength, rollback quality) and blocks low-scoring proposals with explicit reasons |
| BL-028 | done | Outcome calibration by proposal type (post BL-027 companion) | Track pass-rate by proposal type and tune admission thresholds using per-type shipped/no-change outcomes | `outcome_fitness_loop` now emits bounded per-type threshold offsets (`strategy_policy.proposal_type_threshold_offsets`) plus per-type audit reasoning, writes calibration receipts on offset changes (`state/adaptive/strategy/receipts.jsonl`), and proposal admission/gating consume offsets via shared outcome-fitness policy helpers |
| BL-029 | done | Weekly strategy synthesis from executed outcomes | Ensure strategy layer learns from realized outcomes instead of raw proposal volume | Scheduled synthesis summarizes executed proposals, winners/losers, and recommended strategy weight updates with deterministic trace to receipts |
| BL-030 | done | Secret broker isolation + scoped credential handles | Prevent high-capability models from directly reading raw secrets from disk during autonomous changes | Added `lib/secret_broker.js` + `systems/security/secret_broker.js`; autonomous Moltbook flows issue/resolve time-scoped handles; credential reads centralized in broker and audited to `state/security/secret_broker_audit.jsonl` |
| BL-031 | done | Network egress choke point for autonomous actions | Reduce exfiltration/abuse blast radius by forcing all outbound actions through a policy gate | Added `lib/egress_gateway.js` + `systems/security/egress_gateway.js` with `config/egress_gateway_policy.json`; sensory collectors/focus and Moltbook API/guard route outbound HTTP through gateway with allowlists, rate caps, and decision audits in `state/security/egress_audit.jsonl` |
| BL-032 | done | Signed startup attestation + integrity check at run boot | Detect tampering before autonomy loops execute | Boot path emits signed attestation over critical policy/config hashes; autonomy refuses execute/canary when attestation fails or is stale |
| BL-033 | done | Quorum validator for high-tier self-modification proposals | Add independent cross-check before risky self-edits are applied | High-tier mutation proposals require deterministic second-pass validator agreement before admission; disagreement blocks with explainable receipt |
| BL-034 | done | Operator runbook for incidents + rollback drills | Reduce time-to-recover and remove tribal-knowledge dependency during failures | Implemented in `docs/OPERATOR_RUNBOOK.md` with top incident classes (routing degraded, schema drift, sensory starvation, autonomy stall), deterministic remediation, rollback drill, and verification artifacts |
| BL-035 | done | Required-Checks branch protection policy | Prevent contract/security regressions from merging without gates | Implemented `.github/CODEOWNERS`, `.github/workflows/required-checks.yml`, `docs/BRANCH_PROTECTION_POLICY.md`, and local `npm run guard:merge` gates requiring `test:ci`, `contract_check`, `schema_contract_check`, and adaptive guard strict checks |
| BL-041 | doing | Batch execution lane for low-urgency LLM work | Capture major token-cost reductions on deferable workloads without hurting latency-critical tasks | Add queueable batch adapter path for low-urgency tasks with deterministic SLA/expiry rules, per-task receipts, and measured token-cost delta vs non-batch baseline |
| BL-042 | done | Prompt/result cache with TTL + invalidation policy | Reduce repeated LLM spend on near-identical requests while preserving correctness | `systems/routing/llm_gateway.js` now stores prompt/result cache entries with TTL + LRU pruning in `state/routing/prompt_result_cache`, supports source fingerprint + bust key invalidation hooks, and emits cache-hit/miss telemetry in gateway audit logs |
| BL-043 | done | Parallel eyes execution with budget-aware concurrency | Improve sensory throughput without budget/network spikes | `habits/scripts/external_eyes.js` now supports bounded parallel eye runs (`EYES_PARALLEL_ENABLED`, `EYES_MAX_PARALLEL`), automatically contracts concurrency under budget pressure from system budget state, and logs active parallel mode/caps during run cycles |

## P2

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-007 | done | Backup integrity checks | Catch silent backup corruption | Scheduled hash verification and alert on mismatch |
| BL-008 | done | Repo hygiene CI check for generated artifacts | Prevent noisy files slipping into PRs | CI fails if generated paths are staged unexpectedly |

## V1 Hardening (Required for 6-Month Autopilot)

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| V1H-001 | todo | Full-pipeline integration/e2e hardening | Current tests cover slices; unattended autonomy needs deterministic coverage across all major handoffs | CI suite includes deterministic e2e for `spine -> eyes -> insight -> queue -> autonomy -> actuation -> receipt -> scoring` plus failure-path tests (timeout, rate-limit, rollback), and blocks merge on regressions |
| V1H-002 | done | Release-gate + canary/rollback enforcement expansion | Existing checks exist but canary/rollback discipline must be mandatory for self-change and high-risk lanes | `improvement_controller start-validated` now requires policy-root authorization (lease + approval note) before self-change trial start, and medium-risk executable proposals are blocked when rollback path signals are missing (`medium_risk_missing_rollback_path`) |
| V1H-003 | todo | Observability + SLO + runbook completion pass | Metrics/runbooks exist but unattended mode needs complete coverage with actionable alerts | Define and enforce SLOs for proposal throughput, verification pass-rate, dark-eye detection, dream degradation, and budget pressure; alert routes are wired and each alert maps to runbook procedures with tested drill evidence |
| V1H-004 | done | Threat-model-driven security test pack | Governance controls need explicit abuse-path validation before long unattended windows | `docs/THREAT_MODEL_V1.md` now defines prioritized abuse paths and `memory/tools/tests/security_threat_pack.test.js` enforces deterministic regression tests for prompt-injection ingress, unauthorized mutation, egress bypass, secret isolation/exfiltration, policy-root lease misuse, and integrity tamper paths |
| V1H-005 | done | Contract/version governance closure across adaptive boundaries | Schema/versioning exists, but cross-layer drift checks must be exhaustive to prevent silent corruption | `schema_contract_check` now enforces adaptive store `expected_version` pinning per store contract (eyes/focus/habits/reflex/strategy), and CI fails closed on version drift |

## V2

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| V2-001 | todo | Full repo TypeScript conversion (`.js` -> `.ts`) | Improve long-term maintainability and refactor safety once V1 critical-path typing is stable | Execute staged conversion waves across remaining directories, preserve runtime/contract parity, and pass full typecheck + contract + integration checks without `@ts-nocheck` |
| V2-002 | todo | Explore polyglot service modules behind strict contracts | Enable targeted non-TS modules only where ROI is proven (ecosystem/security/hot path) without creating architecture drift | Publish module contract spec (stdin/stdout JSON + receipt parity), ship one pilot module with benchmark + rollback path, and pass contract + integration tests with no control-plane changes outside adapters |
| V2-003 | todo | Dist runtime cutover + legacy paired JS retirement | Remove long-term TS/JS dual-maintenance cost without breaking runtime contracts | Runtime entrypoints and contract checks execute from deterministic `dist/` build output, paired in-tree compatibility JS removed after parity verification + rollback plan |
| V2-006 | todo | Task-type outcome learning upgrade | Improve model/tool routing quality using empirical task success patterns | Routing/ranking consumes rolling success matrix by task type and capability (not just availability), fallback chains auto-adjust after repeated failures, and offline report shows measurable uplift vs baseline policy |
| V2-007 | todo | Self-experimentation framework with promotion gates | Let system improve methods safely via evidence-based trials | A/B harness compares incumbent vs candidate workflows on matched tasks, promotion requires statistically meaningful improvement + safety parity, and failed experiments auto-revert with receipts and summary reports |
| V2-008 | todo | Global capability switchboard (security-locked) | Allow rapid feature/capability deactivation under drift or threat without allowing model-driven disablement of security controls | Add signed policy switchboard covering major feature lanes (autonomy, reflex, dreams, sensory depth/focus, routing modes, external actuation), enforce dual-control + clearance for toggles, deny all security-layer deactivation paths in code and policy, and emit immutable toggle audit receipts |
| V2-009 | todo | Exterior anti-sabotage shield + instant auto-reset | Prevent rogue external AI or out-of-channel mutations from silently corrupting system behavior | Add real-time mutation provenance monitor over protected system/config/adaptive-control paths, trigger immediate rollback to last attested-good snapshot on unauthorized writes, quarantine offending process/session, and emit immutable incident receipts with recovery SLA metrics |
| V2-010 | todo | Chaos testing program (adaptive + orchestration lanes) | Stress resilience under controlled failures once V1 hardening is stable | Scheduled chaos scenarios inject collector, routing, actuation, and state faults with pass/fail recovery metrics and no data-integrity violations |
| V2-011 | todo | Scale/performance benchmarking harness | Quantify headroom and bottlenecks before broader deployment | Reproducible load harness reports throughput, latency, error budget, and token efficiency at increasing workload tiers; baseline + regression thresholds enforced |
| V2-012 | todo | External security assessment and pen-test cycle | Independent validation reduces blind spots in internal security assumptions | Complete third-party security assessment with tracked findings, remediation plans, and verified closure receipts |
| V2-013 | todo | Compliance/reporting automation (optional enterprise track) | Enterprise deployment often requires auditable policy/report workflows | Automated generation of governance/security/change reports from receipts and logs with configurable retention and export controls |
| V2-014 | todo | Multi-team/multi-environment release governance | Support organization-scale ownership without destabilizing autonomy | Environment promotion policy (dev/stage/prod), ownership boundaries, and approval flows are codified and enforced in CI/CD with immutable audit trails |
| V2-015 | todo | Hardware-adaptive per-instance specialized model training (seed -> specialist) | Build long-term AI sovereignty so each deployment can reduce external model dependence with user-specific specialization | Ship offline data curation + license-safe seed model path, gated fine-tune pipeline (LoRA/QLoRA) with rollback/eval thresholds, hardware-aware training profiles, strict provenance/consent controls, and routing policy that only promotes specialized checkpoints after passing objective quality/safety/cost gates |
| V2-016 | todo | Dynamic optimization floor by objective criticality | Prevent endless low-impact self-tuning while allowing tighter thresholds for accuracy-critical domains | Classify objective criticality (safety/financial/reliability/standard ops), auto-set optimization floor bands (e.g., 10/5/2%), detect steady-state plateaus, and emit explicit `good_enough` decisions with override policy + audit receipts |
| V2-017 | todo | Optimization aperture sensing controller (risk-adaptive) | Automatically adjust how aggressively the system pursues optimization based on sensed risk profile of active work | Add a sensing controller that ingests current directive risk/impact context, computes an optimization aperture level per run/lane, writes policy decisions with receipts, and drives optimization gates/floors without hardcoded task-specific logic |

## V3 (Lamp / Super-Intelligence Containment)

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| V3-001 | todo | Recursive goal-preservation kernel | Ensure self-improvement cannot rewrite owner-alignment axioms | Introduce immutable goal-constitution contract with formal non-bypass checks; self-modification proposals that alter protected axioms are rejected and audited |
| V3-002 | todo | Capability ceiling + containment envelopes | Bound high-capability model action scope even if cognition increases sharply | Define per-capability hard ceilings (egress, spend, mutation, actuation) enforced by policy-root and emergency-stop layers with zero bypass paths in strict mode |
| V3-003 | todo | New-model vaccine sandbox (containment pen-test lane) | Validate containment against newly introduced models before production exposure | First-run model onboarding executes adversarial security challenge suite inside a disposable sandbox snapshot; only passing models can be promoted to active routing tiers |
| V3-004 | todo | Dual-control constitutional change governance | Prevent unilateral weakening of containment rules by any single actor/model | Any policy-root, integrity, or containment-rule mutation requires dual human approvals + signed receipts + delayed activation window with rollback |
| V3-005 | todo | External anti-sabotage provenance net | Detect and instantly recover from out-of-channel system tampering attempts | Real-time file provenance monitor over protected roots triggers automatic restore-to-last-attested snapshot + quarantine + immutable incident receipts |

## Backlog Policy

- Lower-impact items (<9% estimated gain) are intentionally parked below to protect V1 focus.
- Estimated impact values are directional deltas against current baseline behavior (throughput, quality, or token efficiency), not guarantees.

## Future Optimizations (<9% Estimated Impact)

| ID | Status | Optimization | Estimated Impact | Why It’s Deferred |
|---|---|---|---|---|
| OPT-001 | todo | Eyes signal weighting retune in router ranking | 6% | Current eyes-to-routing bridge is functional; additional weighting passes are incremental and lower leverage than gating/contract fixes. |
| OPT-002 | todo | Prompt cache policy split by lane (reflex/autonomy/dream) | 5% | Existing TTL cache is live; lane-specific caching can improve hit rate but is not currently a top execution blocker. |
| OPT-003 | todo | Dream fallback quality scoring before proposal injection | 7% | Dreams already bridge upstream; adding stricter fallback-quality filters is valuable but secondary to core autonomy flow reliability. |
| OPT-004 | todo | Proposal semantic dedupe (near-duplicate clustering) | 8% | Queue dedupe exists; semantic clustering would reduce residual noise further but is not the largest current bottleneck. |
| OPT-005 | todo | Outcome correlation expansion (task-type x eye-source x model) | 8% | Task-type learning is already active; adding higher-order correlation improves tuning but is not critical-path for V1 stability. |
| OPT-006 | todo | Focus-controller trigger adaptation cadence tuning | 4% | Dynamic focus+pupil is deployed; cadence tuning gives smaller gains and can wait until higher-priority controls settle. |

## Notes

- Keep this file focused on upgrades (not daily tasks).
- Prefer adding one line per upgrade with concrete exit criteria.
- When an item starts, switch `Status` to `doing` and link the implementation commit(s).
- Tier policy: keep 3 tiers by default; add extra tiers only if telemetry shows persistent misrouting or cost/latency pressure that role-specialization cannot solve.
- BL-014 remains pending as a phased migration track (TS scaffold + file-by-file conversion) to avoid high-risk unattended refactors in permanent layers.
