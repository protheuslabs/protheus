"""Deterministic tests for shorting locate/borrow/recall/squeeze controls."""

from __future__ import annotations

from execution.shorting_controls import ShortingRiskOverlay


def _portfolio(positions: dict[str, float]) -> dict:
    return {"positions": positions}


def test_short_overlay_rejects_missing_locate():
    overlay = ShortingRiskOverlay(
        {
            "enabled": True,
            "require_locate": True,
            "locates": {"binance|BTC-USD": False},
        }
    )

    decision = overlay.evaluate(
        symbol="BTC-USD",
        venue="binance",
        side="sell",
        order_qty=1.0,
        order_price=50000.0,
        portfolio=_portfolio({"BTC-USD": 0.0}),
        capital=100000.0,
    )

    assert decision.approved is False
    assert decision.reason == "no_locate"


def test_short_overlay_rejects_expensive_borrow():
    overlay = ShortingRiskOverlay(
        {
            "enabled": True,
            "max_borrow_bps": 20.0,
            "borrow_bps": {"AAPL": 45.0},
        }
    )

    decision = overlay.evaluate(
        symbol="AAPL",
        venue="alpaca",
        side="sell",
        order_qty=5.0,
        order_price=200.0,
        portfolio=_portfolio({"AAPL": 0.0}),
        capital=100000.0,
    )

    assert decision.approved is False
    assert decision.reason == "borrow_too_expensive"


def test_short_overlay_rejects_squeeze_adjusted_exposure():
    overlay = ShortingRiskOverlay(
        {
            "enabled": True,
            "max_short_exposure_pct": 0.10,
            "squeeze": {"TSLA": 1.8},
        }
    )

    decision = overlay.evaluate(
        symbol="TSLA",
        venue="alpaca",
        side="sell",
        order_qty=20.0,
        order_price=400.0,
        portfolio=_portfolio({"TSLA": 0.0}),
        capital=100000.0,
    )

    assert decision.approved is False
    assert decision.reason == "squeeze_adjusted_exposure_limit"


def test_short_overlay_approves_short_when_controls_pass():
    overlay = ShortingRiskOverlay(
        {
            "enabled": True,
            "max_borrow_bps": 20.0,
            "max_short_exposure_pct": 0.30,
            "borrow_bps": {"binance|BTC-USD": 8.0},
            "locates": {"binance|BTC-USD": True},
            "recalls": {"binance|BTC-USD": False},
            "squeeze": {"binance|BTC-USD": 1.2},
        }
    )

    decision = overlay.evaluate(
        symbol="BTC-USD",
        venue="binance",
        side="sell",
        order_qty=0.1,
        order_price=50000.0,
        portfolio=_portfolio({"BTC-USD": 0.0}),
        capital=100000.0,
    )

    assert decision.approved is True
    assert decision.reason == "approved"


def test_short_overlay_skips_when_sell_only_reduces_long():
    overlay = ShortingRiskOverlay(
        {
            "enabled": True,
            "require_locate": True,
            "locates": {"BTC-USD": False},
        }
    )

    decision = overlay.evaluate(
        symbol="BTC-USD",
        venue="binance",
        side="sell",
        order_qty=0.25,
        order_price=50000.0,
        portfolio=_portfolio({"BTC-USD": 0.5}),
        capital=100000.0,
    )

    assert decision.approved is True
    assert decision.reason == "no_incremental_short"
