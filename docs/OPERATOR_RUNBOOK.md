# Operator Runbook

Purpose: deterministic incident response for autonomy/routing/sensory failures with auditable verification.

## Scope

Covers:

1. Routing degraded
2. Schema drift / contract failure
3. Sensory starvation
4. Autonomy stall

## Global Triage

1. Capture health snapshot:
`node systems/autonomy/health_status.js [YYYY-MM-DD]`
2. If unsafe behavior is live, engage kill switch first:
`node systems/security/emergency_stop.js engage --scope=all --approval-note="contain incident"`
3. Run core contract guards:
`node systems/spine/contract_check.js`
`node systems/security/schema_contract_check.js run`
`node systems/sensory/adaptive_layer_guard.js run --strict`

Expected artifacts:

- `state/security/emergency_stop.json`
- `state/autonomy/runs/YYYY-MM-DD.jsonl`
- `state/autonomy/receipts/YYYY-MM-DD.jsonl`

## Incident 1: Routing Degraded

Symptoms:

- `health_status.routing.spine_local_down_consecutive > 0`
- repeated `route_blocked` or stale/local-down in routing decisions

Diagnose:

1. `node systems/autonomy/health_status.js [YYYY-MM-DD]`
2. `node systems/routing/model_router.js doctor --risk=low --complexity=low --intent=ops_triage --task="routing incident diagnosis"`
3. `node systems/routing/model_router.js probe-all`
4. `node systems/routing/model_router.js stats`

Containment:

- Optional scope-limited stop while recovering:
`node systems/security/emergency_stop.js engage --scope=routing --approval-note="routing containment"`

Recovery:

1. Unban false positives if needed:
`node systems/routing/model_router.js unban --model=ollama/<name>`
2. Force safe execution mode if routing quality is uncertain:
`node systems/autonomy/strategy_mode.js set --mode=score_only --approval-note="routing degraded; reduce blast radius"`

Verification:

1. Re-run doctor command (step 2).
2. Confirm no new `route_blocked` spikes in:
`state/routing/routing_decisions.jsonl`
3. Confirm health status routing section is stable.

## Incident 2: Schema Drift / Contract Failure

Symptoms:

- `schema_contract_check` fails
- `contract_check` fails
- receipt/proposal fields missing or malformed

Diagnose:

1. `node systems/security/schema_contract_check.js run`
2. `node systems/spine/contract_check.js`
3. `node systems/sensory/adaptive_layer_guard.js run --strict`

Containment:

`node systems/security/emergency_stop.js engage --scope=autonomy,routing,actuation --approval-note="schema drift containment"`

Recovery:

1. Identify recent code deltas:
`git log --oneline -n 20`
2. Revert offending commit(s) non-destructively:
`git revert --no-edit <commit_sha>`
3. Re-run diagnosis commands.

Verification:

- all three checks above pass
- no new contract failures in CI run:
`npm run test:ci`

## Incident 3: Sensory Starvation

Symptoms:

- low or zero external signal intake
- high collector error ratio
- sparse/no new actionable proposals

Diagnose:

1. `node habits/scripts/external_eyes.js doctor`
2. `node habits/scripts/external_eyes.js slo [YYYY-MM-DD]`
3. `node systems/spine/spine.js eyes [YYYY-MM-DD] --max-eyes=3`
4. `node systems/autonomy/proposal_enricher.js run [YYYY-MM-DD] --dry-run`

Containment:

- Keep autonomy in safer mode while sensory is degraded:
`node systems/autonomy/strategy_mode.js set --mode=score_only --approval-note="sensory degraded; hold execution risk"`

Recovery:

1. Refresh focus triggers:
`node systems/sensory/focus_controller.js refresh [YYYY-MM-DD]`
2. Resolve collector-specific failures indicated by doctor/slo output.

Verification:

1. `external_eyes.js slo` returns healthy.
2. `state/sensory/proposals/YYYY-MM-DD.json` contains current-day actionable records.
3. `health_status` sensory metrics recover.

## Incident 4: Autonomy Stall

Symptoms:

- repeated stop/repeat gate outcomes
- low/no executed outcomes over multiple runs
- readiness/governor blocks persist

Diagnose:

1. `node systems/autonomy/health_status.js [YYYY-MM-DD]`
2. `node systems/autonomy/strategy_readiness.js run [YYYY-MM-DD] --days=14`
3. `node systems/autonomy/pipeline_spc_gate.js run [YYYY-MM-DD] --days=1 --baseline-days=7 --sigma=3`
4. `node systems/autonomy/receipt_summary.js run [YYYY-MM-DD] --days=7`
5. `node systems/autonomy/strategy_mode_governor.js status [YYYY-MM-DD] --days=14`

Containment:

- keep/return to score-only until pass rates recover:
`node systems/autonomy/strategy_mode.js set --mode=score_only --approval-note="autonomy stall containment"`

Recovery:

1. Recompute admission metadata:
`node systems/autonomy/proposal_enricher.js run [YYYY-MM-DD]`
2. Run governor in dry mode to inspect proposed transition:
`node systems/autonomy/strategy_mode_governor.js run [YYYY-MM-DD] --days=14 --dry-run`

Verification:

- `strategy_readiness` returns `ready_for_execute=true` before enabling execute/canary
- receipt pass rates and success criteria pass rates trend up in `receipt_summary`

## Incident 5: Queue Backlog / Churn

Symptoms:

- OPEN queue count grows daily
- repeated reject noise in queue logs
- stale proposals never resolve

Diagnose:

1. `node habits/scripts/sensory_queue.js stats --days=7`
2. `node habits/scripts/sensory_queue.js list --status=open --days=7`
3. `node systems/autonomy/health_status.js [YYYY-MM-DD]` (check queue backlog SLO + recovery pulse)

Containment / Recovery:

1. Run deterministic hygiene:
`node habits/scripts/queue_gc.js run [YYYY-MM-DD]`
`node habits/scripts/sensory_queue.js sweep [YYYY-MM-DD]`
2. Force compact terminal churn:
`node systems/ops/queue_log_compact.js run --apply=1`
3. If backlog is budget-constrained, pin pressure explicitly for a run:
`QUEUE_GC_BUDGET_PRESSURE=hard node habits/scripts/queue_gc.js run [YYYY-MM-DD]`

Verification:

1. queue open count trends down in `sensory_queue stats`
2. no repeated reject spam for same id/reason in `state/sensory/queue_log.jsonl`
3. `health_status` queue backlog check returns pass

## Rollback Drill (Weekly)

Goal: verify rollback muscle memory and logging path.

1. Snapshot status:
`node systems/autonomy/health_status.js [YYYY-MM-DD]`
2. Simulate change containment:
`node systems/security/emergency_stop.js engage --scope=autonomy --approval-note="rollback drill"`
3. Run core guards:
`node systems/security/schema_contract_check.js run`
`node systems/sensory/adaptive_layer_guard.js run --strict`
4. Release stop:
`node systems/security/emergency_stop.js release --approval-note="rollback drill complete"`
5. Record drill outcome in commit/ops notes.

## Verification Logs and Receipts

Primary files to inspect per incident:

- `state/security/emergency_stop.json`
- `state/security/emergency_stop_events.jsonl`
- `state/security/adaptive_mutations.jsonl`
- `state/autonomy/runs/YYYY-MM-DD.jsonl`
- `state/autonomy/receipts/YYYY-MM-DD.jsonl`
- `state/routing/routing_decisions.jsonl`
