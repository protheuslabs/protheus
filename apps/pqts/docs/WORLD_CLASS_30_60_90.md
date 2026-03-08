# PQTS World-Class 30/60/90 Plan

Last updated: 2026-03-04 (America/Denver)

## Goal

Close the paper-to-live gap and run a measurable, auditable promotion pipeline where live capital decisions are enforced by data.

## Day 0-30: Execution Parity Foundation

### Deliverables

1. Streaming contracts per venue (`market`, `order`, `fill`) and router stream registry.
2. Queue-position-aware paper fill simulation.
3. Daily execution drift report from TCA (`predicted vs realized slippage`).
4. Dashboard telemetry:
   - simulation leaderboard
   - top-level KPI cards (best quality / top optimization target)

### Hard Metrics

- Drift report generated daily with no gaps.
- `slippage_mape_pct` tracked by symbol@venue.
- Queue-aware fill tests + stream contract tests all passing in CI.
- `pytest` remains green.

## Day 31-60: Live Shadow + Reconciliation

### Deliverables

1. Shadow live feed collectors for market/order/fill streams (no trading side effects).
2. Internal-vs-venue reconciliation loop for:
   - positions
   - open orders
   - balances
3. SLO alerting for latency/reject/fill degradation.
4. Weekly error-budget review artifact from SLO reports.

### Hard Metrics

- Reconciliation mismatch rate < 0.1% of checks.
- Reconciliation MTTR < 5 minutes.
- Stream uptime > 99.5% over rolling 30 days.
- Drift delta trend improving week-over-week.
- Weekly error-budget report published with objective-level burn rates.

## Day 61-90: Controlled Capital Ramp

### Deliverables

1. Policy-driven canary allocator:
   - 1% -> 2% -> 5% -> 10% exposure progression
2. Automatic rollback policies on:
   - slippage MAPE breach
   - reject-rate breach
   - reconciliation mismatch breach
3. Promotion evidence bundle:
   - backtest + purged CV + walk-forward + deflated Sharpe
   - paper drift + live shadow parity

### Hard Metrics

- No capital escalation without gate pass.
- Canary rollback latency < 1 event loop tick after breach.
- 30-day canary performance with risk-adjusted targets met:
  - Sharpe threshold
  - max drawdown threshold
  - drift thresholds

## Weekly Operating Cadence

1. Monday: review drift report + top optimization targets.
2. Tuesday-Wednesday: execute strategy/venue execution improvements.
3. Thursday: rerun simulation suites and compare leaderboard deltas.
4. Friday: promotion committee review with hard-gate artifacts only.

## Stop Conditions

- No live allocation increase while any critical operational alert exists.
- No live allocation increase while drift report shows unresolved alerts.
- No strategy promotion without full artifact lineage and reproducibility.
