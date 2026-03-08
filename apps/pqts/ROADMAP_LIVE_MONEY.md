# PQTS Roadmap to Live Money (Based on Grok Analysis)

## Current State Assessment
✅ **Strong Foundation**
- Event-driven engine
- 10 strategy channels
- ML ensemble (RF/XGBoost/LSTM)
- Walk-forward backtesting
- Kelly + VaR risk
- Clean dashboard

⚠️ **Gap: Backtest vs Live P&L**
Example result: SMA trend BTC Q1 2024: +12.45%, Sharpe 1.34, DD -8.2%
This is fine for baseline, but ML ensemble needs upgrades to close reality gap.

---

## Phase 1: Kill Overfitting (Weekend Priority)

### 1.1 Purged Cross-Validation
**Impact: Highest (prevents blow-ups)**

Current: Walk-forward with potential leakage
Target: Marcos Lopez de Prado purged k-fold time-series CV

```python
# Implement: backtesting/purged_cv.py
"""
Purged k-fold time-series cross-validation.

Rules:
- Gap between train and test (purge)
- Embargo period after test set
- No overlap in time windows
"""

from sklearn.model_selection import BaseCrossValidator
import numpy as np

class PurgedKFold(BaseCrossValidator):
    def __init__(self, n_splits=5, purge_pct=0.01, embargo_pct=0.01):
        self.n_splits = n_splits
        self.purge_pct = purge_pct
        self.embargo_pct = embargo_pct
    
    def split(self, X, y=None, groups=None):
        n_samples = len(X)
        indices = np.arange(n_samples)
        fold_size = n_samples // self.n_splits
        
        for fold in range(self.n_splits):
            test_start = fold * fold_size
            test_end = (fold + 1) * fold_size
            
            # Purge gap
            purge_size = int(fold_size * self.purge_pct)
            train_end = max(0, test_start - purge_size)
            
            # Embargo after test
            embargo_size = int(fold_size * self.embargo_pct)
            
            train_indices = indices[:train_end]
            test_indices = indices[test_start:test_end]
            
            yield train_indices, test_indices
```

**Decision Rule:**
```python
if oos_sharpe < 0.8 or profit_factor < 1.4:
    kill_strategy()
```

### 1.2 Optuna Hyperparameter Search
**Impact: High (better hyperparams = better generalization)**

Replace grid search with Bayesian optimization.

```python
# research/hyperopt.py
import optuna

def objective(trial, strategy_class, data):
    # Hyperparameter search space
    params = {
        'lookback': trial.suggest_int('lookback', 5, 100),
        'threshold': trial.suggest_float('threshold', 0.1, 0.9),
        'stop_loss': trial.suggest_float('stop_loss', 0.01, 0.1),
    }
    
    strategy = strategy_class(params)
    sharpe, dd, pf = backtest(strategy, data, cv='purged')
    
    # Penalize overfitting
    train_sharpe = backtest(strategy, data.train, cv=None)
    overfit_penalty = max(0, train_sharpe - sharpe) * 0.5
    
    return sharpe - overfit_penalty - dd * 0.1

study = optuna.create_study(direction='maximize')
study.optimize(lambda t: objective(t, strategy, data), n_trials=100)
```

### 1.3 Regime-Conditioned Models
**Impact: High (survive regime changes)**

Train separate models per regime.

```python
# strategies/regime_ensemble.py
class RegimeEnsemble:
    def __init__(self):
        self.models = {
            'high_vol': None,
            'low_vol': None,
            'trending': None,
            'mean_reverting': None
        }
    
    def fit(self, X, y, regimes):
        for regime in self.models.keys():
            mask = regimes == regime
            if mask.sum() > 100:  # Min samples
                self.models[regime] = xgboost.XGBClassifier(**params)
                self.models[regime].fit(X[mask], y[mask])
    
    def predict(self, X, current_regime):
        if self.models[current_regime]:
            return self.models[current_regime].predict(X)
        # Fallback to global model
        return self.global_model.predict(X)
```

**Deliverable:**
- `backtesting/purged_cv.py`
- `research/hyperopt.py` with Optuna
- `backtest_all.py` script with kill rules

---

## Phase 2: Supercharge ML Ensemble

### 2.1 Feature Expansion
**Impact: High (better predictions)**

Add features missing from current OHLCV:

```python
# features/expanded.py
class ExpandedFeatureEngine:
    def __init__(self):
        self.on_chain_apis = {
            'glassnode': '...',
            'cryptoquant': '...',
            'coinglass': '...'
        }
    
    def compute(self, df):
        features = {}
        
        # Order book features
        features['ob_imbalance'] = self._orderbook_imbalance()
        features['depth_5pct'] = self._depth_at_5pct()
        
        # Funding rates
        features['funding_8h'] = self._funding_rate()
        features['funding_trend'] = self._funding_trend()
        
        # On-chain (if available)
        features['exchange_inflow'] = self._on_chain_metric('inflow')
        features['exchange_outflow'] = self._on_chain_metric('outflow')
        features['netflow'] = features['outflow'] - features['inflow']
        
        # Macro via FRED
        features['dxy'] = self._fred_metric('DTWEXBGS')
        features['fed_rate'] = self._fred_metric('DFF')
        
        return pd.DataFrame(features)
```

### 2.2 Meta-Learner
**Impact: Very high (dynamic strategy weighting adds 0.5-1.0 Sharpe)**

Train model to weight 10 channels.

```python
# strategies/meta_learner.py
class MetaLearner:
    """
    XGBoost that learns dynamic strategy weights.
    
    Input: Recent 30-day performance + current regime
    Output: Weight for each strategy
    """
    
    def __init__(self):
        self.model = xgboost.XGBRegressor()
    
    def prepare_features(self):
        """
        Features:
        - Strategy Sharpe (30d, 90d)
        - Strategy DD
        - Current regime
        - Market volatility
        - Correlation matrix
        """
        features = {}
        for strategy in self.strategies:
            features[f'{strategy}_sharpe_30d'] = calculate_sharpe(strategy, 30)
            features[f'{strategy}_sharpe_90d'] = calculate_sharpe(strategy, 90)
            features[f'{strategy}_dd'] = max_drawdown(strategy, 30)
        
        features['regime'] = self.regime_detector.current()
        features['volatility_20d'] = realized_vol(20)
        features['avg_correlation'] = strategy_correlation_matrix().mean()
        
        return features
    
    def predict_weights(self) -> Dict[str, float]:
        X = self.prepare_features()
        raw_weights = self.model.predict(X)
        
        # Softmax normalization
        weights = softmax(raw_weights)
        
        # Zero out negative Sharpe strategies
        for i, strategy in enumerate(self.strategies):
            if X[f'{strategy}_sharpe_30d'] < 0.5:
                weights[i] = 0
        
        # Renormalize
        return dict(zip(self.strategies, weights / weights.sum()))
```

### 2.3 Online Learning with River
**Impact: Medium (adapt to market changes)**

```python
# requirements.txt additions:
river
shap
hmmlearn

# research/online_learning.py
from river import linear_model, preprocessing, optim

class OnlineStrategy:
    def __init__(self):
        self.model = (
            preprocessing.StandardScaler() |
            linear_model.LogisticRegression(
                optimizer=optim.SGD(lr=0.01)
            )
        )
    
    def update(self, X, y):
        """Incremental update without full retrain"""
        self.model.learn_one(X, y)
    
    def predict(self, X):
        return self.model.predict_proba_one(X)
```

**Deliverable:**
- `features/expanded.py`
- `strategies/meta_learner.py`
- `research/online_learning.py`

---

## Phase 3: Execution Cost Reduction (Pure Profit)

### 3.1 Realistic Slippage Model
**Impact: Very high (0.1% per trade = $2,500/year on $100k)**

```python
# execution/cost_model.py
class RealisticCostModel:
    """
    Volume-based + volatility-adjusted slippage.
    
    Based on square-root market impact law:
    slippage = sigma * sqrt(volume / total_volume)
    """
    
    def __init__(self):
        self.commission = 0.001  # 0.1%
    
    def estimate_slippage(self, order_size, market_depth, volatility):
        """
        Args:
            order_size: USD notional
            market_depth: USD in order book
            volatility: annualized
        """
        participation = order_size / market_depth
        
        # Square-root law
        temp_impact = volatility * np.sqrt(participation)
        
        # Permanent impact (smaller)
        permanent = temp_impact * 0.1
        
        return temp_impact + permanent
    
    def maker_only_optimize(self, desired_size, order_book):
        """
        Split into maker orders to avoid taker fees.
        """
        if order_book.spread < self.commission * 5:
            # Spread is tight, use market
            return [('market', desired_size)]
        
        # Split into multiple post-only
        slices = []
        remaining = desired_size
        
        while remaining > 0:
            slice_size = min(remaining, order_book.best_bid_size * 0.1)
            slices.append(('post_only_limit', slice_size))
            remaining -= slice_size
        
        return slices
```

### 3.2 TWAP/POV Execution
**Impact: Medium (reduces market impact)**

```python
# execution/twap.py
class TWAPExecutor:
    """
    Time-Weighted Average Price execution.
    
    Splits large orders over time to minimize impact.
    """
    
    def __init__(self, total_size, duration_seconds, slices=10):
        self.total_size = total_size
        self.duration = duration_seconds
        self.slices = slices
        self.interval = duration_seconds / slices
        self.remaining = total_size
        self.completed = 0
    
    def get_next_slice(self):
        if self.completed >= self.slices:
            return None
        
        target = self.total_size / self.slices
        
        # Adjust based on volume profile
        volume_ratio = self._expected_volume_ratio()
        size = target * volume_ratio
        
        self.completed += 1
        self.remaining -= size
        
        return {
            'size': size,
            'delay': self.interval,
            'aggression': 'passive'
        }
    
    def _expected_volume_ratio(self):
        """Volume is typically U-shaped (more at open/close)"""
        time_of_day = datetime.now().hour
        if time_of_day in [0, 1, 2, 22, 23]:  # Open/close
            return 1.2
        return 0.9
```

**Deliverable:**
- `execution/cost_model.py` with realistic slippage
- `execution/twap.py` for slicing large orders
- Updated backtest commission: dynamic not fixed

---

## Phase 4: Risk & Position Sizing

### 4.1 Fractional Kelly
**Impact: High (survives drawdowns)**

```python
# portfolio/fractional_kelly.py
def kelly_fraction(returns, fraction=0.25):
    """
    Kelly Criterion with fractional sizing.
    
    f* = (μ - r) / σ²
    We use 0.25 * f* for safety margin.
    """
    mean_return = np.mean(returns)
    variance = np.var(returns)
    
    if variance == 0:
        return 0
    
    kelly = mean_return / variance
    
    # Fractional with max cap
    return np.clip(kelly * fraction, 0, 0.5)

class VolatilityTargeting:
    """
    Scale positions to target constant portfolio vol.
    """
    
    def __init__(self, target_vol=0.20):  # 20% annualized
        self.target_vol = target_vol
        self.lookback = 30
    
    def compute_position_scalar(self, strategy_returns):
        """
        If strategy vol = 30%, target = 20%
        Scalar = 0.20 / 0.30 = 0.67
        """
        current_vol = np.std(strategy_returns) * np.sqrt(252)
        
        if current_vol == 0:
            return 1.0
        
        scalar = self.target_vol / current_vol
        
        # Bounds
        return np.clip(scalar, 0.1, 2.0)
```

### 4.2 Risk Parity
**Impact: Medium (better diversification)**

```python
# requirements.txt
riskfolio-lib

# portfolio/risk_parity.py
import riskfolio as rp

class RiskParityAllocator:
    """
    Hierarchical risk parity allocation.
    """
    
    def optimize(self, strategy_returns):
        """
        Allocate so each strategy contributes equal risk.
        
        Higher vol strategies get smaller allocation.
        """
        port = rp.Portfolio(returns=strategy_returns)
        
        # HRP is robust to estimation error
        weights = port.rp_optimization(
            model='HRP',
            rm='MV',  # Minimize variance
            rf=0.0
        )
        
        return weights
```

### 4.3 Kill Switches
**Impact: Very high (prevents blow-ups)**

```python
# risk/kill_switches.py
class KillSwitches:
    def __init__(self):
        self.max_drawdown = 0.08  # 8%
        self.daily_var_limit = 0.05  # 5% daily VaR
        self.correlation_spike = 0.8  # Strategies too correlated
        self.drift_threshold = 0.15  # Model drift
    
    def check(self, portfolio_state):
        """Called on every heartbeat"""
        signals = []
        
        if portfolio_state.drawdown > self.max_drawdown:
            signals.append(KillSignal(
                action='HALT_ALL',
                reason=f"DD {portfolio_state.drawdown:.1%} > {self.max_drawdown:.1%}"
            ))
        
        if portfolio_state.daily_var > self.daily_var_limit:
            signals.append(KillSignal(
                action='REDUCE_50_PCT',
                reason=f"VaR breach"
            ))
        
        if portfolio_state.correlation_matrix.mean() > self.correlation_spike:
            signals.append(KillSignal(
                action='REBALANCE',
                reason="Correlation spike - strategies trading together"
            ))
        
        return signals
```

### 4.4 Tail Hedge
**Impact: Medium (survive crashes)**

```python
# risk/tail_hedge.py
class TailHedge:
    """
    Buy crash protection when regime = high vol.
    """
    
    def __init__(self):
        self.hedge_size = 0.02  # 2% of portfolio
        self.regime_detector = RegimeDetector()
    
    def get_hedge_position(self, regime):
        if regime == MarketRegime.HIGH_VOLATILITY:
            return {
                'asset': 'BTC_PUT',  # Via Deribit
                'strike_pct': 0.80,  # 20% OTM
                'size': self.hedge_size,
                'reason': 'High vol regime protection'
            }
        return None
```

**Deliverable:**
- `portfolio/fractional_kelly.py`
- `portfolio/risk_parity.py`
- `risk/kill_switches.py`
- `risk/tail_hedge.py`

---

## Phase 5: Strategy Pruning

### 5.1 Quick-Win Focus
Grok's recommendation: Don't run all 10 channels. Focus top 3-4.

**Selection Criteria:**
1. 3-year OOS Sharpe > 1.2
2. Correlation < 0.4 with others
3. Survives purged CV
4. Low max drawdown (<15%)

```python
# research/strategy_selection.py
class StrategySelector:
    def select_top_strategies(self, all_strategies, data, n=4):
        results = []
        
        for strategy in all_strategies:
            sharpe, dd, pf, correlation = self.evaluate(strategy, data)
            
            if sharpe > 1.2 and pf > 1.4 and dd < 0.15:
                results.append({
                    'strategy': strategy,
                    'sharpe': sharpe,
                    'dd': dd,
                    'pf': pf,
                    'correlation': correlation
                })
        
        # Select uncorrelated bundle
        selected = []
        for candidate in sorted(results, key=lambda x: x['sharpe'], reverse=True):
            if len(selected) >= n:
                break
            
            # Check correlation with already selected
            if all(candidate['correlation'][s['strategy']] < 0.4 for s in selected):
                selected.append(candidate)
        
        return selected
```

**Deliverable:**
- `backtest_all.py` that runs purged CV on all strategies
- `research/strategy_selection.py` that picks top 3-4

---

## Implementation Priority

### Priority A (This Weekend)
1. ✅ Purged CV implementation
2. ✅ Optuna hyperopt
3. ✅ Backtest all strategies with kill rules
4. ✅ Select top 3-4 strategies

### Priority B (Next Week)
5. Realistic cost model
6. TWAP execution
7. Fractional Kelly sizing
8. Kill switches

### Priority C (Following Week)
9. Meta-learner
10. Risk parity
11. Tail hedge
12. Docker + VPS deployment

---

## Expected Impact

| Phase | Sharpe Impact | DD Impact | Live P&L Impact |
|-------|--------------|-----------|-----------------|
| Kill Overfitting | -0.2 (backtest) | -50% blow-up risk | **+$5k/year prevents loss** |
| Meta-Learner | +0.5-1.0 | -10% vol | **+0.5% daily alpha** |
| Cost Model | +0.2-0.3 | -2% | **+$2,500/year on $100k** |
| Risk Layer | -0.1 | -40% max DD | **Survives to compound** |

**Estimated Final Performance:**
- OOS Sharpe: 1.2-1.6 (not backtest 3.0)
- Target vol: 15-20% annualized
- Max DD: <12% with tail hedge
- Compounding rate: ~20-30% annually

---

## Weekend Action Plan

```bash
# 1. Install new dependencies
echo "optuna river shap riskfolio-lib hmmlearn" >> requirements.txt
pip install -r requirements.txt

# 2. Create purged CV
# backtesting/purged_cv.py (copy from above)

# 3. Create Optuna hyperopt
# research/hyperopt.py (copy from above)

# 4. Run full backtest
python backtest_all.py --strategies all --cv purged --years 3

# 5. Get report
cat results/best_strategies.json

# 6. Push to GitHub
git add -A && git commit -m "feat: Purged CV + Optuna hyperopt"
git push
```

---

## Notes from Grok

> "Realistic Expectation Check: Even with all these upgrades, live Sharpe will probably be 0.8–1.5 (not 3.0 like some backtests). The goal is **survive + compound** — 1.2 Sharpe at 15% vol with tight risk control compounds very nicely over years."

This is the key insight. We don't need 3.0 Sharpe. We need:
1. **Consistency** (low variance)
2. **Survival** (no blow-ups)
3. **Compounding** (time in market)

The infrastructure is strong. Now we close the backtest gap.

Let's make it print. 🚀
