# Risk Management System
import logging
from dataclasses import dataclass, fields
from typing import Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class RiskLimits:
    max_portfolio_risk_pct: float = 2.0
    max_position_risk_pct: float = 1.0
    max_drawdown_pct: float = 10.0
    max_correlation: float = 0.7
    max_positions: int = 20
    max_leverage: float = 3.0


class RiskManager:
    """Institutional-grade risk management"""

    def __init__(self, config: dict):
        allowed = {field.name for field in fields(RiskLimits)}
        limits_cfg = {k: v for k, v in config.items() if k in allowed}
        self.limits = RiskLimits(**limits_cfg)
        self.current_drawdown = 0.0
        self.peak_portfolio_value = 0.0
        self.daily_pnl = 0.0
        self.risk_metrics = {}

        logger.info(f"RiskManager initialized with limits: {self.limits}")

    async def check_signal(self, signal: dict) -> bool:
        """Check if signal passes risk filters"""

        # Check position size
        if not self._check_position_size(signal):
            logger.warning(f"Signal rejected: position size exceeds limit")
            return False

        # Check portfolio risk
        if not self._check_portfolio_risk(signal):
            logger.warning(f"Signal rejected: portfolio risk exceeds limit")
            return False

        # Check drawdown
        if self.current_drawdown >= self.limits.max_drawdown_pct:
            logger.warning(f"Signal rejected: max drawdown exceeded")
            return False

        # Check correlation
        if not self._check_correlation(signal):
            logger.warning(f"Signal rejected: correlation limit exceeded")
            return False

        return True

    async def check_limits(self, positions: dict, orders: dict):
        """Check all risk limits and take action if breached"""

        # Calculate current metrics
        portfolio_value = self._calculate_portfolio_value(positions)

        # Update peak and drawdown
        if portfolio_value > self.peak_portfolio_value:
            self.peak_portfolio_value = portfolio_value

        self.current_drawdown = (
            (self.peak_portfolio_value - portfolio_value) / self.peak_portfolio_value * 100
        )

        # Check if we need to reduce exposure
        if self.current_drawdown >= self.limits.max_drawdown_pct * 0.8:  # 80% of limit
            logger.warning(f"Approaching max drawdown: {self.current_drawdown:.2f}%")
            await self._reduce_exposure(positions)

        # Check position concentration
        await self._check_concentration(positions)

    def _check_position_size(self, signal: dict) -> bool:
        """Check if position size is within limits"""
        position_risk = signal.get("risk_pct", 0)
        return position_risk <= self.limits.max_position_risk_pct

    def _check_portfolio_risk(self, signal: dict) -> bool:
        """Check if adding this position would exceed portfolio risk"""
        # Calculate Value at Risk (VaR)
        current_var = self._calculate_var()
        signal_var = signal.get("var", 0)

        return (current_var + signal_var) <= self.limits.max_portfolio_risk_pct

    def _check_correlation(self, signal: dict) -> bool:
        """Check correlation with existing positions"""
        symbol = signal.get("symbol")
        # Check correlation matrix
        return True  # Placeholder

    def _calculate_portfolio_value(self, positions: dict) -> float:
        """Calculate total portfolio value"""
        total = 0.0
        for pos in positions.values():
            total += pos.quantity * pos.avg_entry_price
        return total

    def _calculate_var(self, confidence: float = 0.95) -> float:
        """Calculate portfolio Value at Risk"""
        # Simplified VaR calculation
        # In production, use historical simulation or Monte Carlo
        return 0.0  # Placeholder

    async def _reduce_exposure(self, positions: dict):
        """Reduce portfolio exposure when approaching limits"""
        logger.warning("Reducing portfolio exposure")
        # Close lowest conviction positions
        # Reduce position sizes proportionally

    async def _check_concentration(self, positions: dict):
        """Check for position concentration"""
        if len(positions) > self.limits.max_positions:
            logger.warning(f"Too many positions: {len(positions)}")

    def calculate_position_size(self, signal: dict, portfolio_value: float) -> float:
        """Calculate optimal position size using Kelly Criterion"""
        win_rate = signal.get("win_rate", 0.5)
        avg_win = signal.get("avg_win", 0)
        avg_loss = signal.get("avg_loss", 0)

        if avg_loss == 0:
            return 0

        # Kelly formula: f* = (p*b - q) / b
        # where p = win rate, q = loss rate, b = win/loss ratio
        b = avg_win / avg_loss
        q = 1 - win_rate

        kelly_pct = (win_rate * b - q) / b

        # Use half-Kelly for safety
        half_kelly = kelly_pct / 2

        # Cap at max position risk
        max_position_value = portfolio_value * (self.limits.max_position_risk_pct / 100)

        return min(half_kelly * portfolio_value, max_position_value)

    def get_risk_report(self) -> dict:
        """Generate risk report"""
        return {
            "current_drawdown_pct": self.current_drawdown,
            "max_drawdown_limit_pct": self.limits.max_drawdown_pct,
            "daily_pnl": self.daily_pnl,
            "portfolio_var": self._calculate_var(),
            "limits": self.limits.__dict__,
        }
