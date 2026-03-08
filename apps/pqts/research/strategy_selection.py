"""
Strategy Selection: Pick Top 3-4 Performers

Implements Grok's recommendation:
- Select top 3-4 strategies with Sharpe > 1.2, correlation < 0.4
- Pour 80% of effort into winners
- Stop running strategies that don't generalize
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)


@dataclass
class StrategyResult:
    """Container for strategy backtest results"""
    name: str
    returns: np.ndarray
    sharpe: float
    max_drawdown: float
    profit_factor: float
    win_rate: float
    avg_trade: float
    num_trades: int


class StrategySelector:
    """
    Selects top strategies for live trading.
    
    Criteria (Grok's recommendations):
    1. OOS Sharpe > 1.2
    2. Correlation < 0.4 with selected strategies
    3. Profit factor > 1.4
    4. Max drawdown < 15%
    5. Minimum 100 trades
    """
    
    def __init__(self,
                 min_sharpe: float = 1.2,
                 max_correlation: float = 0.4,
                 min_profit_factor: float = 1.4,
                 max_drawdown: float = 0.15,
                 min_trades: int = 100,
                 target_count: int = 4):
        """
        Args:
            min_sharpe: Minimum OOS Sharpe to qualify
            max_correlation: Max correlation with already-selected strategies
            min_profit_factor: Minimum profit factor
            max_drawdown: Maximum drawdown allowed
            min_trades: Minimum number of trades for statistical significance
            target_count: Target number of strategies to select
        """
        self.min_sharpe = min_sharpe
        self.max_correlation = max_correlation
        self.min_pf = min_profit_factor
        self.max_dd = max_drawdown
        self.min_trades = min_trades
        self.target_count = target_count
        
        self.selected = []
        self.rejected = []
    
    def select(self, results: List[StrategyResult]) -> List[StrategyResult]:
        """
        Select top strategies that meet criteria.
        
        Algorithm:
        1. Filter to strategies meeting minimum criteria
        2. Sort by Sharpe (descending)
        3. Greedy selection: pick strategy if correlation < 0.4 with all selected
        4. Stop at target_count or when no more uncorrelated strategies
        """
        logger.info(f"Selecting from {len(results)} strategies")
        
        # Step 1: Filter hard criteria
        qualified = self._filter_hard_criteria(results)
        logger.info(f"Passed hard criteria: {len(qualified)}")
        
        # Step 2: Sort by Sharpe
        qualified.sort(key=lambda x: x.sharpe, reverse=True)
        
        # Step 3: Greedy correlation-aware selection
        selected = []
        
        for strategy in qualified:
            if len(selected) >= self.target_count:
                break
            
            # Check correlation with all selected
            if self._is_uncorrelated(strategy, selected):
                selected.append(strategy)
                logger.info(f"✅ Selected: {strategy.name} "
                           f"(Sharpe={strategy.sharpe:.2f}, "
                           f"DD={strategy.max_drawdown:.1%})")
            else:
                self.rejected.append({
                    'strategy': strategy,
                    'reason': 'high_correlation'
                })
                logger.info(f"⏭️  Rejected: {strategy.name} (high correlation)")
        
        self.selected = selected
        
        logger.info(f"\n✅ FINAL: {len(selected)} strategies selected")
        for s in selected:
            logger.info(f"   - {s.name}: Sharpe={s.sharpe:.2f}")
        
        return selected
    
    def _filter_hard_criteria(self, results: List[StrategyResult]) -> List[StrategyResult]:
        """Filter to strategies meeting minimum thresholds."""
        qualified = []
        
        for r in results:
            passes = True
            reasons = []
            
            if r.sharpe < self.min_sharpe:
                passes = False
                reasons.append(f"Sharpe {r.sharpe:.2f} < {self.min_sharpe}")
            
            if r.profit_factor < self.min_pf:
                passes = False
                reasons.append(f"PF {r.profit_factor:.2f} < {self.min_pf}")
            
            if r.max_drawdown > self.max_dd:
                passes = False
                reasons.append(f"DD {r.max_drawdown:.1%} > {self.max_dd:.1%}")
            
            if r.num_trades < self.min_trades:
                passes = False
                reasons.append(f"Trades {r.num_trades} < {self.min_trades}")
            
            if passes:
                qualified.append(r)
            else:
                self.rejected.append({
                    'strategy': r,
                    'reason': ', '.join(reasons)
                })
                logger.info(f"❌ Rejected: {r.name} - {reasons}")
        
        return qualified
    
    def _is_uncorrelated(self, candidate: StrategyResult,
                      selected: List[StrategyResult]) -> bool:
        """Check if candidate has low correlation with all selected strategies."""
        if not selected:
            return True
        
        for s in selected:
            # Align returns (may be different lengths)
            min_len = min(len(candidate.returns), len(s.returns))
            corr = np.corrcoef(
                candidate.returns[:min_len],
                s.returns[:min_len]
            )[0, 1]
            
            if abs(corr) > self.max_correlation:
                return False
        
        return True
    
    def get_portfolio_stats(self, selected: List[StrategyResult],
                           equal_weight: bool = True) -> Dict:
        """
        Calculate expected portfolio stats if we run these strategies together.
        """
        if not selected:
            return {}
        
        # Equal weight or inverse-vol weight
        weights = self._compute_weights(selected, equal_weight)
        
        # Portfolio returns
        min_len = min(len(s.returns) for s in selected)
        portfolio_returns = np.zeros(min_len)
        
        for i, strategy in enumerate(selected):
            portfolio_returns += weights[i] * strategy.returns[:min_len]
        
        # Calculate metrics
        stats = {
            'n_strategies': len(selected),
            'weights': {s.name: w for s, w in zip(selected, weights)},
            'portfolio_sharpe': self._sharpe(portfolio_returns),
            'portfolio_cagr': self._cagr(portfolio_returns),
            'portfolio_max_dd': self._max_drawdown(portfolio_returns),
            'strategy_stats': [
                {
                    'name': s.name,
                    'sharpe': s.sharpe,
                    'weight': w,
                    'correlation_to_portfolio': np.corrcoef(
                        s.returns[:min_len],
                        portfolio_returns
                    )[0, 1]
                }
                for s, w in zip(selected, weights)
            ]
        }
        
        return stats
    
    def _compute_weights(self, strategies: List[StrategyResult],
                        equal_weight: bool) -> np.ndarray:
        """Compute strategy weights."""
        if equal_weight:
            return np.ones(len(strategies)) / len(strategies)
        
        # Inverse volatility weighting
        vols = np.array([np.std(s.returns) for s in strategies])
        inv_vols = 1 / vols
        return inv_vols / inv_vols.sum()
    
    def _sharpe(self, returns: np.ndarray) -> float:
        """Annualized Sharpe ratio."""
        mean = np.mean(returns)
        std = np.std(returns)
        if std == 0:
            return 0
        return mean / std * np.sqrt(252)
    
    def _cagr(self, returns: np.ndarray) -> float:
        """Compound annual growth rate."""
        total_return = np.prod(1 + returns) - 1
        years = len(returns) / 252
        return (1 + total_return) ** (1 / years) - 1
    
    def _max_drawdown(self, returns: np.ndarray) -> float:
        """Maximum drawdown."""
        cum = np.cumprod(1 + returns)
        running_max = np.maximum.accumulate(cum)
        drawdown = (cum - running_max) / running_max
        return abs(np.min(drawdown))
    
    def generate_report(self) -> str:
        """Generate human-readable selection report."""
        lines = [
            "=" * 70,
            "STRATEGY SELECTION REPORT",
            "=" * 70,
            "",
            f"Selection Criteria:",
            f"  Min Sharpe:       {self.min_sharpe}",
            f"  Max Correlation:  {self.max_correlation}",
            f"  Min Profit Factor: {self.min_pf}",
            f"  Max Drawdown:     {self.max_dd:.1%}",
            f"  Min Trades:       {self.min_trades}",
            f"  Target Count:     {self.target_count}",
            "",
            "SELECTED STRATEGIES:",
            "-" * 70
        ]
        
        for s in self.selected:
            lines.append(f"✅ {s.name}")
            lines.append(f"   Sharpe: {s.sharpe:.2f} | "
                        f"DD: {s.max_drawdown:.1%} | "
                        f"PF: {s.profit_factor:.2f} | "
                        f"Trades: {s.num_trades}")
            lines.append("")
        
        lines.extend([
            "-" * 70,
            "",
            "REJECTED STRATEGIES:",
            "-" * 70
        ])
        
        for r in self.rejected[:10]:  # Show first 10
            s = r['strategy'] if isinstance(r['strategy'], StrategyResult) else r.get('name', 'unknown')
            reason = r['reason']
            if isinstance(s, StrategyResult):
                lines.append(f"❌ {s.name}: {reason}")
            else:
                lines.append(f"❌ {s}: {reason}")
        
        if len(self.rejected) > 10:
            lines.append(f"... and {len(self.rejected) - 10} more")
        
        lines.append("=" * 70)
        
        return "\n".join(lines)


class LiveStrategyManager:
    """
    Manages live strategy portfolio.
    
    Handles:
    - Initial selection
    - Periodic reselection
    - Performance monitoring
    - Strategy retirement
    """
    
    def __init__(self, selector: StrategySelector):
        self.selector = selector
        self.live_strategies = []
        self.performance_history = []
        self.reselection_frequency_days = 30
    
    def is_reselection_due(self, last_reselection: pd.Timestamp) -> bool:
        """Check if we should re-run selection."""
        return (pd.Timestamp.now() - last_reselection).days >= self.reselection_frequency_days
    
    def retire_strategy(self, strategy_name: str, reason: str):
        """Retire a deteriorating strategy."""
        logger.warning(f"Retiring strategy {strategy_name}: {reason}")
        self.live_strategies = [
            s for s in self.live_strategies 
            if s.name != strategy_name
        ]


if __name__ == "__main__":
    # Test
    print("=" * 70)
    print("STRATEGY SELECTOR - TEST")
    print("=" * 70)
    
    # Create fake strategy results
    np.random.seed(42)
    
    strategies = [
        StrategyResult(
            name="Trend_Following",
            returns=np.random.randn(252) * 0.015 + 0.001,
            sharpe=1.35,
            max_drawdown=0.12,
            profit_factor=1.45,
            win_rate=0.52,
            avg_trade=0.001,
            num_trades=150
        ),
        StrategyResult(
            name="Mean_Reversion",
            returns=np.random.randn(252) * 0.012 + 0.0008,
            sharpe=1.42,
            max_drawdown=0.08,
            profit_factor=1.55,
            win_rate=0.54,
            avg_trade=0.0008,
            num_trades=200
        ),
        StrategyResult(
            name="Market_Making",
            returns=np.random.randn(252) * 0.010 + 0.0003,
            sharpe=1.15,
            max_drawdown=0.05,
            profit_factor=1.38,
            win_rate=0.51,
            avg_trade=0.0005,
            num_trades=500
        ),
        StrategyResult(
            name="Momentum",
            returns=np.random.randn(252) * 0.018 + 0.0005,
            sharpe=1.55,
            max_drawdown=0.14,
            profit_factor=1.68,
            win_rate=0.53,
            avg_trade=0.0012,
            num_trades=120
        ),
        StrategyResult(
            name="Dead_Strategy",
            returns=np.random.randn(252) * 0.02 - 0.001,
            sharpe=0.45,
            max_drawdown=0.25,
            profit_factor=0.95,
            win_rate=0.42,
            avg_trade=-0.002,
            num_trades=80
        )
    ]
    
    # Make some strategies correlated
    strategies[0].returns = strategies[1].returns * 0.3 + np.random.randn(252) * 0.01 + 0.001
    
    # Select
    selector = StrategySelector(
        min_sharpe=1.2,
        max_correlation=0.4,
        target_count=3
    )
    
    selected = selector.select(strategies)
    
    # Show report
    print(selector.generate_report())
    
    # Portfolio stats
    print("\n" + "=" * 70)
    print("PORTFOLIO PROJECTION")
    print("=" * 70)
    
    stats = selector.get_portfolio_stats(selected)
    print(f"\nExpected Portfolio:")
    print(f"  Sharpe:     {stats['portfolio_sharpe']:.2f}")
    print(f"  CAGR:       {stats['portfolio_cagr']:.1%}")
    print(f"  Max DD:     {stats['portfolio_max_dd']:.1%}")
    print(f"\nAllocation:")
    for name, weight in stats['weights'].items():
        print(f"  {name}: {weight:.1%}")
    
    print("\n" + "=" * 70)
    print("Strategy selector ready for production!")
    print("=" * 70)
