# Workflow Runner Rollback Hardening Contract (RM-014)

Date: 2026-02-26  
Scope: `systems/workflow/workflow_executor.ts`

## Guarantees

1. Per-step success criteria enforcement
- Each step supports `success_criteria`:
  - `allowed_exit_codes[]`
  - `stdout_includes[]`
  - `stderr_excludes[]`
  - `max_duration_ms`
- Step receipts include criteria verdicts per attempt:
  - `criteria_pass`
  - `criteria_fail_reasons[]`

2. Timeout/retry budget enforcement
- Runner enforces workflow-level caps from `config/workflow_executor_policy.json`:
  - `step_runtime.max_total_attempts_per_workflow`
  - `step_runtime.max_total_retry_attempts_per_workflow`
  - `step_runtime.max_total_step_duration_ms_per_workflow`
- Budget checks run both:
  - pre-step (projected usage)
  - post-step (actual usage)

3. Rollback command path hardening
- On failure, runner resolves rollback path in order:
  - explicit rollback step in workflow
  - policy default rollback command (`failure_rollback.default_command`)
- Rollback receives trigger metadata:
  - `rollback_trigger_reason`
  - `rollback_trigger_step_id`

4. Receipt coverage
- Step receipts persist richer metadata:
  - `failure_reason`
  - `rollback_step`
  - `rollback_trigger_reason`
  - `runtime_mutation_retry`
  - `success_criteria`
- Run payload and status expose `failure_reasons` map.

## Policy Surface

`config/workflow_executor_policy.json`:

```json
{
  "step_runtime": {
    "enforce_success_criteria": true,
    "default_allowed_exit_codes": [0],
    "max_total_attempts_per_workflow": 24,
    "max_total_retry_attempts_per_workflow": 16,
    "max_total_step_duration_ms_per_workflow": 600000
  }
}
```

## Tests

- `memory/tools/tests/workflow_executor.test.js`
- `memory/tools/tests/workflow_executor_rollback_hardening.test.js`
