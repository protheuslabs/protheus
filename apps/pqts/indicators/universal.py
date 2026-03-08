# Universal Technical Indicators
# Works across all markets: crypto, equities, forex

import numpy as np
import pandas as pd
from typing import List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

class IndicatorType(Enum):
    TREND = "trend"
    MOMENTUM = "momentum"
    VOLATILITY = "volatility"
    VOLUME = "volume"
    MEAN_REVERSION = "mean_reversion"

@dataclass
class IndicatorValue:
    name: str
    value: float
    type: IndicatorType
    timestamp: Optional[pd.Timestamp] = None
    signal: Optional[str] = None  # 'buy', 'sell', 'neutral'

class UniversalIndicators:
    """
    Universal indicators that work across all markets.
    Normalized to handle different price scales and volatilities.
    """
    
    @staticmethod
    def sma(prices: pd.Series, period: int = 20) -> pd.Series:
        """Simple Moving Average"""
        return prices.rolling(window=period).mean()
    
    @staticmethod
    def ema(prices: pd.Series, period: int = 20) -> pd.Series:
        """Exponential Moving Average"""
        return prices.ewm(span=period, adjust=False).mean()
    
    @staticmethod
    def rsi(prices: pd.Series, period: int = 14) -> pd.Series:
        """Relative Strength Index"""
        delta = prices.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        
        rs = gain / loss
        rsi = 100 - (100 / (1 + rs))
        return rsi
    
    @staticmethod
    def macd(prices: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[pd.Series, pd.Series, pd.Series]:
        """MACD (Moving Average Convergence Divergence)"""
        ema_fast = prices.ewm(span=fast, adjust=False).mean()
        ema_slow = prices.ewm(span=slow, adjust=False).mean()
        macd_line = ema_fast - ema_slow
        signal_line = macd_line.ewm(span=signal, adjust=False).mean()
        histogram = macd_line - signal_line
        return macd_line, signal_line, histogram
    
    @staticmethod
    def bollinger_bands(prices: pd.Series, period: int = 20, std_dev: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
        """Bollinger Bands"""
        sma = prices.rolling(window=period).mean()
        std = prices.rolling(window=period).std()
        upper = sma + (std * std_dev)
        lower = sma - (std * std_dev)
        return upper, sma, lower
    
    @staticmethod
    def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
        """Average True Range - volatility measure"""
        tr1 = high - low
        tr2 = abs(high - close.shift())
        tr3 = abs(low - close.shift())
        
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        atr = tr.rolling(window=period).mean()
        return atr
    
    @staticmethod
    def stochastic(high: pd.Series, low: pd.Series, close: pd.Series, 
                   k_period: int = 14, d_period: int = 3) -> Tuple[pd.Series, pd.Series]:
        """Stochastic Oscillator"""
        lowest_low = low.rolling(window=k_period).min()
        highest_high = high.rolling(window=k_period).max()
        
        k = 100 * ((close - lowest_low) / (highest_high - lowest_low))
        d = k.rolling(window=d_period).mean()
        
        return k, d
    
    @staticmethod
    def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
        """On-Balance Volume"""
        obv = pd.Series(index=close.index, dtype=float)
        obv.iloc[0] = volume.iloc[0]
        
        for i in range(1, len(close)):
            if close.iloc[i] > close.iloc[i-1]:
                obv.iloc[i] = obv.iloc[i-1] + volume.iloc[i]
            elif close.iloc[i] < close.iloc[i-1]:
                obv.iloc[i] = obv.iloc[i-1] - volume.iloc[i]
            else:
                obv.iloc[i] = obv.iloc[i-1]
        
        return obv
    
    @staticmethod
    def vwap(high: pd.Series, low: pd.Series, close: pd.Series, 
             volume: pd.Series) -> pd.Series:
        """Volume Weighted Average Price"""
        typical_price = (high + low + close) / 3
        vwap = (typical_price * volume).cumsum() / volume.cumsum()
        return vwap
    
    @staticmethod
    def ichimoku_cloud(high: pd.Series, low: pd.Series, close: pd.Series) -> dict:
        """Ichimoku Cloud - comprehensive trend indicator"""
        # Tenkan-sen (Conversion Line): (9-period high + 9-period low)/2
        tenkan_sen = (high.rolling(window=9).max() + low.rolling(window=9).min()) / 2
        
        # Kijun-sen (Base Line): (26-period high + 26-period low)/2
        kijun_sen = (high.rolling(window=26).max() + low.rolling(window=26).min()) / 2
        
        # Senkou Span A (Leading Span A): (Conversion Line + Base Line)/2
        senkou_span_a = ((tenkan_sen + kijun_sen) / 2).shift(26)
        
        # Senkou Span B (Leading Span B): (52-period high + 52-period low)/2
        senkou_span_b = ((high.rolling(window=52).max() + low.rolling(window=52).min()) / 2).shift(26)
        
        # Chikou Span (Lagging Span): Close shifted back 26 periods
        chikou_span = close.shift(-26)
        
        return {
            'tenkan_sen': tenkan_sen,
            'kijun_sen': kijun_sen,
            'senkou_span_a': senkou_span_a,
            'senkou_span_b': senkou_span_b,
            'chikou_span': chikou_span
        }
    
    @staticmethod
    def adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> Tuple[pd.Series, pd.Series, pd.Series]:
        """Average Directional Index - trend strength"""
        # True Range
        tr1 = high - low
        tr2 = abs(high - close.shift())
        tr3 = abs(low - close.shift())
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        
        # +DM and -DM
        plus_dm = high.diff()
        minus_dm = -low.diff()
        
        plus_dm[plus_dm < 0] = 0
        minus_dm[minus_dm < 0] = 0
        
        plus_dm[plus_dm <= minus_dm] = 0
        minus_dm[minus_dm <= plus_dm] = 0
        
        # Smooth TR, +DM, -DM
        atr = tr.rolling(window=period).mean()
        plus_di = 100 * (plus_dm.rolling(window=period).mean() / atr)
        minus_di = 100 * (minus_dm.rolling(window=period).mean() / atr)
        
        # DX and ADX
        dx = (abs(plus_di - minus_di) / (plus_di + minus_di)) * 100
        adx = dx.rolling(window=period).mean()
        
        return adx, plus_di, minus_di
    
    @staticmethod
    def fibonacci_retracement(high: float, low: float) -> dict:
        """Calculate Fibonacci retracement levels"""
        diff = high - low
        return {
            '0.0%': high,
            '23.6%': high - 0.236 * diff,
            '38.2%': high - 0.382 * diff,
            '50.0%': high - 0.5 * diff,
            '61.8%': high - 0.618 * diff,
            '78.6%': high - 0.786 * diff,
            '100.0%': low
        }
    
    @staticmethod
    def normalize_for_market(prices: pd.Series, market_type: str) -> pd.Series:
        """Normalize prices for market-specific characteristics"""
        if market_type == 'crypto':
            # Crypto is 24/7, higher volatility
            return prices.pct_change().rolling(window=24).std()
        elif market_type == 'forex':
            # Forex has pip-based movements
            return prices.diff() * 10000  # Convert to pips
        else:
            # Equities - standard percentage
            return prices.pct_change()
    
    @classmethod
    def generate_all_signals(cls, df: pd.DataFrame, market_type: str = 'crypto') -> dict:
        """Generate all indicator signals for a dataframe"""
        signals = {}
        
        # Trend indicators
        signals['sma_20'] = cls.sma(df['close'], 20)
        signals['sma_50'] = cls.sma(df['close'], 50)
        signals['ema_12'] = cls.ema(df['close'], 12)
        signals['ema_26'] = cls.ema(df['close'], 26)
        
        # Momentum
        signals['rsi'] = cls.rsi(df['close'], 14)
        signals['macd'], signals['macd_signal'], signals['macd_hist'] = cls.macd(df['close'])
        
        # Volatility
        signals['atr'] = cls.atr(df['high'], df['low'], df['close'], 14)
        signals['bb_upper'], signals['bb_middle'], signals['bb_lower'] = cls.bollinger_bands(df['close'])
        
        # Volume
        if 'volume' in df.columns:
            signals['obv'] = cls.obv(df['close'], df['volume'])
            signals['vwap'] = cls.vwap(df['high'], df['low'], df['close'], df['volume'])
        
        # Stochastic
        signals['stoch_k'], signals['stoch_d'] = cls.stochastic(df['high'], df['low'], df['close'])
        
        # Trend strength
        signals['adx'], signals['plus_di'], signals['minus_di'] = cls.adx(df['high'], df['low'], df['close'])
        
        return signals
