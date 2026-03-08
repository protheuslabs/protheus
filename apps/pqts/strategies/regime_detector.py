# Market Regime Detection
import logging
import numpy as np
import pandas as pd
from typing import Dict, Optional
from enum import Enum

logger = logging.getLogger(__name__)

class MarketRegime(Enum):
    TRENDING_UP = "trending_up"
    TRENDING_DOWN = "trending_down"
    RANGING = "ranging"
    VOLATILE = "volatile"
    LOW_VOLATILITY = "low_volatility"

class RegimeDetector:
    """
    Detects market regime to adapt strategy parameters.
    Different strategies work better in different regimes.
    """
    
    def __init__(self, config: dict = None):
        self.config = config or {}
        self.lookback = self.config.get('lookback', 50)
        self.volatility_threshold = self.config.get('volatility_threshold', 0.02)
        self.trend_threshold = self.config.get('trend_threshold', 0.5)
        
        self.current_regime = MarketRegime.RANGING
        self.regime_history = []
        
        logger.info(f"RegimeDetector initialized")
    
    def detect_regime(self, df: pd.DataFrame) -> MarketRegime:
        """Detect current market regime"""
        if len(df) < self.lookback:
            return MarketRegime.RANGING
        
        # Calculate indicators
        adx = self._calculate_adx(df)
        volatility = self._calculate_volatility(df)
        trend_direction = self._calculate_trend_direction(df)
        
        # Regime classification
        if volatility > self.volatility_threshold * 2:
            regime = MarketRegime.VOLATILE
        elif volatility < self.volatility_threshold * 0.5:
            regime = MarketRegime.LOW_VOLATILITY
        elif adx > 25:  # Strong trend
            if trend_direction > 0:
                regime = MarketRegime.TRENDING_UP
            else:
                regime = MarketRegime.TRENDING_DOWN
        else:
            regime = MarketRegime.RANGING
        
        self.current_regime = regime
        self.regime_history.append({
            'timestamp': df.index[-1],
            'regime': regime.value,
            'adx': adx,
            'volatility': volatility,
            'trend': trend_direction
        })
        
        # Keep only last 100 regimes
        if len(self.regime_history) > 100:
            self.regime_history = self.regime_history[-100:]
        
        return regime
    
    def _calculate_adx(self, df: pd.DataFrame, period: int = 14) -> float:
        """Calculate Average Directional Index"""
        high = df['high']
        low = df['low']
        close = df['close']
        
        # True Range
        tr1 = high - low
        tr2 = abs(high - close.shift())
        tr3 = abs(low - close.shift())
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        
        # Directional Movement
        plus_dm = high.diff()
        minus_dm = -low.diff()
        
        plus_dm[plus_dm < 0] = 0
        minus_dm[minus_dm < 0] = 0
        
        plus_dm[plus_dm <= minus_dm] = 0
        minus_dm[minus_dm <= plus_dm] = 0
        
        # Smooth
        atr = tr.rolling(window=period).mean()
        plus_di = 100 * (plus_dm.rolling(window=period).mean() / atr)
        minus_di = 100 * (minus_dm.rolling(window=period).mean() / atr)
        
        # ADX
        dx = (abs(plus_di - minus_di) / (plus_di + minus_di)) * 100
        adx = dx.rolling(window=period).mean()
        
        return adx.iloc[-1] if not adx.empty else 0
    
    def _calculate_volatility(self, df: pd.DataFrame) -> float:
        """Calculate realized volatility"""
        returns = df['close'].pct_change().dropna()
        
        if len(returns) < 10:
            return 0
        
        # Annualized volatility
        volatility = returns.std() * np.sqrt(252 * 24)  # Hourly data
        return volatility
    
    def _calculate_trend_direction(self, df: pd.DataFrame) -> float:
        """Calculate trend direction (-1 to 1)"""
        # Linear regression slope
        x = np.arange(len(df))
        y = df['close'].values
        
        if len(y) < 10:
            return 0
        
        slope = np.polyfit(x, y, 1)[0]
        
        # Normalize by price
        normalized_slope = slope / df['close'].mean()
        
        # Scale to -1 to 1
        return np.tanh(normalized_slope * 100)
    
    def get_strategy_params(self, regime: MarketRegime) -> Dict:
        """Get optimal strategy parameters for regime"""
        params = {
            MarketRegime.TRENDING_UP: {
                'trend_following_weight': 1.0,
                'mean_reversion_weight': 0.0,
                'scalping_weight': 0.3,
                'position_size_multiplier': 1.2,
                'trailing_stop': True,
                'take_profit_atr_multiple': 3.0
            },
            MarketRegime.TRENDING_DOWN: {
                'trend_following_weight': 1.0,
                'mean_reversion_weight': 0.0,
                'scalping_weight': 0.3,
                'position_size_multiplier': 0.8,  # Smaller in downtrends
                'trailing_stop': True,
                'take_profit_atr_multiple': 2.5
            },
            MarketRegime.RANGING: {
                'trend_following_weight': 0.0,
                'mean_reversion_weight': 1.0,
                'scalping_weight': 0.8,
                'position_size_multiplier': 1.0,
                'trailing_stop': False,
                'take_profit_atr_multiple': 1.5
            },
            MarketRegime.VOLATILE: {
                'trend_following_weight': 0.3,
                'mean_reversion_weight': 0.5,
                'scalping_weight': 0.2,
                'position_size_multiplier': 0.5,  # Reduce size
                'trailing_stop': True,
                'take_profit_atr_multiple': 2.0
            },
            MarketRegime.LOW_VOLATILITY: {
                'trend_following_weight': 0.2,
                'mean_reversion_weight': 0.4,
                'scalping_weight': 1.0,  # Scalping works in low vol
                'position_size_multiplier': 1.0,
                'trailing_stop': False,
                'take_profit_atr_multiple': 1.0
            }
        }
        
        return params.get(regime, params[MarketRegime.RANGING])
    
    def should_trade(self, regime: MarketRegime, strategy_type: str) -> bool:
        """Check if strategy should trade in current regime"""
        regime_params = self.get_strategy_params(regime)
        weight = regime_params.get(f'{strategy_type}_weight', 0)
        return weight > 0.3  # Trade if weight > 0.3
    
    def get_regime_duration(self) -> int:
        """Get how long we've been in current regime (periods)"""
        if not self.regime_history:
            return 0
        
        current = self.current_regime.value
        duration = 0
        
        for entry in reversed(self.regime_history):
            if entry['regime'] == current:
                duration += 1
            else:
                break
        
        return duration
