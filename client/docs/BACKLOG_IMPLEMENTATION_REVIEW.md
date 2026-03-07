# Backlog Implementation Review

`client/systems/ops/backlog_implementation_review.ts` audits backlog rows and marks each as reviewed with deterministic evidence.

It verifies:
- implementation anchors exist for `done` rows
- wiring evidence exists (runtime + client/config/test/docs evidence)
- rows are not wrapper-only (`.js` launcher without substantive implementation)

## Commands

```bash
node client/systems/ops/backlog_implementation_review.js run
node client/systems/ops/backlog_implementation_review.js run --strict=1
node client/systems/ops/backlog_implementation_review.js status
```

## Policy

Policy file: `client/config/backlog_implementation_review_policy.json`

Outputs:
- review registry: `client/config/backlog_review_registry.json`
- reviewed view: `client/docs/backlog_views/reviewed.md`
- receipts: `state/ops/backlog_implementation_review/latest.json`, `state/ops/backlog_implementation_review/history.jsonl`
