# Market Regime Detector
import logging
import numpy as np
import pandas as pd
from typing import Dict, Optional, Tuple
from enum import Enum
from datetime import datetime

logger = logging.getLogger(__name__)

class MarketRegime(Enum):
    TREND_UP = "trend_up"
    TREND_DOWN = "trend_down"
    MEAN_REVERSION = "mean_reversion"
    HIGH_VOLATILITY = "high_volatility"
    LOW_LIQUIDITY = "low_liquidity"
    HIGH_LIQUIDITY = "high_liquidity"
    RANGE_BOUND = "range_bound"

class RegimeDetector:
    """
    Detects market regimes for strategy regime-switching.
    Key insight: Strategies that work in one regime fail in another.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.trend_threshold = config.get('trend_threshold', 0.1)
        self.vol_percentile = config.get('vol_percentile', 80)
        self.liq_percentile = config.get('liq_percentile', 20)
        self.trend_lookback = config.get('trend_lookback', 20)
        self.vol_lookback = config.get('vol_lookback', 50)
        logger.info("RegimeDetector initialized")
    
    def detect_regime(self, price_data: pd.DataFrame) -> Tuple[MarketRegime, Dict]:
        """Detect current market regime from price data."""
        if len(price_data) < self.vol_lookback:
            return MarketRegime.RANGE_BOUND, {'overall': 0.5, 'trend': 0.0, 'volatility': 0.0, 'liquidity': 0.5}
        
        close = price_data['close']
        volume = price_data.get('volume', pd.Series([1] * len(price_data)))
        high = price_data.get('high', close)
        low = price_data.get('low', close)
        
        trend_score = self._calculate_trend(close)
        vol_score = self._calculate_volatility(close)
        vol_regime = self._classify_volatility(close, vol_score)
        liq_score = self._calculate_liquidity(volume, close)
        
        regime, confidence = self._classify_regime(trend_score, vol_regime, liq_score, close, high, low)
        
        scores = {
            'overall': confidence,
            'trend': abs(trend_score),
            'volatility': vol_score,
            'liquidity': liq_score,
            'trend_direction': np.sign(trend_score)
        }
        
        return regime, scores
    
    def _calculate_trend(self, close: pd.Series) -> float:
        """Calculate trend strength between -1 (strong down) and 1 (strong up)."""
        if len(close) < self.trend_lookback:
            return 0.0
        
        price_change = (close.iloc[-1] - close.iloc[-self.trend_lookback]) / close.iloc[-self.trend_lookback]
        x = np.arange(len(close.tail(self.trend_lookback)))
        y = close.tail(self.trend_lookback).values
        slope = np.polyfit(x, y, 1)[0]
        normalized_slope = slope / close.iloc[-1] * len(x)
        
        returns = close.pct_change().dropna()
        up_days = (returns > 0).rolling(self.trend_lookback).mean().iloc[-1]
        down_days = (returns < 0).rolling(self.trend_lookback).mean().iloc[-1]
        trend_strength = abs(up_days - down_days)
        
        trend_score = price_change * 2 + normalized_slope + trend_strength
        return np.tanh(trend_score)
    
    def _calculate_volatility(self, close: pd.Series, lookback: int = 50) -> float:
        """Calculate current volatility regime score."""
        if len(close) < lookback:
            return 0.5
        returns = close.pct_change().dropna()
        current_vol = returns.tail(20).std() * np.sqrt(252)
        hist_vol = returns.rolling(20).std().dropna() * np.sqrt(252)
        if len(hist_vol) == 0:
            return 0.5
        vol_percentile = (hist_vol <= current_vol).mean()
        return vol_percentile
    
    def _classify_volatility(self, close: pd.Series, vol_score: float) -> str:
        if vol_score > 0.8: return "high"
        elif vol_score < 0.2: return "low"
        else: return "normal"
    
    def _calculate_liquidity(self, volume: pd.Series, close: pd.Series) -> float:
        """Calculate liquidity score from volume and price."""
        if len(volume) < 50: return 0.5
        dollar_vol = volume * close
        current_liq = dollar_vol.tail(20).mean()
        hist_liq = dollar_vol.rolling(20).mean().dropna()
        if len(hist_liq) == 0: return 0.5
        return (hist_liq <= current_liq).mean()
    
    def _detect_range_bound(self, close: pd.Series, high: pd.Series, low: pd.Series, lookback: int = 20) -> float:
        """Detect if market is range-bound (0-1)."""
        if len(close) < lookback: return 0.5
        price_range = (high.tail(lookback).max() - low.tail(lookback).min()) / close.iloc[-1]
        total_movement = abs(close.tail(lookback).diff().dropna()).sum() / close.iloc[-1]
        net_change = abs(close.iloc[-1] - close.iloc[-lookback]) / close.iloc[-1]
        if total_movement == 0: return 0.5
        efficiency = net_change / total_movement if total_movement > 0 else 0
        return 1 - efficiency
    
    def _classify_regime(self, trend_score: float, vol_regime: str, liq_score: float, close: pd.Series, high: pd.Series, low: pd.Series) -> Tuple[MarketRegime, float]:
        """Classify overall market regime from component scores."""
        range_score = self._detect_range_bound(close, high, low)
        
        if range_score > 0.7 and vol_regime != "high":
            return MarketRegime.MEAN_REVERSION, range_score
        
        if vol_regime == "high":
            return MarketRegime.HIGH_VOLATILITY, abs(trend_score) if abs(trend_score) > 0.3 else 0.6
        
        if abs(trend_score) > 0.3:
            if trend_score > 0:
                return MarketRegime.TREND_UP, trend_score
            else:
                return MarketRegime.TREND_DOWN, abs(trend_score)
        
        if liq_score < 0.3:
            return MarketRegime.LOW_LIQUIDITY, 1 - liq_score
        elif liq_score > 0.8:
            return MarketRegime.HIGH_LIQUIDITY, liq_score
        
        return MarketRegime.RANGE_BOUND, 0.5
    
    def get_optimal_strategies(self, regime: MarketRegime) -> list:
        """Recommend optimal strategies for each regime."""
        strategy_map = {
            MarketRegime.TREND_UP: ["trend_following", "momentum"],
            MarketRegime.TREND_DOWN: ["trend_following", "short_momentum"],
            MarketRegime.MEAN_REVERSION: ["stat_arb", "mean_reversion", "market_making"],
            MarketRegime.HIGH_VOLATILITY: ["volatility_trading", "straddle"],
            MarketRegime.LOW_LIQUIDITY: ["market_making", "liquidity_provision"],
            MarketRegime.HIGH_LIQUIDITY: ["stat_arb", "high_freq"],
            MarketRegime.RANGE_BOUND: ["mean_reversion", "market_making"]
        }
        return strategy_map.get(regime, ["market_making"])
    
    def should_switch_strategy(self, current_regime: MarketRegime, strategy_regime: MarketRegime) -> bool:
        """Determine if strategy should be switched."""
        if current_regime == strategy_regime: return False
        compatible_pairs = [(MarketRegime.MEAN_REVERSION, MarketRegime.RANGE_BOUND)]
        if (current_regime, strategy_regime) in compatible_pairs: return False
        return True


if __name__ == "__main__":
    dates = pd.date_range('2024-01-01', periods=100, freq='h')
    trend_up = 100 + np.cumsum(np.random.randn(100) * 0.01 + 0.002)
    df_trend = pd.DataFrame({'close': trend_up, 'high': trend_up * 1.002, 'low': trend_up * 0.998, 'volume': np.random.randint(1000, 10000, 100)}, index=dates)
    detector = RegimeDetector({})
    regime1, scores1 = detector.detect_regime(df_trend)
    print(f"Trending data: {regime1.value} (confidence: {scores1['overall']:.2f})")
    print(f"Optimal strategies for mean reversion: {detector.get_optimal_strategies(MarketRegime.MEAN_REVERSION)}")
