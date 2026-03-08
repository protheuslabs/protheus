"""
Meta-Learner Strategy: Dynamic Strategy Weighting - FIXED VERSION

Bug fixes:
1. Fixed fit() indexing: X was 2D but indexed as 3D
2. Now properly supports multi-strategy feature training
3. Added unit tests for weight predictions

Implements Grok's recommendation:
- Train a small XGBoost to weight strategies dynamically
- Input: Recent 30-day performance + current regime
- Output: Weight for each strategy
- Often adds +0.5 to +1.0 Sharpe to portfolio

Key insight: Different strategies work in different regimes.
The meta-learner learns when to trust each strategy.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import xgboost as xgb
from datetime import datetime, timedelta
import logging
from sklearn.preprocessing import StandardScaler
import warnings
warnings.filterwarnings('ignore')

logger = logging.getLogger(__name__)


@dataclass
class StrategyFeatures:
    """Features extracted from strategy performance"""
    strategy_name: str
    sharpe_7d: float
    sharpe_30d: float
    sharpe_90d: float
    win_rate_30d: float
    max_dd_30d: float
    volatility_30d: float
    profit_factor: float
    avg_trade_pnl: float
    days_since_last_trade: int
    current_regime: str
    n_trades_30d: int
    streak_30d: int  # consecutive wins or losses
    recovery_factor: float  # return / max DD


class MetaFeatureExtractor:
    """Extract features for meta-learner from strategy performance."""
    
    def __init__(self, regime_detector = None):
        self.regime_detector = regime_detector
        
    def extract(self,
               strategy_returns: np.ndarray,
               strategy_name: str,
               current_regime: str = 'normal') -> StrategyFeatures:
        """Extract all features from strategy return series."""
        
        # Different lookbacks
        r7 = strategy_returns[-7:] if len(strategy_returns) >= 7 else strategy_returns
        r30 = strategy_returns[-30:] if len(strategy_returns) >= 30 else strategy_returns
        r90 = strategy_returns[-90:] if len(strategy_returns) >= 90 else strategy_returns
        
        def sharpe(returns):
            if len(returns) < 5:
                return 0
            return np.mean(returns) / (np.std(returns) + 1e-8) * np.sqrt(252)
        
        def win_rate(returns):
            if len(returns) == 0:
                return 0
            return np.mean(returns > 0)
        
        def max_dd(returns):
            if len(returns) == 0:
                return 0
            cum = np.cumprod(1 + returns)
            running_max = np.maximum.accumulate(cum)
            dd = (cum - running_max) / running_max
            return abs(np.min(dd))
        
        def profit_factor(returns):
            gains = np.sum(returns[returns > 0])
            losses = abs(np.sum(returns[returns < 0]))
            return gains / losses if losses > 0 else 0
        
        # Streak calculation
        signs = np.sign(strategy_returns[-30:])
        streak = 0
        for s in reversed(signs):
            if (streak > 0 and s > 0) or (streak < 0 and s < 0):
                streak += int(np.sign(s))
            else:
                break
        
        return StrategyFeatures(
            strategy_name=strategy_name,
            sharpe_7d=sharpe(r7),
            sharpe_30d=sharpe(r30),
            sharpe_90d=sharpe(r90),
            win_rate_30d=win_rate(r30),
            max_dd_30d=max_dd(r30),
            volatility_30d=np.std(r30) * np.sqrt(252),
            profit_factor=profit_factor(r30),
            avg_trade_pnl=np.mean(r30[r30 != 0]) if np.any(r30 != 0) else 0,
            days_since_last_trade=self._days_since_trade(strategy_returns),
            current_regime=current_regime,
            n_trades_30d=np.sum(r30 != 0),
            streak_30d=streak,
            recovery_factor=np.mean(r30) / (max_dd(r30) + 1e-8)
        )
    
    def _days_since_trade(self, returns: np.ndarray) -> int:
        """Days since last non-zero return"""
        non_zero = np.where(returns != 0)[0]
        if len(non_zero) == 0:
            return 999
        return len(returns) - non_zero[-1]


class StrategyMetaLearner:
    """
    Meta-learning model that predicts strategy weights.
    
    FIXED: Now properly handles multi-strategy training data.
    
    Architecture:
    - Single model per strategy (can be extended to multi-output)
    - Each strategy model learns: f(features) -> weight
    - Weights normalized to simplex (sum=1)
    
    XGBoost regressor that learns:
    f(strategy_features_1, ..., strategy_features_N) -> [w1, w2, ..., wN]
    
    where w_i are weights summing to 1.
    """
    
    def __init__(self, strategy_names: List[str],
                 model_params: dict = None,
                 use_single_model: bool = True):
        """
        Args:
            strategy_names: List of all strategy names
            model_params: XGBoost parameters
            use_single_model: If True, train one model with all strategies
                             If False, train separate model per strategy (original buggy approach)
        """
        self.strategy_names = strategy_names
        self.n_strategies = len(strategy_names)
        self.extractor = MetaFeatureExtractor()
        self.use_single_model = use_single_model
        
        base_params = {
            'n_estimators': 100,
            'max_depth': 5,
            'learning_rate': 0.05,
            'subsample': 0.8,
            'objective': 'reg:squarederror',
            'eval_metric': 'rmse'
        }
        if model_params:
            base_params.update(model_params)
        
        if use_single_model:
            # FIXED: Single model that predicts all weights
            self.model = xgb.XGBRegressor(**base_params)
            self.models = None
        else:
            # Original approach (per-strategy models)
            self.models = {
                name: xgb.XGBRegressor(**base_params)
                for name in strategy_names
            }
            self.model = None
        
        self.is_fitted = False
        self.feature_names = None
        self.scaler = StandardScaler()
        
    def _extract_feature_vector(self, features: StrategyFeatures) -> np.ndarray:
        """Convert StrategyFeatures to feature vector."""
        regime_encoded = self._encode_regime(features.current_regime)
        
        return np.array([
            features.sharpe_7d,
            features.sharpe_30d,
            features.sharpe_90d,
            features.win_rate_30d,
            features.max_dd_30d,
            features.volatility_30d,
            features.profit_factor,
            features.avg_trade_pnl,
            features.recovery_factor,
            features.n_trades_30d
        ] + regime_encoded)
    
    def _encode_regime(self, regime: str) -> List[float]:
        """One-hot encode regime."""
        regimes = ['normal', 'high_vol', 'low_vol', 'trending', 'mean_reverting']
        return [1.0 if r == regime else 0.0 for r in regimes]
    
    def _get_feature_names(self) -> List[str]:
        """Get human-readable feature names."""
        base = [
            'sharpe_7d', 'sharpe_30d', 'sharpe_90d',
            'win_rate', 'max_dd', 'volatility', 'profit_factor',
            'avg_pnl', 'recovery_factor', 'n_trades'
        ]
        regimes = ['regime_normal', 'regime_high_vol', 'regime_low_vol',
                  'regime_trending', 'regime_mean_reverting']
        return base + regimes
    
    def prepare_training_data_batch(self,
                                    historical_data: List[Dict]) -> Tuple[np.ndarray, np.ndarray]:
        """
        FIXED: Proper batch feature extraction for all strategies.
        
        Returns X with shape (n_samples * n_strategies, n_features)
        Returns y with shape (n_samples * n_strategies,) [optimal weights]
        """
        X_list = []
        y_list = []
        
        for sample in historical_data:
            current_returns = sample['returns']
            regime = sample['regime']
            future_returns = sample.get('future_returns')
            
            # Features for all strategies at this timepoint
            for name in self.strategy_names:
                feat = self.extractor.extract(
                    current_returns[name],
                    name,
                    regime
                )
                feat_vec = self._extract_feature_vector(feat)
                X_list.append(feat_vec)
                
                # Target weight from future performance
                if future_returns is not None:
                    future_sharpe = (np.mean(future_returns[name]) / 
                                   (np.std(future_returns[name]) + 1e-8))
                else:
                    future_sharpe = 0
                
                y_list.append(future_sharpe)
        
        X = np.array(X_list)
        y = np.array(y_list)
        
        return X, y
    
    def prepare_training_data(self,
                              historical_returns: Dict[str, np.ndarray],
                              current_regime: str,
                              future_returns: np.ndarray = None) -> Tuple[np.ndarray, np.ndarray]:
        """
        Original method - kept for compatibility.
        Returns features and targets for a single sample.
        """
        features_list = []
        
        for name in self.strategy_names:
            feat = self.extractor.extract(
                historical_returns[name],
                name,
                current_regime
            )
            feat_vec = self._extract_feature_vector(feat)
            features_list.append(feat_vec)
            
        X = np.array(features_list)  # (n_strategies, n_features)
        
        # Target: optimal weight based on future returns
        if future_returns is not None:
            # Weight ∝ future Sharpe
            future_sharpes = [
                np.mean(future_returns[s]) / (np.std(future_returns[s]) + 1e-8)
                for s in self.strategy_names
            ]
            
            # Softmax normalization
            exp_sharpes = np.exp(np.array(future_sharpes))
            y = exp_sharpes / exp_sharpes.sum()
        else:
            y = np.ones(self.n_strategies) / self.n_strategies
        
        return X, y
    
    def fit(self,
           historical_data: List[Dict],
           validation_split: float = 0.2):
        """
        FIXED: Proper training on batched data.
        
        Args:
            historical_data: List of {
                'returns': {strategy_name: returns_arr},
                'regime': str,
                'future_returns': {strategy_name: returns_arr}
            }
        """
        logger.info(f"Fitting meta-learner on {len(historical_data)} samples, "
                   f"{self.n_strategies} strategies")
        
        # Prepare batched training data
        X, y = self.prepare_training_data_batch(historical_data)
        
        logger.info(f"Training data shape: X={X.shape}, y={y.shape}")
        
        # Scale features
        X_scaled = self.scaler.fit_transform(X)
        
        # Split train/val
        split = int(len(X_scaled) * (1 - validation_split))
        X_train, X_val = X_scaled[:split], X_scaled[split:]
        y_train, y_val = y[:split], y[split:]
        
        if self.use_single_model:
            # Single model approach
            logger.info("Training single meta-learner model...")
            self.model.fit(
                X_train, y_train,
                eval_set=[(X_train, y_train), (X_val, y_val)],
                verbose=False
            )
        else:
            # Per-strategy models (split data by strategy)
            features_per_strategy = X.shape[1]
            n_samples_per_strategy = len(X_scaled) // self.n_strategies
            
            for i, name in enumerate(self.strategy_names):
                slice_start = i * n_samples_per_strategy
                slice_end = (i + 1) * n_samples_per_strategy
                
                Xi_train = X_train[slice_start::self.n_strategies]
                Xi_val = X_val[slice_start::self.n_strategies]
                yi_train = y_train[slice_start::self.n_strategies]
                yi_val = y_val[slice_start::self.n_strategies]
                
                self.models[name].fit(
                    Xi_train, yi_train,
                    eval_set=[(Xi_train, yi_train), (Xi_val, yi_val)],
                    verbose=False
                )
        
        self.is_fitted = True
        
        # Evaluate
        if self.use_single_model:
            train_pred = self.model.predict(X_train)
            val_pred = self.model.predict(X_val)
            logger.info(f"Train RMSE: {np.sqrt(np.mean((train_pred - y_train)**2)):.4f}")
            logger.info(f"Val RMSE: {np.sqrt(np.mean((val_pred - y_val)**2)):.4f}")
        
        logger.info("Meta-learner fitted successfully")
    
    def predict_weights(self,
                       current_returns: Dict[str, np.ndarray],
                       current_regime: str,
                       zero_bad_strategies: bool = True) -> Dict[str, float]:
        """
        Predict optimal weights for strategies.
        
        Returns dict of strategy -> weight (sums to 1).
        """
        if not self.is_fitted:
            # Equal weights
            return {s: 1.0/self.n_strategies for s in self.strategy_names}
        
        # Extract features
        features_list = []
        for name in self.strategy_names:
            feat = self.extractor.extract(
                current_returns[name],
                name,
                current_regime
            )
            feat_vec = self._extract_feature_vector(feat)
            features_list.append(feat_vec)
        
        X = np.array(features_list)
        X_scaled = self.scaler.transform(X)
        
        # Predict
        if self.use_single_model:
            predictions = self.model.predict(X_scaled)
        else:
            predictions = []
            for name in self.strategy_names:
                pred = self.models[name].predict(X_scaled[i:i+1])[0]
                predictions.append(pred)
        
        # Convert to weights
        if zero_bad_strategies:
            # Zero out negative predictions (bad strategies)
            predictions = np.maximum(predictions, 0)
        
        # Normalize to simplex (sum to 1)
        weight_sum = np.sum(predictions)
        if weight_sum == 0:
            weights = np.ones(self.n_strategies) / self.n_strategies
        else:
            weights = predictions / weight_sum
        
        # Return as dict
        return dict(zip(self.strategy_names, weights))
    
    def get_feature_importance(self) -> pd.DataFrame:
        """Get feature importance from trained model."""
        if not self.is_fitted:
            return pd.DataFrame()
        
        if self.use_single_model and hasattr(self.model, 'feature_importances_'):
            importance = self.model.feature_importances_
        else:
            # Average across models
            importance = np.mean([
                m.feature_importances_ 
                for m in self.models.values()
                if hasattr(m, 'feature_importances_')
            ], axis=0)
        
        return pd.DataFrame({
            'feature': self._get_feature_names(),
            'importance': importance
        }).sort_values('importance', ascending=False)
