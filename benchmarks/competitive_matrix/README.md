# Competitive Benchmark Matrix (REQ-13-002)

Deterministic benchmark entrypoint for competitive parity claims.

## Metrics

- `cold_start_ms`
- `idle_memory_mb`
- `install_size_mb`
- `evidence_verify_latency_ms`

## Run

```bash
./benchmarks/competitive_matrix/run_matrix.sh
```

The runner writes a receipt-backed snapshot to:

- `client/local/state/ops/competitive_benchmark_matrix/latest.json`
- `client/local/state/ops/competitive_benchmark_matrix/snapshots.jsonl`
