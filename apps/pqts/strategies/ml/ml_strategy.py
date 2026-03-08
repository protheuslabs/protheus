# Machine Learning Strategy
import logging
import numpy as np
import pandas as pd
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timedelta
import joblib
from pathlib import Path

logger = logging.getLogger(__name__)

@dataclass
class MLSignal:
    symbol: str
    direction: str  # 'long', 'short', 'neutral'
    confidence: float
    predicted_return: float
    features: Dict[str, float]
    model_version: str

class MLStrategy:
    """
    Machine Learning-based trading strategy.
    Uses ensemble of models for prediction.
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.enabled = config.get('enabled', False)
        self.model_type = config.get('model_type', 'ensemble')
        self.prediction_horizon = config.get('prediction_horizon', '1h')
        self.confidence_threshold = config.get('confidence_threshold', 0.6)
        self.retrain_interval_hours = config.get('retrain_interval_hours', 24)
        
        self.models = {}
        self.feature_importance = {}
        self.last_training_time = None
        self.model_version = "1.0.0"
        
        # Model paths
        self.model_dir = Path(config.get('model_dir', 'models'))
        self.model_dir.mkdir(exist_ok=True)
        
        logger.info(f"MLStrategy initialized: model={self.model_type}")
    
    async def generate_signals(self, market_data: dict) -> List[MLSignal]:
        """Generate ML-based trading signals"""
        if not self.enabled:
            return []
        
        signals = []
        
        for symbol, data in market_data.items():
            try:
                # Extract features
                features = self._extract_features(data)
                
                # Make prediction
                prediction = self._predict(symbol, features)
                
                if prediction and prediction['confidence'] >= self.confidence_threshold:
                    signals.append(MLSignal(
                        symbol=symbol,
                        direction=prediction['direction'],
                        confidence=prediction['confidence'],
                        predicted_return=prediction['predicted_return'],
                        features=features,
                        model_version=self.model_version
                    ))
                    
            except Exception as e:
                logger.error(f"Error generating ML signal for {symbol}: {e}")
        
        return signals
    
    def _extract_features(self, data: dict) -> Dict[str, float]:
        """Extract features from market data"""
        features = {}
        
        # Price-based features
        if 'close' in data:
            close = data['close']
            features['returns_1h'] = data.get('returns_1h', 0)
            features['returns_24h'] = data.get('returns_24h', 0)
            features['volatility_24h'] = data.get('volatility_24h', 0)
        
        # Technical indicator features
        features['rsi'] = data.get('rsi', 50)
        features['macd'] = data.get('macd', 0)
        features['adx'] = data.get('adx', 0)
        
        # Volume features
        if 'volume' in data:
            features['volume_ratio'] = data.get('volume_ratio', 1.0)
            features['obv_slope'] = data.get('obv_slope', 0)
        
        # Market structure features
        features['distance_from_sma20'] = data.get('distance_from_sma20', 0)
        features['distance_from_sma50'] = data.get('distance_from_sma50', 0)
        
        return features
    
    def _predict(self, symbol: str, features: Dict[str, float]) -> Optional[Dict]:
        """Make prediction using loaded models"""
        if symbol not in self.models:
            # Load or initialize model
            self._load_model(symbol)
        
        model = self.models.get(symbol)
        if not model:
            return None
        
        # Convert features to array
        feature_array = np.array(list(features.values())).reshape(1, -1)
        
        try:
            # Make prediction
            prediction = model.predict(feature_array)[0]
            probabilities = model.predict_proba(feature_array)[0]
            
            # Map to direction
            if prediction == 1:
                direction = 'long'
                confidence = probabilities[1]
            elif prediction == -1:
                direction = 'short'
                confidence = probabilities[0]
            else:
                direction = 'neutral'
                confidence = max(probabilities)
            
            return {
                'direction': direction,
                'confidence': confidence,
                'predicted_return': prediction * 0.01  # Scale factor
            }
            
        except Exception as e:
            logger.error(f"Prediction error: {e}")
            return None
    
    def _load_model(self, symbol: str):
        """Load or initialize model for symbol"""
        model_path = self.model_dir / f"{symbol}_{self.model_type}.pkl"
        
        if model_path.exists():
            try:
                self.models[symbol] = joblib.load(model_path)
                logger.info(f"Loaded model for {symbol}")
            except Exception as e:
                logger.error(f"Failed to load model for {symbol}: {e}")
                self._init_model(symbol)
        else:
            self._init_model(symbol)
    
    def _init_model(self, symbol: str):
        """Initialize new model"""
        from sklearn.ensemble import RandomForestClassifier
        
        # Initialize with default parameters
        model = RandomForestClassifier(
            n_estimators=100,
            max_depth=10,
            random_state=42
        )
        
        self.models[symbol] = model
        logger.info(f"Initialized new model for {symbol}")
    
    async def train(self, historical_data: pd.DataFrame, symbol: str):
        """Train model on historical data"""
        logger.info(f"Training model for {symbol}...")
        
        try:
            # Prepare features and labels
            X, y = self._prepare_training_data(historical_data)
            
            if len(X) < 100:
                logger.warning(f"Insufficient data for training: {len(X)} samples")
                return False
            
            # Train model
            model = self.models.get(symbol)
            if not model:
                self._init_model(symbol)
                model = self.models[symbol]
            
            model.fit(X, y)
            
            # Save model
            model_path = self.model_dir / f"{symbol}_{self.model_type}.pkl"
            joblib.dump(model, model_path)
            
            # Update feature importance
            if hasattr(model, 'feature_importances_'):
                self.feature_importance[symbol] = dict(
                    zip(self._get_feature_names(), model.feature_importances_)
                )
            
            self.last_training_time = datetime.utcnow()
            self.model_version = f"1.0.{int(self.last_training_time.timestamp())}"
            
            logger.info(f"Model trained for {symbol}: version={self.model_version}")
            return True
            
        except Exception as e:
            logger.error(f"Training failed for {symbol}: {e}")
            return False
    
    def _prepare_training_data(self, df: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
        """Prepare training data from historical prices"""
        # Calculate features
        df['returns'] = df['close'].pct_change()
        df['returns_future'] = df['returns'].shift(-1)
        
        # Create labels: 1 = up, -1 = down, 0 = neutral
        df['label'] = np.where(df['returns_future'] > 0.001, 1,
                              np.where(df['returns_future'] < -0.001, -1, 0))
        
        # Feature engineering
        features = pd.DataFrame()
        features['rsi'] = self._calculate_rsi(df['close'])
        features['macd'] = self._calculate_macd(df['close'])
        features['atr'] = self._calculate_atr(df)
        features['volume_ratio'] = df['volume'] / df['volume'].rolling(20).mean()
        
        # Drop NaN
        features = features.dropna()
        labels = df['label'].loc[features.index]
        
        return features.values, labels.values
    
    def _calculate_rsi(self, prices: pd.Series, period: int = 14) -> pd.Series:
        """Calculate RSI"""
        delta = prices.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / loss
        return 100 - (100 / (1 + rs))
    
    def _calculate_macd(self, prices: pd.Series) -> pd.Series:
        """Calculate MACD"""
        ema12 = prices.ewm(span=12).mean()
        ema26 = prices.ewm(span=26).mean()
        return ema12 - ema26
    
    def _calculate_atr(self, df: pd.DataFrame, period: int = 14) -> pd.Series:
        """Calculate ATR"""
        high_low = df['high'] - df['low']
        high_close = abs(df['high'] - df['close'].shift())
        low_close = abs(df['low'] - df['close'].shift())
        tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
        return tr.rolling(window=period).mean()
    
    def _get_feature_names(self) -> List[str]:
        """Get list of feature names"""
        return ['rsi', 'macd', 'atr', 'volume_ratio']
