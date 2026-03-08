"""Deterministic tests for paper campaign helpers."""

from __future__ import annotations

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.paper_campaign import (
    bounded_probe_notional,
    build_portfolio_snapshot,
    build_probe_order,
    iter_cycle_symbols,
    select_probe_side,
    select_symbol_price,
)
from execution.smart_router import OrderType


def test_build_portfolio_snapshot_exposures_and_leverage():
    snapshot = build_portfolio_snapshot(
        positions={"BTCUSDT": 0.5, "ETHUSDT": -2.0},
        prices={"BTCUSDT": 50000.0, "ETHUSDT": 3000.0},
        capital=100000.0,
    )

    assert snapshot["gross_exposure"] == 31000.0
    assert snapshot["net_exposure"] == 19000.0
    assert snapshot["leverage"] == 0.31


def test_select_symbol_price_skips_metadata_payloads():
    market_snapshot = {
        "last_price": 123.0,
        "vol_24h": 1_000_000,
        "binance": {
            "BTCUSDT": {"price": 51000.0, "spread": 0.0002, "volume_24h": 1000.0},
        },
    }

    selected = select_symbol_price(market_snapshot, "BTCUSDT")
    assert selected == ("binance", 51000.0)


def test_build_probe_order_uses_notional_and_order_type():
    order = build_probe_order(
        symbol="BTCUSDT",
        side="buy",
        notional_usd=200.0,
        price=50000.0,
        order_type=OrderType.LIMIT,
    )

    assert order.symbol == "BTCUSDT"
    assert order.side == "buy"
    assert order.order_type == OrderType.LIMIT
    assert order.quantity == pytest.approx(0.004)
    assert order.price == 50000.0


def test_iter_cycle_symbols_rejects_empty():
    with pytest.raises(ValueError):
        iter_cycle_symbols([])


def test_select_probe_side_prefers_flattening_existing_inventory():
    assert select_probe_side(current_qty=1.25, cycle=3, allow_short=False) == "sell"
    assert select_probe_side(current_qty=-0.75, cycle=2, allow_short=False) == "buy"
    assert select_probe_side(current_qty=0.0, cycle=2, allow_short=False) == "buy"


def test_bounded_probe_notional_respects_long_only_inventory_and_cap():
    # Can only sell what we own in long-only mode.
    sell_notional = bounded_probe_notional(
        side="sell",
        requested_notional_usd=200.0,
        current_qty=0.002,
        price=50000.0,
        capital=10000.0,
        max_single_position_pct=0.25,
        allow_short=False,
    )
    assert sell_notional == pytest.approx(100.0)

    # Buy sizing is capped by position headroom.
    buy_notional = bounded_probe_notional(
        side="buy",
        requested_notional_usd=500.0,
        current_qty=0.045,
        price=50000.0,
        capital=10000.0,
        max_single_position_pct=0.25,
        allow_short=False,
    )
    assert buy_notional == pytest.approx(250.0)
