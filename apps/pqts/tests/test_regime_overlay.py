"""Tests for regime-conditioned strategy exposure controls."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from risk.regime_overlay import RegimeExposureOverlay


def _market_data(spread: float, volume_24h: float) -> dict:
    return {
        "binance": {
            "BTCUSDT": {
                "price": 50000.0,
                "spread": spread,
                "volume_24h": volume_24h,
            }
        }
    }


def test_regime_overlay_applies_strategy_multiplier():
    overlay = RegimeExposureOverlay(
        {
            "enabled": True,
            "high_spread": 0.001,
            "strategy_multipliers": {
                "high_vol": {
                    "market_making": 0.4,
                }
            },
        }
    )
    qty, decision = overlay.throttle_quantity(
        "BTCUSDT",
        10.0,
        _market_data(spread=0.002, volume_24h=2_000_000.0),
        strategy_id="market_making",
    )
    assert decision.regime == "high_vol"
    assert decision.strategy_multiplier == 0.4
    assert qty == 10.0 * decision.multiplier * 0.4


def test_regime_overlay_blocks_strategy_in_regime():
    overlay = RegimeExposureOverlay(
        {
            "enabled": True,
            "extreme_spread": 0.003,
            "disabled_strategies_by_regime": {
                "crisis": ["carry_trade"],
            },
        }
    )
    qty, decision = overlay.throttle_quantity(
        "BTCUSDT",
        10.0,
        _market_data(spread=0.004, volume_24h=2_000_000.0),
        strategy_id="carry_trade",
    )
    assert decision.regime == "crisis"
    assert decision.strategy_blocked is True
    assert qty == 0.0
