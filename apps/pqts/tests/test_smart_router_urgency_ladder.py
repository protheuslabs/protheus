"""Tests for maker-first urgency ladder in smart order routing."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.smart_router import OrderRequest, OrderType, SmartOrderRouter


def _market_data() -> dict:
    return {
        "binance": {
            "BTCUSDT": {
                "price": 50000.0,
                "spread": 0.0002,
                "volume_24h": 2_000_000.0,
            }
        }
    }


def test_maker_ladder_prefers_limit_when_alpha_below_cross_cost():
    router = SmartOrderRouter(
        {
            "prefer_maker": True,
            "maker_urgency_ladder": {
                "enabled": True,
                "urgency_alpha_thresholds_bps": {"normal": 2.0, "urgent": 0.5},
                "incremental_cost_buffer_bps": 0.5,
            },
            "default_maker_fee_bps": 2.0,
            "default_taker_fee_bps": 5.0,
        }
    )
    order = OrderRequest(
        symbol="BTCUSDT",
        side="buy",
        quantity=0.05,
        order_type=OrderType.LIMIT,
        time_in_force="GTC",
        expected_alpha_bps=1.0,
    )

    decision = asyncio.run(router.route_order(order, _market_data()))
    assert decision.order_type == OrderType.LIMIT


def test_maker_ladder_allows_taker_when_alpha_clears_cost_hurdle():
    router = SmartOrderRouter(
        {
            "prefer_maker": True,
            "maker_urgency_ladder": {
                "enabled": True,
                "urgency_alpha_thresholds_bps": {"normal": 1.0, "urgent": 0.5},
                "incremental_cost_buffer_bps": 0.25,
            },
            "default_maker_fee_bps": 1.0,
            "default_taker_fee_bps": 2.0,
        }
    )
    order = OrderRequest(
        symbol="BTCUSDT",
        side="buy",
        quantity=0.05,
        order_type=OrderType.LIMIT,
        time_in_force="IOC",
        expected_alpha_bps=8.0,
    )

    decision = asyncio.run(router.route_order(order, _market_data()))
    assert decision.order_type == OrderType.MARKET
