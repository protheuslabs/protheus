# Scale Readiness Program

`V4-SCALE-001` through `V4-SCALE-010` are implemented by `client/systems/ops/scale_readiness_program.ts`.

## Run

```bash
node client/systems/ops/scale_readiness_program.js run-all --apply=1 --strict=1
node client/systems/ops/scale_readiness_program.js status
```

This lane emits reproducible receipts and writes durable contracts under `client/config/scale_readiness/`.
