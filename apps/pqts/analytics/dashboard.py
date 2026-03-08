# Analytics Dashboard
import json
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class PerformanceMetrics:
    total_return_pct: float
    sharpe_ratio: float
    sortino_ratio: float
    max_drawdown_pct: float
    win_rate: float
    profit_factor: float
    avg_trade_return: float
    total_trades: int
    winning_trades: int
    losing_trades: int


@dataclass
class PositionSummary:
    symbol: str
    quantity: float
    avg_entry: float
    current_price: float
    unrealized_pnl: float
    unrealized_pnl_pct: float
    market: str


class AnalyticsDashboard:
    """
    Real-time analytics dashboard for trading performance.
    Tracks P&L, risk metrics, and strategy performance.
    """

    def __init__(self, config: dict):
        self.config = config
        self.data_dir = Path(config.get("data_dir", "data/analytics"))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.tca_db_path = str(config.get("tca_db_path", "data/tca_records.csv"))

        # Performance tracking
        self.daily_pnl = []
        self.trade_history = []
        self.equity_curve = []

        logger.info("AnalyticsDashboard initialized")

    def update_position(self, position: PositionSummary):
        """Update position in dashboard"""
        logger.info(f"Position update: {position.symbol} P&L=${position.unrealized_pnl:.2f}")

    def record_trade(self, trade: dict):
        """Record completed trade"""
        self.trade_history.append({**trade, "timestamp": datetime.utcnow().isoformat()})

        # Save to file
        self._save_trade_history()

    def update_equity(self, portfolio_value: float):
        """Update equity curve"""
        self.equity_curve.append(
            {"timestamp": datetime.utcnow().isoformat(), "value": portfolio_value}
        )

    def calculate_metrics(self, lookback_days: int = 30) -> PerformanceMetrics:
        """Calculate performance metrics"""
        if not self.trade_history:
            return PerformanceMetrics(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

        # Filter trades by lookback
        cutoff = datetime.utcnow() - timedelta(days=lookback_days)
        recent_trades = [
            t for t in self.trade_history if datetime.fromisoformat(t["timestamp"]) > cutoff
        ]

        if not recent_trades:
            return PerformanceMetrics(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

        # Calculate metrics
        returns = [t.get("return_pct", 0) for t in recent_trades]
        winning = [r for r in returns if r > 0]
        losing = [r for r in returns if r <= 0]

        total_return = sum(returns)
        win_rate = len(winning) / len(returns) if returns else 0

        # Sharpe ratio (simplified)
        avg_return = np.mean(returns) if returns else 0
        std_return = np.std(returns) if returns else 1
        sharpe = (avg_return / std_return) * np.sqrt(252) if std_return > 0 else 0

        # Max drawdown
        max_dd = self._calculate_max_drawdown()

        # Profit factor
        gross_profit = sum(winning)
        gross_loss = abs(sum(losing))
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

        return PerformanceMetrics(
            total_return_pct=total_return,
            sharpe_ratio=sharpe,
            sortino_ratio=0,  # Calculate separately
            max_drawdown_pct=max_dd,
            win_rate=win_rate,
            profit_factor=profit_factor,
            avg_trade_return=avg_return,
            total_trades=len(recent_trades),
            winning_trades=len(winning),
            losing_trades=len(losing),
        )

    def _calculate_max_drawdown(self) -> float:
        """Calculate maximum drawdown from equity curve"""
        if len(self.equity_curve) < 2:
            return 0.0

        values = [e["value"] for e in self.equity_curve]
        peak = values[0]
        max_dd = 0.0

        for value in values:
            if value > peak:
                peak = value
            drawdown = (peak - value) / peak
            max_dd = max(max_dd, drawdown)

        return max_dd * 100

    def generate_report(self) -> dict:
        """Generate comprehensive performance report"""
        metrics = self.calculate_metrics()

        report = {
            "generated_at": datetime.utcnow().isoformat(),
            "metrics": asdict(metrics),
            "open_positions": 0,
            "total_trades_all_time": len(self.trade_history),
            "equity_latest": self.equity_curve[-1]["value"] if self.equity_curve else 0,
        }
        try:
            from analytics.revenue_api import get_revenue_kpis

            report["revenue_kpis"] = get_revenue_kpis(
                tca_db_path=self.tca_db_path,
                lookback_days=int(self.config.get("revenue_lookback_days", 30)),
            )
        except Exception:
            report["revenue_kpis"] = {}

        # Save report
        report_path = self.data_dir / f"report_{datetime.utcnow().strftime('%Y%m%d')}.json"
        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)

        return report

    def _save_trade_history(self):
        """Save trade history to file"""
        history_path = self.data_dir / "trade_history.json"
        with open(history_path, "w") as f:
            json.dump(self.trade_history, f, indent=2)

    def print_dashboard(self):
        """Print dashboard to console"""
        metrics = self.calculate_metrics()

        print("\n" + "=" * 60)
        print("  PROTHEUS QUANT TRADING SYSTEM - DASHBOARD")
        print("=" * 60)
        print(f"  Total Return:     {metrics.total_return_pct:+.2f}%")
        print(f"  Sharpe Ratio:     {metrics.sharpe_ratio:.2f}")
        print(f"  Max Drawdown:     {metrics.max_drawdown_pct:.2f}%")
        print(f"  Win Rate:         {metrics.win_rate*100:.1f}%")
        print(f"  Profit Factor:    {metrics.profit_factor:.2f}")
        print(f"  Total Trades:     {metrics.total_trades}")
        print(
            f"  Equity:           ${self.equity_curve[-1]['value']:.2f}"
            if self.equity_curve
            else "  Equity:           $0.00"
        )
        print("=" * 60 + "\n")


# Import numpy for calculations
try:
    import numpy as np
except ImportError:
    import math

    class MockNp:
        @staticmethod
        def mean(x):
            return sum(x) / len(x) if x else 0

        @staticmethod
        def std(x):
            if not x:
                return 1
            m = sum(x) / len(x)
            return math.sqrt(sum((i - m) ** 2 for i in x) / len(x))

        @staticmethod
        def sqrt(x):
            return math.sqrt(x)

    np = MockNp()
