# Dynamic Position Sizing
import logging
import numpy as np
import pandas as pd
from typing import Dict, Optional
from enum import Enum

logger = logging.getLogger(__name__)

class SizingMethod(Enum):
    FIXED_AMOUNT = "fixed_amount"
    FIXED_QUANTITY = "fixed_quantity"
    EQUAL_WEIGHT = "equal_weight"
    KELLY = "kelly"
    HALF_KELLY = "half_kelly"
    VOLATILITY_TARGETING = "volatility_targeting"
    RISK_PERCENT = "risk_percent"
    ATR_BASED = "atr_based"

class PositionSizer:
    """
    Dynamic position sizing with multiple methods.
    
    Key improvements from quant analysis:
    - Volatility targeting
    - Kelly criterion
    - ATR-based sizing
    - Risk percentage method
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.method = SizingMethod(config.get('method', 'half_kelly'))
        self.target_volatility = config.get('target_volatility', 0.15)  # 15% annual
        self.max_position_pct = config.get('max_position_pct', 0.25)
        self.risk_per_trade = config.get('risk_per_trade', 0.01)  # 1% risk
        self.kelly_fraction = config.get('kelly_fraction', 0.5)  # Half Kelly
        self.atr_multiplier = config.get('atr_multiplier', 2.0)
        
        logger.info(f"PositionSizer initialized: method={self.method.value}")
    
    def calculate_size(self, symbol: str, signal: dict, 
                      capital: float, price: float,
                      volatility: float = None,
                      stop_distance: float = None) -> float:
        """
        Calculate position size for a signal
        
        Args:
            symbol: Trading symbol
            signal: Signal dict with expected_return, win_rate, etc.
            capital: Available capital
            price: Current price
            volatility: Price volatility (for vol targeting)
            stop_distance: Distance to stop loss (for risk percent)
        """
        if self.method == SizingMethod.FIXED_AMOUNT:
            return self._fixed_amount(signal, capital, price)
        
        elif self.method == SizingMethod.FIXED_QUANTITY:
            return self._fixed_quantity(signal)
        
        elif self.method == SizingMethod.EQUAL_WEIGHT:
            return self._equal_weight(signal, capital, price)
        
        elif self.method == SizingMethod.KELLY:
            return self._kelly_criterion(signal, capital, price, full_kelly=True)
        
        elif self.method == SizingMethod.HALF_KELLY:
            return self._kelly_criterion(signal, capital, price, full_kelly=False)
        
        elif self.method == SizingMethod.VOLATILITY_TARGETING:
            return self._volatility_targeting(signal, capital, price, volatility)
        
        elif self.method == SizingMethod.RISK_PERCENT:
            return self._risk_percent(signal, capital, price, stop_distance)
        
        elif self.method == SizingMethod.ATR_BASED:
            return self._atr_based(signal, capital, price, volatility)
        
        else:
            return self._fixed_quantity(signal)
    
    def _fixed_amount(self, signal: dict, capital: float, price: float) -> float:
        """Fixed dollar amount per position"""
        amount = signal.get('fixed_amount', 1000.0)
        quantity = amount / price if price > 0 else 0
        return quantity
    
    def _fixed_quantity(self, signal: dict) -> float:
        """Fixed quantity per trade"""
        return signal.get('fixed_quantity', 1.0)
    
    def _equal_weight(self, signal: dict, capital: float, price: float) -> float:
        """Equal weight across positions"""
        num_positions = signal.get('total_positions', 10)
        weight = 1.0 / num_positions
        quantity = (capital * weight) / price if price > 0 else 0
        return quantity
    
    def _kelly_criterion(self, signal: dict, capital: float, 
                         price: float, full_kelly: bool = False) -> float:
        """
        Kelly Criterion for optimal bet sizing.
        
        Kelly = (p*b - q) / b
        where:
        p = win probability
        q = loss probability = 1-p
        b = average win / average loss (payoff ratio)
        """
        win_rate = signal.get('win_rate', 0.5)
        avg_win = signal.get('avg_win', 0.02)  # 2%
        avg_loss = signal.get('avg_loss', 0.01)  # 1%
        
        p = win_rate
        q = 1 - p
        b = avg_win / avg_loss if avg_loss > 0 else 1.0
        
        # Kelly fraction
        kelly = (p * b - q) / b if b > 0 else 0
        
        # Apply fraction (half Kelly for safety)
        fraction = 1.0 if full_kelly else self.kelly_fraction
        kelly = kelly * fraction
        
        # Cap maximum position
        kelly = min(kelly, self.max_position_pct)
        
        quantity = (capital * kelly) / price if price > 0 else 0
        
        logger.debug(f"Kelly sizing: win_rate={win_rate:.2f}, kelly={kelly:.2%}, quantity={quantity:.4f}")
        
        return quantity
    
    def _volatility_targeting(self, signal: dict, capital: float, 
                            price: float, volatility: float) -> float:
        """
        Volatility targeting: scale position inversely with volatility.
        
        Target: constant portfolio volatility regardless of market conditions.
        Position = Base_Position * (Target_Vol / Current_Vol)
        """
        if volatility is None or volatility <= 0:
            volatility = 0.01  # Default 1%
        
        # Annualized volatility
        vol_annual = volatility * np.sqrt(252 * 24)  # For hourly data
        
        # Scale factor
        if vol_annual > 0:
            scale = self.target_volatility / vol_annual
        else:
            scale = 1.0
        
        # Cap scale
        scale = min(max(scale, 0.25), 2.0)  # Between 0.25x and 2x
        
        # Base position (e.g., 10% of capital)
        base_size = (capital * 0.10) / price if price > 0 else 0
        
        quantity = base_size * scale
        
        logger.debug(f"Vol targeting: current_vol={vol_annual:.2%}, target_vol={self.target_volatility:.2%}, "
                    f"scale={scale:.2f}, quantity={quantity:.4f}")
        
        return quantity
    
    def _risk_percent(self, signal: dict, capital: float, 
                     price: float, stop_distance: float) -> float:
        """
        Risk-based sizing: risk X% of capital per trade.
        
        Position = (Capital * Risk_Percent) / Stop_Distance
        """
        if stop_distance is None or stop_distance <= 0:
            stop_distance = price * 0.02  # Default 2% stop
        
        risk_amount = capital * self.risk_per_trade
        stop_pct = stop_distance / price if price > 0 else 0.02
        
        quantity = risk_amount / (price * stop_pct) if stop_pct > 0 else 0
        
        # Convert to units
        quantity = quantity
        
        logger.debug(f"Risk percent: risk_amount=${risk_amount:.2f}, stop={stop_distance:.4f}, "
                    f"quantity={quantity:.4f}")
        
        return quantity
    
    def _atr_based(self, signal: dict, capital: float, 
                  price: float, atr: float) -> float:
        """
        ATR-based sizing: use volatility-adjusted position size.
        
        Stop = ATR * multiplier
        Risk = Capital * risk_per_trade
        Position = Risk / Stop
        """
        if atr is None or atr <= 0:
            # Estimate ATR from price
            atr = price * 0.02  # Default 2%
        
        stop_loss = atr * self.atr_multiplier
        risk_amount = capital * self.risk_per_trade
        
        quantity = risk_amount / stop_loss if stop_loss > 0 else 0
        
        logger.debug(f"ATR sizing: atr={atr:.4f}, stop={stop_loss:.4f}, quantity={quantity:.4f}")
        
        return quantity


if __name__ == "__main__":
    config = {
        'method': 'half_kelly',
        'target_volatility': 0.15,
        'max_position_pct': 0.25,
        'risk_per_trade': 0.01,
        'kelly_fraction': 0.5
    }
    
    sizer = PositionSizer(config)
    
    # Test signal
    signal = {
        'expected_return': 0.02,
        'win_rate': 0.55,
        'avg_win': 0.03,
        'avg_loss': 0.01
    }
    
    capital = 10000
    price = 45000
    volatility = 0.006  # Hourly volatility
    stop_distance = 500  # Stop at $500 away
    
    print("Position Sizing Methods:")
    print("=" * 50)
    
    # Test different methods
    for method in SizingMethod:
        config_test = config.copy()
        config_test['method'] = method.value
        sizer_test = PositionSizer(config_test)
        
        if method == SizingMethod.VOLATILITY_TARGETING:
            size = sizer_test.calculate_size('BTC', signal, capital, price, volatility)
        elif method == SizingMethod.RISK_PERCENT:
            size = sizer_test.calculate_size('BTC', signal, capital, price, stop_distance=stop_distance)
        elif method == SizingMethod.ATR_BASED:
            size = sizer_test.calculate_size('BTC', signal, capital, price, atr=500)
        else:
            size = sizer_test.calculate_size('BTC', signal, capital, price)
        
        notional = size * price
        pct = (notional / capital) * 100
        
        print(f"{method.value:25s}: {size:8.4f} BTC (${notional:,.0f}, {pct:.1f}%)")
