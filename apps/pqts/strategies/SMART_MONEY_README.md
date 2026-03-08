# Smart Money Discovery Engine

## Architecture Overview

The Smart Money Discovery Engine automatically detects traders whose behavior predicts price movements.

### Key Innovations

1. **Lead-Lag Analysis**
   - Determines whether trader predicts or reacts to price
   - Lags tested: 10s, 30s, 60s, 120s, 5m, 10m, 30m, 1h
   - Statistical significance testing

2. **Synthetic Trader Detection**
   - For opaque markets (CEX) where wallets are hidden
   - Uses clustering to detect coordinated institutional flow
   - Features: size, timing, direction patterns

3. **Regime-Aware Performance**
   - Tracks trader performance per market condition
   - Regimes: high vol, low vol, trending, mean-reverting, liquidity
   - Identifies specialist traders for each regime

4. **Trader Classification**
   - **Predictive**: Leads price consistently
   - **Informed**: High predictive + high Sharpe
   - **Reactive**: Follows price
   - **Market Maker**: Provides liquidity profitably
   - **Noise**: Random, no edge

## Data Requirements

### On-Chain Markets (Polymarket, DEX)
```
wallet_id
trade_time
market/contract
side (buy/sell)
size
price
order_type (market/limit)
```

### Centralized Exchanges
```
For synthetic detection:
- order_id
- size
- timestamp
- side
- exchange
```

## Trader Scoring

### Composite Confidence Score
```
score = 
  sharpe_component * 0.25 +
  predictive_confidence * 0.35 +
  win_rate * 0.20 +
  trade_count_penalty * 0.20

Boost for informed traders: +20%
```

### Lead-Lag Test
```
For each lag Δt:
  correlation(trades_t, returns_t+Δt) → correlation[l]
  
optimal_lag = argmax(|correlation[l]|)
is_predictive = correlation[optimal_lag] > 0.15 AND p < 0.05
```

## Strategy Signals

### Multi-Trader Consensus
```
buy_score = Σ(top_trader.buy_size * trader.confidence)
sell_score = Σ(top_trader.sell_size * trader.confidence)

signal:
  buy if buy / (buy + sell) > 0.7
  sell if sell / (buy + sell) > 0.7
  neutral otherwise
```

### Position Sizing
```
size = base_size * signal_strength * signal_confidence
max_size = 15% of capital
```

## Risk Management

- Max position: 15% per trade
- Stop loss: 3%
- Max correlation with other strategies: 0.7
- Minimum traders for signal: 3
- Minimum confidence: 0.6

## Integration with AI Agent

### Discovery Loop
```
1. Scan all visible traders
2. Calculate lead-lag for each
3. Classify trader types
4. Score by confidence
5. Backtest copy strategies
6. Deploy if Sharpe > 1.2
7. Continuously update scores
```

### Regime Adaptation
```
When regime changes:
  - Recalculate regime-specific performance
  - Promote traders strong in new regime
  - Demote traders weak in new regime
```

## Advantages

1. **Behavioral signals** harder to arbitrage away than technicals
2. **Predictive** not just descriptive
3. **Multi-source discovery** - on-chain + synthetic clustering
4. **Continuous learning** - automatic trader discovery/retirement
5. **Regime robustness** - adapts to market conditions

## Limitations

- Requires visible trader data (on-chain or clustered)
- Lag sensitivity: Need <500ms to follow effectively
- Works best in less efficient markets
- Scale limited by liquidity availability

## Expected Performance

Based on backtest assumptions:
- Sharpe: 1.2-2.5
- Win rate: 55-65%
- Drawdown: 8-15%
- Correlation to market: 0.3-0.5

## Files

- `smart_money_discovery.py` - Core engine
- `smart_money_integration.py` - Strategy wrapper
- `whale_tracking.py` - Simpler whale copy (kept for reference)