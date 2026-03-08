# Market Making Strategy
import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime

from strategies.inventory_transfer import InventoryRiskTransferEngine

logger = logging.getLogger(__name__)

@dataclass
class MarketMakerState:
    symbol: str
    inventory: float
    cash_position: float
    avg_entry_price: float
    total_pnl: float
    unrealized_pnl: float
    bid_orders: List[Dict]
    ask_orders: List[Dict]
    skew: float  # Inventory skew indicator

class MarketMakingStrategy:
    """
    Professional market making with microstructure signals.
    
    Edge sources:
    - Order book imbalance
    - Trade flow analysis
    - Inventory management
    - Volatility-adjusted spreads
    - Toxic flow detection
    
    Key insight: Market making profit isn't from predicting direction,
    it's from capturing spread while managing adverse selection.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.base_spread_bps = config.get('base_spread_bps', 50)
        self.max_spread_bps = config.get('max_spread_bps', 150)
        self.min_spread_bps = config.get('min_spread_bps', 10)
        
        # Inventory management
        self.target_inventory = config.get('target_inventory', 0.0)
        self.max_position = config.get('max_position', 10.0)
        self.inventory_halflife = config.get('inventory_halflife', 100)
        
        # Quote sizes
        self.base_quote_size = config.get('base_quote_size', 1.0)
        self.max_quote_size = config.get('max_quote_size', 5.0)
        
        # Adverse selection protection
        self.toxicity_threshold = config.get('toxicity_threshold', 0.3)
        self.cancel_threshold = config.get('cancel_threshold', 0.7)
        transfer_cfg = config.get('inventory_transfer', {})
        self.inventory_transfer_engine = InventoryRiskTransferEngine(
            threshold_ratio=float(transfer_cfg.get('threshold_ratio', 0.8)),
            target_ratio=float(transfer_cfg.get('target_ratio', 0.3)),
            hedge_ratio=float(transfer_cfg.get('hedge_ratio', 1.0)),
        )
        
        # State tracking
        self.states: Dict[str, MarketMakerState] = {}
        self.tick_data: Dict[str, List[Dict]] = {}
        
        logger.info(f"MarketMakingStrategy initialized: base_spread={self.base_spread_bps}bps")
    
    def update_state(self, symbol: str, tick: Dict) -> MarketMakerState:
        """Update market maker state with new tick data"""
        if symbol not in self.states:
            self.states[symbol] = MarketMakerState(
                symbol=symbol,
                inventory=0.0,
                cash_position=0.0,
                avg_entry_price=0.0,
                total_pnl=0.0,
                unrealized_pnl=0.0,
                bid_orders=[],
                ask_orders=[],
                skew=0.0
            )
            self.tick_data[symbol] = []
        
        # Store tick
        self.tick_data[symbol].append({
            'timestamp': tick.get('timestamp', datetime.now()),
            'price': tick.get('price', 0),
            'size': tick.get('size', 0),
            'side': tick.get('side', 'buy')
        })
        
        # Keep last 1000 ticks
        if len(self.tick_data[symbol]) > 1000:
            self.tick_data[symbol] = self.tick_data[symbol][-1000:]
        
        # Update skew
        state = self.states[symbol]
        state.skew = self._calculate_inventory_skew(state.inventory, self.max_position)
        
        return state
    
    def generate_quotes(self, symbol: str, mid_price: float,
                       features: Dict[str, float],
                       state: MarketMakerState = None) -> Dict:
        """
        Generate bid/ask quotes with microstructure adjustments.
        
        Quote formula:
        fair = mid + alpha_adjustment + inventory_skew
        spread = base_spread + volatility_adjustment + toxicity_adjustment
        """
        if state is None:
            state = self.states.get(symbol)
            if state is None:
                return {}
        
        # Extract features
        imbalance = features.get('ob_imbalance', 0)
        volatility = features.get('vol_realized_1h', 0.001)
        toxicity = features.get('trade_toxicity', 0)
        flow_aggressor = features.get('flow_aggressor_bid', 0.5)
        
        # Calculate fair price adjustment
        alpha_adj = self._alpha_adjustment(imbalance, flow_aggressor)
        inventory_adj = self._inventory_adjustment(state.inventory, state.skew)
        fair_price = mid_price * (1 + alpha_adj + inventory_adj)
        
        # Calculate spread
        spread_bps = self._calculate_spread(
            volatility=volatility,
            toxicity=toxicity,
            base_spread=self.base_spread_bps
        )
        
        # Calculate quote sizes
        bid_size = self._quote_size_adjustment(state.inventory, 'bid')
        ask_size = self._quote_size_adjustment(state.inventory, 'ask')
        
        # Check adverse flow
        if toxicity > self.toxicity_threshold:
            # Toxic flow detected - widen spread or cancel
            spread_bps = min(spread_bps * 1.5, self.max_spread_bps)
            bid_size *= 0.5
            ask_size *= 0.5
            logger.warning(f"Toxic flow detected for {symbol}, widening spread")
        
        # Calculate final quotes
        half_spread = spread_bps / 10000 / 2
        bid_price = fair_price * (1 - half_spread)
        ask_price = fair_price * (1 + half_spread)
        
        # Cap by position limits
        current_position = state.inventory
        if current_position >= self.max_position:
            # Full long - cancel bid
            bid_price = 0
            bid_size = 0
        elif current_position <= -self.max_position:
            # Full short - cancel ask
            ask_price = float('inf')
            ask_size = 0
        
        quotes = {
            'symbol': symbol,
            'fair_price': fair_price,
            'spread_bps': spread_bps,
            'skew': state.skew,
            'bid': {
                'price': bid_price,
                'size': bid_size
            },
            'ask': {
                'price': ask_price,
                'size': ask_size
            },
            'adjustments': {
                'alpha': alpha_adj,
                'inventory': inventory_adj,
                'volatility': volatility,
                'toxicity': toxicity
            }
        }

        transfer = self.inventory_transfer_engine.suggest_transfer(
            symbol=symbol,
            inventory=float(state.inventory),
            max_position=float(self.max_position),
            mid_price=float(mid_price),
        )
        if transfer is not None:
            quotes['risk_transfer'] = {
                'symbol': transfer.symbol,
                'side': transfer.side,
                'quantity': transfer.quantity,
                'expected_notional': transfer.expected_notional,
                'reason': transfer.reason,
            }
        
        return quotes
    
    def _alpha_adjustment(self, imbalance: float, flow_aggressor: float) -> float:
        """
        Adjust fair price based on alpha signals.
        
        Imbalance > 0 (more bid volume) → price tends to go up → skew quotes up
        """
        # Book imbalance alpha
        imbalance_alpha = imbalance * 0.001  # Small adjustment
        
        # Flow direction alpha
        flow_alpha = (flow_aggressor - 0.5) * 0.001
        
        total_alpha = imbalance_alpha + flow_alpha
        
        # Cap alpha adjustment
        return max(min(total_alpha, 0.005), -0.005)
    
    def _inventory_adjustment(self, inventory: float, skew: float) -> float:
        """
        Inventory skew: if long, skew quotes lower to sell.
        If short, skew quotes higher to buy.
        """
        adjustment = -skew * 0.002  # Max 0.2% adjustment
        return adjustment
    
    def _calculate_spread(self, volatility: float, toxicity: float,
                         base_spread: float) -> float:
        """
        Dynamic spread calculation.
        
        Spread = base + volatility_premium + toxicity_premium
        """
        # Volatility adjustment: wider spreads in volatile markets
        vol_factor = 1 + volatility * 10  # Scale factor
        
        # Toxicity adjustment: wider spreads for toxic flow
        tox_premium = toxicity * 50  # Up to +50 bps
        
        spread = base_spread * vol_factor + tox_premium
        
        # Bound spread
        spread = max(self.min_spread_bps, min(spread, self.max_spread_bps))
        
        return spread
    
    def _quote_size_adjustment(self, inventory: float, side: str) -> float:
        """
        Adjust quote size based on inventory and side.
        
        If long, increase ask size, decrease bid size.
        """
        base_size = self.base_quote_size
        
        if side == 'bid':
            # Decrease bid size if already long
            multiplier = max(0.1, 1 - abs(inventory) / self.max_position)
        else:  # ask
            # Decrease ask size if already short
            multiplier = max(0.1, 1 - abs(inventory) / self.max_position)
        
        size = base_size * multiplier
        return min(size, self.max_quote_size)
    
    def _calculate_inventory_skew(self, inventory: float, max_pos: float) -> float:
        """Calculate inventory skew indicator (-1 to 1)"""
        if max_pos == 0:
            return 0.0
        skew = inventory / max_pos
        return max(-1.0, min(1.0, skew))
    
    def process_fill(self, symbol: str, side: str, price: float,
                    size: float, state: MarketMakerState = None) -> Dict:
        """
        Process a fill and update P&L.
        """
        if state is None:
            state = self.states.get(symbol)
            if state is None:
                return {}
        
        if side == 'buy':
            # Filled bid - bought inventory
            old_inventory = state.inventory
            new_inventory = old_inventory + size
            
            # Update average entry
            if old_inventory > 0:
                total_cost = state.avg_entry_price * old_inventory + price * size
                state.avg_entry_price = total_cost / new_inventory
            else:
                state.avg_entry_price = price
            
            state.inventory = new_inventory
            state.cash_position -= price * size
            
        else:  # sell
            # Filled ask - sold inventory
            old_inventory = state.inventory
            new_inventory = old_inventory - size
            
            # Calculate realized P&L
            if old_inventory > 0:
                realized = (price - state.avg_entry_price) * size
            else:
                realized = 0
            
            state.total_pnl += realized
            state.inventory = new_inventory
            state.cash_position += price * size
        
        # Update unrealized P&L
        if state.inventory != 0:
            state.unrealized_pnl = (price - state.avg_entry_price) * state.inventory
        else:
            state.unrealized_pnl = 0
        
        state.skew = self._calculate_inventory_skew(state.inventory, self.max_position)
        
        return {
            'symbol': symbol,
            'side': side,
            'price': price,
            'size': size,
            'total_pnl': state.total_pnl,
            'unrealized_pnl': state.unrealized_pnl,
            'inventory': state.inventory,
            'cash': state.cash_position
        }
    
    def should_cancel_quotes(self, symbol: str, features: Dict,
                            state: MarketMakerState = None) -> bool:
        """
        Determine if we should cancel quotes due to adverse conditions.
        
        Triggers:
        - High toxicity
        - Sudden volatility spike
        - Inventory limit breach
        """
        if state is None:
            state = self.states.get(symbol)
            if state is None:
                return False
        
        toxicity = features.get('trade_toxicity', 0)
        vol_spike = features.get('vol_regime', 1.0) > 2.0
        
        if toxicity > self.cancel_threshold:
            logger.warning(f"Canceling quotes for {symbol}: toxic flow detected")
            return True
        
        if vol_spike:
            logger.warning(f"Canceling quotes for {symbol}: volatility spike")
            return True
        
        if abs(state.inventory) > self.max_position * 0.95:
            logger.warning(f"Canceling quotes for {symbol}: inventory limit")
            return True
        
        return False


if __name__ == "__main__":
    config = {
        'base_spread_bps': 50,
        'max_position': 10,
        'target_inventory': 0,
        'toxicity_threshold': 0.3
    }
    
    mm = MarketMakingStrategy(config)
    
    # Simulate
    symbol = 'BTCUSDT'
    mid_price = 45000
    
    features = {
        'ob_imbalance': 0.2,      # Slight bid imbalance
        'vol_realized_1h': 0.001,  # Low vol
        'trade_toxicity': 0.1,      # Low toxicity
        'flow_aggressor_bid': 0.6  # Slight buying flow
    }
    
    # Generate quotes
    quotes = mm.generate_quotes(symbol, mid_price, features)
    
    print("Market Maker Quotes:")
    print(f"Symbol: {symbol}")
    print(f"Fair Price: ${quotes['fair_price']:,.2f}")
    print(f"Spread: {quotes['spread_bps']:.1f} bps")
    print(f"Skew: {quotes['skew']:.2f}")
    print(f"\nBid: ${quotes['bid']['price']:,.2f} x {quotes['bid']['size']:.4f}")
    print(f"Ask: ${quotes['ask']['price']:,.2f} x {quotes['ask']['size']:.4f}")
