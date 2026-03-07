# Productized Suite Program

This program executes and verifies the backlog implementation lanes for the
`protheus-*` productized tool suite and linked organization-provenance controls.

## Covered Backlog IDs

- `V4-SUITE-001` through `V4-SUITE-012`
- `V4-BRAND-001`
- `V4-BRAND-002`
- `V4-TRUST-001`
- `V4-REL-001`
- `V4-ROLL-001`
- `V4-DOC-ORG-001`

## Runtime Entrypoints

- Program: `node client/systems/ops/productized_suite_program.js <list|run|run-all|status>`
- Policy: `client/config/productized_suite_program_policy.json`
- Tool runtime: `node client/systems/cli/protheus_suite_tooling.js <tool> <command> [--k=v]`
- Standalone wrappers: `client/bin/protheus-graph.js`, `client/bin/protheus-mem.js`, `client/bin/protheus-telemetry.js`, `client/bin/protheus-vault.js`, `client/bin/protheus-swarm.js`, `client/bin/protheus-redlegion.js`, `client/bin/protheus-forge.js`, `client/bin/protheus-bootstrap.js`, `client/bin/protheus-econ.js`, `client/bin/protheus-soul.js`, `client/bin/protheus-pinnacle.js`

## Verification and Receipts

- Latest receipt: `state/ops/productized_suite_program/latest.json`
- Receipt stream: `state/ops/productized_suite_program/receipts.jsonl`
- History stream: `state/ops/productized_suite_program/history.jsonl`
- Per-lane state: `state/ops/productized_suite_program/items/<ID>.json`
- Lane artifacts: `state/ops/productized_suite_program/artifacts/`

## Commands

```bash
node client/systems/ops/productized_suite_program.js list
node client/systems/ops/productized_suite_program.js run --id=V4-SUITE-001 --apply=1 --strict=1
node client/systems/ops/productized_suite_program.js run-all --apply=1 --strict=1
node client/systems/ops/productized_suite_program.js status
```

## Governance

The program fails closed if required documentation is missing, if declared
lane IDs are unknown, or if strict checks fail for lane runtime evidence.
