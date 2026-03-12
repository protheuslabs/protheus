# SRS Strict Execution

Generated: 2026-03-12T06:17:47.299Z

## Summary
- ok: true
- execute_now_before: 0
- queue_scanned: 0
- queue_executed: 0
- queue_failed: 0
- queue_skipped: 0
- queue_receipt_hash: 9fbf5bd6b2b97d36266cc81ddee1429bc94a110c6646fb5e8b7e69023f73c959
- full_regression_fail: 0
- top200_regression_fail: 0
- execute_now_after: 0

## Steps
| Step | OK | Status | Command |
| --- | --- | --- | --- |
| srs_actionable_map:pre | true | 0 | `node scripts/ci/srs_actionable_map.mjs` |
| backlog_queue_executor:run_all_with_tests | true | 0 | `cargo run -q -p protheus-ops-core --bin protheus-ops -- backlog-queue-executor run --all=1 --with-tests=1` |
| srs_full_regression | true | 0 | `node scripts/ci/srs_full_regression.mjs` |
| srs_top200_regression | true | 0 | `node scripts/ci/srs_top200_regression.mjs` |
| srs_contract_runtime_evidence_test | true | 0 | `npm run -s test:ops:srs-contract-runtime-evidence` |
| verify | true | 0 | `./verify.sh` |
| srs_actionable_map:post | true | 0 | `node scripts/ci/srs_actionable_map.mjs` |
