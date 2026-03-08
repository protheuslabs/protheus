# Portfolio Optimization Engine
import logging
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from scipy.optimize import minimize

logger = logging.getLogger(__name__)

@dataclass
class PositionAllocation:
    symbol: str
    target_weight: float
    current_weight: float
    delta: float
    expected_alpha: float
    risk_contribution: float

class PortfolioOptimizer:
    """
    Portfolio-level optimization for capital allocation.
    
    Moves from symbol-by-symbol trading to portfolio-aware allocation:
    - Mean-variance optimization
    - Risk parity weighting
    - Sector neutrality
    - Volatility targeting
    - Correlation control
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.target_volatility = config.get('target_volatility', 0.15)  # 15% annual
        self.max_position_pct = config.get('max_position_pct', 0.20)  # 20%
        self.min_position_pct = config.get('min_position_pct', 0.01)  # 1%
        self.risk_aversion = config.get('risk_aversion', 1.0)
        
        # Sector constraints
        self.sector_neutrality = config.get('sector_neutrality', False)
        self.max_sector_deviation = config.get('max_sector_deviation', 0.05)
        
        # Risk budget
        self.use_risk_parity = config.get('use_risk_parity', True)
        
        logger.info(f"PortfolioOptimizer initialized: target_vol={self.target_volatility}")
    
    def optimize(self, signals: List[Dict], 
                 current_positions: Dict[str, float],
                 capital: float,
                 price_data: Dict[str, pd.DataFrame]) -> List[PositionAllocation]:
        """
        Optimize portfolio allocation given signals and constraints
        
        Args:
            signals: List of trading signals with expected returns
            current_positions: Current position sizes
            capital: Total capital available
            price_data: Historical price data for covariance estimation
        """
        if not signals:
            return []
        
        # Extract symbols and expected returns
        symbols = [s['symbol'] for s in signals]
        expected_returns = np.array([s.get('expected_return', 0) for s in signals])
        
        # Estimate covariance matrix
        returns_matrix = self._estimate_returns_matrix(price_data, symbols)
        cov_matrix = np.cov(returns_matrix.T) if returns_matrix.shape[0] > 0 else np.eye(len(symbols)) * 0.01
        
        # Current weights
        current_weights = np.array([
            current_positions.get(s, 0) * self._get_price(price_data, s) / capital 
            if capital > 0 else 0
            for s in symbols
        ])
        
        # Optimization objective
        def objective(weights):
            # Mean-variance optimization
            portfolio_return = np.sum(weights * expected_returns)
            portfolio_variance = np.dot(weights.T, np.dot(cov_matrix, weights))
            
            # Risk-adjusted return (negative for minimization)
            utility = portfolio_return - 0.5 * self.risk_aversion * portfolio_variance
            
            # Transaction cost penalty
            turnover = np.sum(np.abs(weights - current_weights))
            transaction_cost = turnover * 0.001
            
            return -(utility - transaction_cost)
        
        # Constraints
        constraints = [
            {'type': 'eq', 'fun': lambda w: np.sum(w) - 1.0}  # Sum to 1
        ]
        
        # Volatility constraint
        def vol_constraint(weights):
            port_var = np.dot(weights.T, np.dot(cov_matrix, weights))
            port_vol = np.sqrt(port_var) * np.sqrt(252)  # Annualize
            return self.target_volatility - port_vol  # Must be >= 0
        
        constraints.append({'type': 'ineq', 'fun': vol_constraint})
        
        # Bounds
        bounds = tuple((0, self.max_position_pct) for _ in symbols)
        
        # Initial guess (proportional to expected return)
        if np.sum(np.abs(expected_returns)) > 0:
            initial_weights = np.abs(expected_returns) / np.sum(np.abs(expected_returns))
        else:
            initial_weights = np.ones(len(symbols)) / len(symbols)
        
        # Optimize
        try:
            result = minimize(
                objective,
                initial_weights,
                method='SLSQP',
                bounds=bounds,
                constraints=constraints,
                options={'maxiter': 1000}
            )
            
            optimal_weights = result.x
            
        except Exception as e:
            logger.error(f"Optimization failed: {e}")
            optimal_weights = initial_weights
        
        # Create allocations
        allocations = []
        for i, symbol in enumerate(symbols):
            risk_contrib = optimal_weights[i] * np.dot(cov_matrix[i], optimal_weights) / \
                          (np.dot(optimal_weights.T, np.dot(cov_matrix, optimal_weights)) + 1e-8)
            
            allocations.append(PositionAllocation(
                symbol=symbol,
                target_weight=optimal_weights[i],
                current_weight=current_weights[i],
                delta=optimal_weights[i] - current_weights[i],
                expected_alpha=expected_returns[i],
                risk_contribution=risk_contrib
            ))
        
        return allocations
    
    def optimize_risk_parity(self, price_data: Dict[str, pd.DataFrame], 
                            symbols: List[str]) -> Dict[str, float]:
        """
        Risk parity: equal risk contribution from each asset
        """
        # Estimate covariance matrix
        returns_matrix = self._estimate_returns_matrix(price_data, symbols)
        cov_matrix = np.cov(returns_matrix.T) if returns_matrix.size > 0 else np.eye(len(symbols)) * 0.01
        
        def risk_parity_obj(weights):
            port_var = np.dot(weights.T, np.dot(cov_matrix, weights))
            marginal_risks = np.dot(cov_matrix, weights)
            risk_contribs = weights * marginal_risks
            
            # Target: equal risk contribution
            target_risk = port_var / len(symbols)
            error = np.sum((risk_contribs - target_risk) ** 2)
            
            return error
        
        # Constraints
        constraints = [
            {'type': 'eq', 'fun': lambda w: np.sum(w) - 1.0}
        ]
        
        bounds = tuple((self.min_position_pct, self.max_position_pct) for _ in symbols)
        initial_weights = np.ones(len(symbols)) / len(symbols)
        
        try:
            result = minimize(
                risk_parity_obj,
                initial_weights,
                method='SLSQP',
                bounds=bounds,
                constraints=constraints
            )
            
            weights = dict(zip(symbols, result.x))
            
        except Exception as e:
            logger.error(f"Risk parity optimization failed: {e}")
            weights = {s: 1.0/len(symbols) for s in symbols}
        
        return weights
    
    def volatility_targeting(self, target_positions: Dict[str, float],
                           price_data: Dict[str, pd.DataFrame],
                           target_vol: float = None) -> Dict[str, float]:
        """
        Scale positions to target portfolio volatility
        """
        if target_vol is None:
            target_vol = self.target_volatility
        
        symbols = list(target_positions.keys())
        
        # Calculate portfolio volatility
        weights = np.array([target_positions[s] for s in symbols])
        weights = weights / (np.sum(np.abs(weights)) + 1e-8)  # Normalize
        
        returns_matrix = self._estimate_returns_matrix(price_data, symbols)
        if returns_matrix.size == 0:
            return target_positions
        
        cov_matrix = np.cov(returns_matrix.T)
        current_vol = np.sqrt(np.dot(weights.T, np.dot(cov_matrix, weights))) * np.sqrt(252)
        
        # Scale factor
        if current_vol > 0:
            scale = target_vol / current_vol
        else:
            scale = 1.0
        
        # Apply scaling
        scaled_positions = {s: p * scale for s, p in target_positions.items()}
        
        logger.info(f"Vol targeting: current={current_vol:.2%}, target={target_vol:.2%}, scale={scale:.2f}")
        
        return scaled_positions
    
    def _estimate_returns_matrix(self, price_data: Dict, symbols: List[str], 
                                lookback: int = 30) -> np.ndarray:
        """Extract returns matrix from price data"""
        returns_list = []
        
        for symbol in symbols:
            if symbol in price_data:
                df = price_data[symbol]
                if 'close' in df.columns and len(df) > lookback:
                    returns = df['close'].pct_change().dropna().tail(lookback)
                    returns_list.append(returns.values)
                else:
                    returns_list.append(np.zeros(lookback))
            else:
                returns_list.append(np.zeros(lookback))
        
        if returns_list:
            min_len = min(len(r) for r in returns_list)
            if min_len > 0:
                returns_matrix = np.column_stack([r[:min_len] for r in returns_list])
                return returns_matrix
        
        return np.eye(len(symbols)) * 0.001  # Default minimal covariance
    
    def _get_price(self, price_data: Dict, symbol: str) -> float:
        """Get current price for symbol"""
        if symbol in price_data:
            df = price_data[symbol]
            if 'close' in df.columns and len(df) > 0:
                return df['close'].iloc[-1]
        return 100.0  # Default


if __name__ == "__main__":
    # Example usage
    config = {
        'target_volatility': 0.15,
        'max_position_pct': 0.25,
        'risk_aversion': 1.5,
        'use_risk_parity': True
    }
    
    optimizer = PortfolioOptimizer(config)
    
    # Example signals
    signals = [
        {'symbol': 'BTCUSDT', 'expected_return': 0.02, 'confidence': 0.7},
        {'symbol': 'ETHUSDT', 'expected_return': 0.015, 'confidence': 0.65},
        {'symbol': 'SOLUSDT', 'expected_return': 0.025, 'confidence': 0.6}
    ]
    
    current_positions = {'BTCUSDT': 0.1, 'ETHUSDT': 0.05}
    capital = 10000
    
    # Generate synthetic price data
    price_data = {}
    for symbol in ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']:
        dates = pd.date_range('2024-01-01', periods=100, freq='h')
        price = 100 + np.cumsum(np.random.randn(100) * 0.02)
        price_data[symbol] = pd.DataFrame({'close': price}, index=dates)
    
    allocations = optimizer.optimize(signals, current_positions, capital, price_data)
    
    print("Optimal Allocations:")
    for alloc in allocations:
        print(f"{alloc.symbol}: {alloc.target_weight:.2%} (risk: {alloc.risk_contribution:.2%})")
