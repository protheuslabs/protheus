"""Unit-level contracts for typed execution units and side-aware depth."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from execution.realistic_costs import AnnualVol, NotionalUSD, OrderBook, RealisticCostModel, Side
from execution.risk_aware_router import RiskAwareRouter
from risk.kill_switches import RiskLimits


def test_order_book_depth_is_side_aware_and_notional_based():
    book = OrderBook.from_snapshots(
        bid_snapshots=[(99.0, 10.0), (98.0, 20.0)],
        ask_snapshots=[(101.0, 8.0), (102.0, 5.0)],
    )

    buy_depth = float(book.depth_notional_up_to_pct(0.02, Side.BUY))
    sell_depth = float(book.depth_notional_up_to_pct(0.02, Side.SELL))

    assert buy_depth > 0.0
    assert sell_depth > 0.0
    assert buy_depth != sell_depth


def test_cost_model_uses_horizon_scaled_volatility():
    book = OrderBook.from_snapshots(
        bid_snapshots=[(99.0, 3000.0), (98.0, 4000.0)],
        ask_snapshots=[(101.0, 3000.0), (102.0, 4000.0)],
    )
    model = RealisticCostModel(base_volatility=0.50, impact_constant=0.5)

    slip = model.estimate_slippage(
        order_size_usd=NotionalUSD(10_000.0),
        order_book=book,
        side=Side.BUY,
        current_volatility=AnnualVol(0.50),
        is_market_order=False,
    )

    depth = float(book.depth_notional_up_to_pct(0.01, Side.BUY))
    participation = 10_000.0 / depth
    expected = 0.5 * (0.50 / (252.0**0.5)) * (participation**0.5) * 1.1
    assert slip == pytest.approx(expected, rel=1e-9)


def test_synthetic_order_book_depth_is_price_scaled():
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.15,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
    )

    low_price = OrderBook.from_snapshots(
        bid_snapshots=router._synthetic_order_book(1.10)["bids"],
        ask_snapshots=router._synthetic_order_book(1.10)["asks"],
    )
    high_price = OrderBook.from_snapshots(
        bid_snapshots=router._synthetic_order_book(50_000.0)["bids"],
        ask_snapshots=router._synthetic_order_book(50_000.0)["asks"],
    )

    low_depth = float(low_price.depth_notional_up_to_pct(0.01, Side.BUY))
    high_depth = float(high_price.depth_notional_up_to_pct(0.01, Side.BUY))

    assert low_depth > 100_000.0
    assert high_depth > 100_000.0
    assert high_depth / max(low_depth, 1e-9) == pytest.approx(1.0, rel=0.05)
