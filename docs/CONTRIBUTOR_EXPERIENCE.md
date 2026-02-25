# Contributor Experience

## Goal

Make contribution predictable, testable, and safe for a fast-moving autonomy codebase.

## Local setup

```bash
npm install
npm run typecheck:systems
node systems/spine/contract_check.js
```

## Workflow layer contribution rules

- Keep strategy policy in `config/strategies/`.
- Keep workflow definitions in `config/workflows/` + `state/adaptive/workflows/`.
- Do not mix workflow DAG logic into core strategy ranking code.

## Minimum checks before PR

```bash
node memory/tools/tests/strategy_principles.test.js
node memory/tools/tests/workflow_controller.test.js
node memory/tools/tests/collective_shadow.test.js
node memory/tools/tests/observer_mirror.test.js
node systems/ops/public_benchmark_pack.js run
node systems/ops/deployment_packaging.js run --profile=prod --strict=1
node systems/ops/compliance_posture.js run --days=30 --profile=prod --strict=0
```

## Evidence expectations

- Include output JSON path(s) from benchmark and controller runs.
- Include policy/config changes with rationale.
- Include regression/behavior tests for new lanes.
