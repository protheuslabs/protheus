# Order Flow Strategy
import logging
import numpy as np
from typing import List, Dict, Optional
from dataclasses import dataclass
from collections import deque

logger = logging.getLogger(__name__)

@dataclass
class OrderFlowMetrics:
    bid_ask_ratio: float
    delta: float  # Buy volume - Sell volume
    cumulative_delta: float
    large_order_imbalance: float
    iceberg_detected: bool
    absorption_level: Optional[float]

class OrderFlowStrategy:
    """
    Analyzes order flow and microstructure for edge.
    
    Key concepts:
    - Bid/ask imbalance
    - Delta (buy vs sell pressure)
    - Large orders (whale detection)
    - Iceberg orders
    - Absorption (buying/selling into strength)
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.enabled = config.get('enabled', False)
        self.lookback_ticks = config.get('lookback_ticks', 100)
        self.large_order_threshold = config.get('large_order_threshold', 10.0)  # BTC
        
        # Data storage
        self.tick_history = deque(maxlen=self.lookback_ticks)
        self.cumulative_delta = 0.0
        self.large_orders = []
        
        logger.info(f"OrderFlowStrategy initialized")
    
    def process_tick(self, tick: dict):
        """Process a single tick/market update"""
        # Calculate delta
        if tick['aggressor'] == 'buy':
            delta = tick['volume']
        else:
            delta = -tick['volume']
        
        self.cumulative_delta += delta
        
        # Store tick
        tick['delta'] = delta
        tick['cumulative_delta'] = self.cumulative_delta
        self.tick_history.append(tick)
        
        # Detect large orders
        if tick['volume'] >= self.large_order_threshold:
            self.large_orders.append({
                'timestamp': tick['timestamp'],
                'price': tick['price'],
                'volume': tick['volume'],
                'side': tick['aggressor'],
                'type': 'market' if tick.get('is_market') else 'limit'
            })
            
            # Keep last 50 large orders
            if len(self.large_orders) > 50:
                self.large_orders = self.large_orders[-50:]
    
    def calculate_metrics(self) -> OrderFlowMetrics:
        """Calculate current order flow metrics"""
        if not self.tick_history:
            return OrderFlowMetrics(1.0, 0, 0, 0, False, None)
        
        # Bid/ask ratio
        buy_volume = sum(t['volume'] for t in self.tick_history if t['aggressor'] == 'buy')
        sell_volume = sum(t['volume'] for t in self.tick_history if t['aggressor'] == 'sell')
        bid_ask_ratio = buy_volume / sell_volume if sell_volume > 0 else 1.0
        
        # Delta
        delta = buy_volume - sell_volume
        
        # Large order imbalance
        large_buys = sum(o['volume'] for o in self.large_orders if o['side'] == 'buy')
        large_sells = sum(o['volume'] for o in self.large_orders if o['side'] == 'sell')
        large_imbalance = (large_buys - large_sells) / (large_buys + large_sells) if (large_buys + large_sells) > 0 else 0
        
        # Detect iceberg orders
        iceberg = self._detect_iceberg()
        
        # Detect absorption
        absorption = self._detect_absorption()
        
        return OrderFlowMetrics(
            bid_ask_ratio=bid_ask_ratio,
            delta=delta,
            cumulative_delta=self.cumulative_delta,
            large_order_imbalance=large_imbalance,
            iceberg_detected=iceberg,
            absorption_level=absorption
        )
    
    def _detect_iceberg(self) -> bool:
        """Detect iceberg orders (large orders split into small pieces)"""
        if len(self.tick_history) < 20:
            return False
        
        # Look for repeated same-size orders at same price
        recent = list(self.tick_history)[-20:]
        prices = [t['price'] for t in recent]
        volumes = [t['volume'] for t in recent]
        
        # Check for repeated volume at same price
        from collections import Counter
        price_counts = Counter(prices)
        volume_counts = Counter(volumes)
        
        # Iceberg signature: same volume appearing multiple times
        most_common_vol = volume_counts.most_common(1)
        if most_common_vol and most_common_vol[0][1] >= 5:
            return True
        
        return False
    
    def _detect_absorption(self) -> Optional[float]:
        """Detect absorption (buying/selling into strength)"""
        if len(self.tick_history) < 10:
            return None
        
        recent = list(self.tick_history)[-10:]
        
        # Price not moving despite heavy volume
        price_change = abs(recent[-1]['price'] - recent[0]['price']) / recent[0]['price']
        total_volume = sum(t['volume'] for t in recent)
        
        if price_change < 0.001 and total_volume > self.large_order_threshold:
            # Absorption detected
            return recent[-1]['price']
        
        return None
    
    def generate_signals(self, current_price: float) -> List[Dict]:
        """Generate signals based on order flow"""
        if not self.enabled:
            return []
        
        signals = []
        metrics = self.calculate_metrics()
        
        # Signal 1: Extreme bid/ask imbalance
        if metrics.bid_ask_ratio > 2.0:
            signals.append({
                'type': 'order_flow',
                'direction': 'long',
                'reason': f'Heavy buying pressure (ratio: {metrics.bid_ask_ratio:.2f})',
                'confidence': min(metrics.bid_ask_ratio / 3.0, 0.9),
                'strength': 'strong'
            })
        elif metrics.bid_ask_ratio < 0.5:
            signals.append({
                'type': 'order_flow',
                'direction': 'short',
                'reason': f'Heavy selling pressure (ratio: {metrics.bid_ask_ratio:.2f})',
                'confidence': min((1/metrics.bid_ask_ratio) / 3.0, 0.9),
                'strength': 'strong'
            })
        
        # Signal 2: Large order imbalance
        if abs(metrics.large_order_imbalance) > 0.3:
            direction = 'long' if metrics.large_order_imbalance > 0 else 'short'
            signals.append({
                'type': 'whale_activity',
                'direction': direction,
                'reason': f'Whale {direction}ing (imbalance: {metrics.large_order_imbalance:.2f})',
                'confidence': abs(metrics.large_order_imbalance),
                'strength': 'medium'
            })
        
        # Signal 3: Cumulative delta divergence
        if len(self.tick_history) > 50:
            old_delta = list(self.tick_history)[0]['cumulative_delta']
            delta_change = metrics.cumulative_delta - old_delta
            
            # Price down but delta up = bullish divergence
            # Price up but delta down = bearish divergence
            
            # Simplified - would need price history for full divergence
            if delta_change > 0 and metrics.delta > 0:
                signals.append({
                    'type': 'delta_divergence',
                    'direction': 'long',
                    'reason': 'Positive delta accumulation',
                    'confidence': 0.6,
                    'strength': 'weak'
                })
        
        # Signal 4: Absorption
        if metrics.absorption_level:
            # Determine direction based on recent price action
            recent_prices = [t['price'] for t in list(self.tick_history)[-10:]]
            if len(recent_prices) >= 2:
                if recent_prices[-1] > recent_prices[0]:
                    direction = 'short'  # Buying absorption = resistance
                    reason = 'Buying absorption detected (resistance)'
                else:
                    direction = 'long'  # Selling absorption = support
                    reason = 'Selling absorption detected (support)'
                
                signals.append({
                    'type': 'absorption',
                    'direction': direction,
                    'reason': reason,
                    'confidence': 0.7,
                    'level': metrics.absorption_level,
                    'strength': 'strong'
                })
        
        return signals
    
    def get_recent_large_orders(self, n: int = 10) -> List[Dict]:
        """Get recent large orders"""
        return self.large_orders[-n:]
