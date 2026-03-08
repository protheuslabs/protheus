# Statistical Arbitrage Strategy
import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime
from scipy import stats

logger = logging.getLogger(__name__)

@dataclass
class PairTrade:
    symbol_a: str
    symbol_b: str
    z_score: float
    hedge_ratio: float
    spread: float
    confidence: float
    signal_type: str  # 'long_spread' or 'short_spread'
    expected_return: float

class StatisticalArbitrage:
    """
    Statistical arbitrage using cointegrated pairs.
    
    Edge sources:
    - Mean-reversion of cointegrated pairs
    - Sector-neutral market exposure
    - Cross-asset correlation arbitrage
    
    Key insight: Pairs trading has been crowded but still works in
    crypto due to lower institutional participation.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.lookback_days = config.get('lookback_days', 30)
        self.min_correlation = config.get('min_correlation', 0.7)
        self.entry_zscore = config.get('entry_zscore', 2.0)
        self.exit_zscore = config.get('exit_zscore', 0.5)
        self.half_life_max = config.get('half_life_max', 10)  # Days
        self.min_half_life = config.get('min_half_life', 1)  # Days
        
        # Position sizing
        self.max_position_size = config.get('max_position_size', 1000)
        self.position_timeout_hours = config.get('position_timeout_hours', 72)
        
        # State
        self.active_pairs: Dict[Tuple[str, str], Dict] = {}
        self.pair_statistics: Dict[Tuple[str, str], Dict] = {}
        
        logger.info(f"StatisticalArbitrage initialized: entry_z={self.entry_zscore}")
    
    def find_cointegrated_pairs(self, price_data: Dict[str, pd.DataFrame],
                               symbols: List[str] = None) -> List[Tuple[str, str]]:
        """
        Find cointegrated pairs from price history.
        
        Uses Engle-Granger two-step cointegration test.
        """
        if symbols is None:
            symbols = list(price_data.keys())
        
        cointegrated = []
        
        for i, sym_a in enumerate(symbols):
            for sym_b in symbols[i+1:]:
                if sym_a not in price_data or sym_b not in price_data:
                    continue
                
                # Get overlapping data
                df_a = price_data[sym_a]['close']
                df_b = price_data[sym_b]['close']
                
                # Align and drop NaN
                common_index = df_a.index.intersection(df_b.index)
                if len(common_index) < 100:
                    continue
                
                series_a = df_a.loc[common_index]
                series_b = df_b.loc[common_index]
                
                if len(series_a) < self.lookback_days * 24:
                    continue
                
                # Calculate correlation
                corr = series_a.corr(series_b)
                if corr < self.min_correlation:
                    continue
                
                # Engle-Granger cointegration test (simplified)
                # Regress A on B and test residuals for stationarity
                hedge_ratio = self._calculate_hedge_ratio(series_a, series_b)
                spread = series_a - hedge_ratio * series_b
                
                # ADF-like test on spread (simplified)
                is_stationary, half_life = self._test_stationarity(spread)
                
                if is_stationary and self.min_half_life <= half_life <= self.half_life_max:
                    pair_key = (sym_a, sym_b)
                    
                    self.pair_statistics[pair_key] = {
                        'correlation': corr,
                        'hedge_ratio': hedge_ratio,
                        'half_life': half_life,
                        'mean_spread': spread.mean(),
                        'std_spread': spread.std(),
                        'lookback_end': series_a.index[-1]
                    }
                    
                    cointegrated.append(pair_key)
                    
                    logger.info(f"Found cointegrated pair: {sym_a}/{sym_b} "
                               f"(corr={corr:.3f}, half_life={half_life:.1f}d)")
        
        logger.info(f"Found {len(cointegrated)} cointegrated pairs")
        return cointegrated
    
    def calculate_z_score(self, pair: Tuple[str, str],
                         price_data: Dict[str, pd.DataFrame]) -> Optional[PairTrade]:
        """
        Calculate current z-score for a pair.
        """
        sym_a, sym_b = pair
        
        if pair not in self.pair_statistics:
            return None
        
        stats = self.pair_statistics[pair]
        
        # Get current prices
        if sym_a not in price_data or sym_b not in price_data:
            return None
        
        price_a = price_data[sym_a]['close'].iloc[-1]
        price_b = price_data[sym_b]['close'].iloc[-1]
        
        # Calculate spread
        spread = price_a - stats['hedge_ratio'] * price_b
        
        # Calculate z-score
        z_score = (spread - stats['mean_spread']) / stats['std_spread'] if stats['std_spread'] > 0 else 0
        
        # Determine signal
        if z_score > self.entry_zscore:
            signal_type = 'short_spread'  # A expensive vs B
            expected_return = -z_score * stats['std_spread'] / price_a
        elif z_score < -self.entry_zscore:
            signal_type = 'long_spread'  # A cheap vs B
            expected_return = -z_score * stats['std_spread'] / price_a
        else:
            return None
        
        # Confidence based on z-score
        confidence = min(abs(z_score) / 4.0, 0.95)
        
        return PairTrade(
            symbol_a=sym_a,
            symbol_b=sym_b,
            z_score=z_score,
            hedge_ratio=stats['hedge_ratio'],
            spread=spread,
            confidence=confidence,
            signal_type=signal_type,
            expected_return=expected_return
        )
    
    def generate_signals(self, price_data: Dict[str, pd.DataFrame],
                        pairs: List[Tuple[str, str]] = None) -> List[PairTrade]:
        """
        Generate statistical arbitrage signals.
        """
        if pairs is None:
            pairs = list(self.pair_statistics.keys())
        
        signals = []
        
        for pair in pairs:
            trade = self.calculate_z_score(pair, price_data)
            if trade:
                # Check if already in position
                if pair in self.active_pairs:
                    continue  # Already trading this pair
                
                signals.append(trade)
        
        # Sort by absolute z-score
        signals.sort(key=lambda x: abs(x.z_score), reverse=True)
        
        logger.info(f"Generated {len(signals)} statistical arbitrage signals")
        return signals[:10]  # Top 10 only
    
    def check_exit_signals(self, pair: Tuple[str, str],
                          price_data: Dict[str, pd.DataFrame],
                          current_pnl: float = 0) -> bool:
        """
        Check if we should exit a pair trade.
        """
        if pair not in self.active_pairs:
            return False
        
        sym_a, sym_b = pair
        
        # Recalculate z-score
        trade = self.calculate_z_score(pair, price_data)
        
        if trade is None:
            # Z-score returned to normal
            return True
        
        # Exit on z-score mean reversion
        if abs(trade.z_score) < self.exit_zscore:
            logger.info(f"Exit {pair}: z-score={trade.z_score:.2f} returned to mean")
            return True
        
        # Stop loss: z-score continued to widen
        if trade.signal_type == self.active_pairs[pair].get('signal_type'):
            if abs(trade.z_score) > self.entry_zscore * 1.5:
                logger.warning(f"Exit {pair}: z-score widened to {trade.z_score:.2f}")
                return True
        
        return False
    
    def _calculate_hedge_ratio(self, series_a: pd.Series,
                               series_b: pd.Series) -> float:
        """
        Calculate hedge ratio via OLS regression.
        """
        # Simple hedge ratio: price levels regression
        x = series_b.values.reshape(-1, 1)
        y = series_a.values
        
        # Add constant
        x_with_const = np.column_stack([np.ones(len(x)), x])
        
        # OLS
        beta = np.linalg.lstsq(x_with_const, y, rcond=None)[0][1]
        
        return beta
    
    def _test_stationarity(self, series: pd.Series) -> Tuple[bool, float]:
        """
        Simplified ADF-like stationarity test on spread.
        
        Returns:
            is_stationary: bool
            half_life: float (mean reversion speed)
        """
        # Calculate half-life via OU process regression
        # delta_y(t) = lambda * y(t-1) + mu + epsilon
        
        y_lag = series.shift(1).dropna()
        delta_y = series.diff().dropna().iloc[1:]
        
        if len(delta_y) < 10:
            return False, float('inf')
        
        # Regress delta_y on y_lag
        x = y_lag.values.reshape(-1, 1)
        y = delta_y.values
        
        beta = np.linalg.lstsq(x, y, rcond=None)[0][0]
        
        # Half-life = -ln(2) / beta
        if beta < 0:  # Mean reverting
            half_life = -np.log(2) / beta
            is_stationary = True
        else:
            half_life = float('inf')
            is_stationary = False
        
        return is_stationary, half_life
    
    def get_trade_execution(self, signal: PairTrade,
                         capital: float = 10000) -> Dict:
        """
        Convert signal to execution parameters.
        """
        # Equal dollar amounts on both legs
        leg_a_size = capital / 2
        leg_b_size = capital / 2
        
        # Determine directions
        if signal.signal_type == 'long_spread':
            # Long A, Short B
            side_a = 'buy'
            side_b = 'sell'
        else:
            # Short A, Long B
            side_a = 'sell'
            side_b = 'buy'
        
        return {
            'type': 'pair_trade',
            'symbol_a': signal.symbol_a,
            'symbol_b': signal.symbol_b,
            'side_a': side_a,
            'side_b': side_b,
            'size_a': leg_a_size / signal.z_score,  # Size inversely proportional to conviction
            'size_b': leg_a_size * signal.hedge_ratio / signal.z_score,
            'hedge_ratio': signal.hedge_ratio,
            'z_score': signal.z_score,
            'expected_return': signal.expected_return,
            'confidence': signal.confidence
        }


if __name__ == "__main__":
    config = {
        'lookback_days': 30,
        'min_correlation': 0.7,
        'entry_zscore': 2.0,
        'exit_zscore': 0.5,
        'half_life_max': 10
    }
    
    stat_arb = StatisticalArbitrage(config)
    
    # Generate synthetic price data
    dates = pd.date_range('2024-01-01', periods=720, freq='h')
    
    # Create cointegrated pair
    base = np.cumsum(np.random.randn(720) * 0.001) + 100
    cointegrated = base * 0.5 + np.random.randn(720) * 0.5
    
    price_data = {
        'BTCUSDT': pd.DataFrame({
            'close': 100 + np.cumsum(np.random.randn(720) * 0.01)
        }, index=dates),
        'ETHUSDT': pd.DataFrame({
            'close': 10 + np.cumsum(np.random.randn(720) * 0.005)
        }, index=dates),
        'BTC_PERP': pd.DataFrame({
            'close': base
        }, index=dates),
        'BTC_SPOT': pd.DataFrame({
            'close': cointegrated * 2
        }, index=dates)
    }
    
    # Find cointegrated pairs
    pairs = stat_arb.find_cointegrated_pairs(price_data)
    
    # Generate signals
    signals = stat_arb.generate_signals(price_data, pairs)
    
    print(f"\nFound {len(pairs)} cointegrated pairs")
    print(f"\nGenerated {len(signals)} trade signals:\n")
    
    for signal in signals[:3]:
        print(f"{signal.symbol_a}/{signal.symbol_b}: z={signal.z_score:.2f}, "
              f"type={signal.signal_type}, expected_return={signal.expected_return*100:.2f}%")
