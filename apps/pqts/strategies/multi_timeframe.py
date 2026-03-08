# Multi-Timeframe Analysis
import logging
import pandas as pd
from typing import Dict, List, Optional
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

class Timeframe(Enum):
    M1 = "1m"
    M5 = "5m"
    M15 = "15m"
    M30 = "30m"
    H1 = "1h"
    H4 = "4h"
    D1 = "1d"

@dataclass
class TimeframeSignal:
    timeframe: Timeframe
    trend: str  # 'bullish', 'bearish', 'neutral'
    strength: float  # 0-1
    rsi: float
    ema_alignment: str  # 'aligned', 'mixed', 'opposed'

class MultiTimeframeAnalyzer:
    """
    Analyzes multiple timeframes for confluence.
    
    Principle: Higher timeframe trend filters lower timeframe entries.
    - If HTF is bullish, only take longs on LTF
    - If HTF is bearish, only take shorts on LTF
    - If HTF is ranging, reduce position size
    """
    
    def __init__(self, config: dict = None):
        self.config = config or {}
        self.timeframes = [
            Timeframe.H4,  # Higher timeframe (trend)
            Timeframe.H1,  # Middle timeframe
            Timeframe.M15  # Lower timeframe (entry)
        ]
        
        self.signals: Dict[Timeframe, TimeframeSignal] = {}
        
        logger.info(f"MultiTimeframeAnalyzer initialized")
    
    def analyze_timeframe(self, df: pd.DataFrame, tf: Timeframe) -> TimeframeSignal:
        """Analyze a single timeframe"""
        if len(df) < 50:
            return TimeframeSignal(tf, 'neutral', 0, 50, 'mixed')
        
        # Calculate indicators
        close = df['close']
        
        # EMAs
        ema20 = close.ewm(span=20).mean().iloc[-1]
        ema50 = close.ewm(span=50).mean().iloc[-1]
        ema200 = close.ewm(span=200).mean().iloc[-1] if len(df) >= 200 else ema50
        
        current_price = close.iloc[-1]
        
        # Determine trend
        if current_price > ema20 > ema50 > ema200:
            trend = 'bullish'
            strength = 1.0
            ema_alignment = 'aligned'
        elif current_price < ema20 < ema50 < ema200:
            trend = 'bearish'
            strength = 1.0
            ema_alignment = 'aligned'
        elif current_price > ema50:
            trend = 'bullish'
            strength = 0.6
            ema_alignment = 'mixed'
        elif current_price < ema50:
            trend = 'bearish'
            strength = 0.6
            ema_alignment = 'mixed'
        else:
            trend = 'neutral'
            strength = 0.3
            ema_alignment = 'opposed'
        
        # RSI
        rsi = self._calculate_rsi(close)
        
        signal = TimeframeSignal(
            timeframe=tf,
            trend=trend,
            strength=strength,
            rsi=rsi,
            ema_alignment=ema_alignment
        )
        
        self.signals[tf] = signal
        return signal
    
    def _calculate_rsi(self, prices: pd.Series, period: int = 14) -> float:
        """Calculate RSI"""
        delta = prices.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / loss
        rsi = 100 - (100 / (1 + rs))
        return rsi.iloc[-1] if not rsi.empty else 50
    
    def get_confluence(self) -> Dict:
        """Get confluence across all timeframes"""
        if len(self.signals) < 2:
            return {'confluence': 'insufficient_data', 'score': 0}
        
        # Check alignment
        trends = [s.trend for s in self.signals.values()]
        
        if all(t == 'bullish' for t in trends):
            confluence = 'strong_bullish'
            score = sum(s.strength for s in self.signals.values()) / len(self.signals)
        elif all(t == 'bearish' for t in trends):
            confluence = 'strong_bearish'
            score = sum(s.strength for s in self.signals.values()) / len(self.signals)
        elif trends.count('bullish') > trends.count('bearish'):
            confluence = 'weak_bullish'
            score = 0.5
        elif trends.count('bearish') > trends.count('bullish'):
            confluence = 'weak_bearish'
            score = 0.5
        else:
            confluence = 'mixed'
            score = 0.3
        
        # Higher timeframe bias
        htf_signal = self.signals.get(Timeframe.H4) or self.signals.get(Timeframe.D1)
        htf_bias = htf_signal.trend if htf_signal else 'neutral'
        
        return {
            'confluence': confluence,
            'score': score,
            'htf_bias': htf_bias,
            'signals': {
                tf.value: {
                    'trend': s.trend,
                    'strength': s.strength,
                    'rsi': s.rsi
                }
                for tf, s in self.signals.items()
            }
        }
    
    def should_trade(self, direction: str) -> Tuple[bool, float]:
        """Check if we should trade in given direction based on HTF"""
        confluence = self.get_confluence()
        htf_bias = confluence['htf_bias']
        score = confluence['score']
        
        # Only trade in direction of higher timeframe
        if direction == 'long' and htf_bias in ['bullish', 'neutral']:
            return True, score
        elif direction == 'short' and htf_bias in ['bearish', 'neutral']:
            return True, score
        elif htf_bias == 'neutral':
            return True, score * 0.5  # Reduce size in neutral HTF
        
        return False, 0
    
    def get_position_size_multiplier(self) -> float:
        """Get position size adjustment based on confluence"""
        confluence = self.get_confluence()
        score = confluence['score']
        
        # Scale position size based on confluence
        if score > 0.8:
            return 1.5  # High confidence
        elif score > 0.5:
            return 1.0  # Normal
        else:
            return 0.5  # Low confidence
