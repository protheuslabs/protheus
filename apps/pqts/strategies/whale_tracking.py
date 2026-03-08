# Whale Tracking & Copy Trading Strategy
import logging
import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from collections import defaultdict
import hashlib

logger = logging.getLogger(__name__)

@dataclass
class WhaleProfile:
    """Profile of a tracked whale trader"""
    wallet_id: str
    first_seen: datetime
    total_pnl: float
    total_volume: float
    win_rate: float
    sharpe: float
    consistency_score: float
    trades_count: int
    avg_trade_size: float
    markets_traded: List[str]
    confidence_score: float
    rank: int = 0
    last_updated: datetime = field(default_factory=datetime.now)

@dataclass
class WhaleSignal:
    """Signal generated from whale activity"""
    wallet_id: str
    market: str
    signal_type: str  # 'entry', 'exit', 'increase', 'decrease'
    direction: str    # 'buy', 'sell'
    size: float
    confidence: float
    timestamp: datetime
    price_at_signal: float
    whale_position_before: float
    whale_position_after: float

class WhaleTracker:
    """
    Tracks profitable wallets and generates copy trading signals.
    
    Key insight: Some traders have persistent edge due to information
    access (journalists, insiders, experienced quants). Their trades
    reveal alpha before price moves.
    
    This module discovers, ranks, and follows the most profitable whales.
    """
    
    def __init__(self, config: dict):
        self.config = config
        
        # Tracking parameters
        self.min_trades_for_ranking = config.get('min_trades', 10)
        self.min_profit_for_whale = config.get('min_profit', 1000)
        self.lookback_days = config.get('lookback_days', 30)
        self.top_percentile = config.get('top_percentile', 0.05)  # Top 5%
        
        # Signal parameters
        self.signal_strength_threshold = config.get('signal_threshold', 0.3)
        self.latency_tolerance_ms = config.get('latency_ms', 500)
        
        # State
        self.whales: Dict[str, WhaleProfile] = {}
        self.wallet_history: Dict[str, List[Dict]] = defaultdict(list)
        self.market_whale_positions: Dict[str, Dict[str, float]] = defaultdict(dict)
        
        # Tracking which whales we're currently following
        self.followed_whales: List[str] = []
        self.whale_ranks: Dict[str, int] = {}
        
        logger.info(f"WhaleTracker initialized: min_trades={self.min_trades_for_ranking}")
    
    def process_trade(self, wallet_id: str, market: str, direction: str,
                     size: float, price: float, timestamp: datetime,
                     position_after: float):
        """
        Process a trade from the blockchain/API.
        
        Called for every trade to build whale profiles.
        """
        trade = {
            'wallet_id': wallet_id,
            'market': market,
            'direction': direction,
            'size': size,
            'price': price,
            'timestamp': timestamp,
            'position_after': position_after
        }
        
        # Store in wallet history
        self.wallet_history[wallet_id].append(trade)
        
        # Update position tracking
        self.market_whale_positions[market][wallet_id] = position_after
        
        # Clean old history
        cutoff = timestamp - timedelta(days=self.lookback_days)
        self.wallet_history[wallet_id] = [
            t for t in self.wallet_history[wallet_id] 
            if t['timestamp'] > cutoff
        ]
        
        # Recalculate whale profile periodically
        if len(self.wallet_history[wallet_id]) % 5 == 0:
            self._update_whale_profile(wallet_id)
    
    def _update_whale_profile(self, wallet_id: str):
        """Calculate or update whale ranking metrics."""
        trades = self.wallet_history[wallet_id]
        
        if len(trades) < self.min_trades_for_ranking:
            return
        
        # Calculate metrics
        pnls = []
        wins = 0
        volumes = []
        markets = set()
        
        for i in range(1, len(trades)):
            trade = trades[i]
            prev_trade = trades[i-1]
            
            # Simple PnL estimation
            if trade['direction'] == prev_trade['direction']:
                # Same direction - unrealized PnL
                pnl = (trade['price'] - prev_trade['price']) / prev_trade['price']
                if prev_trade['direction'] == 'sell':
                    pnl = -pnl
            else:
                # Reversal - close position
                pnl = (trade['price'] - prev_trade['price']) / prev_trade['price']
                if prev_trade['direction'] == 'sell':
                    pnl = -pnl
            
            pnls.append(pnl)
            volumes.append(trade['size'] * trade['price'])
            markets.add(trade['market'])
            
            if pnl > 0:
                wins += 1
        
        if not pnls:
            return
        
        total_pnl = sum(pnls)
        win_rate = wins / len(pnls)
        sharpe = np.mean(pnls) / (np.std(pnls) + 1e-8)
        total_volume = sum(volumes)
        
        # Consistency: do they win consistently or have big swings?
        consistency = 1 - (np.std(pnls) / (abs(np.mean(pnls)) + 0.01))
        
        # Confidence score combines multiple factors
        confidence = (
            min(sharpe, 3) / 3 * 0.3 +  # Sharpe (capped at 3)
            win_rate * 0.3 +              # Win rate
            min(total_pnl, 10) / 10 * 0.2 +  # Total PnL
            max(0, consistency) * 0.2     # Consistency
        )
        
        profile = WhaleProfile(
            wallet_id=wallet_id,
            first_seen=min(t['timestamp'] for t in trades),
            total_pnl=total_pnl,
            total_volume=total_volume,
            win_rate=win_rate,
            sharpe=sharpe,
            consistency_score=consistency,
            trades_count=len(trades),
            avg_trade_size=np.mean(volumes),
            markets_traded=list(markets),
            confidence_score=confidence,
            last_updated=datetime.now()
        )
        
        self.whales[wallet_id] = profile
        
        # Update rankings
        self._update_rankings()
    
    def _update_rankings(self):
        """Rank all whales and identify top performers."""
        if not self.whales:
            return
        
        # Sort by confidence score
        sorted_whales = sorted(
            self.whales.values(),
            key=lambda w: w.confidence_score,
            reverse=True
        )
        
        # Assign ranks
        for i, whale in enumerate(sorted_whales, 1):
            whale.rank = i
            self.whale_ranks[whale.wallet_id] = i
        
        # Identify top whales to follow
        n_top = max(1, int(len(sorted_whales) * self.top_percentile))
        self.followed_whales = [w.wallet_id for w in sorted_whales[:n_top]]
        
        logger.info(f"Updated whale rankings: tracking {len(self.followed_whales)} top whales")
    
    def detect_signals(self, market: str, lookback_seconds: int = 60) -> List[WhaleSignal]:
        """
        Detect entry/exit signals from whale activity.
        
        Called continuously to find trading opportunities.
        """
        signals = []
        now = datetime.now()
        cutoff = now - timedelta(seconds=lookback_seconds)
        
        # Get recent trades from followed whales
        for whale_id in self.followed_whales:
            if whale_id not in self.whales:
                continue
            
            whale = self.whales[whale_id]
            trades = self.wallet_history[whale_id]
            
            # Find recent trades in this market
            recent_trades = [
                t for t in trades 
                if t['market'] == market and t['timestamp'] > cutoff
            ]
            
            if not recent_trades:
                continue
            
            # Analyze position change
            latest_trade = recent_trades[-1]
            prev_position = 0 if len(recent_trades) < 2 else recent_trades[-2]['position_after']
            curr_position = latest_trade['position_after']
            
            position_change = curr_position - prev_position
            
            if abs(position_change) < self.signal_strength_threshold * latest_trade['size']:
                continue  # Change too small
            
            # Determine signal type
            if prev_position == 0 and curr_position != 0:
                signal_type = 'entry'
            elif curr_position == 0:
                signal_type = 'exit'
            elif abs(curr_position) > abs(prev_position):
                signal_type = 'increase'
            else:
                signal_type = 'decrease'
            
            # Create signal
            signal = WhaleSignal(
                wallet_id=whale_id,
                market=market,
                signal_type=signal_type,
                direction='buy' if curr_position > 0 else 'sell',
                size=abs(position_change),
                confidence=whale.confidence_score,
                timestamp=latest_trade['timestamp'],
                price_at_signal=latest_trade['price'],
                whale_position_before=prev_position,
                whale_position_after=curr_position
            )
            
            signals.append(signal)
        
        # Sort by confidence and recency
        signals.sort(key=lambda s: (s.confidence, s.timestamp), reverse=True)
        
        return signals
    
    def calculate_signal_strength(self, signal: WhaleSignal,
                                our_position: float) -> Tuple[float, str]:
        """
        Calculate how strongly we should follow this signal.
        
        Returns (strength, action) where action is one of:
        - 'follow': Strong signal, take full position
        - 'partial': Moderate signal, take partial position
        - 'ignore': Weak or conflicting signal
        """
        whale = self.whales.get(signal.wallet_id)
        if not whale:
            return 0, 'ignore'
        
        # Base strength from whale confidence
        strength = signal.confidence
        
        # Adjust for signal type
        if signal.signal_type == 'entry':
            strength *= 1.0
        elif signal.signal_type == 'increase':
            strength *= 0.8
        elif signal.signal_type == 'exit':
            # Exits are often more reliable
            strength *= 1.2
        elif signal.signal_type == 'decrease':
            strength *= 0.9
        
        # Check if we're already in same direction
        if our_position != 0:
            our_direction = 'buy' if our_position > 0 else 'sell'
            if signal.direction == our_direction:
                if signal.signal_type in ['increase', 'entry']:
                    # Same direction, add more
                    strength *= 0.7  # Reduce to avoid overexposure
                else:
                    # Reducing while we're holding - exit signal
                    strength = min(strength * 1.5, 1.0)
            else:
                # Opposite direction - strong reversal signal
                strength *= 1.3
        
        # Determine action
        if strength > 0.7:
            return strength, 'follow'
        elif strength > 0.4:
            return strength, 'partial'
        else:
            return strength, 'ignore'
    
    def get_top_whales_report(self, n: int = 10) -> pd.DataFrame:
        """Generate report of top whales."""
        if not self.whales:
            return pd.DataFrame()
        
        sorted_whales = sorted(
            self.whales.values(),
            key=lambda w: w.confidence_score,
            reverse=True
        )
        
        data = []
        for whale in sorted_whales[:n]:
            data.append({
                'wallet_id': whale.wallet_id[:20] + '...',
                'rank': whale.rank,
                'pnl': whale.total_pnl,
                'sharpe': whale.sharpe,
                'win_rate': whale.win_rate,
                'trades': whale.trades_count,
                'markets': len(whale.markets_traded),
                'confidence': whale.confidence_score,
                'followed': whale.wallet_id in self.followed_whales
            })
        
        return pd.DataFrame(data)
    
    def predict_whale_action(self, wallet_id: str, market: str,
                           features: Dict) -> Tuple[str, float]:
        """
        Predict if a whale will trade soon.
        
        Advanced: Model whale behavior to front-run their trades.
        Uses features like:
        - Time since last trade
        - Market volatility
        - Whale's typical holding period
        """
        if wallet_id not in self.whales:
            return 'none', 0.0
        
        whale = self.whales[wallet_id]
        trades = self.wallet_history[wallet_id]
        
        if len(trades) < 3:
            return 'none', 0.0
        
        # Calculate average holding period
        holding_periods = []
        for i in range(1, len(trades)):
            if trades[i]['direction'] != trades[i-1]['direction']:
                holding_periods.append(
                    (trades[i]['timestamp'] - trades[i-1]['timestamp']).total_seconds()
                )
        
        avg_holding = np.mean(holding_periods) if holding_periods else 86400
        
        # Time since last trade
        last_trade = trades[-1]
        time_since = (datetime.now() - last_trade['timestamp']).total_seconds()
        
        # Position age
        position_age = time_since
        position_duration_score = min(position_age / avg_holding, 1.0)
        
        # Market volatility (would come from features)
        vol_score = features.get('volatility', 0.5)
        
        # Combine
        trade_probability = (
            position_duration_score * 0.4 +
            vol_score * 0.3 +
            whale.win_rate * 0.2 +
            (1 if features.get('market_moving', False) else 0) * 0.1
        )
        
        if last_trade['direction'] == 'buy':
            predicted = 'sell' if trade_probability > 0.5 else 'hold'
        else:
            predicted = 'buy' if trade_probability > 0.5 else 'hold'
        
        return predicted, trade_probability


class WhaleCopyStrategy:
    """
    Trading strategy that copies top whale movements.
    
    Integrates with WhaleTracker to generate actionable signals.
    """
    
    def __init__(self, tracker: WhaleTracker, config: dict):
        self.tracker = tracker
        self.config = config
        self.position_size_pct = config.get('position_size', 0.05)  # 5% per whale
        self.max_positions = config.get('max_positions', 5)
        self.stop_loss_pct = config.get('stop_loss', 0.03)
        
        self.positions: Dict[str, Dict] = {}
        self.trade_history: List[Dict] = []
    
    def on_signal(self, signal: WhaleSignal, current_price: float) -> Optional[Dict]:
        """
        Process a whale signal and optionally generate a trade.
        
        Returns trade dict or None.
        """
        market = signal.market
        
        # Get current position
        current_pos = self.positions.get(market, {}).get('size', 0)
        
        # Calculate signal strength
        strength, action = self.tracker.calculate_signal_strength(signal, current_pos)
        
        if action == 'ignore':
            return None
        
        # Generate trade
        if signal.signal_type == 'entry' and current_pos == 0:
            # New entry
            if len(self.positions) >= self.max_positions:
                return None  # At max positions
            
            size = self.position_size_pct * (1 if action == 'follow' else 0.5)
            direction = 1 if signal.direction == 'buy' else -1
            
            trade = {
                'market': market,
                'action': 'enter',
                'side': signal.direction,
                'size': size,
                'confidence': strength,
                'whale_id': signal.wallet_id,
                'signal_type': signal.signal_type,
                'reason': f"Whale {signal.wallet_id[:8]} entered market"
            }
            
            self.positions[market] = {
                'size': size * direction,
                'entry_price': current_price,
                'whale_id': signal.wallet_id,
                'entry_time': datetime.now()
            }
            
            return trade
        
        elif signal.signal_type == 'exit' and current_pos != 0:
            # Exit our position
            trade = {
                'market': market,
                'action': 'exit',
                'side': 'sell' if current_pos > 0 else 'buy',
                'size': abs(current_pos),
                'confidence': strength,
                'whale_id': signal.wallet_id,
                'signal_type': signal.signal_type,
                'reason': f"Whale {signal.wallet_id[:8]} exited market"
            }
            
            if market in self.positions:
                del self.positions[market]
            
            return trade
        
        return None
    
    def check_stop_losses(self, market: str, current_price: float) -> Optional[Dict]:
        """Check if any positions hit stop loss."""
        if market not in self.positions:
            return None
        
        pos = self.positions[market]
        entry = pos['entry_price']
        current_return = (current_price - entry) / entry
        
        if pos['size'] > 0 and current_return < -self.stop_loss_pct:
            return {
                'market': market,
                'action': 'exit',
                'side': 'sell',
                'size': pos['size'],
                'reason': 'stop_loss',
                'confidence': 1.0
            }
        
        if pos['size'] < 0 and -current_return < -self.stop_loss_pct:
            return {
                'market': market,
                'action': 'exit',
                'side': 'buy',
                'size': abs(pos['size']),
                'reason': 'stop_loss',
                'confidence': 1.0
            }
        
        return None
    
    def get_stats(self) -> Dict:
        """Get strategy statistics."""
        total_trades = len(self.trade_history)
        winning_trades = sum(1 for t in self.trade_history if t.get('pnl', 0) > 0)
        
        return {
            'total_trades': total_trades,
            'win_rate': winning_trades / total_trades if total_trades > 0 else 0,
            'current_positions': len(self.positions),
            'whales_tracked': len(self.tracker.followed_whales),
            'avg_confidence': np.mean([t.get('confidence', 0) for t in self.trade_history]) if self.trade_history else 0
        }


if __name__ == "__main__":
    # Test
    config = {
        'min_trades': 5,
        'min_profit': 100,
        'lookback_days': 30,
        'top_percentile': 0.1
    }
    
    tracker = WhaleTracker(config)
    
    # Simulate whale trades
    wallets = ['whale_abc123', 'whale_def456', 'retail_789']
    markets = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP']
    
    # Generate 30 days of trades
    dates = pd.date_range('2024-02-01', periods=720, freq='h')
    
    for i, date in enumerate(dates):
        for wallet in wallets:
            if random.random() < 0.1:  # 10% chance of trade per hour
                market = random.choice(markets)
                direction = random.choice(['buy', 'sell'])
                size = random.uniform(1000, 50000) if 'whale' in wallet else random.uniform(100, 500)
                price = 100 + random.uniform(-10, 10)
                position = size * (1 if direction == 'buy' else -1)
                
                tracker.process_trade(wallet, market, direction, size, price, date, position)
    
    print("\n" + "="*70)
    print("WHALE TRACKING SYSTEM - TEST")
    print("="*70)
    
    # Print whale rankings
    print("\nTop Whales:")
    report = tracker.get_top_whales_report(5)
    print(report.to_string(index=False))
    
    # Detect signals
    print(f"\nFollowing {len(tracker.followed_whales)} whales")
    for whale_id in tracker.followed_whales[:3]:
        whale = tracker.whales[whale_id]
        print(f"  {whale_id[:20]}: Sharpe={whale.sharpe:.2f}, Win Rate={whale.win_rate:.1%}, Confidence={whale.confidence_score:.2f}")
    
    # Simulate detection
    signals = tracker.detect_signals('BTC-PERP', lookback_seconds=3600)
    
    print(f"\nDetected {len(signals)} signals in last hour")
    for signal in signals[:3]:
        print(f"  {signal.signal_type.upper()}: {signal.direction} {signal.market} "
              f"(conf={signal.confidence:.2f}, size=${signal.size:,.0f})")
    
    # Test strategy
    strategy = WhaleCopyStrategy(tracker, {'position_size': 0.05})
    
    print("\nStrategy initialized and ready to copy whales.")
