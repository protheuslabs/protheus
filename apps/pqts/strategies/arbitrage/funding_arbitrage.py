# Funding Rate Arbitrage (Crypto Perpetuals)
import logging
import asyncio
from typing import List, Dict, Optional
from dataclasses import dataclass
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

@dataclass
class FundingRate:
    exchange: str
    symbol: str
    rate: float  # Funding rate (e.g., 0.0001 = 0.01%)
    next_funding_time: datetime
    predicted_rate: Optional[float] = None

@dataclass
class FundingArbitrageOpportunity:
    symbol: str
    spot_exchange: str
    perp_exchange: str
    funding_rate: float
    spread: float
    annualized_return: float
    hours_to_funding: float
    confidence: float

class FundingRateArbitrage:
    """
    Exploits funding rate differences between spot and perpetual markets.
    
    Strategy:
    - When funding is positive (longs pay shorts):
      Buy spot, short perpetual → collect funding
    - When funding is negative (shorts pay longs):
      Sell spot, long perpetual → collect funding
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.enabled = config.get('enabled', False)
        self.min_funding_rate = config.get('min_funding_rate', 0.0001)  # 0.01%
        self.min_annualized_return = config.get('min_annualized_return', 0.10)  # 10%
        self.max_hold_hours = config.get('max_hold_hours', 8)  # Funding every 8h on most exchanges
        
        # Track funding rates
        self.funding_rates: Dict[str, List[FundingRate]] = {}
        self.historical_rates: Dict[str, List[float]] = {}
        
        logger.info(f"FundingRateArbitrage initialized: min_rate={self.min_funding_rate}")
    
    async def update_funding_rates(self, exchange: str, rates: List[Dict]):
        """Update funding rates from exchange"""
        if exchange not in self.funding_rates:
            self.funding_rates[exchange] = []
        
        for rate_data in rates:
            symbol = rate_data['symbol']
            rate = rate_data['fundingRate']
            next_time = datetime.fromtimestamp(rate_data['fundingTime'] / 1000)
            
            funding = FundingRate(
                exchange=exchange,
                symbol=symbol,
                rate=float(rate),
                next_funding_time=next_time,
                predicted_rate=rate_data.get('predictedRate')
            )
            
            # Update storage
            self.funding_rates[exchange] = [
                f for f in self.funding_rates[exchange] 
                if not (f.symbol == symbol)
            ]
            self.funding_rates[exchange].append(funding)
            
            # Track historical
            if symbol not in self.historical_rates:
                self.historical_rates[symbol] = []
            self.historical_rates[symbol].append(float(rate))
            
            # Keep last 100 rates
            if len(self.historical_rates[symbol]) > 100:
                self.historical_rates[symbol] = self.historical_rates[symbol][-100:]
    
    async def find_opportunities(self, spot_prices: Dict, perp_prices: Dict) -> List[FundingArbitrageOpportunity]:
        """Find funding rate arbitrage opportunities"""
        if not self.enabled:
            return []
        
        opportunities = []
        
        for exchange, rates in self.funding_rates.items():
            for funding in rates:
                symbol = funding.symbol
                
                # Check if we have price data
                spot_price = spot_prices.get(symbol)
                perp_price = perp_prices.get(symbol)
                
                if not spot_price or not perp_price:
                    continue
                
                # Calculate spread
                spread = abs(perp_price - spot_price) / spot_price
                
                # Calculate hours to next funding
                hours_to_funding = (funding.next_funding_time - datetime.utcnow()).total_seconds() / 3600
                
                if hours_to_funding <= 0 or hours_to_funding > self.max_hold_hours:
                    continue
                
                # Calculate annualized return
                periods_per_year = 365 * 3   # 3 funding periods per day
                annualized = funding.rate * periods_per_year
                
                # Account for spread cost
                net_return = annualized - (spread * periods_per_year)
                
                # Check if opportunity meets criteria
                if abs(funding.rate) >= self.min_funding_rate and net_return >= self.min_annualized_return:
                    opportunity = FundingArbitrageOpportunity(
                        symbol=symbol,
                        spot_exchange=exchange,  # Simplified - assumes same exchange
                        perp_exchange=exchange,
                        funding_rate=funding.rate,
                        spread=spread,
                        annualized_return=net_return,
                        hours_to_funding=hours_to_funding,
                        confidence=self._calculate_confidence(funding)
                    )
                    opportunities.append(opportunity)
        
        # Sort by annualized return
        opportunities.sort(key=lambda x: x.annualized_return, reverse=True)
        
        return opportunities
    
    def _calculate_confidence(self, funding: FundingRate) -> float:
        """Calculate confidence score for opportunity"""
        confidence = 0.5
        
        # Higher confidence if rate is extreme
        if abs(funding.rate) > 0.001:  # >0.1%
            confidence += 0.2
        
        # Higher confidence if predicted rate aligns
        if funding.predicted_rate:
            if funding.rate * funding.predicted_rate > 0:  # Same direction
                confidence += 0.2
        
        # Check historical context
        symbol = funding.symbol
        if symbol in self.historical_rates and len(self.historical_rates[symbol]) > 10:
            hist = self.historical_rates[symbol]
            avg_rate = sum(hist) / len(hist)
            
            # Higher confidence if current rate is extreme vs history
            if abs(funding.rate) > abs(avg_rate) * 2:
                confidence += 0.1
        
        return min(confidence, 1.0)
    
    async def execute_arbitrage(self, opportunity: FundingArbitrageOpportunity) -> bool:
        """Execute funding rate arbitrage trade"""
        logger.info(f"Executing funding arbitrage: {opportunity}")
        
        try:
            if opportunity.funding_rate > 0:
                # Positive funding: Buy spot, short perpetual
                # Longs pay shorts, so we collect funding as short
                logger.info(f"Strategy: Long spot, Short perp for {opportunity.symbol}")
                # Execute: Buy spot, Sell perpetual
            else:
                # Negative funding: Sell spot, long perpetual
                # Shorts pay longs, so we collect funding as long
                logger.info(f"Strategy: Short spot, Long perp for {opportunity.symbol}")
                # Execute: Sell spot, Buy perpetual
            
            return True
            
        except Exception as e:
            logger.error(f"Funding arbitrage execution failed: {e}")
            return False
    
    def get_funding_summary(self) -> Dict:
        """Get summary of funding rates across markets"""
        summary = {}
        
        for exchange, rates in self.funding_rates.items():
            summary[exchange] = {
                'count': len(rates),
                'avg_rate': sum(f.rate for f in rates) / len(rates) if rates else 0,
                'max_rate': max((f.rate for f in rates), default=0),
                'min_rate': min((f.rate for f in rates), default=0),
                'extreme_rates': [
                    {'symbol': f.symbol, 'rate': f.rate} 
                    for f in rates 
                    if abs(f.rate) > 0.001
                ]
            }
        
        return summary
