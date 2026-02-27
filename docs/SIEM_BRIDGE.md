# SIEM Bridge

`RM-132` exports security/ops telemetry to SIEM-friendly formats and runs built-in correlation rules.

## Commands

```bash
node systems/observability/siem_bridge.js export --format=otlp
node systems/observability/siem_bridge.js export --format=cef
node systems/observability/siem_bridge.js correlate --strict=1
node systems/observability/siem_bridge.js status
```

## Correlation Rules

- `auth_anomaly`
- `integrity_drift`
- `guard_denies`

Each rule is token-based and thresholded (`min_hits`) from policy.

## Outputs

- Latest export payload
- Latest correlation result
- Alert round-trip receipt (`sent/acknowledged/ack_rate`)

Files:
- `state/observability/siem_bridge/latest_export.json`
- `state/observability/siem_bridge/latest_correlation.json`
- `state/observability/siem_bridge/alert_roundtrip.json`
- `state/observability/siem_bridge/receipts.jsonl`
