"""Integration contract: router submissions persist TCA rows."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from execution.risk_aware_router import RiskAwareRouter
from execution.smart_router import OrderRequest, OrderType
from risk.kill_switches import RiskLimits


def test_router_submission_writes_tca_record(tmp_path):
    db_path = tmp_path / "tca_records.csv"
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        tca_db_path=str(db_path),
    )
    router.set_capital(100000.0, source="test")

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.1,
        order_type=OrderType.LIMIT,
        price=50000.0,
    )
    market_data = {
        "binance": {
            "BTC-USD": {
                "price": 50000.0,
                "spread": 0.0002,
                "volume_24h": 2_000_000.0,
            }
        },
        "order_book": {
            "bids": [(49990.0, 3.0), (49980.0, 5.0)],
            "asks": [(50010.0, 2.5), (50020.0, 4.0)],
        },
    }
    strategy_returns = {"s1": np.linspace(-0.01, 0.01, 30)}
    portfolio_changes = list(np.linspace(-10.0, 10.0, 30))
    portfolio = {
        "positions": {},
        "prices": {"BTC-USD": 50000.0},
        "total_pnl": 0.0,
        "unrealized_pnl": 0.0,
        "realized_pnl": 0.0,
        "gross_exposure": 0.0,
        "net_exposure": 0.0,
        "leverage": 0.0,
        "open_orders": [],
    }

    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=portfolio,
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is True
    assert db_path.exists()
    rows = db_path.read_text(encoding="utf-8").splitlines()
    assert len(rows) >= 2
