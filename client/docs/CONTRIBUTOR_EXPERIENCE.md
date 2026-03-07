# Contributor Experience

## Goal

Make contribution predictable, testable, and safe for a fast-moving autonomy codebase.

## Local setup

```bash
npm install
npm run typecheck:systems
node client/systems/spine/contract_check.js
```

## Workflow layer contribution rules

- Keep strategy policy in `client/config/strategies/`.
- Keep workflow definitions in `client/config/workflows/` + `state/client/adaptive/workflows/`.
- Do not mix workflow DAG logic into core strategy ranking code.

## Minimum checks before PR

```bash
node client/memory/tools/tests/strategy_principles.test.js
node client/memory/tools/tests/workflow_controller.test.js
node client/memory/tools/tests/collective_shadow.test.js
node client/memory/tools/tests/observer_mirror.test.js
node client/systems/ops/public_benchmark_pack.js run
node client/systems/ops/deployment_packaging.js run --profile=prod --strict=1
node client/systems/ops/compliance_posture.js run --days=30 --profile=prod --strict=0
```

## Evidence expectations

- Include output JSON path(s) from benchmark and controller runs.
- Include policy/config changes with rationale.
- Include regression/behavior tests for new lanes.
