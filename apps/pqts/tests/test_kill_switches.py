"""
Test suite for kill switches.

Production-grade tests for risk overlay system.

Run: pytest tests/test_kill_switches.py -v
"""

import numpy as np
from datetime import datetime
from pathlib import Path
import sys

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from risk.kill_switches import (
    RiskLimits, KillSwitchMonitor, RiskDecision, RiskState,
    PortfolioState, TradingEngine
)


# Standard test fixtures as constants (deterministic)
LIMITS = RiskLimits(
    max_daily_loss_pct=0.02,
    max_drawdown_pct=0.10,
    max_gross_leverage=2.0,
    max_order_notional=50000,
    max_slippage_bps=50
)

PORTFOLIO_NORMAL = PortfolioState(
    timestamp=datetime.now(),
    positions={'BTC': 0.5},
    prices={'BTC': 50000},
    total_pnl=1000,
    unrealized_pnl=500,
    realized_pnl=500,
    gross_exposure=25000,
    net_exposure=25000,
    leverage=0.5,
    open_orders=[],
    pending_cancels=[]
)

PORTFOLIO_HIGH_LEV = PortfolioState(
    timestamp=datetime.now(),
    positions={'BTC': 2.5},
    prices={'BTC': 50000},
    total_pnl=0,
    unrealized_pnl=0,
    realized_pnl=0,
    gross_exposure=125000,
    net_exposure=125000,
    leverage=2.5,
    open_orders=[],
    pending_cancels=[]
)

PORTFOLIO_CRASH = PortfolioState(
    timestamp=datetime.now(),
    positions={'BTC': 1.0},
    prices={'BTC': 40000},
    total_pnl=-12000,
    unrealized_pnl=-12000,
    realized_pnl=0,
    gross_exposure=40000,
    net_exposure=40000,
    leverage=1.0,
    open_orders=[{'id': 'ord1'}, {'id': 'ord2'}],
    pending_cancels=[]
)

# Deterministic arrays for repeatable tests
FIXED_RETURNS = np.linspace(-0.02, 0.02, 30)
FIXED_RETURNS_SHIFTED = np.roll(FIXED_RETURNS, 5) * 0.7
FIXED_RETURNS_WAVE = np.sin(np.linspace(0.0, 3.0 * np.pi, 30)) * 0.012
FIXED_PORTFOLIO_CHANGES = np.linspace(-1000.0, 1000.0, 30)

# Strategy returns - deterministic fixed arrays
STRATEGY_RETURNS = {
    'strat1': FIXED_RETURNS,
    'strat2': FIXED_RETURNS_SHIFTED,
    'strat3': FIXED_RETURNS_WAVE
}


def new_monitor_with_capital():
    """Factory: return fresh monitor with capital injected."""
    monitor = KillSwitchMonitor(LIMITS)
    monitor.set_capital(100000.0, source='test_fixture')
    return monitor


class TestKillSwitchMonitor:
    """Test suite for kill switch monitoring."""
    
    def test_initial_state(self):
        """Test monitor initializes correctly."""
        monitor = new_monitor_with_capital()
        assert not monitor.kill_switch_active
        assert monitor.kill_reason == ""
        assert monitor.current_drawdown == 0.0
    
    def test_daily_loss_no_trigger(self):
        """Test daily loss check with normal P&L."""
        monitor = new_monitor_with_capital()
        monitor.daily_pnl = 1000  # Profit
        is_triggered, reason = monitor.check_daily_loss()
        assert not is_triggered
        assert reason == ""
    
    def test_daily_loss_trigger(self):
        """Test daily loss limit triggers correctly."""
        monitor = new_monitor_with_capital()
        monitor.daily_pnl = -2500  # 2.5% loss on 100k
        is_triggered, reason = monitor.check_daily_loss()
        assert is_triggered
        assert "2.50%" in reason
        assert "2.00%" in reason
    
    def test_drawdown_no_trigger(self):
        """Test drawdown check with normal levels."""
        monitor = new_monitor_with_capital()
        monitor.peak_portfolio_value = 105000
        monitor.current_drawdown = 0.05  # 5%
        is_triggered, reason = monitor.check_drawdown()
        assert not is_triggered
    
    def test_drawdown_trigger(self):
        """Test drawdown limit triggers correctly."""
        monitor = new_monitor_with_capital()
        monitor.peak_portfolio_value = 110000
        monitor.current_drawdown = 0.12  # 12%
        is_triggered, reason = monitor.check_drawdown()
        assert is_triggered
        assert "12.00%" in reason
        assert "10.00%" in reason
    
    def test_leverage_no_trigger(self):
        """Test leverage check with normal leverage."""
        monitor = new_monitor_with_capital()
        is_triggered, reason = monitor.check_leverage(PORTFOLIO_NORMAL)
        assert not is_triggered
    
    def test_leverage_trigger(self):
        """Test leverage limit triggers correctly."""
        monitor = new_monitor_with_capital()
        is_triggered, reason = monitor.check_leverage(PORTFOLIO_HIGH_LEV)
        assert is_triggered
        assert "2.50x" in reason
        assert "2.00x" in reason
    
    def test_slippage_no_trigger(self):
        """Test slippage check with normal levels."""
        monitor = new_monitor_with_capital()
        monitor.last_slippages.extend([0.0001, 0.0002, 0.0001])  # 1-2 bps
        is_triggered, reason = monitor.check_slippage()
        assert not is_triggered
    
    def test_slippage_trigger(self):
        """Test slippage limit triggers correctly."""
        monitor = new_monitor_with_capital()
        # Need at least slippage_lookback_trade (default 20) entries
        monitor.last_slippages.extend([0.006] * 25)  # 60 bps (over 50 bps limit)
        is_triggered, reason = monitor.check_slippage()
        assert is_triggered
        assert "60" in reason or "0.006" in reason
        assert "50" in reason or "0.005" in reason
    
    def test_evaluate_all_allow(self):
        """Test all-clear evaluates to ALLOW."""
        monitor = new_monitor_with_capital()
        state = monitor.evaluate_all(
            PORTFOLIO_NORMAL,
            STRATEGY_RETURNS,
            FIXED_PORTFOLIO_CHANGES
        )
        assert state.decision == RiskDecision.ALLOW
        assert state.reason == "All clear"
        assert not monitor.kill_switch_active
    
    def test_evaluate_all_flatten(self):
        """Test crash scenario triggers FLATTEN."""
        monitor = new_monitor_with_capital()
        # Simulate large losses
        monitor.daily_pnl = -2500
        monitor.peak_portfolio_value = 110000
        monitor.current_drawdown = 0.12
        
        state = monitor.evaluate_all(
            PORTFOLIO_CRASH,
            STRATEGY_RETURNS,
            [-5000] * 30  # Large negative changes
        )
        
        assert state.decision == RiskDecision.FLATTEN
        assert "Daily loss" in state.reason or "Drawdown" in state.reason
        assert monitor.kill_switch_active
    
    def test_capital_not_set_raises(self):
        """Test that missing capital raises RuntimeError."""
        monitor = KillSwitchMonitor(LIMITS)
        try:
            monitor._get_capital()
            assert False, "Should have raised RuntimeError"
        except RuntimeError as e:
            assert "Capital not set" in str(e)


class TestTradingEngine:
    """Test suite for trading engine integration."""
    
    @staticmethod
    def new_engine():
        """Factory: return fresh engine with capital injected."""
        limits = RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.10,
            max_gross_leverage=2.0
        )
        engine = TradingEngine(limits)
        engine.risk_monitor.set_capital(100000.0, source='test_fixture')
        return engine
    
    @staticmethod
    def portfolio():
        """Normal portfolio."""
        return PortfolioState(
            timestamp=datetime.now(),
            positions={},
            prices={'BTC': 50000},
            total_pnl=0,
            unrealized_pnl=0,
            realized_pnl=0,
            gross_exposure=0,
            net_exposure=0,
            leverage=0,
            open_orders=[],
            pending_cancels=[]
        )
    
    @staticmethod
    def portfolio_orders():
        """Portfolio with open orders."""
        return PortfolioState(
            timestamp=datetime.now(),
            positions={'BTC': 0.5},
            prices={'BTC': 50000},
            total_pnl=0,
            unrealized_pnl=0,
            realized_pnl=0,
            gross_exposure=25000,
            net_exposure=25000,
            leverage=0.5,
            open_orders=[
                {'id': 'ord1'},
                {'id': 'ord2'},
                {'id': 'ord3'}
            ],
            pending_cancels=[]
        )
    
    def test_pre_trade_check_allow(self):
        """Test normal conditions allow order."""
        engine = self.new_engine()
        decision, state = engine.pre_trade_check(
            {'notional': 1000},
            self.portfolio(),
            {'s1': FIXED_RETURNS},
            FIXED_PORTFOLIO_CHANGES * 0.1
        )
        assert decision == RiskDecision.ALLOW
    
    def test_no_orders_after_flatten(self):
        """Test no orders accepted after flatten."""
        engine = self.new_engine()
        # Trigger flatten
        state = engine.manual_kill('test')
        
        # Try to place order
        result = engine.approve_order({'notional': 1000}, state)
        assert not result

    def test_position_limit_enforced_in_approve_order(self):
        """max_single_position_pct must block oversized single-name exposure."""
        engine = self.new_engine()
        decision, state = engine.pre_trade_check(
            {'notional': 1000, 'side': 'buy'},
            self.portfolio(),
            {'s1': FIXED_RETURNS},
            FIXED_PORTFOLIO_CHANGES * 0.1
        )
        assert decision == RiskDecision.ALLOW

        blocked = engine.approve_order(
            {
                'notional': 30000,
                'side': 'buy',
                'current_position_notional': 0.0,
            },
            state,
        )
        assert blocked is False

        allowed = engine.approve_order(
            {
                'notional': 20000,
                'side': 'buy',
                'current_position_notional': 0.0,
            },
            state,
        )
        assert allowed is True
    
    def test_manual_flatten(self):
        """Test manual flatten triggers correctly."""
        engine = self.new_engine()
        state = engine.manual_kill('manual emergency')
        
        assert state.decision == RiskDecision.FLATTEN
        assert 'manual emergency' in state.reason
        assert engine.is_flattening
    
    def test_orders_cancelled_on_flatten(self):
        """Test open orders are cancelled on flatten."""
        engine = self.new_engine()
        # Set up so flatten will trigger
        engine.risk_monitor.daily_pnl = -2500
        engine.risk_monitor.peak_portfolio_value = 100000
        engine.risk_monitor.current_drawdown = 0.12
        
        portfolio = self.portfolio_orders()
        
        # Trigger flatten
        engine.manual_kill('test')
        engine._initiate_flatten(portfolio)
        
        # Check orders were cancelled
        assert len(engine.cancelled_orders) == 3
        assert 'ord1' in engine.cancelled_orders
    
    def test_reset_after_kill(self):
        """Test reset functionality."""
        engine = self.new_engine()
        # Trigger flatten
        engine.manual_kill('test')
        assert engine.is_flattening
        
        # Reset
        engine.reset()
        assert not engine.is_flattening
        assert not engine.is_halted
        assert not engine.risk_monitor.kill_switch_active


class TestIntegration:
    """Integration tests for full system."""
    
    def test_complete_flow_allow(self):
        """Test complete flow from order to execution with ALLOW."""
        limits = RiskLimits(max_daily_loss_pct=0.02)
        engine = TradingEngine(limits)
        engine.risk_monitor.set_capital(100000.0, source='test')  # INJECT CAPITAL
        
        portfolio = PortfolioState(
            timestamp=datetime.now(),
            positions={},
            prices={'BTC': 50000},
            total_pnl=0,
            unrealized_pnl=0,
            realized_pnl=0,
            gross_exposure=0,
            net_exposure=0,
            leverage=0,
            open_orders=[],
            pending_cancels=[]
        )
        
        # Check risk
        decision, state = engine.pre_trade_check(
            {'notional': 5000},
            portfolio,
            {},
            [0] * 30
        )
        
        assert decision == RiskDecision.ALLOW
        
        # Place order
        result = engine.approve_order({'notional': 5000}, state)
        assert result
        assert engine.order_count == 1
    
    def test_crash_triggers_flatten_one_tick(self):
        """
        CRITICAL TEST: Simulate 10-sigma crash and verify FLATTEN in one tick.
        """
        limits = RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.10,
            max_gross_leverage=2.0
        )
        engine = TradingEngine(limits)
        engine.risk_monitor.set_capital(100000.0, source='test')  # INJECT CAPITAL
        
        # Simulate crash scenario
        engine.risk_monitor.daily_pnl = -2500  # 2.5% loss
        engine.risk_monitor.peak_portfolio_value = 110000
        engine.risk_monitor.current_drawdown = 0.12  # 12% drawdown
        
        portfolio = PortfolioState(
            timestamp=datetime.now(),
            positions={'BTC': 1.0},
            prices={'BTC': 40000},  # 20% down from 50k
            total_pnl=-12000,
            unrealized_pnl=-12000,
            realized_pnl=0,
            gross_exposure=40000,
            net_exposure=40000,
            leverage=1.0,
            open_orders=[{'id': 'o1'}, {'id': 'o2'}],
            pending_cancels=[]
        )
        
        # One tick risk check
        decision, state = engine.pre_trade_check(
            {'notional': 1000},
            portfolio,
            {'s1': FIXED_RETURNS * 2.5},  # High vol
            [-5000] * 30  # Large negative changes
        )
        
        # Verify FLATTEN triggered in one tick
        assert decision == RiskDecision.FLATTEN
        assert engine.is_flattening
        
        # Verify orders cannot be placed
        result = engine.approve_order({'notional': 100}, state)
        assert not result
    
    def test_deterministic_triggers(self):
        """Test that triggers are deterministic and reproducible."""
        limits = RiskLimits(max_daily_loss_pct=0.02)
        
        # Create two identical engines
        engine1 = TradingEngine(limits)
        engine2 = TradingEngine(limits)
        
        # INJECT CAPITAL BEFORE ANY CHECKS
        engine1.risk_monitor.set_capital(100000.0, source='test')
        engine2.risk_monitor.set_capital(100000.0, source='test')
        
        # Set identical crash state
        for engine in [engine1, engine2]:
            engine.risk_monitor.daily_pnl = -2500
            engine.risk_monitor.peak_portfolio_value = 100000
            engine.risk_monitor.current_drawdown = 0.11
        
        portfolio = PortfolioState(
            timestamp=datetime.now(),
            positions={},
            prices={'BTC': 50000},
            total_pnl=-11000,
            unrealized_pnl=-11000,
            realized_pnl=0,
            gross_exposure=0,
            net_exposure=0,
            leverage=0,
            open_orders=[],
            pending_cancels=[]
        )
        
        # Same checks on both
        d1, s1 = engine1.pre_trade_check(
            {'notional': 1000}, portfolio, {}, [0]*30
        )
        d2, s2 = engine2.pre_trade_check(
            {'notional': 1000}, portfolio, {}, [0]*30
        )
        
        # Deterministic
        assert d1 == d2
        assert s1.reason == s2.reason


if __name__ == "__main__":
    # Run with: python -m pytest tests/test_kill_switches.py -v
    import pytest
    pytest.main([__file__, "-v"])
