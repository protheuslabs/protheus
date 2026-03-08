"""Tests for user risk-tolerance profile resolution and scaling."""

from __future__ import annotations

import pytest

from risk.risk_tolerance import (
    resolve_effective_risk_config,
    resolve_risk_tolerance_profile,
    scale_canary_steps_for_profile,
)


def _config() -> dict:
    return {
        "risk": {
            "risk_tolerance_profile": "balanced",
            "initial_capital": 100000.0,
            "max_portfolio_risk_pct": 2.0,
            "max_position_risk_pct": 1.0,
            "max_drawdown_pct": 10.0,
            "max_leverage": 2.0,
            "max_order_notional": 50000.0,
            "max_symbol_notional": {"BTCUSDT": 50000.0},
            "max_venue_notional": {"binance": 100000.0},
        }
    }


def test_conservative_profile_scales_limits_down():
    risk_cfg, profile = resolve_effective_risk_config(
        _config(),
        override_profile="conservative",
    )

    assert profile.name == "conservative"
    assert risk_cfg["max_portfolio_risk_pct"] == pytest.approx(1.2)
    assert risk_cfg["max_position_risk_pct"] == pytest.approx(0.6)
    assert risk_cfg["max_order_notional"] == pytest.approx(30000.0)
    assert risk_cfg["max_symbol_notional"]["BTCUSDT"] == pytest.approx(30000.0)
    assert risk_cfg["max_venue_notional"]["binance"] == pytest.approx(60000.0)
    assert risk_cfg["initial_capital"] == pytest.approx(100000.0)


def test_alias_and_custom_profile_resolution():
    config = _config()
    config["risk"]["risk_tolerance_profiles"] = {
        "desk_plus": {
            "description": "Custom desk profile",
            "risk_limit_scale": 1.2,
            "canary_allocation_scale": 1.1,
        }
    }

    low = resolve_risk_tolerance_profile(config, override_profile="low")
    assert low.name == "conservative"

    custom = resolve_risk_tolerance_profile(config, override_profile="desk_plus")
    assert custom.name == "desk_plus"
    assert custom.risk_limit_scale == pytest.approx(1.2)
    assert custom.canary_allocation_scale == pytest.approx(1.1)


def test_unknown_profile_raises_value_error():
    with pytest.raises(ValueError):
        resolve_risk_tolerance_profile(_config(), override_profile="unknown_profile")


def test_scale_canary_steps_clamps_and_keeps_order():
    profile = resolve_risk_tolerance_profile(_config(), override_profile="professional")
    steps = scale_canary_steps_for_profile([0.01, 0.02, 0.05, 0.90], profile=profile)

    assert steps == sorted(steps)
    assert steps[0] > 0.01
    assert steps[-1] <= 1.0
