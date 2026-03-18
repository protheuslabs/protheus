# Benchmark Regression Analysis 2026-03-18

## Scope

This note separates three questions:

1. Is the benchmark harness itself materially different from the older published baseline?
2. Is the latest single live run overstating the regression?
3. What changed in the product/runtime surface that plausibly explains the remaining stabilized regression?

## Findings

### 1. The single live refresh overstated the regression

The one-shot live refresh produced materially worse numbers than the stabilized median pack, especially for throughput.

- Pure throughput live: `5987.3 ops/sec`
- Pure throughput stabilized median: `7891.9 ops/sec`
- Tiny-max cold start live: `3.08 ms`
- Tiny-max cold start stabilized median: `2.88 ms`

Conclusion: one-shot live refreshes are too noisy for README publication.

### 2. The benchmark harness itself barely changed

Diffing the older benchmark publication baseline commit `8f3d24e8` against current `HEAD` shows that the benchmark harness changed only minimally, while runtime/security/swarm surfaces grew substantially.

Diff summary:

- `core/layer0/ops/src/benchmark_matrix.rs`: `5` changed lines
- `core/layer0/ops/src/swarm_runtime.rs`: `+3438`
- `core/layer1/security/src/security_wave1.rs`: `+683`
- `core/layer0/ops/src/mcp_plane.rs`: `+180`
- `core/layer0/ops/src/security_plane.rs`: `+13`

Conclusion: the dominant regression driver is runtime/system growth, not a major rewrite of the benchmark harness.

### 3. Stabilized medians still confirm real regressions

Against the previously published README baseline:

- Rich:
  - cold start: `5.1 -> 7.247 ms` (`+42.1%`)
  - idle memory: `10.3 -> 10.672 MB` (`+3.6%`)
  - install size: `12.7 -> 14.034 MB` (`+10.5%`)
  - throughput: `12341.2 -> 7703.7 ops/sec` (`-37.6%`)
- Pure:
  - cold start: `1.6 -> 3.009 ms` (`+88.0%`)
  - idle memory: `1.4 -> 1.344 MB` (`-4.0%`)
  - install size: `0.7 -> 0.67 MB` (`-4.3%`)
  - throughput: `11728.3 -> 7891.9 ops/sec` (`-32.7%`)
- Tiny-max:
  - cold start: `1.6 -> 2.881 ms` (`+80.1%`)
  - idle memory: `1.4 -> 1.344 MB` (`-4.0%`)
  - install size: `0.5 -> 0.483 MB` (`-3.4%`)
  - throughput: `12368.0 -> 7893.5 ops/sec` (`-36.2%`)

Conclusion: the live refresh overstated the damage, but the stabilized pack still shows meaningful regression, especially on cold start and rich install size.

## New Fixed Baseline

To separate host/harness drift from product-path regressions, use:

```bash
protheus-ops fixed-microbenchmark run --rounds=9 --warmup-runs=2 --sample-ms=800
```

This measures a fixed SHA-256 workload only and excludes:

- runtime efficiency floor orchestration
- cold-start process probes
- install-size aggregation
- idle RSS collection

Artifacts:

- `local/state/ops/fixed_microbenchmark/latest.json`
- `local/state/ops/fixed_microbenchmark/history.jsonl`

Interpretation rule:

- If `fixed-microbenchmark` is stable while `benchmark-matrix` degrades, the product/runtime path regressed.
- If both degrade together, host load or harness environment drift is a likely contributor.
