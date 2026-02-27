# Sub-Executor Synthesis (`V3-041`)

`systems/actuation/sub_executor_synthesis.js` is the bounded edge-case lane for profile execution failures.

## Purpose

- Keep the universal execution path profile-first.
- When a profile repeatedly fails on an edge case, queue a temporary sub-executor candidate instead of adding bespoke runtime branches.
- Require explicit validation before distilling behavior back into reusable profile semantics.

## Commands

```bash
node systems/actuation/sub_executor_synthesis.js propose \
  --profile-id=<id> \
  --intent=<intent> \
  --failure-reason=<reason> \
  --risk-class=low|medium|high

node systems/actuation/sub_executor_synthesis.js evaluate \
  --candidate-id=<id> \
  --nursery-pass=1 \
  --adversarial-pass=1 \
  --evidence='{"lane":"nursery"}'

node systems/actuation/sub_executor_synthesis.js distill --candidate-id=<id>
node systems/actuation/sub_executor_synthesis.js gc
node systems/actuation/sub_executor_synthesis.js status [--candidate-id=<id>]
```

## Lifecycle

1. `propose`: Create candidate from `(profile_id, intent, failure_reason, risk_class)`.
2. Deduplication: If same signature appears inside dedupe window, candidate is reused.
3. `evaluate`: Candidate is validated only when required lanes pass (`nursery`, `adversarial` by policy).
4. `distill`: Validated candidate becomes a profile patch artifact at:
   - `state/assimilation/capability_profiles/distilled/<candidate_id>.json`
5. `gc`: Expire stale candidates based on TTL (atrophy).

## Policy

Primary policy file:

- `config/sub_executor_synthesis_policy.json`

Key controls:

- `enabled`
- `default_ttl_sec`
- `max_active_candidates`
- `dedupe_window_sec`
- `allow_high_risk`
- `validation.require_nursery_pass`
- `validation.require_adversarial_pass`

## Universal Primitive Integration

`systems/actuation/universal_execution_primitive.js` can auto-propose candidates on configured failures via `config/universal_execution_primitive_policy.json`:

- `sub_executor_synthesis.enabled`
- `sub_executor_synthesis.auto_propose_on_errors`
- `sub_executor_synthesis.risk_class_by_error`

When triggered, universal execution receipts include candidate linkage fields:

- `sub_executor_candidate_id`
- `sub_executor_candidate_status`
- `sub_executor_candidate_reused`
