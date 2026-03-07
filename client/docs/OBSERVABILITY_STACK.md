# Observability Stack (RM-005)

This stack adds three production control-plane observability lanes:

- `client/systems/observability/metrics_exporter.js`
- `client/systems/observability/trace_bridge.js`
- `client/systems/observability/slo_alert_router.js`

Policy:

- `client/config/observability_policy.json`

## Metrics (Prometheus Snapshot)

Command:

```bash
node client/systems/observability/metrics_exporter.js run 2026-02-26 --window=daily
```

Outputs:

- Prometheus text: `state/observability/prometheus/current.prom`
- Latest JSON snapshot: `state/observability/metrics/latest.json`
- JSONL history: `state/observability/metrics/history.jsonl`

Primary metric groups:

- autonomy SLO level/warn/critical/fail counts
- verification pass rate
- queue/policy-hold branch pressure
- workflow executor SLO metrics
- CI baseline streak progress

## Tracing (OpenTelemetry-style JSONL)

Emit span:

```bash
node client/systems/observability/trace_bridge.js span \
  --name=spine.autonomy_health.daily \
  --status=warn \
  --duration-ms=120 \
  --attrs-json='{"window":"daily","critical_count":"1"}'
```

Summarize:

```bash
node client/systems/observability/trace_bridge.js summary --hours=24
```

Outputs:

- Spans JSONL: `state/observability/tracing/spans.jsonl`
- Latest span: `state/observability/tracing/latest.json`

## Alert Routing (SLO Breach Routing)

Route alerts from health status output:

```bash
node client/systems/observability/slo_alert_router.js route 2026-02-26 --min-level=warn
```

Outputs:

- Routed alert stream: `state/observability/alerts/routed.jsonl`
- Router dedupe state: `state/observability/alerts/router_state.json`

Sinks:

- file sink (default on)
- stdout sink (optional)
- webhook sink (optional, off by default)

Webhook config:

- `alert_routing.sinks.webhook.enabled=true`
- set URL in policy `url` or env `OBSERVABILITY_ALERT_WEBHOOK_URL`

## Spine Integration

`client/systems/spine/spine.js` can emit observability lanes automatically.

Relevant env flags:

- `SPINE_OBSERVABILITY_ENABLED=1` (default)
- `SPINE_OBSERVABILITY_TRACE_ENABLED=1` (default)
- `SPINE_OBSERVABILITY_ALERT_MIN_LEVEL=warn` (default)
- `SPINE_OBSERVABILITY_STRICT=0` (default)
- `SPINE_OBSERVABILITY_METRICS_WINDOW=daily` (default)

When enabled:

1. health runs produce SLO alerts
2. alert router routes + dedupes breach alerts
3. metrics snapshot is generated
4. trace spans are emitted for health/metrics lanes
