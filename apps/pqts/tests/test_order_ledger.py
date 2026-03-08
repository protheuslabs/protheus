"""Tests for immutable order lifecycle ledger and router integration."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.order_ledger import ImmutableOrderLedger
from execution.risk_aware_router import RiskAwareRouter
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
    return {"strategy": [0.0002, -0.0001, 0.0001]}, [2.0, -1.0, 1.0]


def test_order_ledger_valid_transitions_and_replay(tmp_path):
    ledger = ImmutableOrderLedger(str(tmp_path / "order_ledger.jsonl"))

    assert (
        ledger.record(
            order_id="ord_1",
            state="submitted",
            symbol="BTCUSDT",
            side="buy",
            venue="binance",
            quantity=1.0,
        )
        is True
    )
    assert (
        ledger.record(
            order_id="ord_1",
            state="acknowledged",
            symbol="BTCUSDT",
            side="buy",
            venue="binance",
            quantity=1.0,
        )
        is True
    )
    assert (
        ledger.record(
            order_id="ord_1",
            state="filled",
            symbol="BTCUSDT",
            side="buy",
            venue="binance",
            quantity=1.0,
        )
        is True
    )

    replay = ledger.replay("ord_1")
    assert [row["state"] for row in replay] == ["submitted", "acknowledged", "filled"]
    assert ledger.current_state("ord_1") == "filled"


def test_order_ledger_rejects_invalid_transition(tmp_path):
    ledger = ImmutableOrderLedger(str(tmp_path / "order_ledger.jsonl"))

    ledger.record(
        order_id="ord_2",
        state="submitted",
        symbol="BTCUSDT",
        side="buy",
        venue="binance",
        quantity=1.0,
    )

    try:
        ledger.record(
            order_id="ord_2",
            state="filled",
            symbol="BTCUSDT",
            side="buy",
            venue="binance",
            quantity=1.0,
        )
        raised = False
    except RuntimeError:
        raised = True

    assert raised is True


def test_order_ledger_dedupes_repeated_event_payload(tmp_path):
    ledger = ImmutableOrderLedger(str(tmp_path / "order_ledger.jsonl"))

    first = ledger.record(
        order_id="ord_3",
        state="submitted",
        symbol="ETHUSDT",
        side="sell",
        venue="binance",
        quantity=2.0,
    )
    second = ledger.record(
        order_id="ord_3",
        state="submitted",
        symbol="ETHUSDT",
        side="sell",
        venue="binance",
        quantity=2.0,
    )

    assert first is True
    assert second is False


def test_router_writes_order_lifecycle_for_success_and_reject(tmp_path):
    ledger_path = tmp_path / "router_order_ledger.jsonl"
    router = RiskAwareRouter(
        risk_config=RiskLimits(max_order_notional=50000.0),
        broker_config={
            "enabled": True,
            "live_execution": False,
            "order_ledger_path": str(ledger_path),
        },
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
    strategy_returns, portfolio_changes = _strategy_inputs()

    success_order = OrderRequest(
        symbol="BTCUSDT",
        side="buy",
        quantity=0.1,
        order_type=OrderType.LIMIT,
        price=float(market_data["last_price"]),
    )
    success = asyncio.run(
        router.submit_order(
            order=success_order,
            market_data=market_data,
            portfolio=_portfolio(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )
    assert success.success is True

    reject_order = OrderRequest(
        symbol="BTCUSDT",
        side="buy",
        quantity=1000.0,
        order_type=OrderType.LIMIT,
        price=float(market_data["last_price"]),
    )
    rejected = asyncio.run(
        router.submit_order(
            order=reject_order,
            market_data=market_data,
            portfolio=_portfolio(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )
    assert rejected.success is False

    ledger = ImmutableOrderLedger(str(ledger_path))
    success_states = [row["state"] for row in ledger.replay(success.audit_log["order_id"])]
    reject_states = [row["state"] for row in ledger.replay(rejected.audit_log["order_id"])]

    assert success_states[:2] == ["submitted", "acknowledged"]
    assert success_states[-1] in {"filled", "partially_filled"}
    assert reject_states == ["submitted", "rejected"]
