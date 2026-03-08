# Evidence Audit Dashboard (`V6-COMP-003`)

Claim -> evidence -> receipt drilldown surface for operator/audit workflows.

## Command Surface

```bash
npm run -s ops:evidence-audit-dashboard:run
npm run -s ops:evidence-audit-dashboard:export
```

## Exports

- JSON export: `client/local/state/ops/evidence_audit_dashboard/export.json`
- Markdown export: `client/local/state/ops/evidence_audit_dashboard/export.md`

## Claim Evaluation Rule

A claim passes only when every configured evidence path exists and does not report `ok: false`.

Policy source: `client/config/evidence_audit_dashboard_policy.json`
