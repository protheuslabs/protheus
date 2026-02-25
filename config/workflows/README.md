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
- `node systems/workflow/workflow_controller.js run [YYYY-MM-DD] --apply=1`
- `node systems/workflow/orchestron/adaptive_controller.js run [YYYY-MM-DD] --intent="..."` (intent -> candidates -> nursery scorecards)

Orchestron integration defaults to shadow mode in `config/orchestron_policy.json`:
- `--orchestron=1` keeps candidate generation active
- `--orchestron-apply=0` keeps promotions proposal-only (default)
- `--orchestron-apply=1` includes passing Orchestron drafts in registry apply only when policy `shadow_only=false`
