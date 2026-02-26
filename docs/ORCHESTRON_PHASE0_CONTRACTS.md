# Orchestron Phase-0 Contracts (Shadow-Only)

Status: active (`RM-009`)

Phase-0 goal is to generate and score adaptive workflows without autonomous promotion into active execution.

## Policy Invariants

Source: `/Users/jay/.openclaw/workspace/config/orchestron_policy.json`

- `enabled: true`
- `shadow_only: true`
- `auto_apply.enabled: false`
- `auto_apply.require_shadow_off: true`

These defaults guarantee no autonomous apply path is active in baseline operation.

## Typed Contract Artifacts

Canonical normalizers live in `/Users/jay/.openclaw/workspace/systems/workflow/orchestron/contracts.ts`.

The controller emits the following typed payload families:

1. `intent`
- `id`
- `strategy_id`
- `objective`
- `uncertainty_band`
- `constraints` (`speed_weight`, `robustness_weight`, `cost_weight`)
- `signals` (`feasibility`, `risk`, `novelty`)
- `signature`

2. `candidate` (includes fractal children)
- `id`
- `trigger` (`proposal_type`, `min_occurrences`, `intent_signature`)
- `risk_policy`
- `steps[]` (`id`, `type`, `command`, `timeout_ms`, `retries`)
- `parent_workflow_id` and `fractal_depth`

3. `scorecard`
- `candidate_id`
- `predicted_yield_delta`
- `predicted_drift_delta`
- `safety_score`
- `regression_risk`
- `trit_alignment`
- `composite_score`
- `adversarial_*` fields
- `pass`

4. `workflow_draft`
- Candidate fields + principle snapshot + metrics + lineage/fractal metadata
- `status: "draft"` in Phase-0

5. `run payload`
- `type: "orchestron_adaptive_run"`
- `policy`, `policy_path`
- `candidates`, `scorecards`, `passing`, `drafts`, `promotable_drafts`

## Failure Gates

Gates that can block autonomous promotion/apply:

1. `shadow_only_policy_on`
- Triggered when policy is shadow-only and auto-apply requires shadow-off.

2. `orchestron_error`
- Generation/runtime error in adaptive controller.

3. Auto-apply threshold gates
- `promotable_drafts_below_min`
- `principle_score_below_min`
- `red_team_critical_failures`
- `composite_score_below_min`
- `avg_trit_alignment_below_min`
- `min_trit_alignment_below_min`
- `predicted_drift_above_max`
- `predicted_yield_below_min`

4. Identity gate (promotion/apply path)
- Evaluated in workflow controller before registry activation.

## Runtime Receipts and Paths

- Latest Orchestron run snapshot:
  `/Users/jay/.openclaw/workspace/state/adaptive/workflows/orchestron/latest.json`
- Per-run payload:
  `/Users/jay/.openclaw/workspace/state/adaptive/workflows/orchestron/<date>.json`
- Birth event stream:
  `/Users/jay/.openclaw/workspace/state/adaptive/workflows/orchestron/birth_events.jsonl`

## Validation Commands

```bash
node memory/tools/tests/workflow_controller_orchestron_phase0_shadow.test.js
node memory/tools/tests/workflow_controller_orchestron_auto_apply.test.js
node memory/tools/tests/workflow_controller_orchestron_shadow.test.js
node systems/spine/contract_check.js
```
