# Volume Profile Strategy
import logging
import numpy as np
import pandas as pd
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass
class VolumeProfile:
    price_levels: np.ndarray
    volumes: np.ndarray
    poc: float  # Point of Control (most traded price)
    value_area_high: float
    value_area_low: float
    high_volume_nodes: List[float]

class VolumeProfileStrategy:
    """
    Volume Profile-based trading strategy.
    Uses historical volume distribution to identify key levels.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.enabled = config.get('enabled', False)
        self.lookback_periods = config.get('lookback_periods', 24)  # Hours
        self.value_area_pct = config.get('value_area_pct', 0.70)  # 70% of volume
        self.min_volume_node = config.get('min_volume_node', 0.05)  # 5% of total
        
        logger.info(f"VolumeProfileStrategy initialized")
    
    def calculate_volume_profile(self, df: pd.DataFrame, num_bins: int = 50) -> VolumeProfile:
        """Calculate volume profile from OHLCV data"""
        # Create price bins
        price_min = df['low'].min()
        price_max = df['high'].max()
        bins = np.linspace(price_min, price_max, num_bins)
        
        # Calculate volume at each price level
        volumes = np.zeros(len(bins) - 1)
        
        for i in range(len(bins) - 1):
            mask = (df['close'] >= bins[i]) & (df['close'] < bins[i + 1])
            volumes[i] = df.loc[mask, 'volume'].sum()
        
        # Find Point of Control (POC)
        poc_idx = np.argmax(volumes)
        poc = (bins[poc_idx] + bins[poc_idx + 1]) / 2
        
        # Calculate Value Area (70% of volume)
        total_volume = volumes.sum()
        sorted_indices = np.argsort(volumes)[::-1]  # Descending
        
        cumulative_volume = 0
        value_area_indices = []
        
        for idx in sorted_indices:
            cumulative_volume += volumes[idx]
            value_area_indices.append(idx)
            
            if cumulative_volume >= total_volume * self.value_area_pct:
                break
        
        value_area_high = bins[max(value_area_indices) + 1]
        value_area_low = bins[min(value_area_indices)]
        
        # Find high volume nodes (>5% of total)
        high_volume_nodes = []
        for i, vol in enumerate(volumes):
            if vol >= total_volume * self.min_volume_node:
                node_price = (bins[i] + bins[i + 1]) / 2
                high_volume_nodes.append(node_price)
        
        return VolumeProfile(
            price_levels=bins[:-1],
            volumes=volumes,
            poc=poc,
            value_area_high=value_area_high,
            value_area_low=value_area_low,
            high_volume_nodes=high_volume_nodes
        )
    
    def generate_signals(self, df: pd.DataFrame, current_price: float) -> List[Dict]:
        """Generate signals based on volume profile"""
        if not self.enabled or len(df) < 100:
            return []
        
        signals = []
        
        # Calculate volume profile
        vp = self.calculate_volume_profile(df)
        
        # Signal 1: Price returns to POC (mean reversion)
        poc_distance = abs(current_price - vp.poc) / vp.poc
        
        if poc_distance < 0.005:  # Within 0.5% of POC
            # Price near high-volume node - potential support/resistance
            if current_price > df['close'].mean():
                signals.append({
                    'type': 'mean_reversion',
                    'direction': 'short',
                    'reason': 'Price at POC in uptrend - potential resistance',
                    'confidence': 0.6,
                    'target': vp.value_area_low,
                    'stop': vp.value_area_high
                })
            else:
                signals.append({
                    'type': 'mean_reversion',
                    'direction': 'long',
                    'reason': 'Price at POC in downtrend - potential support',
                    'confidence': 0.6,
                    'target': vp.value_area_high,
                    'stop': vp.value_area_low
                })
        
        # Signal 2: Price outside Value Area (trend continuation)
        if current_price > vp.value_area_high:
            signals.append({
                'type': 'breakout',
                'direction': 'long',
                'reason': 'Price above Value Area High - bullish breakout',
                'confidence': 0.7,
                'target': current_price * 1.02,
                'stop': vp.value_area_high
            })
        
        elif current_price < vp.value_area_low:
            signals.append({
                'type': 'breakout',
                'direction': 'short',
                'reason': 'Price below Value Area Low - bearish breakout',
                'confidence': 0.7,
                'target': current_price * 0.98,
                'stop': vp.value_area_low
            })
        
        # Signal 3: High Volume Node test
        for node in vp.high_volume_nodes:
            node_distance = abs(current_price - node) / node
            
            if node_distance < 0.003:  # Within 0.3%
                signals.append({
                    'type': 'support_resistance',
                    'direction': 'long' if current_price > node else 'short',
                    'reason': f'Price testing high volume node at {node:.2f}',
                    'confidence': 0.65,
                    'target': node * 1.01 if current_price > node else node * 0.99,
                    'stop': node * 0.99 if current_price > node else node * 1.01
                })
        
        return signals
    
    def get_levels(self, df: pd.DataFrame) -> Dict:
        """Get key levels for charting"""
        vp = self.calculate_volume_profile(df)
        
        return {
            'poc': vp.poc,
            'value_area_high': vp.value_area_high,
            'value_area_low': vp.value_area_low,
            'high_volume_nodes': vp.high_volume_nodes,
            'volume_distribution': list(zip(vp.price_levels.tolist(), vp.volumes.tolist()))
        }
