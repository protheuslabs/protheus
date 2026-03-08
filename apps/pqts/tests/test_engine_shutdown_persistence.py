"""Deterministic tests for graceful shutdown and crash recovery state."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import MarketType, Order, OrderSide, OrderType, Position, TradingEngine


def _write_engine_config(tmp_path: Path, state_path: Path) -> Path:
    config = {
        "mode": "paper_trading",
        "runtime": {"state_path": str(state_path)},
        "markets": {
            "crypto": {"enabled": True, "exchanges": [{"name": "binance", "symbols": ["BTC-USD"]}]}
        },
        "risk": {
            "initial_capital": 100000.0,
            "max_portfolio_risk_pct": 2.0,
            "max_drawdown_pct": 10.0,
            "max_leverage": 3.0,
        },
        "strategies": {},
    }
    config_path = tmp_path / "engine_state_config.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")
    return config_path


def test_stop_cancels_orders_flattens_positions_and_persists_state(tmp_path):
    state_path = tmp_path / "state" / "engine_state.json"
    engine = TradingEngine(str(_write_engine_config(tmp_path, state_path)))

    engine.positions["BTC-USD"] = Position(
        symbol="BTC-USD",
        quantity=0.75,
        avg_entry_price=50000.0,
        market=MarketType.CRYPTO,
    )
    engine.orders["ord_pending"] = Order(
        id="ord_pending",
        symbol="BTC-USD",
        side=OrderSide.BUY,
        order_type=OrderType.LIMIT,
        quantity=0.1,
        price=50000.0,
        market=MarketType.CRYPTO,
        status="pending",
    )
    engine.orders["ord_submitted"] = Order(
        id="ord_submitted",
        symbol="BTC-USD",
        side=OrderSide.SELL,
        order_type=OrderType.LIMIT,
        quantity=0.1,
        price=51000.0,
        market=MarketType.CRYPTO,
        status="submitted",
    )

    asyncio.run(engine.stop())

    assert engine.positions == {}
    assert engine.orders["ord_pending"].status == "cancelled"
    assert engine.orders["ord_submitted"].status == "cancelled"
    assert any(order.id.endswith("_shutdown") for order in engine.orders.values())
    assert state_path.exists()

    payload = json.loads(state_path.read_text(encoding="utf-8"))
    assert payload["positions"] == []
    assert any(row["status"] == "cancelled" for row in payload["orders"])
    assert any(str(row["id"]).endswith("_shutdown") for row in payload["orders"])


def test_engine_recovers_state_on_restart(tmp_path):
    state_path = tmp_path / "state" / "engine_state.json"
    config_path = _write_engine_config(tmp_path, state_path)

    first = TradingEngine(str(config_path))
    first.positions["EUR_USD"] = Position(
        symbol="EUR_USD",
        quantity=-10000.0,
        avg_entry_price=1.1,
        market=MarketType.FOREX,
    )
    first.orders["ord_live"] = Order(
        id="ord_live",
        symbol="EUR_USD",
        side=OrderSide.SELL,
        order_type=OrderType.MARKET,
        quantity=10000.0,
        market=MarketType.FOREX,
        status="filled",
        filled_quantity=10000.0,
        avg_fill_price=1.095,
    )
    first._portfolio_change_history = [0.1, -0.2, 0.05]
    first._persist_state()

    second = TradingEngine(str(config_path))

    assert "EUR_USD" in second.positions
    assert second.positions["EUR_USD"].quantity == -10000.0
    assert "ord_live" in second.orders
    assert second.orders["ord_live"].status == "filled"
    assert second._portfolio_change_history == [0.1, -0.2, 0.05]
