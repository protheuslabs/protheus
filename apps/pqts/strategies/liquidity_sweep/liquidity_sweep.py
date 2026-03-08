# Liquidity Sweep Strategy
import logging
import numpy as np
import pandas as pd
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass
class LiquidityLevel:
    price: float
    type: str  # 'support' or 'resistance'
    strength: int  # Number of touches
    volume_at_level: float
    last_tested: Optional[int] = None  # Index of last test

@dataclass
class LiquiditySweep:
    level: LiquidityLevel
    sweep_price: float
    reclaim_price: float
    volume: float
    direction: str  # 'long' or 'short'
    confidence: float

class LiquiditySweepStrategy:
    """
    Exploits liquidity sweeps - false breakouts that trap traders.
    
    Concept:
    - Price approaches key level (support/resistance)
    - Briefly breaks level to trigger stops
    - Quickly reclaims level (sweep)
    - Trade the reversal
    
    Also known as:
    - Stop hunt
    - Liquidity grab
    - False breakout
    - Bear/bull trap
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.enabled = config.get('enabled', False)
        self.lookback_periods = config.get('lookback_periods', 100)
        self.min_touches = config.get('min_touches', 2)
        self.sweep_threshold = config.get('sweep_threshold', 0.005)  # 0.5%
        self.reclaim_threshold = config.get('reclaim_threshold', 0.003)  # 0.3%
        
        self.liquidity_levels: List[LiquidityLevel] = []
        
        logger.info(f"LiquiditySweepStrategy initialized")
    
    def identify_liquidity_levels(self, df: pd.DataFrame) -> List[LiquidityLevel]:
        """Identify support and resistance levels"""
        levels = []
        
        # Find swing highs and lows
        highs = df['high'].values
        lows = df['low'].values
        
        # Simple method: find levels with multiple touches
        price_range = df['high'].max() - df['low'].min()
        tolerance = price_range * 0.005  # 0.5% tolerance
        
        # Check for support levels (multiple lows at similar price)
        for i in range(self.min_touches, len(lows)):
            recent_lows = lows[i-self.min_touches:i]
            
            # Check if lows are clustered
            if max(recent_lows) - min(recent_lows) < tolerance:
                level_price = np.mean(recent_lows)
                
                # Calculate volume at level
                volume_at_level = df.iloc[i-self.min_touches:i]['volume'].sum()
                
                levels.append(LiquidityLevel(
                    price=level_price,
                    type='support',
                    strength=self.min_touches,
                    volume_at_level=volume_at_level,
                    last_tested=i
                ))
        
        # Check for resistance levels (multiple highs at similar price)
        for i in range(self.min_touches, len(highs)):
            recent_highs = highs[i-self.min_touches:i]
            
            if max(recent_highs) - min(recent_highs) < tolerance:
                level_price = np.mean(recent_highs)
                
                volume_at_level = df.iloc[i-self.min_touches:i]['volume'].sum()
                
                levels.append(LiquidityLevel(
                    price=level_price,
                    type='resistance',
                    strength=self.min_touches,
                    volume_at_level=volume_at_level,
                    last_tested=i
                ))
        
        # Merge nearby levels
        merged = self._merge_levels(levels, tolerance)
        
        # Sort by strength
        merged.sort(key=lambda x: x.strength, reverse=True)
        
        self.liquidity_levels = merged[:10]  # Keep top 10
        return self.liquidity_levels
    
    def _merge_levels(self, levels: List[LiquidityLevel], tolerance: float) -> List[LiquidityLevel]:
        """Merge nearby levels"""
        if not levels:
            return []
        
        merged = []
        used = set()
        
        for i, level in enumerate(levels):
            if i in used:
                continue
            
            # Find nearby levels
            nearby = [level]
            for j, other in enumerate(levels[i+1:], i+1):
                if j in used:
                    continue
                if abs(level.price - other.price) < tolerance:
                    nearby.append(other)
                    used.add(j)
            
            # Merge
            avg_price = np.mean([l.price for l in nearby])
            total_strength = sum(l.strength for l in nearby)
            total_volume = sum(l.volume_at_level for l in nearby)
            
            # Determine type based on majority
            support_count = sum(1 for l in nearby if l.type == 'support')
            resistance_count = sum(1 for l in nearby if l.type == 'resistance')
            
            merged_type = 'support' if support_count >= resistance_count else 'resistance'
            
            merged.append(LiquidityLevel(
                price=avg_price,
                type=merged_type,
                strength=total_strength,
                volume_at_level=total_volume
            ))
            
            used.add(i)
        
        return merged
    
    def detect_sweeps(self, df: pd.DataFrame) -> List[LiquiditySweep]:
        """Detect liquidity sweeps in recent data"""
        if not self.liquidity_levels:
            self.identify_liquidity_levels(df)
        
        sweeps = []
        
        if len(df) < 3:
            return sweeps
        
        recent = df.iloc[-5:]  # Look at last 5 candles
        
        for level in self.liquidity_levels:
            # Check for sweep
            if level.type == 'support':
                # Support sweep: price drops below support then reclaims
                sweep_candle = recent[recent['low'] < level.price * (1 - self.sweep_threshold)]
                
                if not sweep_candle.empty:
                    # Check if reclaimed
                    last_close = df['close'].iloc[-1]
                    if last_close > level.price:
                        sweep = LiquiditySweep(
                            level=level,
                            sweep_price=sweep_candle['low'].min(),
                            reclaim_price=last_close,
                            volume=sweep_candle['volume'].sum(),
                            direction='long',
                            confidence=self._calculate_sweep_confidence(level, sweep_candle)
                        )
                        sweeps.append(sweep)
            
            else:  # resistance
                # Resistance sweep: price breaks above then falls back
                sweep_candle = recent[recent['high'] > level.price * (1 + self.sweep_threshold)]
                
                if not sweep_candle.empty:
                    last_close = df['close'].iloc[-1]
                    if last_close < level.price:
                        sweep = LiquiditySweep(
                            level=level,
                            sweep_price=sweep_candle['high'].max(),
                            reclaim_price=last_close,
                            volume=sweep_candle['volume'].sum(),
                            direction='short',
                            confidence=self._calculate_sweep_confidence(level, sweep_candle)
                        )
                        sweeps.append(sweep)
        
        return sweeps
    
    def _calculate_sweep_confidence(self, level: LiquidityLevel, sweep_candle: pd.DataFrame) -> float:
        """Calculate confidence in sweep setup"""
        confidence = 0.5
        
        # Higher confidence for stronger levels
        confidence += min(level.strength * 0.05, 0.2)
        
        # Higher confidence for higher volume
        avg_volume = sweep_candle['volume'].mean()
        if avg_volume > level.volume_at_level:
            confidence += 0.1
        
        # Higher confidence if level hasn't been tested recently
        if level.last_tested and level.last_tested < len(sweep_candle) - 20:
            confidence += 0.1
        
        return min(confidence, 0.95)
    
    def generate_signals(self, df: pd.DataFrame) -> List[Dict]:
        """Generate trading signals from sweeps"""
        if not self.enabled:
            return []
        
        signals = []
        sweeps = self.detect_sweeps(df)
        
        for sweep in sweeps:
            signal = {
                'type': 'liquidity_sweep',
                'direction': sweep.direction,
                'reason': f'{sweep.level.type.capitalize()} sweep at {sweep.level.price:.2f}',
                'confidence': sweep.confidence,
                'entry_price': sweep.reclaim_price,
                'stop_loss': sweep.sweep_price,
                'target': self._calculate_target(sweep),
                'strength': 'strong' if sweep.confidence > 0.7 else 'medium'
            }
            signals.append(signal)
        
        return signals
    
    def _calculate_target(self, sweep: LiquiditySweep) -> float:
        """Calculate profit target based on sweep range"""
        range_size = abs(sweep.reclaim_price - sweep.sweep_price)
        
        if sweep.direction == 'long':
            return sweep.reclaim_price + (range_size * 2)  # 2:1 reward/risk
        else:
            return sweep.reclaim_price - (range_size * 2)
    
    def get_levels(self) -> List[Dict]:
        """Get current liquidity levels"""
        return [
            {
                'price': l.price,
                'type': l.type,
                'strength': l.strength,
                'volume': l.volume_at_level
            }
            for l in self.liquidity_levels
        ]
