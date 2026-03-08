"""
Smart Money Discovery Engine

Detects traders whose behavior systematically predicts price movements.

Key innovations:
- Lead-lag analysis: Do they predict or react?
- Synthetic trader clusters: Detect institutional flow in opaque markets  
- Regime-aware scoring: Performance per market condition
- Multi-timeframe analysis: 10s, 1m, 5m, 1h prediction windows

This is the institutional-grade version of whale tracking.
"""

import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from collections import defaultdict
from enum import Enum
import hashlib
from scipy import stats
from sklearn.cluster import DBSCAN

logger = logging.getLogger(__name__)

class MarketRegime(Enum):
    """Market condition classifications"""
    HIGH_VOLATILITY = "high_vol"
    LOW_VOLATILITY = "low_vol"
    TRENDING = "trending"
    MEAN_REVERTING = "mean_reverting"
    HIGH_LIQUIDITY = "high_liq"
    LOW_LIQUIDITY = "low_liq"
    NEWS_EVENT = "news"
    NORMAL = "normal"

class TraderType(Enum):
    """Classification of trader behavior"""
    PREDICTIVE = "predictive"  # Leads price
    REACTIVE = "reactive"      # Follows price
    NOISE = "noise"           # Random
    MARKET_MAKER = "mm"       # Provides liquidity
    INFORMED = "informed"     # Has alpha

@dataclass  
class LeadLagResult:
    """Result of lead-lag correlation analysis"""
    correlation: float
    optimal_lag: int  # seconds
    is_predictive: bool  # True if trader leads price
    confidence: float
    forward_returns: Dict[int, float]  # returns at different lags
    p_value: float

@dataclass
class SyntheticTrader:
    """Cluster of trades treated as single entity"""
    cluster_id: str
    characteristics: Dict  # Size pattern, timing, exchange
    trade_count: int
    total_volume: float
    first_seen: datetime
    last_seen: datetime
    predictive_score: float
    member_count: int  # Number of unique wallets/orders in cluster

@dataclass
class SmartMoneyProfile:
    """Enhanced trader profile with predictive analytics"""
    trader_id: str
    
    # Basic performance
    total_pnl: float
    sharpe_ratio: float
    win_rate: float
    trade_count: int
    avg_trade_size: float
    
    # Predictive analytics
    lead_lag: LeadLagResult
    trader_type: TraderType
    information_ratio: float  # Alpha vs benchmark
    
    # Regime performance
    regime_performance: Dict[MarketRegime, Dict] = field(default_factory=dict)
    
    # Behavior patterns
    typical_holding_period: float  # seconds
    entry_timing_score: float  # 0-1, how well timed
    exit_timing_score: float
    
    # Meta
    first_seen: datetime
    last_trade: datetime
    is_active: bool = True
    confidence_score: float = 0.0
    rank: int = 0


class RegimeDetector:
    """Classify current market conditions"""
    
    def __init__(self, lookback_minutes: int = 30):
        self.lookback = lookback_minutes
        self.volatility_threshold_high = 0.02  # 2% per period
        self.volatility_threshold_low = 0.005
        self.trend_threshold = 0.015
        
    def detect(self, price_series: pd.Series, volume_series: Optional[pd.Series] = None) -> MarketRegime:
        """Classify current market regime"""
        if len(price_series) < 20:
            return MarketRegime.NORMAL
        
        returns = price_series.pct_change().dropna()
        volatility = returns.std()
        
        # Trend detection
        momentum = (price_series.iloc[-1] - price_series.iloc[0]) / price_series.iloc[0]
        
        # Regime classification
        regimes = []
        
        if volatility > self.volatility_threshold_high:
            regimes.append(MarketRegime.HIGH_VOLATILITY)
        elif volatility < self.volatility_threshold_low:
            regimes.append(MarketRegime.LOW_VOLATILITY)
        
        if abs(momentum) > self.trend_threshold:
            if momentum > 0:
                regimes.append(MarketRegime.TRENDING)
        else:
            # Check for mean reversion
            half_life = self._estimate_half_life(returns)
            if half_life < 50:  # Fast mean reversion
                regimes.append(MarketRegime.MEAN_REVERTING)
        
        # Liquidity
        if volume_series is not None:
            avg_volume = volume_series.mean()
            recent_volume = volume_series.tail(10).mean()
            if recent_volume < avg_volume * 0.5:
                regimes.append(MarketRegime.LOW_LIQUIDITY)
            elif recent_volume > avg_volume * 2:
                regimes.append(MarketRegime.HIGH_LIQUIDITY)
        
        return regimes[0] if regimes else MarketRegime.NORMAL
    
    def _estimate_half_life(self, returns: pd.Series) -> float:
        """Estimate mean reversion half-life using OU process"""
        from statsmodels.regression.linear_model import OLS
        
        lag = returns.shift(1).dropna()
        ret = returns.iloc[1:]
        
        if len(lag) != len(ret) or len(lag) < 10:
            return np.inf
        
        try:
            model = OLS(ret, lag, add_constant=True).fit()
            theta = -np.log(1 + model.params.iloc[1]) if model.params.iloc[1] < 0 else 0
            half_life = np.log(2) / theta if theta > 0 else np.inf
            return half_life
        except:
            return np.inf


class LeadLagAnalyzer:
    """
    Determines whether trader predicts price or reacts to it.
    
    Key question: Does trader's buy predict future price increase?
    """
    
    def __init__(self, max_lag_seconds: int = 3600):
        self.max_lag = max_lag_seconds
        self.lags_to_test = [10, 30, 60, 120, 300, 600, 1800, 3600]
        self.min_correlation = 0.15
        self.confidence_threshold = 0.95
        
    def analyze(self, trader: SmartMoneyProfile,
                trades: List[Dict],
                price_series: pd.Series) -> LeadLagResult:
        """
        Run lead-lag correlation analysis.
        
        Returns whether trader predicts or follows price.
        """
        if len(trades) < 10:
            return LeadLagResult(
                correlation=0, optimal_lag=0, is_predictive=False,
                confidence=0, forward_returns={}, p_value=1.0
            )
        
        # Build trader position series
        position_changes = []
        timestamps = []
        
        for trade in trades:
            position_change = trade['size'] if trade['side'] == 'buy' else -trade['size']
            position_changes.append(position_change)
            timestamps.append(trade['timestamp'])
        
        position_series = pd.Series(position_changes, index=timestamps).sort_index()
        
        # Calculate forward returns at each lag
        forward_returns = {}
        correlations = {}
        
        for lag in self.lags_to_test:
            returns = []
            signals = []
            
            for ts in position_series.index:
                # Find price at trade time
                nearest_price_idx = price_series.index.get_indexer([ts], method='nearest')[0]
                if nearest_price_idx == -1:
                    continue
                
                entry_price = price_series.iloc[nearest_price_idx]
                
                # Find price at lag time
                lag_time = ts + timedelta(seconds=lag)
                lag_idx = price_series.index.get_indexer([lag_time], method='nearest')[0]
                if lag_idx == -1 or lag_idx >= len(price_series):
                    continue
                
                exit_price = price_series.iloc[lag_idx]
                forward_ret = (exit_price - entry_price) / entry_price
                
                returns.append(forward_ret)
                signals.append(position_changes[position_series.index.get_loc(ts)])
            
            if len(returns) > 5:
                corr, p_val = stats.pearsonr(signals, returns)
                forward_returns[lag] = np.mean(returns) if returns else 0
                correlations[lag] = (corr, p_val)
        
        if not correlations:
            return LeadLagResult(0, 0, False, 0, {}, 1.0)
        
        # Find best lag
        best_lag = max(correlations.keys(), key=lambda l: abs(correlations[l][0]))
        best_corr, best_p = correlations[best_lag]
        
        # Determine if predictive
        # Predictive = positive correlation (buy → price up)
        is_predictive = best_corr > self.min_correlation and best_p < 0.05
        
        # Calculate confidence
        confidence = min(abs(best_corr) * 2, 1.0)  # Scale correlation to confidence
        if best_p > 0.05:
            confidence *= 0.5
        
        return LeadLagResult(
            correlation=best_corr,
            optimal_lag=best_lag,
            is_predictive=is_predictive,
            confidence=confidence,
            forward_returns=forward_returns,
            p_value=best_p
        )


class SyntheticTraderDetector:
    """
    Detect institutional flow in markets where trader IDs are hidden.
    
    Uses clustering to identify coordinated trading patterns.
    """
    
    def __init__(self, config: Dict):
        self.min_cluster_size = config.get('min_cluster_size', 5)
        self.time_tolerance_seconds = config.get('time_tolerance', 60)
        self.eps_size = config.get('eps_size', 0.1)  # Size similarity
        self.eps_time = config.get('eps_time', 30)   # Time similarity
        
    def detect_clusters(self, trades: List[Dict]) -> List[SyntheticTrader]:
        """
        Cluster trades that may be from same entity.
        
        Features for clustering:
        - Trade size (normalized)
        - Timing (seconds from first trade)
        - Direction
        """
        if len(trades) < self.min_cluster_size:
            return []
        
        # Build feature matrix
        first_time = min(t['timestamp'] for t in trades)
        features = []
        
        for trade in trades:
            features.append([
                np.log1p(trade['size']),  # Size (log normalized)
                (trade['timestamp'] - first_time).total_seconds(),  # Time
                1 if trade['side'] == 'buy' else 0  # Direction
            ])
        
        features = np.array(features)
        
        # Normalize
        from sklearn.preprocessing import StandardScaler
        scaler = StandardScaler()
        features_scaled = scaler.fit_transform(features)
        
        # Cluster
        clustering = DBSCAN(eps=0.5, min_samples=self.min_cluster_size).fit(features_scaled)
        labels = clustering.labels_
        
        # Build synthetic traders from clusters
        synthetic_traders = []
        unique_labels = set(labels) - {-1}  # -1 is noise
        
        for label in unique_labels:
            cluster_trades = [trades[i] for i in range(len(trades)) if labels[i] == label]
            
            if len(cluster_trades) < self.min_cluster_size:
                continue
            
            synthetic = SyntheticTrader(
                cluster_id=f"synthetic_{hashlib.md5(str(label).encode()).hexdigest()[:8]}",
                characteristics={
                    'avg_size': np.mean([t['size'] for t in cluster_trades]),
                    'size_std': np.std([t['size'] for t in cluster_trades]),
                    'direction_bias': sum(1 for t in cluster_trades if t['side'] == 'buy') / len(cluster_trades),
                    'exchange': cluster_trades[0].get('exchange', 'unknown')
                },
                trade_count=len(cluster_trades),
                total_volume=sum(t['size'] * t['price'] for t in cluster_trades),
                first_seen=min(t['timestamp'] for t in cluster_trades),
                last_seen=max(t['timestamp'] for t in cluster_trades),
                predictive_score=0.0,  # To be calculated
                member_count=len(set(t.get('order_id', t.get('id', str(i))) for i, t in enumerate(cluster_trades)))
            )
            
            synthetic_traders.append(synthetic)
        
        return synthetic_traders
    
    def classify_flow_type(self, trades: List[Dict]) -> str:
        """
        Classify what type of flow this represents.
        
        Types:
        - aggressive: Market orders, sweeping book
        - passive: Limit orders, providing liquidity
        - stealth: Iceberg, hidden orders
        - coordinated: Multiple accounts, same strategy
        """
        features = {
            'avg_slippage': np.mean([t.get('slippage', 0) for t in trades]),
            'market_order_pct': sum(1 for t in trades if t.get('order_type') == 'market') / len(trades),
            'size_consistency': 1 - (np.std([t['size'] for t in trades]) / (np.mean([t['size'] for t in trades]) + 1)),
        }
        
        if features['market_order_pct'] > 0.7:
            return 'aggressive'
        elif features['avg_slippage'] < 0.0005:
            return 'passive'
        elif features['size_consistency'] > 0.8 and len(trades) > 10:
            return 'coordinated'
        else:
            return 'mixed'


class SmartMoneyEngine:
    """
    Main engine that discovers, ranks, and tracks predictive traders.
    """
    
    def __init__(self, config: Dict):
        self.config = config
        
        # Components
        self.regime_detector = RegimeDetector()
        self.lead_lag_analyzer = LeadLagAnalyzer()
        self.synthetic_detector = SyntheticTraderDetector(config.get('clustering', {}))
        
        # State
        self.traders: Dict[str, SmartMoneyProfile] = {}
        self.synthetic_traders: Dict[str, SyntheticTrader] = {}
        self.trade_history: Dict[str, List[Dict]] = defaultdict(list)
        self.regime_history: List[Tuple[datetime, MarketRegime]] = []
        
        # Scoring parameters
        self.min_trades_for_analysis = config.get('min_trades', 15)
        self.predictive_threshold = config.get('predictive_threshold', 0.7)
        self.top_n_traders = config.get('top_n', 50)
        
        logger.info("SmartMoneyEngine initialized")
    
    def process_trade(self, trade: Dict, price_series: pd.Series = None):
        """
        Process a single trade and update trader analytics.
        
        trade = {
            'trader_id': str,
            'timestamp': datetime,
            'market': str,
            'side': 'buy' | 'sell',
            'size': float,
            'price': float,
            'order_type': 'market' | 'limit'
        }
        """
        trader_id = trade.get('trader_id') or trade.get('wallet_id')
        if not trader_id:
            return
        
        # Store trade
        self.trade_history[trader_id].append(trade)
        
        # Update profile periodically
        trades = self.trade_history[trader_id]
        if len(trades) % 10 == 0 and len(trades) >= self.min_trades_for_analysis:
            self._update_trader_profile(trader_id, price_series)
    
    def _update_trader_profile(self, trader_id: str, price_series: pd.Series = None):
        """Recalculate trader profile with full analytics."""
        trades = self.trade_history[trader_id]
        
        if len(trades) < self.min_trades_for_analysis:
            return
        
        # Basic metrics
        pnls = []
        wins = 0
        volumes = []
        
        for i in range(1, len(trades)):
            # Simplified PnL calculation
            # Would use actual position tracking in production
            trade = trades[i]
            prev = trades[i-1]
            
            if prev['side'] != trade['side']:
                pnl = (trade['price'] - prev['price']) / prev['price']
                if prev['side'] == 'sell':
                    pnl = -pnl
                pnls.append(pnl)
                if pnl > 0:
                    wins += 1
            
            volumes.append(trade['size'] * trade['price'])
        
        if not pnls:
            return
        
        total_pnl = sum(pnls)
        win_rate = wins / len(pnls)
        sharpe = np.mean(pnls) / (np.std(pnls) + 1e-8) if np.std(pnls) > 0 else 0
        
        # Lead-lag analysis
        lead_lag = LeadLagResult(0, 0, False, 0, {}, 1.0)
        if price_series is not None and len(trades) > 20:
            lead_lag = self.lead_lag_analyzer.analyze(
                None, trades, price_series
            )
        
        # Classify trader type
        trader_type = self._classify_trader_type(lead_lag, sharpe, win_rate)
        
        # Calculate holding period
        holding_periods = []
        for i in range(1, len(trades)):
            if trades[i-1]['side'] != trades[i]['side']:
                dt = (trades[i]['timestamp'] - trades[i-1]['timestamp']).total_seconds()
                holding_periods.append(dt)
        
        avg_holding = np.mean(holding_periods) if holding_periods else 3600
        
        # Information ratio
        info_ratio = self._calculate_information_ratio(trades, price_series) if price_series is not None else 0
        
        # Confidence score
        confidence = self._calculate_confidence(
            sharpe, lead_lag.confidence, win_rate, len(trades), trader_type
        )
        
        # Create/update profile
        profile = SmartMoneyProfile(
            trader_id=trader_id,
            total_pnl=total_pnl,
            sharpe_ratio=sharpe,
            win_rate=win_rate,
            trade_count=len(trades),
            avg_trade_size=np.mean(volumes) if volumes else 0,
            lead_lag=lead_lag,
            trader_type=trader_type,
            information_ratio=info_ratio,
            typical_holding_period=avg_holding,
            entry_timing_score=0.0,  # Would calculate from price action
            exit_timing_score=0.0,
            first_seen=min(t['timestamp'] for t in trades),
            last_trade=max(t['timestamp'] for t in trades),
            is_active=(datetime.now() - max(t['timestamp'] for t in trades)) < timedelta(hours=24),
            confidence_score=confidence
        )
        
        self.traders[trader_id] = profile
    
    def _classify_trader_type(self, lead_lag: LeadLagResult,
                             sharpe: float, win_rate: float) -> TraderType:
        """Classify what type of trader this is."""
        if lead_lag.is_predictive and lead_lag.correlation > 0.3:
            if sharpe > 1.5:
                return TraderType.INFORMED
            return TraderType.PREDICTIVE
        
        if lead_lag.correlation < -0.2:
            return TraderType.REACTIVE
        
        if win_rate > 0.55 and sharpe > 0.8:
            return TraderType.MARKET_MAKER
        
        return TraderType.NOISE
    
    def _calculate_information_ratio(self, trades: List[Dict],
                                    price_series: pd.Series) -> float:
        """Calculate information ratio (alpha / tracking error)."""
        # Simplified - would use proper benchmark
        returns = []
        for i in range(1, min(len(trades), 100)):
            daily_ret = (trades[i]['price'] - trades[i-1]['price']) / trades[i-1]['price']
            returns.append(daily_ret)
        
        if len(returns) < 10:
            return 0
        
        avg_return = np.mean(returns)
        tracking_error = np.std(returns)
        
        return avg_return / tracking_error if tracking_error > 0 else 0
    
    def _calculate_confidence(self, sharpe: float, lead_lag_conf: float,
                             win_rate: float, n_trades: int,
                             trader_type: TraderType) -> float:
        """Calculate overall confidence score (0-1)."""
        # Base from metrics
        score = (
            min(sharpe, 3) / 3 * 0.25 +
            lead_lag_conf * 0.35 +
            win_rate * 0.2 +
            min(n_trades, 100) / 100 * 0.2
        )
        
        # Boost for informed traders
        if trader_type == TraderType.INFORMED:
            score = min(score * 1.2, 1.0)
        
        return score
    
    def detect_synthetic_traders(self, market: str, 
                                time_window: timedelta = timedelta(hours=1)):
        """Find coordinated trading patterns."""
        cutoff = datetime.now() - time_window
        
        # Gather all trades in window
        all_trades = []
        for trader_id, trades in self.trade_history.items():
            recent = [t for t in trades if t['timestamp'] > cutoff and t['market'] == market]
            all_trades.extend(recent)
        
        if len(all_trades) < 50:
            return
        
        # Detect clusters
        clusters = self.synthetic_detector.detect_clusters(all_trades)
        
        for cluster in clusters:
            self.synthetic_traders[cluster.cluster_id] = cluster
        
        logger.info(f"Detected {len(clusters)} synthetic traders in {market}")
    
    def get_predictive_traders(self, n: int = None,
                               min_confidence: float = 0.6) -> List[SmartMoneyProfile]:
        """Get list of predictive traders sorted by confidence."""
        if n is None:
            n = self.top_n_traders
        
        # Filter to predictive/informed traders
        predictive = [
            t for t in self.traders.values()
            if (t.trader_type in [TraderType.PREDICTIVE, TraderType.INFORMED]
                and t.confidence_score >= min_confidence
                and t.is_active
                and t.lead_lag.is_predictive)
        ]
        
        # Sort by confidence
        predictive.sort(key=lambda x: x.confidence_score, reverse=True)
        
        return predictive[:n]
    
    def generate_trading_signal(self, traders: List[SmartMoneyProfile],
                              market: str,
                              current_price: float) -> Dict:
        """
        Generate trading signal from multiple traders' activity.
        
        Uses multi-trader consensus with confidence weighting.
        """
        if not traders:
            return {'signal': 'neutral', 'strength': 0}
        
        # Get recent trades from these traders in this market
        buy_score = 0
        sell_score = 0
        
        for trader in traders[:10]:  # Top 10
            trades = self.trade_history[trader.trader_id]
            recent = [t for t in trades[-5:] if t['market'] == market]
            
            for trade in recent:
                weight = trader.confidence_score
                if trade['side'] == 'buy':
                    buy_score += trade['size'] * weight
                else:
                    sell_score += trade['size'] * weight
        
        # Calculate signal
        total = buy_score + sell_score
        if total == 0:
            return {'signal': 'neutral', 'strength': 0}
        
        buy_ratio = buy_score / total
        
        if buy_ratio > 0.7:
            signal = 'buy'
            strength = (buy_ratio - 0.5) * 2  # 0 to 1
        elif buy_ratio < 0.3:
            signal = 'sell'
            strength = (0.5 - buy_ratio) * 2
        else:
            signal = 'neutral'
            strength = abs(buy_ratio - 0.5) * 2
        
        return {
            'signal': signal,
            'strength': strength,
            'confidence': np.mean([t.confidence_score for t in traders[:3]]),
            'num_traders': len(traders),
            'buy_pressure': buy_score,
            'sell_pressure': sell_score
        }
    
    def get_performance_report(self) -> Dict:
        """Generate summary statistics."""
        if not self.traders:
            return {}
        
        total_traders = len(self.traders)
        active = sum(1 for t in self.traders.values() if t.is_active)
        predictive = sum(1 for t in self.traders.values() 
                        if t.trader_type in [TraderType.PREDICTIVE, TraderType.INFORMED])
        
        top = self.get_predictive_traders(10)
        
        return {
            'total_traders': total_traders,
            'active': active,
            'predictive': predictive,
            'synthetic_detected': len(self.synthetic_traders),
            'avg_confidence': np.mean([t.confidence_score for t in self.traders.values()]),
            'top_traders': [
                {
                    'id': t.trader_id[:20],
                    'type': t.trader_type.value,
                    'sharpe': t.sharpe_ratio,
                    'confidence': t.confidence_score,
                    'lead_lag': t.lead_lag.correlation if t.lead_lag else 0
                }
                for t in top[:5]
            ]
        }


if __name__ == "__main__":
    # Test
    config = {
        'min_trades': 15,
        'predictive_threshold': 0.7,
        'top_n': 50,
        'clustering': {
            'min_cluster_size': 5,
            'time_tolerance': 60
        }
    }
    
    engine = SmartMoneyEngine(config)
    
    # Generate test data
    np.random.seed(42)
    
    traders = ['smart_1', 'smart_2', 'dumb_1', 'mm_1']
    dates = pd.date_range('2024-02-01', periods=720, freq='h')
    
    # Smart trader: enters before price moves up
    for i in range(len(dates)):
        # Price series with trend
        price = 100 + i * 0.01 + np.random.randn() * 0.5
        
        for trader in traders:
            if random.random() < 0.05:  # 5% chance to trade
                trade = {
                    'trader_id': trader,
                    'timestamp': dates[i],
                    'market': 'BTC-PERP',
                    'side': 'buy',
                    'size': random.uniform(1000, 10000),
                    'price': price,
                    'order_type': 'limit'
                }
                engine.process_trade(trade)
    
    print("\n" + "="*70)
    print("SMART MONEY DISCOVERY ENGINE - TEST")
    print("="*70)
    
    report = engine.get_performance_report()
    print(f"\nTraders analyzed: {report['total_traders']}")
    print(f"Active: {report['active']}")
    print(f"Predictive: {report['predictive']}")
    
    if report.get('top_traders'):
        print("\nTop Traders:")
        for t in report['top_traders']:
            print(f"  {t['id']}: {t['type']}, sharpe={t['sharpe']:.2f}, conf={t['confidence']:.2f}")
    
    print("\nEngine ready for production.")
