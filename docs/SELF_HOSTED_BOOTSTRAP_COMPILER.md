# Self-Hosted Runtime Bootstrap + Compiler Loop

`systems/ops/self_hosted_bootstrap_compiler.ts` implements `V3-062`.

It adds a governed self-hosted runtime build lane:

1. `compile` (build + smoke)
2. `verify` (formal invariants + supply-chain verification commands)
3. `promote` (approval-gated active build switch)
4. `rollback` (revert to previous active build)

## Governance Guarantees

- promotion requires verified build plus human approval note
- state tracks `active_build_id` and `previous_active_build_id`
- rollback is explicit and receipted
- latest operation snapshot is persisted

## Commands

- `node systems/ops/self_hosted_bootstrap_compiler.js compile`
- `node systems/ops/self_hosted_bootstrap_compiler.js verify --build-id=<id>`
- `node systems/ops/self_hosted_bootstrap_compiler.js promote --build-id=<id> --approved-by=<id> --approval-note="..."`
- `node systems/ops/self_hosted_bootstrap_compiler.js rollback`
- `node systems/ops/self_hosted_bootstrap_compiler.js status`

