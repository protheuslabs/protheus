# Backtesting Tests
import pytest
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path

# Add parent to path
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from backtesting.engine import BacktestingEngine, BacktestResult


class TestBacktestingEngine:
    """Test suite for backtesting engine"""
    
    @pytest.fixture
    def engine(self):
        config = {
            'data_dir': 'data/historical',
            'commission_rate': 0.001,
            'slippage_bps': 5
        }
        return BacktestingEngine(config)
    
    def test_engine_initialization(self, engine):
        """Test engine initialization"""
        assert engine.commission_rate == 0.001
        assert engine.slippage_bps == 5
        assert engine.current_capital == 0.0
    
    def test_slippage_application(self, engine):
        """Test slippage is applied correctly"""
        price = 100.0
        direction = 'long'
        
        executed = engine._apply_slippage(price, direction, 1000)
        
        # Should be higher than original for long
        assert executed >= price
        assert executed == price * (1 + 5/10000)
    
    def test_empty_result_creation(self, engine):
        """Test empty result when no trades"""
        start = datetime(2024, 1, 1)
        end = datetime(2024, 1, 31)
        
        result = engine._create_empty_result("test", start, end, 10000.0)
        
        assert result.total_trades == 0
        assert result.final_capital == 10000.0
        assert result.start_date == start
        assert result.end_date == end
    
    def test_max_drawdown_calculation(self, engine):
        """Test max drawdown calculation"""
        # Create equity curve
        engine.equity_curve = [
            {'timestamp': '2024-01-01', 'equity': 10000},
            {'timestamp': '2024-01-02', 'equity': 11000},
            {'timestamp': '2024-01-03', 'equity': 9000},
            {'timestamp': '2024-01-04', 'equity': 9500},
        ]
        
        max_dd = engine._calculate_max_drawdown()
        
        # Max drawdown from 11000 to 9000 = 18.18%
        assert max_dd > 0
        assert abs(max_dd - 18.18) < 1.0


class TestBacktestResult:
    """Test backtest result data class"""
    
    def test_result_creation(self):
        """Test result object creation"""
        result = BacktestResult(
            strategy_name="test_strategy",
            start_date=datetime(2024, 1, 1),
            end_date=datetime(2024, 1, 31),
            initial_capital=10000.0,
            final_capital=11000.0,
            total_return_pct=10.0,
            sharpe_ratio=1.5,
            max_drawdown_pct=5.0,
            win_rate=60.0,
            total_trades=50,
            profit_factor=1.8
        )
        
        assert result.strategy_name == "test_strategy"
        assert result.total_return_pct == 10.0
        assert result.total_trades == 50


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
