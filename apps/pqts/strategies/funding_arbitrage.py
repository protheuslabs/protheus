# Funding Rate Arbitrage Strategy
import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

@dataclass
class FundingArbitrageOpportunity:
    symbol: str
    perp_exchange: str
    spot_exchange: str
    perp_price: float
    spot_price: float
    funding_rate: float  # 8-hour rate
    annualized_yield: float
    borrow_rate: float
    net_yield_annual: float
    position_size: float
    expected_daily_profit: float
    confidence: float
    timestamp: datetime

class FundingArbitrageStrategy:
    """
    Funding rate arbitrage: short perpetual, long spot.
    
    Edge: Perpetual futures pay funding rates. When funding is positive,
    shorts get paid. Long spot hedge eliminates directional risk.
    
    Profit = funding - fees - borrow costs
    
    Advantages:
    - Low directional risk (delta neutral)
    - Predictable yield (funding known in advance)
    - Scalable
    
    This is how large funds earn "risk-free" yield in crypto.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.min_funding_rate = config.get('min_funding_rate', 0.0001)  # 0.01%
        self.min_annual_yield = config.get('min_annual_yield', 0.05)  # 5%
        self.funding_interval_hours = config.get('funding_interval', 8)
        
        # Position sizing
        self.max_position_size_usd = config.get('max_position_size_usd', 50000)
        self.min_position_size_usd = config.get('min_position_size_usd', 1000)
        
        # Borrow rates (annual)
        self.spot_borrow_rates = config.get('borrow_rates', {
            'binance': 0.05,    # 5% annual
            'coinbase': 0.08,
            'kraken': 0.06,
            'bybit': 0.04,
            'okx': 0.05
        })
        
        # Fee schedule
        self.fee_rates = config.get('fee_rates', {
            'perp_open': 0.0005,   # 0.05%
            'perp_close': 0.0005,
            'spot_open': 0.001,    # 0.1%
            'spot_close': 0.001
        })
        
        # State
        self.active_positions: Dict[str, Dict] = {}
        self.funding_history: Dict[str, List] = {}
        self.cumulative_funding_earned: float = 0.0
        
        logger.info(f"FundingArbitrage initialized: min_yield={self.min_annual_yield:.1%}")
    
    def scan_opportunities(self, market_data: Dict[str, Dict],
                        funding_rates: Dict[str, float]) -> List[FundingArbitrageOpportunity]:
        """
        Scan for funding arbitrage opportunities.
        
        Args:
            market_data: {exchange: {symbol: {'spot': price, 'perp': price}}}
            funding_rates: {symbol: current_funding_rate}
        """
        opportunities = []
        
        for symbol, funding_rate in funding_rates.items():
            # Skip if funding rate too low
            if abs(funding_rate) < self.min_funding_rate:
                continue
            
            # Find cross-exchange prices
            for perp_ex, data in market_data.items():
                if symbol not in data or 'perp' not in data[symbol]:
                    continue
                
                for spot_ex, spot_data in market_data.items():
                    if symbol not in spot_data or 'spot' not in spot_data[symbol]:
                        continue
                    
                    perp_price = data[symbol]['perp']
                    spot_price = spot_data[symbol]['spot']
                    
                    # Calculate opportunity
                    opp = self._calculate_opportunity(
                        symbol, perp_ex, spot_ex, perp_price, spot_price, funding_rate
                    )
                    
                    if opp and opp.net_yield_annual >= self.min_annual_yield:
                        opportunities.append(opp)
        
        # Sort by net yield
        opportunities.sort(key=lambda x: x.net_yield_annual, reverse=True)
        
        logger.info(f"Found {len(opportunities)} funding arbitrage opportunities")
        return opportunities
    
    def _calculate_opportunity(self, symbol: str, perp_ex: str, spot_ex: str,
                            perp_price: float, spot_price: float,
                            funding_rate: float) -> Optional[FundingArbitrageOpportunity]:
        """Calculate complete opportunity metrics"""
        
        # Only trade positive funding (short perp, long spot)
        if funding_rate <= 0:
            return None
        
        # Spot price should be close to perp for valid hedge
        price_diff = abs(perp_price - spot_price) / spot_price
        if price_diff > 0.005:  # 0.5% max basis
            logger.debug(f"Basis too wide for {symbol}: {price_diff:.2%}")
            return None
        
        # Annualized funding yield
        periods_per_year = 365 * 24 / self.funding_interval_hours
        annualized_yield = funding_rate * periods_per_year
        
        # Estimated borrow rate for spot long
        borrow_rate = self.spot_borrow_rates.get(spot_ex, 0.06)
        
        # Calculate fees (entry + exit)
        entry_fees = perp_price * self.fee_rates['perp_open'] + spot_price * self.fee_rates['spot_open']
        exit_fees = perp_price * self.fee_rates['perp_close'] + spot_price * self.fee_rates['spot_close']
        total_fees_pct = (entry_fees + exit_fees) / spot_price
        
        # Break-even hours (how long to hold to recoup fees)
        hours_to_breakeven = (total_fees_pct / funding_rate) * self.funding_interval_hours
        
        # Estimate hold period (conservative: 1 week)
        hold_period_days = 7
        periods_held = hold_period_days * 24 / self.funding_interval_hours
        
        # Net yield calculation
        gross_yield = funding_rate * periods_held
        borrow_cost = borrow_rate * hold_period_days / 365
        net_yield = gross_yield - total_fees_pct - borrow_cost
        
        # Annualize
        net_yield_annual = net_yield * (365 / hold_period_days)
        
        # Position sizing
        position_size = min(self.max_position_size_usd, self.config.get('capital', 100000) * 0.1)
        position_size = max(position_size, self.min_position_size_usd)
        
        # Calculate profit
        expected_daily_profit = position_size * (funding_rate / self.funding_interval_hours * 24) - \
                                position_size * (borrow_rate / 365) - \
                                position_size * (total_fees_pct / hold_period_days)
        
        # Confidence based on funding rate consistency
        confidence = min(funding_rate / 0.001, 0.95)  # Higher funding = higher confidence
        
        return FundingArbitrageOpportunity(
            symbol=symbol,
            perp_exchange=perp_ex,
            spot_exchange=spot_ex,
            perp_price=perp_price,
            spot_price=spot_price,
            funding_rate=funding_rate,
            annualized_yield=annualized_yield,
            borrow_rate=borrow_rate,
            net_yield_annual=net_yield_annual,
            position_size=position_size,
            expected_daily_profit=expected_daily_profit,
            confidence=confidence,
            timestamp=datetime.now()
        )
    
    def calculate_yield_curve(self, funding_history: pd.DataFrame,
                            symbol: str, days: int = 30) -> pd.DataFrame:
        """
        Calculate historical funding yield curve.
        
        Shows if funding has been consistently positive.
        """
        if symbol not in funding_history.columns:
            return pd.DataFrame()
        
        symbol_data = funding_history[symbol].tail(days * 3)  # 3 funding periods per day
        
        # Calculate rolling statistics
        yield_curve = pd.DataFrame({
            'funding_rate': symbol_data,
            'positive_pct': (symbol_data > 0).rolling(3).mean(),
            'mean_7d': symbol_data.rolling(21).mean(),
            'mean_30d': symbol_data.rolling(90).mean(),
            'volatility': symbol_data.rolling(21).std()
        })
        
        return yield_curve.dropna()
    
    def check_position_health(self, position: Dict,
                            current_funding: float,
                            mark_prices: Dict[str, float]) -> Dict:
        """
        Check if existing position is still profitable.
        
        Returns decision: hold, close, or rollover.
        """
        symbol = position['symbol']
        entry_funding = position['entry_funding_rate']
        funding_earned = position['funding_earned']
        entry_time = position['entry_time']
        
        # Hold duration
        hold_hours = (datetime.now() - entry_time).total_seconds() / 3600
        
        # Calculate metrics
        metrics = {
            'hold_hours': hold_hours,
            'entry_funding': entry_funding,
            'current_funding': current_funding,
            'funding_earned': funding_earned,
            'days_held': hold_hours / 24,
            'daily_yield': funding_earned / (hold_hours / 24) if hold_hours > 0 else 0
        }
        
        # Decision logic
        if current_funding < entry_funding * 0.3:
            # Funding rate dropped significantly - close position
            metrics['decision'] = 'close'
            metrics['reason'] = 'funding_rate_decayed'
        elif hold_hours > 24 * 7 and funding_earned < 0:
            # Held for a week, still losing money - cut losses
            metrics['decision'] = 'close'
            metrics['reason'] = 'loss_threshold'
        elif current_funding >= self.min_funding_rate:
            # Still profitable - hold
            metrics['decision'] = 'hold'
        else:
            # Funding went negative - close
            metrics['decision'] = 'close'
            metrics['reason'] = 'negative_funding'
        
        return metrics
    
    def generate_signals(self, opportunities: List[FundingArbitrageOpportunity]) -> List[Dict]:
        """Convert opportunities to trading signals"""
        signals = []
        
        for opp in opportunities:
            if opp.net_yield_annual < self.min_annual_yield:
                continue
            
            signal = {
                'type': 'funding_arbitrage',
                'symbol': opp.symbol,
                'direction': 'delta_neutral',
                'legs': [
                    {
                        'side': 'sell',  # Short perpetual
                        'exchange': opp.perp_exchange,
                        'notional': opp.position_size,
                        'instrument': 'perp'
                    },
                    {
                        'side': 'buy',   # Long spot
                        'exchange': opp.spot_exchange,
                        'notional': opp.position_size,
                        'instrument': 'spot'
                    }
                ],
                'funding_rate': opp.funding_rate,
                'annualized_yield': opp.annualized_yield,
                'net_yield_annual': opp.net_yield_annual,
                'expected_daily_profit': opp.expected_daily_profit,
                'position_size_usd': opp.position_size,
                'confidence': opp.confidence,
                'timestamp': opp.timestamp
            }
            
            signals.append(signal)
        
        return signals
    
    def get_funding_calendar(self, symbols: List[str],
                            funding_times: Dict[str, List[int]]) -> pd.DataFrame:
        """
        Get funding calendar for position timing.
        
        Shows when funding is paid for each symbol.
        """
        calendar = []
        now = datetime.now()
        
        for symbol in symbols:
            if symbol not in funding_times:
                continue
            
            hours = funding_times[symbol]
            for h in hours:
                funding_time = now.replace(hour=h, minute=0, second=0)
                if funding_time < now:
                    funding_time += timedelta(days=1)
                
                calendar.append({
                    'symbol': symbol,
                    'funding_time': funding_time,
                    'hours_until': (funding_time - now).total_seconds() / 3600
                })
        
        return pd.DataFrame(calendar).sort_values('funding_time')


if __name__ == "__main__":
    config = {
        'min_funding_rate': 0.0001,
        'min_annual_yield': 0.05,
        'max_position_size_usd': 50000,
        'capital': 100000
    }
    
    strategy = FundingArbitrageStrategy(config)
    
    # Example market data
    market_data = {
        'binance': {
            'BTCUSDT': {'spot': 45000, 'perp': 44950},  # Perp slightly cheaper
            'ETHUSDT': {'spot': 3000, 'perp': 2995}
        },
        'bybit': {
            'BTCUSDT': {'spot': 45010, 'perp': 44960},
            'ETHUSDT': {'spot': 3005, 'perp': 3000}
        }
    }
    
    # Example funding rates (positive = longs pay shorts)
    funding_rates = {
        'BTCUSDT': 0.0003,  # 0.03% per 8 hours
        'ETHUSDT': 0.0002   # 0.02% per 8 hours
    }
    
    # Scan for opportunities
    opps = strategy.scan_opportunities(market_data, funding_rates)
    
    print(f"\nFound {len(opps)} funding arbitrage opportunities:\n")
    for opp in opps[:3]:
        print(f"{opp.symbol}: Short {opp.perp_exchange} perp @ ${opp.perp_price:,.0f}")
        print(f"         Long {opp.spot_exchange} spot @ ${opp.spot_price:,.0f}")
        print(f"  Funding rate: {opp.funding_rate:.4%}")
        print(f"  Annual yield: {opp.annualized_yield:.1%}")
        print(f"  Net yield (after costs): {opp.net_yield_annual:.1%}")
        print(f"  Daily profit: ${opp.expected_daily_profit:.2f}")
        print(f"  Position size: ${opp.position_size:,.0f}")
        print()
    
    # Calculate what this means for capital
    if opps:
        opp = opps[0]
        annual_profit = opp.net_yield_annual * opp.position_size
        print(f"\nWith ${opp.position_size:,.0f}:")
        print(f"  Annual profit target: ${annual_profit:,.0f}")
        print(f"  Daily average: ${annual_profit/365:.2f}")
        print(f"  Sharpe estimate: ~{opp.net_yield_annual / 0.2:.1f}")  # Assuming 20% vol
