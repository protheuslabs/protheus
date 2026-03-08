# Backtesting Engine
import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Callable
from datetime import datetime, timedelta
from dataclasses import dataclass, field
import json
from pathlib import Path

logger = logging.getLogger(__name__)

@dataclass
class BacktestResult:
    strategy_name: str
    start_date: datetime
    end_date: datetime
    initial_capital: float
    final_capital: float
    total_return_pct: float
    sharpe_ratio: float
    max_drawdown_pct: float
    win_rate: float
    total_trades: int
    profit_factor: float
    trades: List[Dict] = field(default_factory=list)
    equity_curve: List[Dict] = field(default_factory=list)

class BacktestingEngine:
    """
    Event-driven backtesting engine for strategy validation.
    
    Features:
    - Walk-forward analysis
    - Transaction cost modeling
    - Slippage simulation
    - Realistic order execution
    """
    
    def __init__(self, config: dict):
        self.config = config
        self.data_dir = Path(config.get('data_dir', 'data/historical'))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        
        # Trading costs
        self.commission_rate = config.get('commission_rate', 0.001)  # 0.1%
        self.slippage_model = config.get('slippage_model', 'fixed')  # fixed/volume based
        self.slippage_bps = config.get('slippage_bps', 5)  # 5 basis points
        
        # State
        self.current_capital = 0.0
        self.positions: Dict[str, Dict] = {}
        self.trade_history: List[Dict] = []
        self.equity_curve: List[Dict] = []
        
        logger.info(f"BacktestingEngine initialized")
    
    def load_historical_data(self, symbol: str, timeframe: str = '1h', 
                            start: datetime = None, end: datetime = None) -> pd.DataFrame:
        """Load historical OHLCV data"""
        file_path = self.data_dir / f"{symbol}_{timeframe}.csv"
        
        if not file_path.exists():
            logger.error(f"Historical data not found: {file_path}")
            return pd.DataFrame()
        
        df = pd.read_csv(file_path, parse_dates=['timestamp'])
        df.set_index('timestamp', inplace=True)
        
        if start:
            df = df[df.index >= start]
        if end:
            df = df[df.index <= end]
        
        return df
    
    def run_backtest(self, strategy: Callable, symbol: str, 
                     start_date: datetime, end_date: datetime,
                     initial_capital: float = 10000.0) -> BacktestResult:
        """Run a complete backtest"""
        logger.info(f"Starting backtest: {symbol} from {start_date} to {end_date}")
        
        self.current_capital = initial_capital
        self.positions = {}
        self.trade_history = []
        self.equity_curve = []
        
        # Load data
        df = self.load_historical_data(symbol, '1h', start_date, end_date)
        
        if df.empty:
            logger.error("No historical data available")
            return self._create_empty_result(strategy.__name__, start_date, end_date, initial_capital)
        
        # Event-driven simulation
        for timestamp, row in df.iterrows():
            market_data = {
                'timestamp': timestamp,
                'open': row['open'],
                'high': row['high'],
                'low': row['low'],
                'close': row['close'],
                'volume': row['volume']
            }
            
            # Update positions with current market data
            self._update_positions(market_data)
            
            # Generate signals from strategy
            try:
                signals = strategy(market_data, df.loc[:timestamp])
                
                # Execute signals
                for signal in signals:
                    self._execute_signal(signal, market_data)
                    
            except Exception as e:
                logger.error(f"Strategy error at {timestamp}: {e}")
            
            # Record equity
            self.equity_curve.append({
                'timestamp': timestamp.isoformat(),
                'equity': self._calculate_total_equity(market_data['close'])
            })
        
        # Close all positions at end
        self._close_all_positions(df['close'].iloc[-1])
        
        # Calculate metrics
        result = self._calculate_metrics(
            strategy.__name__, start_date, end_date, 
            initial_capital, self.current_capital
        )
        
        logger.info(f"Backtest complete: Return={result.total_return_pct:.2f}%, "
                   f"Trades={result.total_trades}, Sharpe={result.sharpe_ratio:.2f}")
        
        return result
    
    def _update_positions(self, market_data: dict):
        """Update position P&L with current market data"""
        pass  # Positions updated on close
    
    def _execute_signal(self, signal: dict, market_data: dict):
        """Execute a trading signal"""
        symbol = signal.get('symbol', 'UNKNOWN')
        direction = signal.get('direction')  # 'long' or 'short'
        quantity = signal.get('quantity', 0)
        
        if not direction or quantity <= 0:
            return
        
        # Get execution price with slippage
        execution_price = self._apply_slippage(
            market_data['close'], 
            direction, 
            market_data['volume']
        )
        
        # Calculate commission
        notional = quantity * execution_price
        commission = notional * self.commission_rate
        
        if direction == 'long':
            # Buy
            cost = notional + commission
            if cost <= self.current_capital:
                self.current_capital -= cost
                
                self.positions[symbol] = {
                    'quantity': quantity,
                    'entry_price': execution_price,
                    'entry_time': market_data['timestamp'],
                    'commission_paid': commission
                }
                
                self.trade_history.append({
                    'timestamp': market_data['timestamp'].isoformat(),
                    'symbol': symbol,
                    'action': 'buy',
                    'quantity': quantity,
                    'price': execution_price,
                    'commission': commission
                })
                
        elif direction == 'short':
            # Short sell (simplified - no borrow costs)
            self.positions[symbol] = {
                'quantity': -quantity,
                'entry_price': execution_price,
                'entry_time': market_data['timestamp'],
                'commission_paid': commission
            }
            
            self.current_capital += notional - commission
            
            self.trade_history.append({
                'timestamp': market_data['timestamp'].isoformat(),
                'symbol': symbol,
                'action': 'sell_short',
                'quantity': quantity,
                'price': execution_price,
                'commission': commission
            })
        
        # Check for exit signals
        if signal.get('exit', False) and symbol in self.positions:
            self._close_position(symbol, execution_price, market_data['timestamp'])
    
    def _apply_slippage(self, price: float, direction: str, volume: float) -> float:
        """Apply realistic slippage to execution price"""
        slippage_pct = self.slippage_bps / 10000
        
        if direction == 'long':
            return price * (1 + slippage_pct)
        else:
            return price * (1 - slippage_pct)
    
    def _close_position(self, symbol: str, current_price: float, timestamp: datetime):
        """Close a position"""
        if symbol not in self.positions:
            return
        
        position = self.positions[symbol]
        quantity = position['quantity']
        entry_price = position['entry_price']
        
        if quantity > 0:  # Long position
            notional = quantity * current_price
            commission = notional * self.commission_rate
            pnl = (current_price - entry_price) * quantity - commission - position['commission_paid']
            self.current_capital += notional - commission
            action = 'sell'
        else:  # Short position
            quantity = abs(quantity)
            notional = quantity * current_price
            commission = notional * self.commission_rate
            pnl = (entry_price - current_price) * quantity - commission - position['commission_paid']
            self.current_capital -= notional + commission
            action = 'buy_to_cover'
        
        self.trade_history.append({
            'timestamp': timestamp.isoformat(),
            'symbol': symbol,
            'action': action,
            'quantity': quantity,
            'price': current_price,
            'pnl': pnl,
            'commission': commission
        })
        
        del self.positions[symbol]
    
    def _close_all_positions(self, final_price: float):
        """Close all open positions"""
        for symbol in list(self.positions.keys()):
            self._close_position(symbol, final_price, datetime.now())
    
    def _calculate_total_equity(self, current_price: float) -> float:
        """Calculate total equity including open positions"""
        equity = self.current_capital
        
        for symbol, position in self.positions.items():
            market_value = position['quantity'] * current_price
            equity += market_value
        
        return equity
    
    def _calculate_metrics(self, strategy_name: str, start: datetime, 
                          end: datetime, initial: float, final: float) -> BacktestResult:
        """Calculate performance metrics"""
        
        # Basic metrics
        total_return = (final - initial) / initial * 100
        
        # Trade statistics
        closed_trades = [t for t in self.trade_history if 'pnl' in t]
        total_trades = len(closed_trades)
        
        if total_trades == 0:
            return self._create_empty_result(strategy_name, start, end, initial)
        
        winning_trades = [t for t in closed_trades if t['pnl'] > 0]
        losing_trades = [t for t in closed_trades if t['pnl'] <= 0]
        
        win_rate = len(winning_trades) / total_trades * 100
        
        gross_profit = sum(t['pnl'] for t in winning_trades)
        gross_loss = sum(t['pnl'] for t in losing_trades)
        profit_factor = abs(gross_profit / gross_loss) if gross_loss != 0 else float('inf')
        
        # Calculate Sharpe ratio from equity curve
        returns = []
        if len(self.equity_curve) > 1:
            for i in range(1, len(self.equity_curve)):
                e1 = self.equity_curve[i-1]['equity']
                e2 = self.equity_curve[i]['equity']
                returns.append((e2 - e1) / e1)
        
        if returns:
            avg_return = np.mean(returns)
            std_return = np.std(returns)
            sharpe = (avg_return / std_return) * np.sqrt(252) if std_return > 0 else 0
        else:
            sharpe = 0
        
        # Max drawdown
        max_dd = self._calculate_max_drawdown()
        
        return BacktestResult(
            strategy_name=strategy_name,
            start_date=start,
            end_date=end,
            initial_capital=initial,
            final_capital=final,
            total_return_pct=total_return,
            sharpe_ratio=sharpe,
            max_drawdown_pct=max_dd,
            win_rate=win_rate,
            total_trades=total_trades,
            profit_factor=profit_factor,
            trades=closed_trades,
            equity_curve=self.equity_curve
        )
    
    def _calculate_max_drawdown(self) -> float:
        """Calculate maximum drawdown from equity curve"""
        if not self.equity_curve:
            return 0.0
        
        values = [e['equity'] for e in self.equity_curve]
        peak = values[0]
        max_dd = 0.0
        
        for value in values:
            if value > peak:
                peak = value
            drawdown = (peak - value) / peak
            max_dd = max(max_dd, drawdown)
        
        return max_dd * 100
    
    def _create_empty_result(self, name: str, start: datetime, end: datetime, 
                            initial: float) -> BacktestResult:
        """Create empty result object"""
        return BacktestResult(
            strategy_name=name,
            start_date=start,
            end_date=end,
            initial_capital=initial,
            final_capital=initial,
            total_return_pct=0.0,
            sharpe_ratio=0.0,
            max_drawdown_pct=0.0,
            win_rate=0.0,
            total_trades=0,
            profit_factor=0.0
        )
    
    def save_results(self, result: BacktestResult, filename: str = None):
        """Save backtest results to file"""
        if not filename:
            filename = f"backtest_{result.strategy_name}_{result.start_date.strftime('%Y%m%d')}.json"
        
        output_path = self.data_dir / filename
        
        result_dict = {
            'strategy': result.strategy_name,
            'start_date': result.start_date.isoformat(),
            'end_date': result.end_date.isoformat(),
            'initial_capital': result.initial_capital,
            'final_capital': result.final_capital,
            'total_return_pct': result.total_return_pct,
            'sharpe_ratio': result.sharpe_ratio,
            'max_drawdown_pct': result.max_drawdown_pct,
            'win_rate': result.win_rate,
            'total_trades': result.total_trades,
            'profit_factor': result.profit_factor,
            'trades': result.trades,
            'equity_curve': result.equity_curve
        }
        
        with open(output_path, 'w') as f:
            json.dump(result_dict, f, indent=2)
        
        logger.info(f"Backtest results saved to: {output_path}")


if __name__ == "__main__":
    # Example usage
    config = {
        'data_dir': 'data/historical',
        'commission_rate': 0.001,
        'slippage_bps': 5
    }
    
    engine = BacktestingEngine(config)
    
    # Simple strategy example
    def example_strategy(market_data, historical_df):
        signals = []
        if len(historical_df) > 20:
            sma20 = historical_df['close'].rolling(20).mean().iloc[-1]
            current = market_data['close']
            
            if current > sma20:
                signals.append({
                    'symbol': 'BTCUSDT',
                    'direction': 'long',
                    'quantity': 0.1
                })
        return signals
    
    # Run backtest
    result = engine.run_backtest(
        example_strategy, 
        'BTCUSDT',
        datetime(2024, 1, 1),
        datetime(2024, 1, 31),
        10000.0
    )
    
    print(f"Return: {result.total_return_pct:.2f}%")
    print(f"Sharpe: {result.sharpe_ratio:.2f}")
    print(f"Trades: {result.total_trades}")
