# Rust50 Sprint Contract

`client/systems/ops/rust50_sprint_contract.ts` enforces sprint-mode execution for `V6-RUST50-CONF-002`.

## Contract Gates
- Enforcer preamble acknowledgement is required:
  - `ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.`
- Single batch mode only.
- Ordered execution only (no out-of-order completion).
- No skipped tasks.
- No premature done:
  - `requested_status=done` requires:
    - all tasks completed
    - no blockers
    - proof refs present
    - approval recorded

## Commands
```bash
node client/systems/ops/rust50_sprint_contract.js run \
  --sprint-id=V6-RUST50-CONF-002 \
  --batch-id=batch-001 \
  --plan-file=tmp/sprint_plan.json \
  --requested-status=in_progress \
  --enforcer-active=1 \
  --preamble-text="ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST."

node client/systems/ops/rust50_sprint_contract.js status
```

## Artifacts
- Latest receipt:
  - `state/ops/rust50_sprint_contract/latest.json`
- History:
  - `state/ops/rust50_sprint_contract/history.jsonl`
- Audit snapshots:
  - `state/ops/rust50_sprint_contract/audits/*.json`
