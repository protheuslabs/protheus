# Workflow Definitions

Purpose: store executable agentic workflows (n8n-style intent) separately from strategy policy.

- `config/strategies/` defines **why/priority/risk/budget**.
- `config/workflows/` defines **how/steps/triggers/contracts**.

Generated adaptive workflow drafts are stored in:
- `state/adaptive/workflows/drafts/YYYY-MM-DD.json`

Applied workflows are stored in:
- `state/adaptive/workflows/registry.json`

Controllers:
- `node systems/workflow/workflow_generator.js run [YYYY-MM-DD]`
- `node systems/workflow/orchestron_controller.js run [YYYY-MM-DD] --apply=1` (preferred entrypoint)
- `node systems/workflow/workflow_controller.js run [YYYY-MM-DD] --apply=1` (legacy-compatible)
- `node systems/workflow/orchestron/adaptive_controller.js run [YYYY-MM-DD] --intent="..."` (intent -> candidates -> nursery scorecards)

Orchestron integration defaults to shadow mode in `config/orchestron_policy.json`:
- `--orchestron=1` keeps candidate generation active
- `--orchestron-apply=0` keeps promotions proposal-only (default)
- `--orchestron-apply=1` includes passing Orchestron drafts in registry apply only when policy `shadow_only=false`
- `--orchestron-auto=1` enables dynamic auto-apply gate (policy + runtime signal checks)

Auto-trigger default behavior:
- If `--orchestron-auto` is not provided, auto-trigger defaults to ON when strategy execution mode is `execute` (full automation mode).
- In `score_only` or `canary_execute`, auto-trigger defaults to OFF unless explicitly enabled.
- `WORKFLOW_ORCHESTRON_AUTO_APPLY` still overrides defaults.

Dynamic auto-apply gate (`auto_apply`) checks:
- minimum promotable drafts
- principle score floor
- red-team critical failure ceiling
- average composite score floor
- predicted drift delta ceiling
- predicted yield delta floor
- optional `require_shadow_off` guard
