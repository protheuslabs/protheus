# Alpha Discovery Agent System Interfaces

## Required Platform APIs

The agent produces **structured artifacts** (not code). The platform compiles and runs them.

### Data API
```python
list_datasets() -> [dataset_id]
get_market_data(dataset_id, symbols, start, end, granularity) -> events
def get_event_metadata(dataset_id) -> schema, timestamp_resolution, venue, fees
```

### Feature API
```python
list_primitives() -> operators, base_series
compile_feature(feature_expr) -> feature_id
compute_feature(feature_id, dataset_id, symbols, start, end) -> series
```

### Strategy API
```python
compile_strategy(strategy_spec) -> strategy_id
backtest(strategy_id, dataset_id, sim_config) -> report_id
walk_forward(strategy_id, dataset_id, wf_config) -> wf_report_id
paper_trade(strategy_id, paper_config) -> paper_run_id
promote_live(strategy_id, allocation_config) -> live_id
kill(strategy_id or live_id, reason)
```

### Experiment DB
```python
log_experiment(artifact_hashes, configs, metrics, diagnostics) -> experiment_id
query_experiments(filters) -> results
get_top_strategies(objective, constraints, regime) -> ranked list
```

### Monitoring
```python
get_live_metrics(live_id) -> pnl, slippage, fills, drawdown, latency
get_regime_state(dataset_id or live_feed) -> regime_labels
```

---

## Strategy Specification DSL

YAML/JSON representation that the agent produces:

```yaml
strategy_name: "imbalance_mm_v3"
version: "1.0"
universe:
  symbols: ["BTC-PERP"]
  venue: "binance"

features:
  - expr: "zscore(imbalance(l1_bid_size, l1_ask_size), 200)"
  - expr: "realized_vol(mid_price, 1000)"
  - expr: "spread(l1_ask, l1_bid)"

model:
  type: "linear"           # linear, xgboost, mlp, logistic
  target: "future_mid_return"
  horizon_ms: 200
  regularization: "l2"

signal:
  rule: "clip(model_pred, -1, 1)"
  threshold: 0.1

portfolio:
  sizing: "vol_target"
  vol_target_annual: 0.25
  max_gross: 1.0
  max_symbol_weight: 0.25

execution:
  style: "market_making"
  quote_spread_bps: "base + k_vol * vol"
  max_quote_age_ms: 200
  cancel_on_toxicity: true

risk:
  max_daily_loss_pct: 0.02
  max_drawdown_pct: 0.10
  max_position_notional: 25000

validation:
  costs: "realistic"
  holdout_policy: "walk_forward"
```

**Key constraint:** Agent produces StrategySpecs, not code. The platform compiles them.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    ALPHA DISCOVERY AGENT                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
    ┌───────────────────────────┼───────────────────┐
    ▼                           ▼                   ▼
┌───────────┐           ┌──────────────┐     ┌──────────────┐
│ ALPHA     │           │ STRATEGY     │     │ EXPERIMENT   │
│ FACTORY   │           │ CONSTRUCTOR  │     │ VALIDATOR    │
│           │           │              │     │              │
│ - Enumerate│          │ - Templates  │     │ - Backtest   │
│ - Genetic │           │ - Variants   │     │ - WF         │
│ - Learned │           │ - Execution  │     │ - PBO/Deflated│
└─────┬─────┘           └──────┬───────┘     │ - Gates      │
      │                        │             └──────┬───────┘
      ▼                        ▼                    │
┌──────────────────────────────────────────────────┘
│                      PROMOTION SELECTOR            │
│                         (Top 3-4 diversity-aware) │
└───────────────────────────┬────────────────────────┘
                            ▼
                   ┌─────────────────┐
                   │  PAPER TRADING  │
                   │  (N days test)  │
                   └────────┬────────┘
                            ▼
                   ┌─────────────────┐
                   │  LIVE CANARY    │
                   │  (10%→90%)      │
                   └────────┬────────┘
                            ▼
                   ┌─────────────────┐
                   │  MONITORING     │
                   │  & RETIREMENT   │
                   └─────────────────┘
```

---

## Discovery Loop (Detailed)

### Phase 1: Feature Synthesis (Alpha Factory)

**Mode A - Enumerative DSL Search:**
```python
for depth in range(1, max_depth+1):
  for operator in operators:
    for base in base_series:
      expr = f"{operator}({base}, {window})"
      
      # Gate 1: Not lookahead
      # Gate 2: Is stationary
      # Gate 3: Low redundancy
      # Gate 4: Some predictiveness
```

**Mode B - Genetic Programming:**
```python
population = random_features(n=100)
for generation in range(10):
  fitness = evaluate_performance(population)
  parents = select_top(fitness, 50%)
  offspring = crossover_and_mutate(parents)
  population = parents + offspring
```

**Feature Gates (cheap pre-tests):**
1. Causality check - no lookahead operators
2. Stability check - distribution not drifting
3. Predictiveness sanity - correlation > 0 on validation
4. Redundancy - correlation < 0.8 vs existing features

### Phase 2: Strategy Construction

**Required Templates:**
1. Market-making with toxicity filter
2. Taker momentum (short-horizon)
3. Mean reversion (microstructure)
4. Carry/funding capture
5. Cross-venue spread capture

**Variants per feature:**
- 5 horizons: 200ms, 500ms, 1000ms, 2000ms, 5000ms
- 5 spread multipliers: 2, 5, 10, 20, 50 bps
- 3 inventory skews: neutral, aggressive, passive

### Phase 3: Validation

**Backtest Requirements:**
- ✓ Fees and rebates
- ✓ Latency model
- ✓ Slippage / partial fills
- ✓ Order book simulation
- ✓ Market impact penalty

**Walk-Forward:**
- Multiple rolling windows
- Embargo periods (no leakage)
- Consistency across windows

**Multiple Testing Control:**
```python
deflated_sharpe = sharpe / sqrt(n_trials)  # Simplified
pbo = variance_across_cv / mean^2  # Approximation
```

**Promotion Thresholds:**
- Sharpe > 1.2 (OOS)
- Max DD < 15%
- Turnover < 10x/year (except MM)
- Stability: no month > 60% of PnL
- PBO < 0.5

### Phase 4: Promotion

**Selection Criteria:**
```python
candidates = filter(gates_passed, experiments)
candidates.sort(deflated_sharpe, reverse=True)

selected = []
for candidate in candidates:
  if diversity_check(candidate, selected):
    selected.append(candidate)
  if len(selected) >= 3:
    break
```

**Paper Stage:**
- Run for N days or N trades
- Compare realized vs simulation
- Compute "simulation gap"
- Promote if gap < tolerance

**Live Stage:**
- Start with 10% allocation
- Champion/challenger: 90/10 → 80/20
- Strict kill thresholds
- Auto-rollback on breach

---

## Compute Budgeting

**Bandit-based allocation:**
```python
# 60% exploitation, 40% exploration
research_buckets = {
  'template_type': {...},
  'feature_family': {...},
  'market_regime': {...}
}

# Allocate by success rate + exploration bonus
for bucket in buckets:
  allocation = (0.6 * success_rate + 0.4 * exploration_bonus)
  trials_per_bucket[bucket] = allocation * total_budget
```

---

## Meta-Research (ResearchMap)

Tracks what works:
```python
research_map = {
  'operator_success': {
    'zscore': {'wins': 15, 'total': 50},
    'rolling_mean': {'wins': 20, 'total': 60},
  },
  'template_success': {
    'market_making': {'wins': 5, 'total': 20},
  },
  'horizon_per_venue': {
    'binance': {'200ms': 0.3, '1000ms': 0.4}
  },
  'execution_correlation': {
    'spread_optimal': 0.2,
    'toxicity_filter': 0.15
  }
}
```

Updates after each batch.

---

## Monitoring & Retirement

**Live Metrics:**
- Rolling Sharpe (30d window)
- Drawdown
- Slippage drift (actual vs expected)
- Fill rate drift
- Feature distribution drift
- Regime mismatch

**Retirement Conditions:**
```python
if rolling_sharpe < 0.5 for 3 windows:
  retire('decaying')
if drawdown > max_dd:
  retire('breach')
if slippage > backtest * 2:
  retire('model drift')
if latency_variance > threshold:
  retire('execution unstable')
```

---

## Implementation Priority

### Minimal Viable (Real Quant) Version:
1. ✅ DSL + enumerative search (depth-limited)
2. ✅ Strict walk-forward + multiple-testing penalties
3. 2 templates: market-making + taker momentum
4. Experiment DB + bandit budgeting
5. Paper trading + sim-gap analysis
6. Live canary + kill switches

**That alone feels like a quant shop.**

Remaining:
7. Full 5 templates
8. Genetic programming mode
9. Representation learning mode
10. Full online learning integration

---

## Files

- `research/alpha_discovery_agent.py` - Main agent orchestrator
- `backtesting/purged_cv.py` - Validation gates
- `research/hyperopt.py` - Optuna integration
- `research/strategy_selection.py` - Promotion selector
- `portfolio/fractional_kelly.py` - Capital allocation
