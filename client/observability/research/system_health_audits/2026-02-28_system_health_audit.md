# Protheus System Health Audit
Date: 2026-02-28
Mode: Manual framework audit (scored 1-10)

## Scorecard

| Area | Score | Evidence Snapshot |
|---|---:|---|
| 1. Completeness | 8.0 | Backlog has 297 done / 34 todo; core lanes exist for decomposition, assimilation, attribution, storm, helix, echo, weaver |
| 2. Efficiency & Resource Usage | 8.5 | Runtime efficiency pass (`cold_start_p95_ms=213`, `idle_rss_p95_mb=37.75`, install artifact 3.323 MB); token economics allow with low defer ratio |
| 3. Wiring & Architectural Integrity | 7.5 | No TS circular deps detected in `systems` (0 cycles); cross-organ imports present (88), mostly expected governance links |
| 4. Bugs & Reliability | 7.0 | Critical targeted tests green; explicit fail/deny events exist in last 24h (budget denies, llm gateway fails, eye command denies) |
| 5. Primitive-First Purity | 6.5 | Core strict roots are TS-paired; advisory JS holdouts remain high in `client/cognition/habits/scripts` + `tests/client-memory-tools` (430 unpaired) |
| 6. Governance, Alignment & Duality | 8.0 | Duality seeded and integrated across key lanes; echo/weaver shadow outputs include duality and gate behavior |
| 7. Security & Sovereignty | 7.5 | Helix clear, red team active, sandbox enforce mode; integrity reseal check currently reports 2 hash mismatches |
| 8. Observability & Explainability | 6.5 | Many status lanes are observable; explanation primitive enabled but currently empty (`index_entries=0`) |
| 9. Scalability & Hardware Agnosticism | 7.0 | Scale envelope pass with parity=1.0 across phone/desktop/cluster simulation; surface budget and embodiment latest states are missing |
| 10. Self-Improvement Health | 6.5 | Gated self-improvement framework present but no active proposals/runs yet (`total=0`) |

Overall weighted health: **7.3 / 10**

## Findings by Section

### 1) Completeness
- Core end-to-end journey exists: idea -> task decomposition -> routing -> execution lanes -> attribution -> storm value distribution.
- Missing runtime evidence for some “present but idle” lanes: resurrection bundles (0), continuity vault entries (0), explanation artifacts (0).
- Action:
  1. Run first seeded cycle for continuity/explanation lanes so they are proven, not just scaffolded.

### 2) Efficiency & Resource Usage
- Runtime efficiency floor status is strong.
- Token economics status shows allow/normal queue mode; low defer ratio.
- Action:
  1. Keep weekly efficiency baseline snapshots; alert on >10% cold-start or RSS drift.

### 3) Wiring & Architectural Integrity
- TS dependency graph: no circular dependencies found.
- Cross-organ imports (88) are moderate; top coupling includes `workflow->security`, `security->adaptive`, `autonomy->adaptive`.
- Action:
  1. Add coupling budget alert by pair count trend (do not block yet).

### 4) Bugs & Reliability
- Green tests today:
  - `duality_seed.test.js`
  - `task_decomposition_primitive.test.js`
  - `assimilation_controller.test.js`
  - `value_attribution_primitive.test.js`
  - `creator_optin_ledger.test.js`
  - `storm_value_distribution.test.js`
- 24h explicit fail/deny signals are concentrated in:
  - `state/runtime/canonical_events/2026-02-27.jsonl`
  - `state/routing/llm_gateway_calls.jsonl`
  - `state/eye/audit/command_bus.jsonl`
  - budget deny events in `state/autonomy/budget_events.jsonl`
- Action:
  1. Triage llm gateway fail reasons and eye command-bus denies into a single reliability ticket.

### 5) Primitive-First Purity
- Strict TS roots are clean (`systems`/`lib` paired with TS or exception-approved).
- Advisory roots still large JS surface (430 files) in client/cognition/habits/tests tooling.
- Action:
  1. Split advisory JS migration into measurable waves (habits first, then client/memory/tools tests).

### 6) Governance, Alignment & Duality
- Echo and Weaver statuses show healthy guard flow and shadow behavior.
- Duality is integrated as advisory signal across key reasoning paths.
- Action:
  1. Add a tiny duality KPI dashboard row: coverage by lane + contradiction decay trend.

### 7) Security & Sovereignty
- Helix status clear, malice quarantine idle, red-team colony healthy, soul attestation match true.
- Security gap: `integrity:check` currently fails with 2 hash mismatches:
  - `client/runtime/systems/echo/heroic_echo_controller.ts`
  - `client/runtime/systems/weaver/weaver_core.ts`
- Agent passport status currently has no active passport/action chain state.
- Action:
  1. Reseal integrity policy immediately after verifying those two files.
  2. Issue a runtime passport and verify append flow in live status.

### 8) Observability & Explainability
- Holo/security/runtime statuses are mostly queryable.
- Explanation primitive is enabled but has no artifacts yet.
- Action:
  1. Require one explanation artifact per major run class (assimilation, decomposition, self-improvement) in shadow mode.

### 9) Scalability & Hardware Agnosticism
- Scale envelope baseline passes with parity score 1.0.
- Surface budget and embodiment controllers have no recent latest snapshots.
- Action:
  1. Schedule periodic runs for `hardware:surface-budget:run` and `hardware:embodiment:sense` so statuses remain fresh.

### 10) Self-Improvement Health
- Gated loop exists but has zero proposals processed.
- Action:
  1. Run one controlled shadow proposal end-to-end and capture rollback drill evidence.

## Top 10 Priority Action Items

1. Reseal integrity policy for current hash mismatches (`echo`, `weaver`).
2. Restore active passport chain state (issue + append sanity check).
3. Triage llm gateway failure cluster from last 24h and patch top cause.
4. Add periodic surface-budget and embodiment sensing jobs (freshness SLO).
5. Seed explanation primitive with mandatory shadow artifacts per major lane.
6. Open coupling budget monitor (cross-organ import trend, no hard fail yet).
7. Execute one gated self-improvement shadow run + rollback drill.
8. Create continuity vault + resurrection test bundle baseline.
9. Address simplicity-budget missing offset receipts for new organs (`attribution`, `execution`, `finance`, `storm`, `symbiosis`).
10. Start advisory JS migration wave for `client/cognition/habits/scripts` and `client/memory/tools`.

## Commands Used (selected)
- `npm run -s helix:status`
- `npm run -s redteam:colony:status`
- `npm run -s soul:status`
- `npm run -s passport:status`
- `npm run -s weaver:status`
- `npm run -s echo:status`
- `npm run -s assimilation:status`
- `npm run -s execution:task-decompose:status`
- `npm run -s integrity:check`
- `npm run -s ops:token-economics:status`
- `npm run -s ops:runtime-efficiency:status`
- `npm run -s foundation:contract`
- `npm run -s foundation:scale-envelope`
- `npm run -s js:holdout:status`
- `npm run -s security:sandbox:status`
- `npm run -s ops:execution-reliability:status`
