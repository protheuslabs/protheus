"""
Kill Switches - Priority C Implementation

Production-grade risk overlay with enforced actions.

Based on Grok's spec:
1. Add RiskDecision return type: ALLOW | REDUCE | HALT | FLATTEN
2. TradingEngine must call risk_manager.pre_trade_check() BEFORE every order
3. On HALT: stop generating new orders (do not flatten)
4. On FLATTEN: cancel all orders, reduce positions to zero safely
5. Add unit tests for each trigger
6. Emit dashboard metrics: kill_switch_state, drawdown, slippage, leverage

Acceptance Criteria:
- A synthetic crash triggers FLATTEN within one event loop tick
- No further orders placed after HALT/FLATTEN
- All triggers deterministic and reproducible in tests
"""

import logging
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


class RiskDecision(Enum):
    """Risk manager's decision on whether to allow a trade."""

    ALLOW = "allow"  # Proceed normally
    REDUCE = "reduce"  # Reduce size but allow
    HALT = "halt"  # Stop new orders (keep positions)
    FLATTEN = "flatten"  # Emergency: liquidate everything


@dataclass
class RiskState:
    """Current risk system state."""

    decision: RiskDecision
    reason: str
    timestamp: datetime
    metrics: Dict[str, float]
    max_order_notional: float
    max_gross_leverage: float
    max_participation: float


@dataclass
class RiskLimits:
    """Hard limits for kill switch triggers."""

    # Daily loss
    max_daily_loss_pct: float = 0.02  # 2%

    # Drawdown
    max_drawdown_pct: float = 0.15  # 15%

    # VaR - daily
    var_95_daily: float = 0.03  # 3%
    var_99_daily: float = 0.05  # 5%

    # Exposure
    max_gross_leverage: float = 2.0  # 2x
    max_single_position_pct: float = 0.25  # 25%

    # Order controls
    max_order_notional: float = 50000  # $50k
    max_participation: float = 0.05  # 5% of market depth

    # Rate limits
    max_orders_per_minute: int = 30
    max_errors_per_hour: int = 5

    # Slippage monitoring
    max_slippage_bps: float = 50  # 50 bps
    slippage_lookback_trade: int = 20

    # Correlation spike
    correlation_threshold: float = 0.8
    correlation_lookback_days: int = 30

    # Volatility regime
    vol_regime_spike: float = 2.0  # 2x recent vol


@dataclass
class PortfolioState:
    """Current portfolio snapshot."""

    timestamp: datetime
    positions: Dict[str, float]
    prices: Dict[str, float]

    # P&L
    total_pnl: float
    unrealized_pnl: float
    realized_pnl: float

    # Risk metrics
    gross_exposure: float  # Sum of absolute positions in USD
    net_exposure: float
    leverage: float

    # Market
    open_orders: List[Dict]
    pending_cancels: List[str]

    @property
    def gross_leverage(self) -> float:
        """Total position notional / capital."""
        return self.leverage

    @property
    def total_notional(self) -> float:
        """Sum of absolute position notionals."""
        return self.gross_exposure


class KillSwitchMonitor:
    """
    Real-time kill switch monitoring.

    Evaluates portfolio state against hard limits.
    """

    def __init__(self, limits: RiskLimits, capital: Optional[float] = None):
        """
        Args:
            limits: Risk hard limits
            capital: Total capital (NOT hardcoded - injected from config/broker)
        """
        self.limits = limits
        self._capital = capital  # Injected capital, NOT hardcoded
        self.state_history: deque = deque(maxlen=1000)
        self.pnl_history: deque = deque(maxlen=252)  # 1 year of daily
        self.last_reset: datetime = datetime.now()
        self.errors_last_hour: deque = deque(maxlen=100)
        self.orders_last_minute: deque = deque(maxlen=100)

        # Current state
        self.current_drawdown: float = 0.0
        self.peak_portfolio_value: float = 0.0
        self.daily_pnl: float = 0.0
        self.kill_switch_active: bool = False
        self.kill_reason: str = ""
        self.last_slippages: deque = deque(maxlen=50)

    def set_capital(self, capital: float, source: str = "unknown"):
        """
        Set capital dynamically.

        Args:
            capital: Total capital in USD
            source: Source of capital (e.g., 'broker_api', 'config_file', 'manual')
        """
        self._capital = capital
        logger.info(f"KillSwitchMonitor capital set: ${capital:,.2f} (source: {source})")

    def _get_capital(self) -> float:
        """Get total capital (raises if not set)."""
        if self._capital is None or self._capital <= 0:
            raise RuntimeError(
                "Capital not set for kill switch monitor. "
                "Call set_capital() with actual capital before trading. "
                "Capital must be injected, never hardcoded."
            )
        return self._capital

    def reset_daily(self, portfolio_value: float):
        """Reset daily tracking."""
        self.daily_pnl = 0.0
        self.last_reset = datetime.now()
        self.peak_portfolio_value = max(self.peak_portfolio_value, portfolio_value)

    def update(self, portfolio: PortfolioState, trades: List[Dict]):
        """Update metrics with latest portfolio state."""
        self.state_history.append(portfolio)

        # Update drawdown - HARD STOP if capital not set (no fallback)
        capital = self._get_capital()  # Raises RuntimeError if not set
        current_value = portfolio.total_pnl + capital

        self.peak_portfolio_value = max(self.peak_portfolio_value, current_value)
        self.current_drawdown = (
            (self.peak_portfolio_value - current_value) / self.peak_portfolio_value
            if self.peak_portfolio_value > 0
            else 0.0
        )

        # Update daily P&L
        self.daily_pnl += sum(t.get("pnl", 0) for t in trades)

        # Track slippages
        for trade in trades:
            if "expected_price" in trade and "actual_price" in trade:
                slippage = (
                    abs(trade["actual_price"] - trade["expected_price"]) / trade["expected_price"]
                )
                self.last_slippages.append(slippage)

        # Track orders
        now = datetime.now()
        for _ in trades:
            self.orders_last_minute.append(now)

        # Clean old orders
        cutoff = now - timedelta(minutes=1)
        while self.orders_last_minute and self.orders_last_minute[0] < cutoff:
            self.orders_last_minute.popleft()

        # Clean old errors (simulated)
        error_cutoff = now - timedelta(hours=1)
        while self.errors_last_hour and self.errors_last_hour[0] < error_cutoff:
            self.errors_last_hour.popleft()

    def check_daily_loss(self) -> Tuple[bool, str]:
        """Check if daily loss limit hit."""
        capital = self._get_capital()
        daily_loss_pct = self.daily_pnl / capital

        if daily_loss_pct <= -self.limits.max_daily_loss_pct:
            return (
                True,
                f"Daily loss {daily_loss_pct:.2%} > limit {self.limits.max_daily_loss_pct:.2%}",
            )
        return False, ""

    def check_drawdown(self) -> Tuple[bool, str]:
        """Check if max drawdown breached."""
        if self.current_drawdown >= self.limits.max_drawdown_pct:
            return (
                True,
                f"Drawdown {self.current_drawdown:.2%} > limit {self.limits.max_drawdown_pct:.2%}",
            )
        return False, ""

    def check_var(self, portfolio_pnl_changes: List[float]) -> Tuple[bool, str]:
        """Check if VaR estimate exceeds limits."""
        if len(portfolio_pnl_changes) < 30:
            return False, ""

        var_95 = np.percentile(portfolio_pnl_changes, 5)  # 5th percentile = 95% VaR
        var_99 = np.percentile(portfolio_pnl_changes, 1)  # 1st percentile = 99% VaR

        capital = self._get_capital()
        var_95_pct = abs(var_95) / capital
        var_99_pct = abs(var_99) / capital

        if var_99_pct > self.limits.var_99_daily:
            return True, f"VaR 99% {var_99_pct:.2%} > limit {self.limits.var_99_daily:.2%}"

        return False, ""

    def check_leverage(self, portfolio: PortfolioState) -> Tuple[bool, str]:
        """Check if leverage exceeds limit."""
        if portfolio.gross_leverage > self.limits.max_gross_leverage:
            return (
                True,
                f"Leverage {portfolio.gross_leverage:.2f}x > limit {self.limits.max_gross_leverage:.2f}x",
            )
        return False, ""

    def check_slippage(self) -> Tuple[bool, str]:
        """Check if recent slippage exceeds limit."""
        if len(self.last_slippages) < self.limits.slippage_lookback_trade:
            return False, ""

        recent_slippage = list(self.last_slippages)[-self.limits.slippage_lookback_trade :]
        avg_slippage = np.mean(recent_slippage)

        if avg_slippage > self.limits.max_slippage_bps / 10000:
            return (
                True,
                f"Avg slippage {avg_slippage*10000:.1f} bps > limit {self.limits.max_slippage_bps} bps",
            )

        return False, ""

    def check_rate_limits(self) -> Tuple[bool, str]:
        """Check order rate limits."""
        if len(self.orders_last_minute) > self.limits.max_orders_per_minute:
            return (
                True,
                f"Orders/min {len(self.orders_last_minute)} > limit {self.limits.max_orders_per_minute}",
            )

        if len(self.errors_last_hour) > self.limits.max_errors_per_hour:
            return (
                True,
                f"Errors/hour {len(self.errors_last_hour)} > limit {self.limits.max_errors_per_hour}",
            )

        return False, ""

    def check_correlation_spike(self, strategy_returns: Dict[str, np.ndarray]) -> Tuple[bool, str]:
        """Check if correlation spike detected."""
        if len(strategy_returns) < 2:
            return False, ""

        # Calculate pairwise correlations
        corrs = []
        names = list(strategy_returns.keys())

        min_len = min(len(r) for r in strategy_returns.values())
        if min_len < 20:
            return False, ""

        for i, s1 in enumerate(names):
            for s2 in names[i + 1 :]:
                corr = np.corrcoef(
                    strategy_returns[s1][-min_len:], strategy_returns[s2][-min_len:]
                )[0, 1]
                corrs.append(abs(corr))

        avg_corr = np.mean(corrs) if corrs else 0

        if avg_corr > self.limits.correlation_threshold:
            return (
                True,
                f"Avg correlation {avg_corr:.2f} > threshold {self.limits.correlation_threshold}",
            )

        return False, ""

    def evaluate_all(
        self,
        portfolio: PortfolioState,
        strategy_returns: Dict[str, np.ndarray],
        portfolio_changes: List[float],
    ) -> RiskState:
        """
        Evaluate all kill switch conditions.

        Returns RiskState with decision and constraints.
        """
        triggers = []

        # Check each trigger
        is_triggered, reason = self.check_daily_loss()
        if is_triggered:
            triggers.append(("daily_loss", reason))

        is_triggered, reason = self.check_drawdown()
        if is_triggered:
            triggers.append(("drawdown", reason))

        is_triggered, reason = self.check_var(portfolio_changes)
        if is_triggered:
            triggers.append(("var", reason))

        is_triggered, reason = self.check_leverage(portfolio)
        if is_triggered:
            triggers.append(("leverage", reason))

        is_triggered, reason = self.check_slippage()
        if is_triggered:
            triggers.append(("slippage", reason))

        is_triggered, reason = self.check_rate_limits()
        if is_triggered:
            triggers.append(("rate_limit", reason))

        is_triggered, reason = self.check_correlation_spike(strategy_returns)
        if is_triggered:
            triggers.append(("correlation", reason))

        # Determine severity and decision
        if any(t[0] in ["drawdown", "daily_loss", "var"] for t in triggers):
            # Critical: Flatten positions
            decision = RiskDecision.FLATTEN
            reason = "Critical: " + "; ".join([t[1] for t in triggers])
            max_order = 0
            max_leverage = 0
            max_participation = 0
            self.kill_switch_active = True

        elif any(t[0] in ["leverage", "correlation"] for t in triggers):
            # Reduce: Halt new orders
            decision = RiskDecision.HALT
            reason = "Risk increase: " + "; ".join([t[1] for t in triggers])
            max_order = self.limits.max_order_notional * 0.5
            max_leverage = self.limits.max_gross_leverage * 0.7
            max_participation = self.limits.max_participation * 0.5
            self.kill_switch_active = True

        elif any(t[0] in ["slippage", "rate_limit"] for t in triggers):
            # Reduce: Smaller orders
            decision = RiskDecision.REDUCE
            reason = "Caution: " + "; ".join([t[1] for t in triggers])
            max_order = self.limits.max_order_notional * 0.5
            max_leverage = self.limits.max_gross_leverage
            max_participation = self.limits.max_participation * 0.5

        else:
            # All clear
            decision = RiskDecision.ALLOW
            reason = "All clear"
            max_order = self.limits.max_order_notional
            max_leverage = self.limits.max_gross_leverage
            max_participation = self.limits.max_participation

        if triggers and decision != RiskDecision.ALLOW:
            logger.warning(f"KILL SWITCH TRIGGERED: {decision.value.upper()} - {reason}")
            logger.warning(f"  Active triggers: {[t[0] for t in triggers]}")

        self.kill_reason = reason

        return RiskState(
            decision=decision,
            reason=reason,
            timestamp=datetime.now(),
            metrics={
                "drawdown": self.current_drawdown,
                "daily_pnl": self.daily_pnl,
                "leverage": portfolio.gross_leverage,
                "n_triggers": len(triggers),
            },
            max_order_notional=max_order,
            max_gross_leverage=max_leverage,
            max_participation=max_participation,
        )

    def manual_flatten(self, reason: str):
        """Manual kill switch trigger."""
        logger.critical(f"MANUAL FLATTEN TRIGGERED: {reason}")
        self.kill_switch_active = True
        self.kill_reason = f"MANUAL: {reason}"
        return RiskState(
            decision=RiskDecision.FLATTEN,
            reason=f"MANUAL: {reason}",
            timestamp=datetime.now(),
            metrics={},
            max_order_notional=0,
            max_gross_leverage=0,
            max_participation=0,
        )

    def reset(self):
        """Reset kill switch after review."""
        logger.info("Kill switch manually reset")
        self.kill_switch_active = False
        self.kill_reason = ""
        self.last_reset = datetime.now()


class TradingEngine:
    """
    Example integrated trading engine with kill switches.

    Must call risk_manager.pre_trade_check() BEFORE every order.
    """

    def __init__(self, risk_limits: RiskLimits):
        self.risk_monitor = KillSwitchMonitor(risk_limits)
        self.is_flattening: bool = False
        self.is_halted: bool = False
        self.order_count: int = 0
        self.cancelled_orders: List[str] = []
        self._state_lock = threading.Lock()

    def pre_trade_check(
        self,
        order: Dict,
        portfolio: PortfolioState,
        strategy_returns: Dict[str, np.ndarray],
        portfolio_changes: List[float],
    ) -> Tuple[RiskDecision, RiskState]:
        """
        Mandatory risk check before every order.

        Returns:
            (decision, risk_state)
        """
        with self._state_lock:
            state = self.risk_monitor.evaluate_all(portfolio, strategy_returns, portfolio_changes)

            # Check if already in emergency state
            if self.is_flattening:
                return RiskDecision.FLATTEN, state

            if self.is_halted and state.decision == RiskDecision.HALT:
                return RiskDecision.HALT, state

            # Update emergency states
            if state.decision == RiskDecision.FLATTEN:
                self.is_flattening = True
                self._initiate_flatten(portfolio)

            elif state.decision == RiskDecision.HALT:
                self.is_halted = True

            elif state.decision == RiskDecision.ALLOW:
                self.is_halted = False

            return state.decision, state

    def _initiate_flatten(self, portfolio: PortfolioState):
        """Begin flattening process."""
        logger.critical("INITIATING FLATTEN - Cancelling all orders and liquidating positions")

        # Cancel all open orders
        for order in portfolio.open_orders:
            self.cancelled_orders.append(order.get("id", "unknown"))
            logger.info(f"Cancelled order: {order.get('id')}")

        # Schedule liquidation orders (would use TWAP/POV in real implementation)
        # For simulation, we just log
        for symbol, size in portfolio.positions.items():
            if size != 0:
                logger.info(f"Scheduled liquidation: {symbol} {size} via safe TWAP")

    def approve_order(self, order: Dict, risk_state: RiskState) -> bool:
        """
        Approve an order only if risk allows.

        Returns True if the order is approved by the risk engine.
        """
        # Check order size against limits
        if order.get("notional", 0) > risk_state.max_order_notional:
            logger.warning(
                f"Order notional ${order.get('notional')} > limit ${risk_state.max_order_notional}"
            )
            return False

        # Check leverage
        if risk_state.decision == RiskDecision.FLATTEN:
            logger.warning("Engine is flattening - no new orders allowed")
            return False

        if risk_state.decision == RiskDecision.HALT:
            logger.warning("Engine is halted - no new orders allowed")
            return False

        max_single_position_pct = float(self.risk_monitor.limits.max_single_position_pct)
        post_trade_position_pct = order.get("post_trade_position_pct")
        if post_trade_position_pct is None:
            capital = self.risk_monitor._get_capital()
            current_position_notional = float(order.get("current_position_notional", 0.0))
            order_notional = float(order.get("notional", 0.0))
            side = str(order.get("side", "buy")).lower()
            signed_delta = order_notional if side == "buy" else -order_notional
            post_trade_notional = abs(current_position_notional + signed_delta)
            post_trade_position_pct = post_trade_notional / capital if capital > 0 else float("inf")
        else:
            post_trade_position_pct = float(post_trade_position_pct)

        if post_trade_position_pct > max_single_position_pct:
            logger.warning(
                "Post-trade position pct %.2f%% > limit %.2f%%",
                post_trade_position_pct * 100.0,
                max_single_position_pct * 100.0,
            )
            return False

        self.order_count += 1
        logger.info(f"Order #{self.order_count} approved: {order}")
        return True

    def get_status(self) -> Dict:
        """Get current engine status for dashboard."""
        return {
            "kill_switch_active": self.risk_monitor.kill_switch_active,
            "kill_switch_reason": self.risk_monitor.kill_reason,
            "current_drawdown": self.risk_monitor.current_drawdown,
            "daily_pnl": self.risk_monitor.daily_pnl,
            "is_flattening": self.is_flattening,
            "is_halted": self.is_halted,
            "orders_placed": self.order_count,
            "orders_cancelled": len(self.cancelled_orders),
        }

    def manual_kill(self, reason: str) -> RiskState:
        """Manual kill switch."""
        with self._state_lock:
            state = self.risk_monitor.manual_flatten(reason)
            self.is_flattening = True
            return state

    def manual_halt(self, reason: str) -> RiskState:
        """Manual halt without flattening positions."""
        with self._state_lock:
            self.is_halted = True
            self.risk_monitor.kill_switch_active = True
            self.risk_monitor.kill_reason = f"MANUAL_HALT: {reason}"
            return RiskState(
                decision=RiskDecision.HALT,
                reason=f"MANUAL_HALT: {reason}",
                timestamp=datetime.now(),
                metrics={},
                max_order_notional=0.0,
                max_gross_leverage=0.0,
                max_participation=0.0,
            )

    def reset(self):
        """Reset engine after review."""
        with self._state_lock:
            self.risk_monitor.reset()
            self.is_flattening = False
            self.is_halted = False
            logger.info("Engine reset - resuming normal operations")
