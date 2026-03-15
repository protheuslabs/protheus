# External Unblock Operator Runbook

Use this runbook to unblock the remaining `blocked_external` SRS items with deterministic evidence handling.

## 1) Refresh current blocked inventory

```bash
cd ${WORKSPACE_ROOT:-$(pwd)}
npm run -s ops:blocked-external:plan
npm run -s ops:blocked-external:top10
```

Outputs:
- `local/workspace/reports/BLOCKED_EXTERNAL_UNBLOCK_PLAN.md`
- `local/workspace/reports/BLOCKED_EXTERNAL_TOP10.md`

## 2) Prepare packet scaffolds (idempotent)

```bash
npm run -s ops:blocked-external:scaffold
```

Each blocked ID must have:
- `docs/external/evidence/<ID>/README.md`
- At least one real artifact file (report/export/cert/screenshot/log)

## 3) Audit packet quality

```bash
npm run -s ops:blocked-external:evidence
npm run -s ops:blocked-external:packet-audit
```

Target state:
- `blocked_external_evidence_status`: `ready_for_reconcile > 0`
- `blocked_external_packet_audit`: packet status `ready_for_reconcile`

## 4) Reconcile evidence-ready IDs into execution

Dry run:

```bash
npm run -s ops:blocked-external:reconcile
```

Apply status move (`blocked -> in_progress`) for evidence-ready IDs:

```bash
npm run -s ops:blocked-external:reconcile -- --apply=1
```

## 5) Validate and continue execution

```bash
node tests/tooling/scripts/ci/srs_actionable_map.mjs
node tests/tooling/scripts/ci/srs_full_regression.mjs
./verify.sh
```

If `execute_now > 0`, resume normal lane execution flow.
