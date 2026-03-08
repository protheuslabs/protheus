# Competitive Benchmark Matrix (`V6-COMP-001`)

This lane provides reproducible, receipt-backed parity metrics across key competitors.

## Command Surface

```bash
npm run -s ops:competitive-matrix:run
npm run -s ops:competitive-matrix:status
```

## Artifact Paths

- Latest: `client/local/state/ops/competitive_benchmark_matrix/latest.json`
- Receipts: `client/local/state/ops/competitive_benchmark_matrix/receipts.jsonl`
- Snapshots: `client/local/state/ops/competitive_benchmark_matrix/snapshots.jsonl`

## Core Metrics

- `cold_start_ms`
- `idle_memory_mb`
- `install_size_mb`
- `evidence_verify_latency_ms`

The matrix includes deterministic score generation plus optional sub-benchmark invocation for observability, mobile matrix, and OpenFang runtime budget lanes.
