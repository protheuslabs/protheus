"""Tests for shadow stream worker event persistence and health snapshots."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.risk_aware_router import RiskAwareRouter
from execution.shadow_stream_worker import ShadowParityStreamWorker, ShadowStreamEventStore
from execution.smart_router import OrderRequest, OrderType
from risk.kill_switches import RiskLimits


def _portfolio() -> dict:
    return {
        "positions": {},
        "prices": {},
        "total_pnl": 0.0,
        "unrealized_pnl": 0.0,
        "realized_pnl": 0.0,
        "gross_exposure": 0.0,
        "net_exposure": 0.0,
        "leverage": 0.0,
        "open_orders": [],
    }


def _strategy_inputs() -> tuple[dict, list[float]]:
    return {"strategy": [0.0001, -0.0001, 0.0002, -0.0001]}, [1.0, -1.0, 2.0, -1.0]


def test_shadow_stream_worker_persists_market_order_and_fill_events(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(max_order_notional=50000.0),
        broker_config={"enabled": True, "live_execution": False},
        tca_db_path=str(tmp_path / "tca.csv"),
    )
    router.set_capital(100000.0, source="unit_test")
    router.configure_market_adapters(
        {
            "crypto": {
                "enabled": True,
                "exchanges": [{"name": "binance", "symbols": ["BTCUSDT"]}],
            },
            "equities": {"enabled": False, "brokers": []},
            "forex": {"enabled": False, "brokers": []},
        }
    )

    market_data = asyncio.run(router.fetch_market_snapshot())
    order = OrderRequest(
        symbol="BTCUSDT",
        side="buy",
        quantity=0.25,
        order_type=OrderType.LIMIT,
        price=float(market_data["last_price"]),
    )
    strategy_returns, portfolio_changes = _strategy_inputs()
    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )
    assert result.success is True

    store = ShadowStreamEventStore(
        events_path=str(tmp_path / "shadow_stream_events.jsonl"),
        health_path=str(tmp_path / "stream_health.json"),
    )
    worker = ShadowParityStreamWorker(router=router, store=store)

    payload = asyncio.run(worker.collect_once())

    assert payload["market_events"] >= 1
    assert payload["order_events"] >= 1
    assert payload["fill_events"] >= 1

    rows = [
        json.loads(line)
        for line in store.events_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    channels = {str(row.get("channel")) for row in rows}
    assert {"market", "order", "fill"}.issubset(channels)

    health = json.loads(store.health_path.read_text(encoding="utf-8"))
    assert health["summary"]["venues"] == 1
    assert "stream_uptime_ratio" in health["summary"]
