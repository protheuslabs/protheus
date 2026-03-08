# Feature Store
import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Set
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
import json

logger = logging.getLogger(__name__)

@dataclass
class FeatureSet:
    """Container for a set of features"""
    symbol: str
    timestamp: datetime
    features: Dict[str, float]
    feature_group: str
    version: str = "1.0"

class FeatureStore:
    """
    Centralized feature management for ML models.
    
    Organizes features by type and provides efficient access:
    - order_book_features
    - trade_features
    - volatility_features
    - macro_features
    - cross_asset_features
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.data_dir = Path(config.get('data_dir', 'data/features'))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        
        self.features: Dict[str, FeatureSet] = {}
        self.feature_registry: Dict[str, Dict] = {}
        
        # Feature groups
        self.groups = {
            'order_book',
            'trade_flow',
            'volatility',
            'momentum',
            'sentiment',
            'macro',
            'cross_asset',
            'microstructure'
        }
        
        self._load_registry()
        
        logger.info(f"FeatureStore initialized with {len(self.groups)} groups")
    
    def compute_all_features(self, symbol: str, df: pd.DataFrame,
                            external_data: Dict = None) -> FeatureSet:
        """Compute complete feature set for symbol"""
        features = {}
        
        # Order book features
        features.update(self._compute_order_book_features(df))
        
        # Trade flow features
        features.update(self._compute_trade_flow_features(df))
        
        # Volatility features
        features.update(self._compute_volatility_features(df))
        
        # Momentum features
        features.update(self._compute_momentum_features(df))
        
        # Microstructure features
        features.update(self._compute_microstructure_features(df))
        
        # Cross-asset features (if available)
        if external_data:
            features.update(self._compute_cross_asset_features(symbol, external_data))
        
        timestamp = df.index[-1] if len(df) > 0 else datetime.now()
        
        feature_set = FeatureSet(
            symbol=symbol,
            timestamp=timestamp,
            features=features,
            feature_group='all',
            version='1.0'
        )
        
        # Store
        key = f"{symbol}_{timestamp.isoformat()}"
        self.features[key] = feature_set
        
        return feature_set
    
    def _compute_order_book_features(self, df: pd.DataFrame) -> Dict[str, float]:
        """Order book imbalance and depth features"""
        features = {}
        
        if len(df) < 2:
            return features
        
        close = df['close'].iloc[-1]
        high = df['high'].iloc[-1]
        low = df['low'].iloc[-1]
        volume = df['volume'].iloc[-1]
        
        # Basic OB features
        features['ob_price_range'] = (high - low) / close if close > 0 else 0
        features['ob_volume'] = volume
        features['ob_price_position'] = (close - low) / (high - low + 1e-8)
        
        # Spread estimation (if bid/ask available)
        if 'bid' in df.columns and 'ask' in df.columns:
            features['ob_spread'] = (df['ask'].iloc[-1] - df['bid'].iloc[-1]) / close
            features['ob_mid'] = (df['bid'].iloc[-1] + df['ask'].iloc[-1]) / 2
            
            # Imbalance (simplified)
            if 'bid_size' in df.columns and 'ask_size' in df.columns:
                bid_size = df['bid_size'].iloc[-1]
                ask_size = df['ask_size'].iloc[-1]
                features['ob_imbalance'] = (bid_size - ask_size) / (bid_size + ask_size + 1e-8)
        
        return features
    
    def _compute_trade_flow_features(self, df: pd.DataFrame) -> Dict[str, float]:
        """Trade flow and aggressor features"""
        features = {}
        
        if len(df) < 10:
            return features
        
        close = df['close']
        volume = df['volume']
        
        # Volume features
        features['flow_volume_sma'] = volume.tail(20).mean()
        features['flow_volume_ratio'] = volume.iloc[-1] / (features['flow_volume_sma'] + 1e-8)
        
        # Price velocity
        if len(close) >= 2:
            returns = close.pct_change().dropna()
            features['flow_return_1h'] = returns.iloc[-1]
            features['flow_return_24h'] = returns.tail(24).sum()
            features['flow_volatility_24h'] = returns.tail(24).std() * np.sqrt(24)
        
        # Trade aggressor (simplified - assumes buys on up candles)
        if len(df) >= 2:
            last_close = close.iloc[-1]
            prev_close = close.iloc[-2]
            last_volume = volume.iloc[-1]
            
            if last_close > prev_close:
                features['flow_aggressor_bid'] = 1.0
                features['flow_aggressor_ask'] = 0.0
            else:
                features['flow_aggressor_bid'] = 0.0
                features['flow_aggressor_ask'] = 1.0
            
            features['flow_aggressor_volume'] = last_volume
        
        return features
    
    def _compute_volatility_features(self, df: pd.DataFrame) -> Dict[str, float]:
        """Volatility and risk features"""
        features = {}
        
        if len(df) < 20:
            return features
        
        close = df['close']
        high = df['high']
        low = df['low']
        
        # Price-based volatility
        returns = close.pct_change().dropna()
        
        features['vol_realized_24h'] = returns.tail(24).std() * np.sqrt(24)
        features['vol_realized_7d'] = returns.tail(24*7).std() * np.sqrt(24*7)
        
        # ATR (Average True Range)
        tr1 = high - low
        tr2 = abs(high - close.shift())
        tr3 = abs(low - close.shift())
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        features['vol_atr_14'] = tr.tail(14).mean()
        features['vol_atr_pct'] = features['vol_atr_14'] / close.iloc[-1] if close.iloc[-1] > 0 else 0
        
        # Volatility regime
        vol_short = returns.tail(12).std()
        vol_long = returns.tail(48).std()
        features['vol_regime'] = vol_short / (vol_long + 1e-8)
        
        return features
    
    def _compute_momentum_features(self, df: pd.DataFrame) -> Dict[str, float]:
        """Momentum and trend features"""
        features = {}
        
        if len(df) < 50:
            return features
        
        close = df['close']
        
        # Moving averages
        features['mom_sma_20'] = close.tail(20).mean()
        features['mom_sma_50'] = close.tail(50).mean()
        
        # Distance from MAs
        current = close.iloc[-1]
        features['mom_dist_sma20'] = (current - features['mom_sma_20']) / features['mom_sma_20'] if features['mom_sma_20'] > 0 else 0
        features['mom_dist_sma50'] = (current - features['mom_sma_50']) / features['mom_sma_50'] if features['mom_sma_50'] > 0 else 0
        
        # Trend strength
        features['mom_trend_aligned'] = 1.0 if (features['mom_dist_sma20'] > 0 and features['mom_dist_sma50'] > 0) or (features['mom_dist_sma20'] < 0 and features['mom_dist_sma50'] < 0) else 0.0
        
        # RSI
        delta = close.diff()
        gain = (delta.where(delta > 0, 0)).tail(14).mean()
        loss = (-delta.where(delta < 0, 0)).tail(14).mean()
        rs = gain / (loss + 1e-8)
        features['mom_rsi'] = 100 - (100 / (1 + rs))
        
        return features
    
    def _compute_microstructure_features(self, df: pd.DataFrame) -> Dict[str, float]:
        """Market microstructure signals"""
        features = {}
        
        if len(df) < 20:
            return features
        
        close = df['close']
        volume = df['volume']
        
        # Kyle's lambda (price impact)
        returns = close.pct_change().dropna()
        if len(returns) > 0 and len(volume) > 0:
            signed_volume = volume.iloc[-len(returns):] * np.sign(returns)
            lambda_val = np.cov(returns, signed_volume)[0, 1] / (np.var(signed_volume) + 1e-8)
            features['micro_kyle_lambda'] = abs(lambda_val)
        
        # Amihud illiquidity
        if len(df) > 1:
            dollar_volume = volume * close
            features['micro_amihud'] = abs(returns.iloc[-1]) / (dollar_volume.iloc[-1] + 1e-8)
        
        # Roll's spread estimator
        if len(returns) >= 2:
            autocov = np.cov(returns[:-1], returns[1:])[0, 1]
            features['micro_roll_spread'] = 2 * np.sqrt(max(-autocov, 0))
        
        return features
    
    def _compute_cross_asset_features(self, symbol: str, 
                                     external_data: Dict) -> Dict[str, float]:
        """Cross-asset correlation features"""
        features = {}
        
        if 'dominant_asset' in external_data:
            dom_returns = external_data['dominant_asset']['returns']
            symbol_returns = external_data.get('returns', [])
            
            if len(dom_returns) > 0 and len(symbol_returns) > 0:
                min_len = min(len(dom_returns), len(symbol_returns))
                if min_len > 5:
                    correlation = np.corrcoef(dom_returns[:min_len], symbol_returns[:min_len])[0, 1]
                    features['cross_corr_dominant'] = correlation
        
        if 'sector_returns' in external_data:
            features['cross_sector_beta'] = external_data.get('sector_beta', 0)
        
        return features
    
    def get_feature_vector(self, symbol: str, timestamp: datetime,
                          feature_names: List[str] = None) -> np.ndarray:
        """Get feature vector for ML model input"""
        key = f"{symbol}_{timestamp.isoformat()}"
        
        if key not in self.features:
            logger.warning(f"Features not found for {key}")
            return np.array([])
        
        feature_set = self.features[key]
        
        if feature_names:
            values = [feature_set.features.get(f, 0.0) for f in feature_names]
        else:
            values = list(feature_set.features.values())
        
        return np.array(values)
    
    def list_available_features(self) -> List[str]:
        """List all unique feature names available"""
        all_features = set()
        for feature_set in self.features.values():
            all_features.update(feature_set.features.keys())
        return sorted(list(all_features))
    
    def save_registry(self):
        """Save feature metadata"""
        registry_path = self.data_dir / 'feature_registry.json'
        with open(registry_path, 'w') as f:
            json.dump(self.feature_registry, f, indent=2, default=str)
    
    def _load_registry(self):
        """Load feature metadata"""
        registry_path = self.data_dir / 'feature_registry.json'
        if registry_path.exists():
            with open(registry_path, 'r') as f:
                self.feature_registry = json.load(f)


if __name__ == "__main__":
    config = {'data_dir': 'data/features'}
    store = FeatureStore(config)
    
    # Generate sample data
    dates = pd.date_range('2024-01-01', periods=100, freq='h')
    df = pd.DataFrame({
        'open': 100 + np.cumsum(np.random.randn(100) * 0.01),
        'high': 102 + np.cumsum(np.random.randn(100) * 0.01),
        'low': 98 + np.cumsum(np.random.randn(100) * 0.01),
        'close': 100 + np.cumsum(np.random.randn(100) * 0.01),
        'volume': np.random.randint(1000, 10000, 100)
    }, index=dates)
    
    # Compute features
    feature_set = store.compute_all_features('BTCUSDT', df)
    
    print(f"\nComputed {len(feature_set.features)} features for {feature_set.symbol}")
    print("\nTop features:")
    for name, value in sorted(feature_set.features.items())[:10]:
        print(f"  {name}: {value:.4f}")
