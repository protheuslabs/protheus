# World-Class Next Steps Execution

This document operationalizes the 10-step checklist into executable commands.

## One-shot Orchestrator

Run all 10 steps in quick smoke mode:

```bash
python scripts/run_world_class_ops.py --config config/paper.yaml --quick
```

Run the same checklist in longer mode:

```bash
python scripts/run_world_class_ops.py --config config/paper.yaml
```

## Individual Steps

1. Paper campaign with readiness gates:

```bash
python scripts/daily_paper_ops.py --config config/paper.yaml --require-ready --require-no-critical-alerts
```

2. WS ingestion + data lake:

```bash
python scripts/run_ws_ingestion.py --config config/paper.yaml --data-lake-root data/lake --cycles 1440 --sleep-seconds 1.0
```

3. Incident automation:

```bash
python scripts/run_incident_automation.py --ops-events data/analytics/ops_events.jsonl --incident-log data/analytics/incidents.jsonl --since-minutes 60
```

4. Monthly attribution:

```bash
python scripts/monthly_attribution_report.py --db-path data/research.db --stage paper --lookback-days 90
```

5. Adapter certification:

```bash
python scripts/run_exchange_certification.py --venues binance,coinbase,alpaca,oanda
```

6. Live secret validation:

```bash
python scripts/validate_live_secrets.py --config config/live_canary.yaml --strict
```

7. Live canary prep + ramp:

```bash
python scripts/run_shadow_stream_worker.py --config config/paper.yaml --cycles 60 --sleep-seconds 1.0
python scripts/slo_health_report.py --stream-health data/analytics/stream_health.json
python scripts/run_canary_ramp.py --config config/paper.yaml
```

8. Capacity ladder:

```bash
python scripts/run_capacity_ladder.py --strategy-id capacity_probe --venue binance --symbol BTCUSDT
```

9. Failure drills:

```bash
python scripts/run_failure_drills.py --config config/paper.yaml
```

10. Entitlement regression:

```bash
pytest -q tests/test_multi_tenant.py
```

## Suggested Schedule (cron)

```cron
# Hourly incidents
0 * * * * cd /Users/jay/.openclaw/workspace/pqts && /usr/bin/python3 scripts/run_incident_automation.py --since-minutes 60 >> logs/incident_automation.log 2>&1

# Daily paper ops
5 0 * * * cd /Users/jay/.openclaw/workspace/pqts && /usr/bin/python3 scripts/daily_paper_ops.py --config config/paper.yaml --require-ready --require-no-critical-alerts >> logs/daily_paper_ops.log 2>&1

# Weekly attribution + canary ramp
15 1 * * 1 cd /Users/jay/.openclaw/workspace/pqts && /usr/bin/python3 scripts/monthly_attribution_report.py --db-path data/research.db --stage paper --lookback-days 90 >> logs/monthly_attribution.log 2>&1
30 1 * * 1 cd /Users/jay/.openclaw/workspace/pqts && /usr/bin/python3 scripts/run_canary_ramp.py --config config/paper.yaml >> logs/canary_ramp.log 2>&1
```
