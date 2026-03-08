# Walk-Forward Testing Framework
import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Callable
from datetime import datetime, timedelta
from dataclasses import dataclass
from backtesting.event_engine import EventDrivenBacktester

logger = logging.getLogger(__name__)

@dataclass
class WalkForwardWindow:
    train_start: datetime
    train_end: datetime
    validation_start: datetime
    validation_end: datetime
    test_start: datetime
    test_end: datetime

class WalkForwardTester:
    """
    Walk-forward testing to prevent overfitting.
    
    Critical for production: Strategies that work in-sample but fail out-of-sample
    are worthless. Walk-forward simulates how strategies would perform rolling
    forward in time.
    
    Standard approach:
    Train: 2019-2022
    Validate: 2023
    Test: 2024
    
    Then roll forward and repeat.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.train_years = config.get('train_years', 3)
        self.validate_years = config.get('validate_years', 1)
        self.test_years = config.get('test_years', 1)
        self.step_years = config.get('step_years', 1)
        
        logger.info(f"WalkForwardTester: train={self.train_years}y, validate={self.validate_years}y, test={self.test_years}y")
    
    def generate_windows(self, start_date: datetime, end_date: datetime) -> List[WalkForwardWindow]:
        """Generate non-overlapping windows for walk-forward testing."""
        windows = []
        
        current = start_date
        window_years = self.train_years + self.validate_years + self.test_years
        
        while True:
            train_start = current
            train_end = train_start + timedelta(days=self.train_years*365)
            
            validate_start = train_end
            validate_end = validate_start + timedelta(days=self.validate_years*365)
            
            test_start = validate_end
            test_end = test_start + timedelta(days=self.test_years*365)
            
            if test_end > end_date:
                break
            
            window = WalkForwardWindow(
                train_start=train_start,
                train_end=train_end,
                validation_start=validate_start,
                validation_end=validate_end,
                test_start=test_start,
                test_end=test_end
            )
            
            windows.append(window)
            current += timedelta(days=self.step_years*365)
        
        logger.info(f"Generated {len(windows)} walk-forward windows")
        return windows
    
    def run_walk_forward(self, strategy_factory: Callable,
                        data: Dict[str, pd.DataFrame],
                        windows: List[WalkForwardWindow]) -> Dict:
        """
        Run strategy through all walk-forward windows.
        
        Args:
            strategy_factory: Function that creates strategy instance
            data: Historical data
            windows: List of time windows
        """
        results = []
        
        for i, window in enumerate(windows):
            logger.info(f"Window {i+1}/{len(windows)}")
            
            # Train phase
            logger.info(f"  Training: {window.train_start.date()} to {window.train_end.date()}")
            train_strategy = strategy_factory()
            train_data = self._slice_data(data, window.train_start, window.train_end)
            
            # Train strategy (if trainable)
            if hasattr(train_strategy, 'train'):
                train_strategy.train(train_data)
            
            # Validation phase
            logger.info(f"  Validation: {window.validation_start.date()} to {window.validation_end.date()}")
            validation_data = self._slice_data(data, window.validation_start, window.validation_end)
            val_metrics = self._evaluate(train_strategy, validation_data)
            
            # Hyperparameter tuning on validation
            if hasattr(train_strategy, 'tune_hyperparameters'):
                tuned_strategy = train_strategy.tune_hyperparameters(validation_data)
            else:
                tuned_strategy = train_strategy
            
            # Test phase (out-of-sample)
            logger.info(f"  Test: {window.test_start.date()} to {window.test_end.date()}")
            test_data = self._slice_data(data, window.test_start, window.test_end)
            test_metrics = self._evaluate(tuned_strategy, test_data)
            
            results.append({
                'window': i,
                'train_period': f"{window.train_start.date()} to {window.train_end.date()}",
                'validation_sharpe': val_metrics.get('sharpe', 0),
                'test_sharpe': test_metrics.get('sharpe', 0),
                'validation_return': val_metrics.get('total_return', 0),
                'test_return': test_metrics.get('total_return', 0),
                'validation_drawdown': val_metrics.get('max_drawdown', 0),
                'test_drawdown': test_metrics.get('max_drawdown', 0),
                'metrics': test_metrics
            })
        
        # Aggregate results
        aggregate = self._aggregate_results(results)
        
        logger.info(f"Walk-forward complete. Avg Sharpe: {aggregate['avg_sharpe']:.2f}")
        
        return {
            'window_results': results,
            'aggregate': aggregate,
            'consistency_score': aggregate['consistency_score']
        }
    
    def _slice_data(self, data: Dict[str, pd.DataFrame],
                   start: datetime, end: datetime) -> Dict[str, pd.DataFrame]:
        """Slice data to time window."""
        sliced = {}
        for symbol, df in data.items():
            mask = (df.index >= start) & (df.index <= end)
            sliced[symbol] = df[mask]
        return sliced
    
    def _evaluate(self, strategy, data: Dict[str, pd.DataFrame]) -> Dict:
        """Run backtest and return metrics."""
        if not data:
            return {'sharpe': 0.0, 'total_return': 0.0, 'max_drawdown': 0.0, 'trades': 0}

        # Primary path: strategy supplies deterministic evaluator.
        if hasattr(strategy, 'evaluate'):
            metrics = strategy.evaluate(data)
            return {
                'sharpe': float(metrics.get('sharpe', 0.0)),
                'total_return': float(metrics.get('total_return', 0.0)),
                'max_drawdown': float(metrics.get('max_drawdown', 0.0)),
                'trades': int(metrics.get('total_trades', metrics.get('trades', 0))),
            }

        # Fallback path: run event-driven simulation for on_tick strategies.
        if hasattr(strategy, 'on_tick'):
            backtester = EventDrivenBacktester({
                'initial_capital': self.config.get('initial_capital', 10000.0),
                'latency_ms': self.config.get('latency_ms', 100),
                'fee_rate': self.config.get('fee_rate', 0.001),
                'partial_fills': self.config.get('partial_fills', True),
            })
            metrics = backtester.run_backtest(strategy, data)
            return {
                'sharpe': float(metrics.get('sharpe', 0.0)),
                'total_return': float(metrics.get('total_return', 0.0)),
                'max_drawdown': float(metrics.get('max_drawdown', 0.0)),
                'trades': int(metrics.get('total_trades', 0)),
            }

        raise TypeError(
            "WalkForwardTester requires strategies implementing either "
            "evaluate(data)->metrics or on_tick(symbol,tick,timestamp)."
        )
    
    def _aggregate_results(self, results: List[Dict]) -> Dict:
        """Aggregate results across windows."""
        if not results:
            return {
                'avg_sharpe': 0.0,
                'sharpe_std': 0.0,
                'min_sharpe': 0.0,
                'max_sharpe': 0.0,
                'avg_return': 0.0,
                'avg_drawdown': 0.0,
                'consistency_score': 0.0
            }

        sharpes = [r['test_sharpe'] for r in results]
        returns = [r['test_return'] for r in results]
        drawdowns = [r['test_drawdown'] for r in results]
        
        # Consistency: do results degrade over time?
        consistency = 1 - abs(np.std(sharpes) / (abs(np.mean(sharpes)) + 0.01))
        consistency = float(np.clip(consistency, 0.0, 1.0))
        
        return {
            'avg_sharpe': np.mean(sharpes),
            'sharpe_std': np.std(sharpes),
            'min_sharpe': np.min(sharpes),
            'max_sharpe': np.max(sharpes),
            'avg_return': np.mean(returns),
            'avg_drawdown': np.mean(drawdowns),
            'consistency_score': consistency
        }
