"""
Smart Money Strategy Implementation

Integrates SmartMoneyEngine with the PQTS trading system.
"""

import logging
import numpy as np
from typing import Dict, List, Optional
from datetime import datetime
from .smart_money_discovery import SmartMoneyEngine, TraderType
from pqts.core.engine import Strategy

logger = logging.getLogger(__name__)

class SmartMoneyStrategy(Strategy):
    """
    Trading strategy based on smart money detection.
    
    Combines multiple signals:
    1. Individual predictive trader signals
    2. Multi-trader consensus
    3. Regime-aware filtering
    4. Confidence-weighted position sizing
    """
    
    def __init__(self, engine: SmartMoneyEngine, config: Dict):
        super().__init__(config)
        self.engine = engine
        self.config = config
        
        # Strategy parameters
        self.min_traders_for_signal = config.get('min_traders', 3)
        self.min_confidence = config.get('min_confidence', 0.6)
        self.position_size_base = config.get('position_size', 0.05)
        self.max_position_pct = config.get('max_position', 0.15)
        self.stop_loss_pct = config.get('stop_loss', 0.03)
        
        # Signal aggregation
        self.consensus_threshold = config.get('consensus_threshold', 0.7)
        self.lookback_trades = config.get('lookback', 10)
        
        # State
        self.positions: Dict[str, Dict] = {}
        self.signals_history: List[Dict] = []
        
    def on_market_data(self, data: Dict) -> Optional[Dict]:
        """
        Called on every market update.
        
        Returns trade signal or None.
        """
        market = data.get('symbol')
        current_price = data.get('close')
        
        # Get predictive traders
        traders = self.engine.get_predictive_traders(
            min_confidence=self.min_confidence
        )
        
        if len(traders) < self.min_traders_for_signal:
            return None
        
        # Generate signal
        signal = self.engine.generate_trading_signal(
            traders, market, current_price
        )
        
        self.signals_history.append({
            'timestamp': datetime.now(),
            'signal': signal,
            'price': current_price
        })
        
        # Check if we should act
        return self._evaluate_signal(signal, market, current_price)
    
    def _evaluate_signal(self, signal: Dict, market: str,
                       current_price: float) -> Optional[Dict]:
        """Evaluate signal and generate trade if appropriate."""
        if signal['strength'] < 0.3:
            return None
        
        current_pos = self.positions.get(market, {}).get('size', 0)
        
        # Entry logic
        if current_pos == 0 and signal['signal'] != 'neutral':
            if signal['confidence'] >= self.min_confidence:
                return self._generate_entry(signal, market, current_price)
        
        # Exit logic
        elif current_pos != 0:
            # Exit if signal reverses strongly
            if (signal['signal'] == 'buy' and current_pos < 0) or \
               (signal['signal'] == 'sell' and current_pos > 0):
                if signal['strength'] > 0.6:
                    return self._generate_exit(market, current_price, 'signal_reversal')
            
            # Exit if confidence drops
            if signal['confidence'] < 0.4:
                return self._generate_exit(market, current_price, 'low_confidence')
        
        return None
    
    def _generate_entry(self, signal: Dict, market: str,
                       price: float) -> Dict:
        """Generate entry trade."""
        # Size based on confidence and strength
        size = self.position_size_base * signal['confidence'] * signal['strength']
        size = min(size, self.max_position_pct)
        
        side = 'buy' if signal['signal'] == 'buy' else 'sell'
        
        trade = {
            'action': 'enter',
            'side': side,
            'size': size,
            'price': price,
            'market': market,
            'metadata': {
                'confidence': signal['confidence'],
                'strength': signal['strength'],
                'num_traders': signal['num_traders'],
                'signal_type': 'smart_money'
            }
        }
        
        self.positions[market] = {
            'size': size if side == 'buy' else -size,
            'entry_price': price,
            'entry_time': datetime.now(),
            'signal_confidence': signal['confidence']
        }
        
        logger.info(f"SMART_MONEY entry: {side} {market} size={size:.3f} "
                   f"conf={signal['confidence']:.2f}")
        
        return trade
    
    def _generate_exit(self, market: str, price: float, reason: str) -> Dict:
        """Generate exit trade."""
        pos = self.positions[market]
        side = 'sell' if pos['size'] > 0 else 'buy'
        
        trade = {
            'action': 'exit',
            'side': side,
            'size': abs(pos['size']),
            'price': price,
            'market': market,
            'metadata': {
                'reason': reason,
                'holding_time': (datetime.now() - pos['entry_time']).total_seconds(),
                'unrealized_pnl': (price - pos['entry_price']) / pos['entry_price'] * (1 if pos['size'] > 0 else -1)
            }
        }
        
        del self.positions[market]
        
        logger.info(f"SMART_MONEY exit: {market} reason={reason}")
        
        return trade
    
    def check_stop_loss(self, market: str, current_price: float) -> Optional[Dict]:
        """Check if position hit stop loss."""
        if market not in self.positions:
            return None
        
        pos = self.positions[market]
        entry = pos['entry_price']
        
        # Calculate return
        if pos['size'] > 0:
            current_return = (current_price - entry) / entry
        else:
            current_return = (entry - current_price) / entry
        
        if current_return < -self.stop_loss_pct:
            return self._generate_exit(market, current_price, 'stop_loss')
        
        return None
    
    def get_metrics(self) -> Dict:
        """Get strategy metrics."""
        return {
            'active_positions': len(self.positions),
            'predictive_traders': len(self.engine.get_predictive_traders(50)),
            'avg_signal_strength': np.mean([s['signal']['strength'] 
                                          for s in self.signals_history[-100:]])
        }