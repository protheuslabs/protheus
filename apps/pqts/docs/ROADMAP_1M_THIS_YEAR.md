# PQTS Roadmap to $1M This Calendar Year

Last updated: 2026-03-04 (America/Denver)
Feasibility snapshot as of: 2026-03-04

## 1) Feasibility Math: What $1M Profit Implies

Target annual PnL: **$1,000,000 net of trading costs**.

Model:
- Gross return = `Sharpe * AnnualVol`
- Annual cost drag = `Turnover * CostPerTurnover`
- Net return = `Gross return - Cost drag`
- Required capital = `1,000,000 / Net return`

Where:
- `AnnualVol` in decimal (15%-25%)
- `CostPerTurnover` in decimal (e.g., 45 bps = 0.45%)
- Turnover in x/year (not daily)

### Scenario Table

| Scenario | Sharpe | Vol | Gross Return | Turnover | Cost / Turnover | Annual Cost Drag | Net Return | Capital Needed for $1M |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Conservative | 1.00 | 15% | 15.00% | 8.0x | 60 bps | 4.80% | 10.20% | **$9.80M** |
| Realistic | 1.25 | 20% | 25.00% | 6.0x | 45 bps | 2.70% | 22.30% | **$4.48M** |
| Aggressive | 1.50 | 25% | 37.50% | 5.0x | 35 bps | 1.75% | 35.75% | **$2.80M** |

### Interpretation
- With capital below ~$3M, only the aggressive scenario reaches $1M and requires strong execution quality and low cost leakage.
- With ~$4.5M, the realistic scenario is sufficient if realized Sharpe >= 1.25 and annual cost drag stays near 2.7%.
- With ~$10M, even conservative assumptions can reach the target.
- A "10x per month" objective implies >11,000,000% annualized return, which violates realistic Sharpe/vol/cost bounds and is blocked by objective constraints in the research agent.

## 2) Strategy Focus (Fit to Current Engine)

Prioritize strategies that benefit from risk-aware routing, microstructure models, and TCA calibration:

1. Market making with microstructure filters
- Inventory-aware quoting
- Queue position and spread state filters
- Hard stop for adverse selection windows

2. Funding/carry arbitrage
- Cross-venue/perp funding dislocations
- Carry-adjusted position sizing and financing constraints
- Capacity-aware with borrow/funding stress limits

3. Cross-venue spread/basis
- Spot-perp basis and venue spread convergence
- Latency- and fill-risk aware execution
- Strict stale-quote and venue health checks

4. Smart-money/behavioral signals
- Only include if feature stability and out-of-sample lift survive purged CV
- Drop entirely if incremental IR fails over walk-forward windows

## 3) Promotion Pipeline (Hard Gates)

A strategy can be promoted only if all gates pass:

1. Research gate
- Purged CV + embargoed splits
- Walk-forward evaluation with realistic costs and slippage
- Deflated Sharpe Ratio above threshold (for multiple-testing control)

2. Paper-trading gate (minimum 30 days)
- 30 calendar days live market replay/paper execution
- Realized slippage MAPE below threshold by symbol/venue
- No kill-switch breaches; no bypass of `RiskAwareRouter.submit_order`

3. Live canary gate
- Initial capital allocation 2%-5% of target strategy sleeve
- Automatic rollback on threshold breaches
- Promotion only after statistically significant positive live alpha

4. Kill-switch thresholds (non-negotiable)
- Daily loss, drawdown, leverage, and slippage thresholds enforced mechanically
- Immediate FLATTEN on critical breach
- Re-enable trading requires explicit human review

## 4) 30/60/90-Day Operational Milestones

### Day 0-30
- Lock CI as hard gate (`pytest`, `flake8`, raw CI verification).
- Enforce token-gated adapter path and single order choke point.
- Begin paper fills + TCA storage for all routed orders.
- Baseline top 3 candidate strategies with purged CV and walk-forward.

### Day 31-60
- Run 30-day paper track records for candidate strategies.
- Weekly eta calibration by symbol/venue from realized slippage.
- Reject or refactor strategies failing DSR, slippage, or stability gates.
- Implement live canary runbook and rollback automation.

### Day 61-90
- Launch canary capital in staged tranches.
- Monitor realized Sharpe, drawdown, and cost-drag vs plan.
- Promote only strategies with validated live edge and stable TCA error.
- Re-forecast capital required for $1M using realized, not backtest, metrics.

## 5) Evidence Policy for Quant Claims

No claim like "Sharpe X" or "CAGR Y" is valid unless produced by reproducible backtest artifacts that include:
- Realistic transaction costs + slippage
- Walk-forward and purged CV evaluation
- Overfit controls (including Deflated Sharpe)
- Versioned data slice, config, commit SHA, and test pass evidence

This policy is required before paper or live capital promotion.
