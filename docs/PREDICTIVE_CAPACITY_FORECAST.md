# Predictive Capacity Forecast

`RM-134` publishes 7/30 day capacity forecasts and preemptive scaling recommendations for queue depth, latency, token burn pressure, and model cooldown risk.

## Commands

```bash
node systems/ops/predictive_capacity_forecast.js run --strict=1
node systems/ops/predictive_capacity_forecast.js status
```

## Inputs

- `state/ops/execution_reliability_slo_history.jsonl`
- `state/ops/token_economics_engine_history.jsonl`
- `state/ops/queue_hygiene_state.json`
- `state/routing/model_health_auto_recovery/latest.json`
- `state/routing/banned_models.json`

## Outputs

- `state/ops/predictive_capacity_forecast/latest.json`
- `state/ops/predictive_capacity_forecast/history.jsonl`
- `state/ops/predictive_capacity_forecast/forecast_errors.jsonl`

## Error Tracking

Matured 7-day forecasts are auto-evaluated against current observed metrics; MAE is tracked per metric in `forecast_errors.jsonl` and surfaced in run output.
