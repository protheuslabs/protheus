# Heartbeat KPI

Canonical report for reminder/heartbeat readiness.

## Command

```bash
npm run -s metrics:heartbeat-kpi
```

## Outputs

- Latest snapshot: `core/local/artifacts/heartbeat/heartbeat_kpi_latest.json`
- History stream: `core/local/artifacts/heartbeat/heartbeat_kpi_history.jsonl`

## KPI Contract

- `checks_total`: fixed at 3
- `checks_passed`: count of passing checks
- `completion_rate`: `checks_passed / checks_total`

Checks:

1. `slack_status` readiness from `client/runtime/systems/ops/reminder_data_bridge.ts`
2. `moltcheck_status` readiness from `client/runtime/systems/ops/reminder_data_bridge.ts`
3. `deployment_health` from `tests/tooling/scripts/utils/health-check-deployment.sh`

This report is published daily via `.github/workflows/heartbeat-kpi.yml`.
