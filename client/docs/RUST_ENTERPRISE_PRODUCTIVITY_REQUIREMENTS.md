# Rust Productivity Requirements (Enterprise Standard)

## Objective
Use Rust only where it materially improves runtime behavior, reliability, or operating cost. Keep orchestration and product-surface velocity in TypeScript where it is already efficient.

## Scope Selection Rules
Migrate a component to Rust only if at least one is true:
- It is CPU-bound or allocation-heavy under production-like load.
- It is concurrency-sensitive with lock contention or event-loop starvation risk.
- It is on a p95/p99 latency-critical path.
- It has memory-safety or crash-risk exposure best reduced by Rust.
- It drives substantial cost and can be optimized through lower CPU/memory use.

Do not migrate if primary bottleneck is external I/O, database latency, or third-party API wait time.

## Enterprise Requirements

### 1) Baseline & Prioritization
- Build a hotspot inventory from profiling data (CPU flamegraphs, heap profiles, queue wait/lag).
- Rank candidates by expected impact (latency, throughput, crash reduction, $/request).
- Require ADR/RFC per migration candidate with explicit ROI hypothesis.

### 2) Boundary Contracts
- Define strict Rust/TS boundaries (FFI/N-API/WASM) with typed contracts.
- Version and test serialization schemas; no implicit cross-language drift.
- Guarantee deterministic fallback to TS path per component.

### 3) Performance & Reliability Gates
- For each migrated component, require side-by-side benchmark receipts vs baseline.
- Promotion gates must include: p95/p99 latency delta, throughput delta, CPU/memory delta, error-rate delta.
- No promotion without non-regression proof under production-like workloads.

### 4) Rollout & Rollback
- Ship behind feature flags and canary cohorts.
- Support one-command rollback to previous implementation path.
- Define automatic rollback thresholds for SLO, error budget, or crash regressions.

### 5) Observability & SRE Readiness
- Expose equivalent metrics/traces/log fields across Rust and TS paths.
- Add on-call runbooks for migration lanes (failure modes, mitigations, rollback steps).
- Include chaos/fault-injection checks where migration changes failure behavior.

### 6) Security & Supply Chain
- Enforce crate pinning, CVE/license scanning, and reproducible build attestations.
- Require MSRV and toolchain pin policy.
- Preserve existing secrets, auth, and policy boundaries across language boundary.

### 7) Developer Productivity
- Cargo workspace standards, lint/format/test commands, and codeowners per crate.
- Common templates for new crates, benchmark harnesses, and FFI adapters.
- Maintain a migration playbook with examples and anti-patterns.

## Initial High-Value Migration Targets
1. Scheduler and queue workers (backpressure, concurrency, throughput).
2. Memory retrieval/indexing hot paths (vector/ANN/search and transform loops).
3. High-frequency pre/post-processing transforms (tokenization, parsing, compression, scoring).
4. Serialization/data movement hot loops (zero-copy and bounded allocations).

## Acceptance Standard (per migration item)
A migration item is complete only when all are true:
- Verification: benchmark + parity + stability receipts are present.
- Rollback: tested rollback path exists and is documented.
- Operations: metrics/traces/runbooks updated.
- Governance: CI gate enforces the above on future changes.
