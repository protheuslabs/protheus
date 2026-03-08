"""
Optuna Hyperparameter Optimization

Bayesian optimization for strategy parameters with
overfitting penalty (Grok's recommendation).
"""

import optuna
import numpy as np
import pandas as pd
from typing import Dict, Callable, Optional, Any
import logging
from backtesting.purged_cv import PurgedKFold, BacktestValidator

logger = logging.getLogger(__name__)

class StrategyOptimizer:
    """
    Optimize strategy hyperparameters using Optuna.
    
    Key features:
    - Bayesian optimization (faster than grid search)
    - Overfitting penalty (train vs test performance gap)
    - Purged CV for OOS evaluation
    """
    
    def __init__(self, 
                 strategy_class: type,
                 param_space: Dict[str, Any],
                 data: pd.DataFrame,
                 n_trials: int = 100,
                 overfit_penalty: float = 0.5):
        """
        Args:
            strategy_class: Strategy class to optimize
            param_space: Dict of parameter names -> optuna distributions
            data: Training data (purged CV will split)
            n_trials: Number of optimization iterations
            overfit_penalty: Penalty for train/test performance gap
        """
        self.strategy_class = strategy_class
        self.param_space = param_space
        self.data = data
        self.n_trials = n_trials
        self.overfit_penalty = overfit_penalty
        
        self.best_params = None
        self.best_value = float('-inf')
        self.study = None
        
    def optimize(self, direction: str = 'maximize') -> Dict:
        """
        Run optimization.
        
        Returns best parameters found.
        """
        self.study = optuna.create_study(
            direction=direction,
            pruner=optuna.pruners.MedianPruner()
        )
        
        logger.info(f"Starting optimization: {self.n_trials} trials")
        
        self.study.optimize(
            self._objective,
            n_trials=self.n_trials,
            show_progress_bar=True
        )
        
        self.best_params = self.study.best_params
        self.best_value = self.study.best_value
        
        logger.info(f"Best value: {self.best_value:.4f}")
        logger.info(f"Best params: {self.best_params}")
        
        return self.best_params
    
    def _objective(self, trial: optuna.Trial) -> float:
        """Optuna objective function."""
        # Sample parameters
        params = self._sample_params(trial)
        
        # Create strategy
        strategy = self.strategy_class(params)
        
        # Run purged CV
        cv = PurgedKFold(n_splits=5, pct_purge=0.01, pct_embargo=0.01)
        
        test_returns = []
        train_returns = []
        
        for fold, (train_idx, test_idx) in enumerate(cv.split(self.data)):
            try:
                # Train data
                train_data = self.data.iloc[train_idx]
                test_data = self.data.iloc[test_idx]
                
                # Fit on train
                strategy.fit(train_data)
                train_perf = strategy.simulate(train_data)
                train_returns.extend(train_perf)
                
                # Evaluate on test (OOS)
                test_perf = strategy.simulate(test_data)
                test_returns.extend(test_perf)
                
            except Exception as e:
                logger.warning(f"Trial {trial.number} fold {fold} failed: {e}")
                return float('-inf')
        
        # Calculate metrics
        test_sharpe = self._sharpe(test_returns)
        train_sharpe = self._sharpe(train_returns)
        
        # Penalize overfitting
        overfit_gap = train_sharpe - test_sharpe
        
        if overfit_gap > 0.3:  # Large gap
            penalty = overfit_gap * self.overfit_penalty
        else:
            penalty = 0
        
        score = test_sharpe - penalty
        
        # Prune if very bad
        if trial.number > 10 and score < 0:
            raise optuna.TrialPruned()
        
        return score
    
    def _sample_params(self, trial: optuna.Trial) -> Dict:
        """Sample parameters from parameter space."""
        params = {}
        
        for name, spec in self.param_space.items():
            if spec['type'] == 'int':
                params[name] = trial.suggest_int(
                    name, 
                    spec['low'], 
                    spec['high'],
                    step=spec.get('step', 1)
                )
            elif spec['type'] == 'float':
                params[name] = trial.suggest_float(
                    name,
                    spec['low'],
                    spec['high'],
                    log=spec.get('log', False)
                )
            elif spec['type'] == 'categorical':
                params[name] = trial.suggest_categorical(
                    name,
                    spec['choices']
                )
        
        return params
    
    def _sharpe(self, returns: np.ndarray) -> float:
        """Calculate annualized Sharpe ratio."""
        mean = np.mean(returns)
        std = np.std(returns)
        if std == 0:
            return 0
        return mean / std * np.sqrt(252)
    
    def get_optimization_report(self) -> Dict:
        """Generate report of optimization results."""
        if not self.study:
            return {}
        
        return {
            'best_params': self.best_params,
            'best_value': self.best_value,
            'n_trials': len(self.study.trials),
            'n_completed': len([t for t in self.study.trials if t.state == optuna.trial.TrialState.COMPLETE]),
            'optimization_history': [
                {'trial': t.number, 'value': t.value} 
                for t in self.study.trials 
                if t.value is not None
            ],
            'param_importance': optuna.importance.get_param_importances(self.study) if self.study else {}
        }


def optimize_all_strategies(strategies: list, data: pd.DataFrame,
                           base_config: dict) -> Dict[str, Dict]:
    """
    Optimize all strategies with Optuna.
    
    Returns dict of strategy_name -> best_params.
    """
    results = {}
    
    for strategy_cfg in strategies:
        name = strategy_cfg['name']
        logger.info(f"\n{'='*60}")
        logger.info(f"Optimizing: {name}")
        logger.info('='*60)
        
        optimizer = StrategyOptimizer(
            strategy_class=strategy_cfg['class'],
            param_space=strategy_cfg['param_space'],
            data=data,
            n_trials=base_config.get('n_trials', 100)
        )
        
        best_params = optimizer.optimize()
        
        results[name] = {
            'params': best_params,
            'report': optimizer.get_optimization_report()
        }
    
    return results


# Strategy-specific parameter spaces
STRATEGY_PARAM_SPACES = {
    'trend_following': {
        'lookback': {'type': 'int', 'low': 10, 'high': 100},
        'short_window': {'type': 'int', 'low': 5, 'high': 50},
        'long_window': {'type': 'int', 'low': 20, 'high': 200},
        'threshold': {'type': 'float', 'low': 0.001, 'high': 0.05},
        'stop_loss': {'type': 'float', 'low': 0.01, 'high': 0.10}
    },
    
    'mean_reversion': {
        'lookback': {'type': 'int', 'low': 5, 'high': 50},
        'z_score_threshold': {'type': 'float', 'low': 1.0, 'high': 3.0},
        'half_life_limit': {'type': 'int', 'low': 5, 'high': 100},
        'profit_target': {'type': 'float', 'low': 0.01, 'high': 0.10}
    },
    
    'market_making': {
        'spread_multiplier': {'type': 'float', 'low': 1.0, 'high': 5.0, 'log': True},
        'inventory_limit': {'type': 'float', 'low': 0.05, 'high': 0.50},
        'rebalance_threshold': {'type': 'float', 'low': 0.01, 'high': 0.10},
        'skew_factor': {'type': 'float', 'low': 0.1, 'high': 2.0}
    },
    
    'momentum': {
        'lookback': {'type': 'int', 'low': 5, 'high': 60},
        'momentum_threshold': {'type': 'float', 'low': 0.005, 'high': 0.05},
        'volatility_filter': {'type': 'float', 'low': 0.0, 'high': 0.5},
        'max_holding_period': {'type': 'int', 'low': 5, 'high': 50}
    },
    
    'ml_ensemble': {
        'n_estimators': {'type': 'int', 'low': 50, 'high': 500},
        'max_depth': {'type': 'int', 'low': 3, 'high': 10},
        'learning_rate': {'type': 'float', 'low': 0.01, 'high': 0.3, 'log': True},
        'subsample': {'type': 'float', 'low': 0.5, 'high': 1.0},
        'min_child_weight': {'type': 'int', 'low': 1, 'high': 10}
    }
}


if __name__ == "__main__":
    # Test
    import logging
    logging.basicConfig(level=logging.INFO)
    
    print("\n" + "="*70)
    print("OPTUNA HYPEROPT - TEST")
    print("="*70 + "\n")
    
    # Create fake strategy class
    class FakeStrategy:
        def __init__(self, params):
            self.params = params
            self.name = "fake"
        
        def fit(self, data):
            pass
        
        def simulate(self, data):
            # Random returns, better with certain parameters
            np.random.seed(self.params.get('lookback', 1))
            return np.random.randn(len(data)) * 0.01 + 0.0001 * self.params.get('lookback', 1)
    
    # Create test data
    data = pd.DataFrame({
        'close': 100 + np.cumsum(np.random.randn(500) * 0.1),
        'feature': np.random.randn(500)
    })
    
    # Define parameter space
    param_space = {
        'lookback': {'type': 'int', 'low': 10, 'high': 100},
        'threshold': {'type': 'float', 'low': 0.01, 'high': 0.1},
        'model_type': {'type': 'categorical', 'choices': ['xgboost', 'rf']}
    }
    
    # Optimize
    optimizer = StrategyOptimizer(
        strategy_class=FakeStrategy,
        param_space=param_space,
        data=data,
        n_trials=20
    )
    
    best = optimizer.optimize()
    
    print(f"\n{'='*70}")
    print("BEST PARAMETERS:")
    print('='*70)
    for k, v in best.items():
        print(f"  {k}: {v}")
    
    print("\nOptuna hyperopt ready for production!")
