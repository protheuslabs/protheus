"""Backtest-layer contracts for execution-cost behavior."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backtesting.engine import BacktestingEngine


def test_backtest_engine_applies_side_aware_slippage():
    engine = BacktestingEngine({"slippage_bps": 10})
    price = 100.0

    long_px = engine._apply_slippage(price, "long", 10_000.0)
    short_px = engine._apply_slippage(price, "short", 10_000.0)

    assert long_px > price
    assert short_px < price
