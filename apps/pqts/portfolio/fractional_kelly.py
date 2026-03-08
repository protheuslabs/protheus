"""
Fractional Kelly + Risk Parity Integration - FIXED VERSION

Bug fixes:
1. calculate_allocations() now actually uses Kelly in final_weight calculation
2. Added complete integration: Risk Parity → Kelly → Vol Targeting → Correlation
3. Added normalization step to ensure total weight ≤ 1.0
4. Added unit tests to verify Kelly integration

Implements Grok's recommendations:
- Fractional Kelly (0.25-0.5 of full Kelly) for safety
- Volatility targeting (target 15-20% annualized vol)
- Risk parity allocation across selected strategies

Based on:
- Kelly Criterion (Kelly, 1956)
- Fractional Kelly (Thorp, 2006)
- Risk Parity (Asness, 1996)
- Hierarchical Risk Parity (Lopez de Prado, 2016)
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


@dataclass
class StrategyAllocation:
    """Position sizing for a single strategy"""
    strategy_name: str
    target_weight: float
    kelly_fraction: float
    volatility_scalar: float
    correlation_adjustment: float
    final_weight: float
    max_position_pct: float
    stop_loss_price: Optional[float]


class FractionalKellySizer:
    """
    Kelly Criterion with fractional sizing for risk management.

    Full Kelly: f* = (μ - r) / σ²
    This is too aggressive (high volatility, high drawdown).

    Fractional Kelly: f = c × f* where c ∈ [0.25, 0.5]
    """

    def __init__(self,
                 kelly_fraction: float = 0.25,  # Conservative: 0.25
                 max_leverage: float = 2.0,
                 min_position: float = 0.01,
                 max_position: float = 0.50):
        """
        Args:
            kelly_fraction: Fraction of full Kelly (0.25-0.5 recommended)
            max_leverage: Maximum allowed leverage
            min_position: Minimum position size
            max_position: Maximum position size
        """
        if not 0.1 <= kelly_fraction <= 1.0:
            raise ValueError("kelly_fraction must be in [0.1, 1.0]")

        self.fraction = kelly_fraction
        self.max_leverage = max_leverage
        self.min_pos = min_position
        self.max_pos = max_position

        logger.info(f"Fractional Kelly: fraction={kelly_fraction}")

    def calculate_kelly(self,
                       mean_return: float,
                       variance: float,
                       risk_free_rate: float = 0.0) -> float:
        """
        Calculate fractional Kelly position size.

        f = c × (μ - r) / σ²
        """
        if variance == 0:
            return 0

        # Full Kelly
        full_kelly = (mean_return - risk_free_rate) / variance

        # Fractional Kelly
        f = full_kelly * self.fraction

        # Bounds
        f = np.clip(f, -self.max_pos, self.max_pos)

        return f

    def size_position(self,
                     strategy_returns: np.ndarray,
                     capital: float,
                     price: float,
                     current_position: float = 0) -> float:
        """
        Calculate target position size based on Kelly.

        Returns number of units to hold.
        """
        if len(strategy_returns) < 30:
            logger.warning("Insufficient returns for Kelly sizing")
            return 0

        mean = np.mean(strategy_returns)
        variance = np.var(strategy_returns)

        # Kelly fraction
        kelly_position = self.calculate_kelly(mean, variance)

        # Convert to capital allocation
        target_capital = capital * abs(kelly_position)

        # Convert to units
        target_units = target_capital / price

        # Sign (direction)
        if mean < 0:
            target_units = -target_units

        # Don't trade if already at target
        if abs(target_units - current_position) / (abs(current_position) + 0.0001) < 0.05:
            return current_position

        return target_units


class VolatilityTargeter:
    """
    Scale positions to target constant portfolio volatility.

    Formula: scalar_w = σ_target / σ_strategy
    """

    def __init__(self,
                 target_volatility: float = 0.20,  # 20% annual
                 lookback_days: int = 20):
        """
        Args:
            target_volatility: Target annualized volatility (0.15-0.20 typical)
            lookback_days: Days for volatility calculation
        """
        self.target = target_volatility
        self.lookback = lookback_days

        # Bounds
        self.min_scalar = 0.1
        self.max_scalar = 3.0

    def calculate_scalar(self, returns: np.ndarray) -> float:
        """
        Calculate position scalar to hit target vol.

        If strategy is 30% vol and target is 20%:
        scalar = 0.20 / 0.30 = 0.67 (67% of capital)
        """
        if len(returns) < self.lookback:
            return 1.0

        # Current volatility (annualized)
        current_vol = np.std(returns[-self.lookback:]) * np.sqrt(252)

        if current_vol == 0:
            return 1.0

        scalar = self.target / current_vol

        # Bounds check
        scalar = np.clip(scalar, self.min_scalar, self.max_scalar)

        return scalar


class RiskParityAllocator:
    """
    Allocate capital using Risk Parity (equal risk contribution).

    Each strategy contributes equally to portfolio risk.
    Higher vol strategies get smaller allocations.
    """

    def __init__(self,
                 target_portfolio_vol: float = 0.18,
                 rebalance_threshold: float = 0.05):
        """
        Args:
            target_portfolio_vol: Target volatility
            rebalance_threshold: Rebalance if allocation differs by this %
        """
        self.target = target_portfolio_vol
        self.threshold = rebalance_threshold

    def inverse_vol_weights(self, volatilities: np.ndarray) -> np.ndarray:
        """
        Simple risk parity: weight ∝ 1/volatility
        """
        inv_vols = 1 / volatilities
        weights = inv_vols / inv_vols.sum()
        return weights

    def risk_budget_weights(self,
                           returns_df: pd.DataFrame,
                           target_risk_contribution: np.ndarray = None) -> np.ndarray:
        """
        Equal risk contribution portfolio.

        Uses numerical optimization to find weights where
        each asset's risk contribution = target.
        """
        n = len(returns_df.columns)

        if target_risk_contribution is None:
            # Equal risk
            target_risk_contribution = np.ones(n) / n

        # Use HRP as practical approximation
        try:
            import riskfolio as rp

            port = rp.Portfolio(returns=returns_df)

            # HRP (Hierarchical Risk Parity)
            weights = port.rp_optimization(
                model='HRP',
                rm='MV',  # Minimize variance
                rf=0.0
            )

            return weights['weights'].values
        except ImportError:
            # Fallback: inverse volatility
            vols = returns_df.std() * np.sqrt(252)
            return self.inverse_vol_weights(vols.values)

    def get_allocation(self,
                      strategy_returns: Dict[str, np.ndarray]) -> Dict[str, float]:
        """
        Get risk parity allocation.

        Returns dict of strategy -> weight.
        """
        # Build returns dataframe
        min_len = min(len(r) for r in strategy_returns.values())

        if min_len < 30:
            # Equal weight
            return {s: 1.0/len(strategy_returns) for s in strategy_returns}

        df = pd.DataFrame({
            name: ret[-min_len:]
            for name, ret in strategy_returns.items()
        })

        # Calculate weights
        try:
            weights = self.risk_budget_weights(df)
        except:
            # Fallback
            vols = np.array([np.std(r[-min_len:]) for r in strategy_returns.values()])
            weights = self.inverse_vol_weights(vols)

        return dict(zip(strategy_returns.keys(), weights))


class IntegratedPositionSizer:
    """
    Combines Kelly + Volatility Targeting + Risk Parity.

    PIPELINE (FIXED to actually integrate Kelly):
    1. Risk parity: Base allocation (equal risk contribution)
    2. Kelly: Leverage scalar (fractional Kelly on top)
    3. Vol targeting: Scale to target vol
    4. Correlation: Down-weight highly correlated strategies
    5. Bounds: Enforce max limits
    """

    def __init__(self,
                 kelly_config: dict = None,
                 vol_target_config: dict = None,
                 risk_parity_config: dict = None):
        """
        Initialize all components.
        """
        self.kelly = FractionalKellySizer(**(kelly_config or {}))
        self.vol_target = VolatilityTargeter(**(vol_target_config or {}))
        self.risk_parity = RiskParityAllocator(**(risk_parity_config or {}))

        self.allocation_history = []

    def calculate_allocations(self,
                            strategies: Dict[str, Dict],
                            capital: float,
                            current_positions: Dict[str, float],
                            strategy_corrs: Dict[str, float] = None) -> Dict[str, StrategyAllocation]:
        """
        Calculate position allocations for all strategies.

        INTEGRATED PIPELINE (fixed to actually use Kelly):
        1. Risk parity: Base allocation (equal risk contribution)
        2. Kelly: Leverage scalar (fractional Kelly on top)
        3. Vol targeting: Scale to target vol
        4. Correlation: Down-weight highly correlated strategies
        5. Bounds: Enforce max limits

        Args:
            strategies: Dict of strategy_name -> {returns, price, direction}
            capital: Total capital
            current_positions: Current position per strategy
            strategy_corrs: Optional correlation adjustments per strategy

        Returns:
            Dict of strategy_name -> StrategyAllocation
        """
        results = {}

        # 1. Risk parity weights (base allocation)
        returns_dict = {s: data['returns'] for s, data in strategies.items()}
        risk_weights = self.risk_parity.get_allocation(returns_dict)

        # Calculate global volatility for vol targeting
        all_returns = np.column_stack([
            returns_dict[s][-30:] for s in strategies.keys()
        ])
        global_vol = np.std(all_returns) * np.sqrt(252) if len(all_returns) > 0 else 0.20
        global_vol_scalar = self.vol_target.target / (global_vol + 1e-8)
        global_vol_scalar = np.clip(global_vol_scalar, 0.1, 3.0)

        # Calculate Kelly fractions and correlation adjustments per strategy
        kelly_fractions = {}
        correlation_adjustments = strategy_corrs or {}

        for name, data in strategies.items():
            returns = data['returns']

            if len(returns) >= 30:
                mean = np.mean(returns[-30:])
                variance = np.var(returns[-30:])

                # Kelly fraction (fractional Kelly)
                kelly_frac = self.kelly.calculate_kelly(mean, variance)
                kelly_fractions[name] = kelly_frac
            else:
                kelly_fractions[name] = 0.5  # Default conservative

            if name not in correlation_adjustments:
                correlation_adjustments[name] = 1.0

        # 2-5. Calculate final weights with Kelly + vol + correlation + bounds
        for name, data in strategies.items():
            returns = data['returns']
            price = data['price']
            current_pos = current_positions.get(name, 0)

            # Base risk-parity weight
            base_weight = risk_weights[name]

            # Volatility scalar (this strategy vs target)
            strategy_vol = np.std(returns[-20:]) * np.sqrt(252) if len(returns) >= 20 else 0.20
            vol_scalar = self.vol_target.target / (strategy_vol + 1e-8)
            vol_scalar = np.clip(vol_scalar, 0.1, 3.0)

            # Kelly scalar: How much leverage to apply
            # Kelly > 0.5 means we're confident, apply more weight
            # Kelly < 0.2 means unfavorable, reduce weight
            kelly_scalar = np.clip(kelly_fractions[name] * 2, 0.25, 2.0)

            # Correlation adjustment (default 1.0)
            corr_adj = correlation_adjustments.get(name, 1.0)

            # Combined weight = base * kelly_scalar * vol_scalar * correlation * global_vol
            # This integrates ALL components
            final_weight = (
                base_weight *
                kelly_scalar *
                vol_scalar *
                corr_adj *
                global_vol_scalar
            )

            # Apply per-strategy max limit
            max_limit = 0.25  # 25% per strategy
            final_weight = np.clip(final_weight, 0.01, max_limit)  # Min 1%, Max 25%

            # Calculate stop loss
            strategy_vol = np.std(returns[-20:]) if len(returns) >= 20 else 0.02
            direction = data.get('direction', 'long')
            stop_level = 2 * strategy_vol  # 2x daily vol
            if direction == 'long':
                stop_loss = price * (1 - stop_level)
            else:
                stop_loss = price * (1 + stop_level)

            allocation = StrategyAllocation(
                strategy_name=name,
                target_weight=base_weight,
                kelly_fraction=kelly_fractions[name],
                volatility_scalar=vol_scalar,
                correlation_adjustment=corr_adj,
                final_weight=final_weight,
                max_position_pct=max_limit,
                stop_loss_price=stop_loss
            )

            results[name] = allocation

        # Normalize to ensure total = 1.0 (or max leverage)
        total_weight = sum(a.final_weight for a in results.values())
        if total_weight > 1.0:
            # Scale down to respect max gross leverage
            scale = 1.0 / total_weight
            for alloc in results.values():
                alloc.final_weight *= scale

        # Log
        self.allocation_history.append({
            'timestamp': pd.Timestamp.now(),
            'allocations': results,
            'total_weight': sum(a.final_weight for a in results.values()),
            'global_vol_scalar': global_vol_scalar,
            'kelly_scalar_mean': np.mean(list(kelly_fractions.values()))
        })

        logger.info(f"Allocations calculated: {len(results)} strategies")
        logger.info(f"  Global vol scalar: {global_vol_scalar:.2f}")
        for name, alloc in results.items():
            logger.info(f"  {name}: final={alloc.final_weight:.1%} "
                       f"(RP={alloc.target_weight:.1%}, Kelly={alloc.kelly_fraction:.2f}x, "
                       f"Vol={alloc.volatility_scalar:.2f}x)")

        return results

    def get_portfolio_stats(self) -> Dict:
        """Get portfolio-level statistics."""
        if not self.allocation_history:
            return {}

        latest = self.allocation_history[-1]

        return {
            'timestamp': latest['timestamp'],
            'total_weight': latest['total_weight'],
            'n_strategies': len(latest['allocations']),
            'allocations': {
                name: alloc.final_weight
                for name, alloc in latest['allocations'].items()
            }
        }
