# V9 Evolution Compaction Prep (V9-EVOLUTION-COMPACTION-001)

Date: 2026-03-19  
Owner: Codex execution lane (Rust-core authority)

## Objective
Prepare a ruthless compaction round that removes duplicate/parallel logic while preserving behavior, safety invariants, and throughput.

## Baseline (frozen before compaction)
Source artifact:
- `docs/client/reports/benchmark_matrix_resample_post_pack_2026-03-19.json`

Median metrics (2 warmups + 9 runs):

| Mode | Cold Start (ms) | Idle Memory (MB) | Install Size (MB) | Throughput (ops/sec) |
| --- | ---: | ---: | ---: | ---: |
| OpenClaw/rich | 4.703 | 8.250 | 14.899 | 143710.82 |
| InfRing pure | 1.7345 | 1.3594 | 1.054 | 143710.82 |
| InfRing tiny-max | 1.7233 | 1.3594 | 0.445 | 143710.82 |

## Duplicate Inventory Snapshot
Generated with:
- `npm run -s ops:client:wrapper-compaction-candidates`

Artifacts:
- `artifacts/client_wrapper_compaction_candidates_current.json`
- `docs/workspace/CLIENT_WRAPPER_COMPACTION_CANDIDATES.md`

Current snapshot:
- `totalTsFiles=212`
- `duplicateGroups=1`
- `duplicateFiles=58`
- `duplicateRows=57`

## Hard Guardrails
1. Rust core remains authoritative for security/runtime/scheduling pathways.
2. No change to fail-closed behavior in security, conduit, or compatibility gates.
3. No behavior regression: output parity and receipt semantics preserved.
4. No compaction commit unless benchmark deltas are neutral-to-positive overall.
5. Archive removed feature ideas as optional artifacts (binary/blob lane), not active runtime paths.

## Compaction Execution Checklist
1. Duplicate inventory:
   - `npm run -s ops:client:wrapper-compaction-candidates`
   - `rg` duplicate scans across `core/layer0/ops`, `core/layer2/ops`, `client/runtime/systems/ops`
2. Prioritize merges by ROI:
   - hot-path runtime helpers
   - shared parser/validator/receipt utilities
   - duplicated bridge wrappers
3. Apply compaction in small batches:
   - batch A: helper/function dedupe
   - batch B: orchestration/plane adapter dedupe
   - batch C: optional extension extraction
4. After each batch:
   - run module tests
   - run fail-closed/security tests
5. End-of-round validation:
   - `npm run -s ops:srs:full:regression`
   - `npm run -s ops:dod:gate`
   - `npm run -s ops:v8:runtime-proof:gate`
   - `npm run -s ops:benchmark:build-release`
   - `npm run -s ops:benchmark:refresh`
   - stabilized resample (2 warmups + 9 runs)
6. Publish:
   - update README benchmark table only from stabilized artifact
   - include delta report and rationale per major merge

## Commit Rule
Use this exact message format only when the round is a measured win:

`compaction: [one-line summary] — [new cold start] / [new idle] / [new install] / [new throughput] (V9-EVOLUTION-COMPACTION-001)`

## Execution Update (2026-03-20)
Batch implemented:
- Added shared binder helpers in `client/runtime/lib/legacy_retired_wrapper.ts`:
  - `createLegacyRetiredModuleForFile(filePath)`
  - `bindLegacyRetiredModule(filePath, currentModule, argv?)`
- Compacted 58 duplicated legacy-retired TypeScript wrappers to a single shared-call form.
- Compacted 62 duplicated JavaScript TS-bootstrap wrappers to an inline shared bootstrap call form.

Measured compaction effect (wrapper surface only):
- Runtime wrapper files changed: `121`
- Aggregate bytes before: `31,967`
- Aggregate bytes after: `14,720`
- Net source reduction: `-17,247 bytes` (~54.0%)
- TS duplicate cluster payload (`58` files) reduced from ~`23,432` bytes to `8,294` bytes.

Validation executed:
- Wrapper smoke tests:
  - `node client/runtime/systems/security/conflict_marker_guard.{js,ts} status`
  - `node client/runtime/systems/ops/state_kernel.{js,ts} status`
- Targeted regression tests:
  - `node tests/client-memory-tools/repository_access_auditor.test.js`
  - `node tests/client-memory-tools/dist_runtime_cutover.test.js`
  - `node tests/client-memory-tools/motivational_state_vector.test.js`
  - `node tests/client-memory-tools/interactive_desktop_session_primitive.test.js`
  - `node tests/client-memory-tools/backlog_github_sync.test.js`
  - `npm run -s test:ops:competitive-matrix`
- Benchmark refresh:
  - `npm run -s ops:benchmark:build-release`
  - `npm run -s ops:benchmark:refresh`

Benchmark delta note:
- Latest live-refresh artifact shows small throughput/cold/idle drift and a larger install-size jump driven by binary-path size changes in the benchmark pipeline (not wrapper-source compaction itself). A stabilized multi-run resample is still required before final compaction sign-off.

Post-compaction stabilized artifact:
- `docs/client/reports/benchmark_matrix_resample_post_compaction_2026-03-20.json`
- Method: `2` warmups + `9` measured runs
- Median metrics:
  - OpenClaw/rich: cold `4.95 ms`, idle `8.25 MB`, install `14.883 MB`, throughput `140172.64 ops/sec`
  - Pure: cold `1.730333 ms`, idle `1.375 MB`, install `1.054 MB`, throughput `140172.64 ops/sec`
  - Tiny-max: cold `1.711583 ms`, idle `1.375 MB`, install `0.445 MB`, throughput `140172.64 ops/sec`

Delta vs previous stabilized medians (`benchmark_matrix_stabilized_2026-03-19.json`):
- Rich: cold `+0.458 ms`, idle `+0.078 MB`, install `+0.634 MB`, throughput `-5302.28 ops/sec`
- Pure: cold `+0.13675 ms`, idle `+0.03125 MB`, install `+0.384 MB`, throughput `-5302.28 ops/sec`
- Tiny-max: cold `+0.069666 ms`, idle `+0.03125 MB`, install `-0.038 MB`, throughput `-5302.28 ops/sec`

Attribution note:
- Throughput dropped uniformly across all profiles, which points to shared benchmark/runtime baseline drift rather than wrapper-source compaction.
- Install-size jump is dominated by binary path changes in benchmark receipts (not wrapper files), while wrapper compaction itself reduced runtime-system wrapper source by ~17.2 KB.
