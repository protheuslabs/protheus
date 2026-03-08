# Cross-Exchange Arbitrage Strategy
import logging
import asyncio
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

@dataclass
class ArbitrageOpportunity:
    symbol: str
    buy_exchange: str
    sell_exchange: str
    buy_price: float
    sell_price: float
    spread: float  # pct
    spread_bps: float
    profit_after_fees: float
    size: float
    timestamp: datetime
    latency_estimate_ms: float

class CrossExchangeArbitrage:
    """
    Cross-exchange arbitrage strategy.
    
    Identifies price discrepancies across exchanges and executes
    simultaneous buy/sell for risk-free profit (minus fees).
    
    Key edge: Small players can still compete in cross-exchange arb
    because it requires capital across multiple venues, which larger
    players may not optimize for.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.min_spread_bps = config.get('min_spread_bps', 50)  # 0.5%
        self.min_profit_bps = config.get('min_profit_bps', 20)  # 0.2%
        self.max_position_size = config.get('max_position_size', 1000)
        
        # Fee schedule
        self.fee_rates = config.get('fee_rates', {
            'binance': {'maker': 0.001, 'taker': 0.001},
            'coinbase': {'maker': 0.005, 'taker': 0.006},
            'kraken': {'maker': 0.0016, 'taker': 0.0026},
            'bybit': {'maker': 0.001, 'taker': 0.001}
        })
        
        # Latency estimates
        self.latency_estimates = config.get('latency_ms', {
            'binance': 150,
            'coinbase': 200,
            'kraken': 300,
            'bybit': 180
        })
        
        # Track opportunities
        self.opportunities: List[ArbitrageOpportunity] = []
        self.trade_history: List[Dict] = []
        
        logger.info(f"CrossExchangeArbitrage initialized: min_spread={self.min_spread_bps}bps")
    
    def scan_opportunities(self, exchange_data: Dict[str, Dict],
                          symbols: List[str] = None) -> List[ArbitrageOpportunity]:
        """
        Scan for arbitrage opportunities across exchanges.
        
        Args:
            exchange_data: Dict of {exchange_name: {symbol: market_data}}
            symbols: List of symbols to scan (None = all available)
        """
        opportunities = []
        
        # Get all symbols if not specified
        if symbols is None:
            symbols = set()
            for ex_data in exchange_data.values():
                symbols.update(ex_data.keys())
            symbols = list(symbols)
        
        for symbol in symbols:
            # Collect prices from all exchanges
            prices = {}
            for exchange, data in exchange_data.items():
                if symbol in data:
                    prices[exchange] = {
                        'bid': data[symbol].get('bid', 0),
                        'ask': data[symbol].get('ask', 0),
                        'volume': data[symbol].get('volume', 0)
                    }
            
            # Check all pairs
            for buy_ex in prices:
                for sell_ex in prices:
                    if buy_ex == sell_ex:
                        continue
                    
                    buy_price = prices[buy_ex]['ask']
                    sell_price = prices[sell_ex]['bid']
                    
                    if buy_price <= 0 or sell_price <= 0:
                        continue
                    
                    # Calculate spread
                    spread = sell_price - buy_price
                    spread_pct = spread / buy_price
                    spread_bps = spread_pct * 10000
                    
                    # Calculate fees
                    buy_fee = buy_price * self.fee_rates.get(buy_ex, {}).get('taker', 0.001)
                    sell_fee = sell_price * self.fee_rates.get(sell_ex, {}).get('taker', 0.001)
                    total_fees = buy_fee + sell_fee
                    
                    # Calculate profit after fees
                    profit_bps = spread_bps - (total_fees / buy_price * 10000)
                    
                    if spread_bps >= self.min_spread_bps and profit_bps >= self.min_profit_bps:
                        opp = ArbitrageOpportunity(
                            symbol=symbol,
                            buy_exchange=buy_ex,
                            sell_exchange=sell_ex,
                            buy_price=buy_price,
                            sell_price=sell_price,
                            spread=spread_pct,
                            spread_bps=spread_bps,
                            profit_after_fees=profit_bps,
                            size=self.max_position_size,
                            timestamp=datetime.now(),
                            latency_estimate_ms=(
                                self.latency_estimates.get(buy_ex, 200) +
                                self.latency_estimates.get(sell_ex, 200)
                            )
                        )
                        opportunities.append(opp)
        
        # Sort by profit
        opportunities.sort(key=lambda x: x.profit_after_fees, reverse=True)
        
        self.opportunities = opportunities
        logger.info(f"Found {len(opportunities)} arbitrage opportunities")
        
        return opportunities
    
    def calculate_edge_stability(self, historical_spreads: pd.DataFrame,
                                symbol: str,
                                lookback_hours: int = 24) -> Dict:
        """
        Calculate how stable an arbitrage edge has been historically.
        Stable edges are more profitable (less competitive).
        """
        if symbol not in historical_spreads.columns:
            return {'edge_exists': False}
        
        spreads = historical_spreads[symbol].tail(lookback_hours * 60)
        
        if len(spreads) == 0:
            return {'edge_exists': False}
        
        # Calculate metrics
        mean_spread = spreads.mean()
        std_spread = spreads.std()
        min_spread = spreads.min()
        max_spread = spreads.max()
        
        # Percentage of time spread is profitable
        profitable_pct = (spreads > self.min_profit_bps).mean()
        
        # Decay analysis: is the edge disappearing?
        if len(spreads) > 60:
            first_hour = spreads.head(60).mean()
            last_hour = spreads.tail(60).mean()
            decay_rate = (last_hour - first_hour) / first_hour if first_hour > 0 else 0
        else:
            decay_rate = 0
        
        return {
            'edge_exists': mean_spread > self.min_profit_bps,
            'mean_spread_bps': mean_spread,
            'std_spread_bps': std_spread,
            'min_spread_bps': min_spread,
            'max_spread_bps': max_spread,
            'profitable_duration_pct': profitable_pct,
            'edge_decay_rate': decay_rate,
            'edge_quality': 'high' if profitable_pct > 0.7 and decay_rate > -0.1 else
                           'medium' if profitable_pct > 0.4 else 'low'
        }
    
    def filter_viable_opportunities(self, opportunities: List[ArbitrageOpportunity],
                                    capital_by_exchange: Dict[str, float]) -> List[ArbitrageOpportunity]:
        """
        Filter opportunities based on capital availability and edge quality.
        """
        viable = []
        
        for opp in opportunities:
            # Check capital on both sides
            buy_capital = capital_by_exchange.get(opp.buy_exchange, 0)
            sell_capital = capital_by_exchange.get(opp.sell_exchange, 0)
            
            buy_requirement = opp.buy_price * opp.size
            sell_requirement = opp.sell_price * opp.size
            
            if buy_capital >= buy_requirement and sell_capital >= sell_requirement:
                viable.append(opp)
        
        logger.info(f"Viable opportunities: {len(viable)} / {len(opportunities)}")
        return viable
    
    def simulate_execution(self, opportunity: ArbitrageOpportunity,
                          fill_probability: float = 0.95) -> Dict:
        """
        Simulate execution of arbitrage trade with realistic fill assumptions.
        """
        symbol = opportunity.symbol
        
        # Expected fill
        filled_buy = np.random.random() < fill_probability
        filled_sell = np.random.random() < fill_probability
        
        if filled_buy and filled_sell:
            # Successful arbitrage
            gross_profit = (opportunity.sell_price - opportunity.buy_price) * opportunity.size
            fees = (opportunity.buy_price * self.fee_rates[opportunity.buy_exchange]['taker'] +
                   opportunity.sell_price * self.fee_rates[opportunity.sell_exchange]['taker']) * opportunity.size
            net_profit = gross_profit - fees
            
            return {
                'success': True,
                'gross_profit': gross_profit,
                'fees': fees,
                'net_profit': net_profit,
                'return_pct': net_profit / (opportunity.buy_price * opportunity.size) * 100
            }
        else:
            # Partial or failed fill - risk
            realized_loss = 0
            if filled_buy and not filled_sell:
                # Stuck with long position
                realized_loss = 0  # Unrealized until sold
            elif filled_sell and not filled_buy:
                # Stuck with short position
                realized_loss = 0
            
            return {
                'success': False,
                'reason': 'partial_fill',
                'filled_buy': filled_buy,
                'filled_sell': filled_sell
            }
    
    def generate_signals(self, opportunities: List[ArbitrageOpportunity]) -> List[Dict]:
        """Convert opportunities to trading signals"""
        signals = []
        
        for opp in opportunities[:5]:  # Top 5 only
            signal = {
                'type': 'arbitrage',
                'symbol': opp.symbol,
                'side': 'cross_exchange',
                'buy_exchange': opp.buy_exchange,
                'sell_exchange': opp.sell_exchange,
                'buy_price': opp.buy_price,
                'sell_price': opp.sell_price,
                'size': opp.size,
                'expected_profit_bps': opp.profit_after_fees,
                'confidence': min(opp.profit_after_fees / 100, 0.95),
                'urgency': 'high' if opp.profit_after_fees > 50 else 'medium',
                'timestamp': opp.timestamp
            }
            signals.append(signal)
        
        return signals


if __name__ == "__main__":
    config = {
        'min_spread_bps': 50,
        'min_profit_bps': 20,
        'max_position_size': 1.0
    }
    
    arb = CrossExchangeArbitrage(config)
    
    # Simulate exchange data
    exchange_data = {
        'binance': {
            'BTCUSDT': {'bid': 45000, 'ask': 45005, 'volume': 1000},
            'ETHUSDT': {'bid': 3000, 'ask': 3002, 'volume': 5000}
        },
        'coinbase': {
            'BTCUSDT': {'bid': 45020, 'ask': 45030, 'volume': 800},
            'ETHUSDT': {'bid': 2995, 'ask': 2998, 'volume': 4000}
        },
        'kraken': {
            'BTCUSDT': {'bid': 45000, 'ask': 45015, 'volume': 500},
            'ETHUSDT': {'bid': 3005, 'ask': 3008, 'volume': 3000}
        }
    }
    
    # Scan for opportunities
    opps = arb.scan_opportunities(exchange_data)
    
    print(f"\nFound {len(opps)} arbitrage opportunities:\n")
    for opp in opps[:5]:
        print(f"{opp.symbol}: Buy @ {opp.buy_exchange} (${opp.buy_price:,.2f}) "
              f"→ Sell @ {opp.sell_exchange} (${opp.sell_price:,.2f})")
        print(f"  Spread: {opp.spread_bps:.1f} bps | Profit after fees: {opp.profit_after_fees:.1f} bps")
        print()
