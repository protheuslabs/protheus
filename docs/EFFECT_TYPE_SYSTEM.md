# Effect Type System

`systems/primitives/effect_type_system.ts` enforces plan-time effect governance for workflow execution.

## What it does

- Compiles each workflow step into an effect class (`compute`, `network`, `money`, `shell`, etc.)
- Computes transition shadow scores for each edge in the step graph
- Fails closed on forbidden transitions and forbidden effect co-occurrence sets
- Emits structured effect-plan receipts with value/ethics shadow metadata

## Policy

Policy file: `config/effect_type_policy.json`

Key controls:

- `mode`: `enforce` or `advisory`
- `allowed_effects`
- `forbidden_transitions`
- `forbidden_cooccurrence_sets`
- `effect_shadow_weights`
- `max_transition_shadow`
- `max_total_shadow_per_workflow`

## Runtime integration

`systems/workflow/workflow_executor.ts` evaluates effect plans before any step execution.

- Unsupported effect combos are blocked at plan-time (`failure_reason=effect_plan_denied`)
- Step receipts include `effect_type` and `effect_transition`
- Runtime mutation candidates are rejected if their post-mutation step graph fails effect-policy checks

## Commands

```bash
node systems/primitives/effect_type_system.js evaluate --workflow-json=@/tmp/workflow.json --strict=1
node systems/primitives/effect_type_system.js status
```
