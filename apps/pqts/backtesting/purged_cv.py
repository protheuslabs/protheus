"""
Purged Cross-Validation for Time Series

Implementation of Marcos Lopez de Prado's methodology for
preventing data leakage in financial backtesting.

Key concepts:
- Purge: Gap between train and test sets
- Embargo: Gap after test set before using data again
- Combinatorial: Test robustness across multiple splits
"""

import numpy as np
import pandas as pd
from typing import Iterator, Tuple, List, Optional
from sklearn.model_selection import BaseCrossValidator
from datetime import timedelta
import logging

logger = logging.getLogger(__name__)


class PurgedKFold(BaseCrossValidator):
    """
    K-fold cross-validation with purging and embargo.
    
    Prevents data leakage by:
    1. Removing overlapping periods (purging)
    2. Adding embargo after test sets
    """
    
    def __init__(self, 
                 n_splits: int = 5,
                 pct_purge: float = 0.01,
                 pct_embargo: float = 0.01):
        """
        Args:
            n_splits: Number of folds
            pct_purge: % of fold size to purge between train/test
            pct_embargo: % of fold size to embargo after test
        """
        self.n_splits = n_splits
        self.pct_purge = pct_purge
        self.pct_embargo = pct_embargo
    
    def split(self, X: pd.DataFrame, y=None, groups=None) -> Iterator[Tuple[np.ndarray, np.ndarray]]:
        """Generate train/test indices with purging and embargo."""
        n_samples = len(X)
        indices = np.arange(n_samples)
        fold_size = n_samples // self.n_splits
        
        purge_size = int(fold_size * self.pct_purge)
        embargo_size = int(fold_size * self.pct_embargo)
        
        for fold in range(self.n_splits):
            # Test set
            test_start = fold * fold_size
            test_end = min((fold + 1) * fold_size, n_samples)
            test_indices = indices[test_start:test_end]
            
            # Purge: gap before test
            purge_end = test_start
            purge_start = max(0, purge_end - purge_size)
            
            # Embargo: gap after test
            embargo_start = test_end
            embargo_end = min(n_samples, embargo_start + embargo_size)
            
            # Train: everything before purge_start + after embargo_end
            train_indices = np.concatenate([
                indices[:purge_start],
                indices[embargo_end:]
            ])
            
            yield train_indices, test_indices
    
    def get_n_splits(self, X=None, y=None, groups=None) -> int:
        return self.n_splits


class CombinatorialPurgedCV(BaseCrossValidator):
    """
    Combinatorial purged cross-validation.
    
    Generates many train/test combinations to estimate
    distribution of out-of-sample performance.
    """
    
    def __init__(self,
                 n_splits: int = 6,
                 pct_purge: float = 0.01,
                 pct_embargo: float = 0.01,
                 n_test_splits: int = 2):
        """
        Args:
            n_splits: Total splits
            n_test_splits: Number of splits combined for test set
        """
        self.n_splits = n_splits
        self.pct_purge = pct_purge
        self.pct_embargo = pct_embargo
        self.n_test_splits = n_test_splits
        
    def split(self, X: pd.DataFrame, y=None, groups=None):
        """Generate combinatorial splits."""
        from itertools import combinations
        
        n_samples = len(X)
        indices = np.arange(n_samples)
        fold_size = n_samples // self.n_splits
        
        purge_size = int(fold_size * self.pct_purge)
        embargo_size = int(fold_size * self.pct_embargo)
        
        # All combinations of test folds
        for test_folds in combinations(range(self.n_splits), self.n_test_splits):
            # Build test set from multiple folds
            test_indices = []
            for fold in test_folds:
                start = fold * fold_size
                end = min((fold + 1) * fold_size, n_samples)
                test_indices.extend(indices[start:end])
            
            test_indices = np.array(test_indices)
            test_start = min(test_indices)
            test_end = max(test_indices)
            
            # Purge before test
            purge_start = max(0, test_start - purge_size)
            
            # Embargo after test
            embargo_end = min(n_samples, test_end + embargo_size)
            
            # Train set
            train_indices = np.concatenate([
                indices[:purge_start],
                indices[embargo_end:]
            ])
            
            yield train_indices, test_indices
    
    def get_n_splits(self, X=None, y=None, groups=None) -> int:
        from math import comb
        return comb(self.n_splits, self.n_test_splits)


class BacktestValidator:
    """
    Validates backtest results to prevent overfitting.
    
    Implements Grok's kill rules:
    - OOS Sharpe < 0.8 → Kill
    - Profit factor < 1.4 → Kill
    - Max drawdown > 15% → Kill
    """
    
    def __init__(self,
                 min_sharpe: float = 0.8,
                 min_profit_factor: float = 1.4,
                 max_drawdown: float = 0.15):
        self.min_sharpe = min_sharpe
        self.min_pf = min_profit_factor
        self.max_dd = max_drawdown
    
    def validate(self, returns: np.ndarray) -> dict:
        """
        Validate strategy performance.
        
        Returns dict with:
            - passed: bool
            - reasons: List[str] (if failed)
            - metrics: dict
        """
        metrics = self._calculate_metrics(returns)
        
        passed = True
        reasons = []
        
        if metrics['sharpe'] < self.min_sharpe:
            passed = False
            reasons.append(f"Sharpe {metrics['sharpe']:.2f} < {self.min_sharpe}")
        
        if metrics['profit_factor'] < self.min_pf:
            passed = False
            reasons.append(f"PF {metrics['profit_factor']:.2f} < {self.min_pf}")
        
        if metrics['max_drawdown'] > self.max_dd:
            passed = False
            reasons.append(f"DD {metrics['max_drawdown']:.1%} > {self.max_dd:.1%}")
        
        return {
            'passed': passed,
            'reasons': reasons,
            'metrics': metrics
        }
    
    def _calculate_metrics(self, returns: np.ndarray) -> dict:
        """Calculate performance metrics."""
        if len(returns) < 10:
            return {
                'sharpe': 0,
                'profit_factor': 0,
                'max_drawdown': 1,
                'win_rate': 0,
                'total_return': -1
            }
        
        # Returns
        total_return = np.sum(returns)
        
        # Sharpe (assuming 252 trading days)
        sharpe = np.mean(returns) / (np.std(returns) + 1e-8) * np.sqrt(252)
        
        # Profit factor
        gains = np.sum(returns[returns > 0])
        losses = abs(np.sum(returns[returns < 0]))
        pf = gains / losses if losses > 0 else 0
        
        # Max drawdown
        cum = np.cumprod(1 + returns)
        running_max = np.maximum.accumulate(cum)
        drawdown = (cum - running_max) / running_max
        max_dd = abs(np.min(drawdown))
        
        # Win rate
        win_rate = np.mean(returns > 0)
        
        return {
            'sharpe': sharpe,
            'profit_factor': pf,
            'max_drawdown': max_dd,
            'win_rate': win_rate,
            'total_return': total_return
        }


class StrategyKiller:
    """
    Automatically kills strategies that don't meet criteria.
    
    Implements Grok's recommendations for preventing overfitting.
    """
    
    def __init__(self, validator: BacktestValidator):
        self.validator = validator
        self.killed_strategies = []
    
    def test_strategy(self, strategy, data: pd.DataFrame) -> bool:
        """
        Test a strategy and kill if it fails validation.
        
        Returns True if strategy survives, False if killed.
        """
        logger.info(f"Testing strategy: {strategy.name}")
        
        # Run backtest with purged CV
        cv = PurgedKFold(n_splits=5)
        all_returns = []
        
        for train_idx, test_idx in cv.split(data):
            train_data = data.iloc[train_idx]
            test_data = data.iloc[test_idx]
            
            # Train on train data
            strategy.fit(train_data)
            
            # Simulate on test data
            returns = strategy.simulate(test_data)
            all_returns.extend(returns)
        
        # Validate
        result = self.validator.validate(np.array(all_returns))
        
        if result['passed']:
            logger.info(f"✅ {strategy.name} survived: "
                       f"Sharpe={result['metrics']['sharpe']:.2f}, "
                       f"PF={result['metrics']['profit_factor']:.2f}")
            return True
        else:
            logger.warning(f"❌ {strategy.name} KILLED: {result['reasons']}")
            self.killed_strategies.append({
                'name': strategy.name,
                'reasons': result['reasons'],
                'metrics': result['metrics']
            })
            return False
    
    def get_survivors(self, strategies: List, data: pd.DataFrame) -> List:
        """Test all strategies and return survivors."""
        survivors = []
        
        for strategy in strategies:
            if self.test_strategy(strategy, data):
                survivors.append(strategy)
        
        logger.info(f"Survived: {len(survivors)} / {len(strategies)}")
        return survivors


if __name__ == "__main__":
    # Test
    print("="*70)
    print("PURGED CROSS-VALIDATION - TEST")
    print("="*70)
    
    # Create synthetic data
    dates = pd.date_range('2020-01-01', periods=1000, freq='d')
    data = pd.DataFrame({
        'close': 100 + np.cumsum(np.random.randn(1000) * 0.1),
        'returns': np.random.randn(1000) * 0.02
    }, index=dates)
    
    # Test PurgedKFold
    print("\n1. Testing PurgedKFold...")
    cv = PurgedKFold(n_splits=5, pct_purge=0.01, pct_embargo=0.01)
    
    for fold, (train, test) in enumerate(cv.split(data)):
        print(f"  Fold {fold}: train={len(train)}, test={len(test)}")
    
    # Test Combinatorial
    print("\n2. Testing CombinatorialPurgedCV...")
    comb_cv = CombinatorialPurgedCV(n_splits=6, n_test_splits=2)
    print(f"  Total splits: {comb_cv.get_n_splits(data)}")
    
    # Test Validator
    print("\n3. Testing BacktestValidator...")
    validator = BacktestValidator(
        min_sharpe=0.8,
        min_profit_factor=1.4,
        max_drawdown=0.15
    )
    
    # Good strategy
    good_returns = np.random.randn(252) * 0.01 + 0.0005
    result = validator.validate(good_returns)
    print(f"  Good strategy: {'✅ PASSED' if result['passed'] else '❌ FAILED'}")
    print(f"    Sharpe: {result['metrics']['sharpe']:.2f}")
    print(f"    PF: {result['metrics']['profit_factor']:.2f}")
    print(f"    DD: {result['metrics']['max_drawdown']:.1%}")
    
    # Bad strategy
    bad_returns = np.random.randn(252) * 0.02 - 0.001
    result = validator.validate(bad_returns)
    print(f"  Bad strategy: {'✅ PASSED' if result['passed'] else '❌ FAILED'}")
    print(f"    Sharpe: {result['metrics']['sharpe']:.2f}")
    print(f"    PF: {result['metrics']['profit_factor']:.2f}")
    print(f"    DD: {result['metrics']['max_drawdown']:.1%}")
    
    print("\n" + "="*70)
    print("Purged CV system ready for production")
    print("="*70)
