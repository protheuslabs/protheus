# PQTS - Protheus Quant Trading System

## Executive Summary

A professional-grade algorithmic trading platform designed for multi-market trading (crypto, equities, forex) with institutional-quality risk management, machine learning integration, and comprehensive analytics.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PQTS ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   MARKETS    │  │  STRATEGIES  │  │     ML       │      │
│  │              │  │              │  │              │      │
│  │ • Binance    │  │ • Scalping   │  │ • Ensemble   │      │
│  │ • Coinbase   │  │ • Arbitrage  │  │ • LSTM       │      │
│  │ • Alpaca     │  │ • Trend      │  │ • XGBoost    │      │
│  │ • OANDA      │  │ • Mean Rev   │  │ • Online     │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                 │
│              ┌────────────┴────────────┐                   │
│              │   TRADING ENGINE        │                   │
│              │                         │                   │
│              │ • Order Management      │                   │
│              │ • Position Tracking     │                   │
│              │ • Execution Logic       │                   │
│              └────────────┬────────────┘                   │
│                           │                                 │
│              ┌────────────┴────────────┐                   │
│              │   RISK MANAGER          │                   │
│              │                         │                   │
│              │ • Position Sizing       │                   │
│              │ • Drawdown Control      │                   │
│              │ • Correlation Limits    │                   │
│              └────────────┬────────────┘                   │
│                           │                                 │
│              ┌────────────┴────────────┐                   │
│              │   ANALYTICS DASHBOARD   │                   │
│              │                         │                   │
│              │ • Real-time P&L        │                   │
│              │ • Performance Metrics   │                   │
│              │ • Risk Reporting        │                   │
│              └─────────────────────────┘                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Strategy Channels

### 1. Scalping
**Timeframe:** 1m, 5m  
**Holding Period:** Seconds to minutes  
**Characteristics:**
- High frequency, small profits
- Tight stop losses
- Order book analysis
- Microstructure exploitation

**Indicators:**
- Order book imbalance
- Bid-ask spread
- Volume spikes
- Price momentum bursts

### 2. Arbitrage
**Types:**
- Cross-exchange arbitrage
- Triangular arbitrage
- Funding rate arbitrage
- Statistical arbitrage (pairs trading)

**Requirements:**
- Low latency execution
- Multiple exchange connections
- Real-time price synchronization

### 3. Trend Following
**Timeframes:** 1h, 4h, 1d  
**Holding Period:** Hours to days  
**Characteristics:**
- Momentum-based entries
- Trailing stop losses
- Multi-timeframe confirmation

**Indicators:**
- Moving averages (SMA, EMA)
- MACD
- ADX (trend strength)
- Ichimoku Cloud

### 4. Mean Reversion
**Timeframe:** 15m, 1h  
**Holding Period:** Hours  
**Characteristics:**
- Oversold/overbought bounces
- Statistical arbitrage
- Bollinger Band mean reversion

**Indicators:**
- RSI
- Bollinger Bands
- Stochastic Oscillator
- Z-score

### 5. Machine Learning
**Models:**
- Random Forest (ensemble)
- XGBoost (gradient boosting)
- LSTM (sequential patterns)
- Online learning (continuous updates)

**Features:**
- Technical indicators
- Price action patterns
- Volume profiles
- Cross-market correlations

## Universal Indicators

All indicators normalized to work across crypto, equities, and forex:

| Indicator | Type | Markets | Description |
|-----------|------|---------|-------------|
| RSI | Momentum | All | Relative Strength Index |
| MACD | Trend | All | Moving Average Convergence |
| Bollinger Bands | Volatility | All | Standard deviation bands |
| ATR | Volatility | All | Average True Range |
| VWAP | Volume | All | Volume Weighted Average Price |
| ADX | Trend Strength | All | Average Directional Index |
| Ichimoku | Trend | All | Comprehensive trend system |
| Stochastic | Momentum | All | Overbought/Oversold |

## Risk Management

### Position Sizing
- **Kelly Criterion:** Optimal bet sizing based on win rate
- **Risk Parity:** Equal risk contribution across positions
- **Volatility Targeting:** Adjust size based on market volatility

### Risk Limits
```yaml
max_portfolio_risk_pct: 2.0      # Max 2% portfolio risk per trade
max_position_risk_pct: 1.0       # Max 1% risk per position
max_drawdown_pct: 10.0           # Stop trading at 10% drawdown
max_correlation: 0.7             # Max correlation between positions
max_positions: 15                # Max simultaneous positions
max_leverage: 2.0                # Max 2x leverage
```

### Stop Loss Types
1. **Fixed:** Percentage-based stop
2. **Trailing:** Follows price movement
3. **Volatility-based:** ATR-based stops
4. **Time-based:** Exit after time limit

## Machine Learning Pipeline

### Training Process
1. **Data Collection:** Historical OHLCV + features
2. **Feature Engineering:** Technical indicators, patterns
3. **Label Generation:** Future returns classification
4. **Model Training:** Cross-validation, hyperparameter tuning
5. **Backtesting:** Out-of-sample performance
6. **Deployment:** Live prediction with confidence thresholds

### Online Learning
- Models update continuously with new data
- Drift detection for model degradation
- Automatic retraining triggers

### Feature Importance
Track which features drive predictions:
- Price momentum
- Volume patterns
- Volatility measures
- Cross-market signals

## Analytics Dashboard

### Real-time Metrics
- **P&L:** Realized and unrealized profit/loss
- **Positions:** Current holdings and exposure
- **Orders:** Pending and filled orders
- **Risk:** VaR, drawdown, correlation

### Performance Reports
- **Sharpe Ratio:** Risk-adjusted returns
- **Sortino Ratio:** Downside risk-adjusted returns
- **Max Drawdown:** Peak-to-trough decline
- **Win Rate:** Percentage of winning trades
- **Profit Factor:** Gross profit / gross loss

### Visualization
- Equity curve
- Drawdown chart
- Trade distribution
- Strategy performance comparison

## API Integration

### Crypto Exchanges
- **Binance:** Spot, Futures, Testnet
- **Coinbase Pro:** Spot trading
- **Kraken:** Spot and margin

### Equity Brokers
- **Alpaca:** Commission-free, paper trading
- **Interactive Brokers:** Professional execution

### Forex Brokers
- **OANDA:** Major pairs, CFDs
- **Forex.com:** Retail forex

## Configuration

### Paper Trading
```yaml
mode: paper_trading
markets:
  crypto:
    enabled: true
    exchanges:
      - name: binance
        testnet: true
```

### Live Trading
```yaml
mode: live
markets:
  crypto:
    enabled: true
    exchanges:
      - name: binance
        testnet: false
        api_key: ${BINANCE_API_KEY}
        api_secret: ${BINANCE_API_SECRET}
```

## Development Roadmap

### Phase 1: Foundation (Complete)
- ✅ Core trading engine
- ✅ Risk management
- ✅ Universal indicators
- ✅ Basic strategies

### Phase 2: Advanced Features
- 🔄 ML model training pipeline
- 🔄 Multi-exchange arbitrage
- 🔄 Real-time dashboard
- 🔄 Backtesting framework

### Phase 3: Production
- ⏳ Live trading deployment
- ⏳ Advanced analytics
- ⏳ Mobile alerts
- ⏳ Automated reporting

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Set environment variables
export BINANCE_TESTNET_API_KEY="your_key"
export BINANCE_TESTNET_API_SECRET="your_secret"

# Run paper trading
python main.py config/paper.yaml

# View dashboard
python -m analytics.dashboard
```

## Testing

```bash
# Run all tests
pytest tests/

# Run specific test suite
pytest tests/unit/
pytest tests/integration/

# Backtest strategy
python -m ml.backtest --strategy trend_following
```

## License

Proprietary - Protheus Labs
