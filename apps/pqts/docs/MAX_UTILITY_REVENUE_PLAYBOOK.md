# Max Utility + Revenue Playbook

Last updated: 2026-03-04 (America/Denver)

## Objective

Run PQTS as a measurable quant platform with two outputs:
1. Net-trading alpha after costs/risk controls.
2. B2B control-plane revenue (research + execution + risk ops tooling).

## Stack Added

1. **Execution truth layer**
- Immutable order lifecycle ledger: `data/analytics/order_ledger.jsonl`
- Websocket ingestion events: `data/analytics/ws_ingestion_events.jsonl`
- Required states: `submitted -> acknowledged -> (partially_filled|filled|canceled|rejected)`

2. **Data moat**
- Partitioned lakehouse by `channel/venue/symbol/date`
- Deterministic replay API from lake partitions
- Hard quality gates (completeness/missing intervals/monotonicity)

3. **Research tournament + promotion**
- Automated tournament runner from lake data
- Quality gate must pass before research cycle runs
- Live scope enforcement for strategy types

4. **Canary capital ramp policy**
- Default ladder: `1% -> 2% -> 5% -> 10%`
- Actions: `advance | hold | rollback | halt`
- Rollback/halt on policy breaches

5. **B2B control-plane meter**
- Tenant usage/event meter
- MRR/ARR rollup + deterministic pricing tier recommendation

## Operating Commands

```bash
# Execution truth layer
python scripts/run_ws_ingestion.py --cycles 30 --sleep-seconds 1.0

# Data-driven strategy tournament
python scripts/run_strategy_tournament.py \
  --start 2026-01-01T00:00:00Z \
  --end 2026-02-01T00:00:00Z \
  --sources binance:BTCUSDT,binance:ETHUSDT \
  --strategy-types market_making,funding_arbitrage

# Reconciliation + SLO + weekly error budget
python scripts/run_reconciliation_daemon.py --halt-on-mismatch
python scripts/slo_health_report.py
python scripts/weekly_error_budget_review.py --window-days 7

# Canary capital policy
python scripts/run_canary_ramp.py

# Commercial control-plane report
python scripts/control_plane_report.py
```

## Hard Gates

1. **Promotion blocker**
- If data-quality gate fails, tournament/promotion is blocked.

2. **Live scope blocker**
- `live_canary/live` promotion blocked unless strategy type is in configured allowlist.

3. **Canary blocker**
- Rollback/halt on reject/slippage/reconciliation/critical-alert breaches.

4. **Operational blocker**
- Reconciliation mismatch can force router halt.

## KPI Targets

- Stream uptime: `>= 99.5%`
- Reject rate: `<= 5%` (canary policy default)
- Slippage MAPE: `<= 25%` (canary policy default)
- Reconciliation incidents: `0` at canary scale-up checkpoints
- Error-budget weekly report: no breached objectives before capital increase
