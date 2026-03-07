# WASI2 Execution Completeness Gate

`V3-RACE-220` verifies that critical TS lanes have a governed WASI2 runtime path with parity/safety/perf checks before promotion.

## Commands

```bash
node client/systems/ops/wasi2_execution_completeness_gate.js run --strict=1 --apply=1
node client/systems/ops/wasi2_execution_completeness_gate.js status
```

## What It Checks

- JS vs WASI2 normalized contract parity on target lanes.
- Safety pass rate for WASI2 probe execution.
- p95 latency delta (`js_duration_ms` vs `wasi2_duration_ms`) below policy threshold.

The gate uses `client/systems/ops/wasi2_lane_adapter.js` to normalize probe envelopes and routes WASI2 probes through `client/systems/wasm/component_runtime.js`.

Receipts:

- `state/ops/wasi2_execution_completeness_gate/latest.json`
- `state/ops/wasi2_execution_completeness_gate/receipts.jsonl`
- `state/ops/wasi2_execution_completeness_gate/history.jsonl`
