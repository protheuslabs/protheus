"""Tests for unified market/strategy toggle controls."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import TradingEngine
from core.toggle_manager import MarketStrategyToggleManager, ToggleValidationError


def _config_dict() -> dict:
    return {
        "mode": "paper_trading",
        "markets": {
            "crypto": {"enabled": True, "exchanges": [{"name": "binance"}]},
            "equities": {"enabled": True, "brokers": [{"name": "alpaca"}]},
            "forex": {"enabled": True, "brokers": [{"name": "oanda"}]},
        },
        "strategies": {
            "scalping": {"enabled": True, "markets": ["crypto", "forex"]},
            "mean_reversion": {"enabled": True, "markets": ["equities"]},
            "arb": {"enabled": True, "markets": ["crypto"]},
        },
        "strategy_profiles": {
            "crypto_only": {
                "markets": ["crypto"],
                "strategies": ["scalping", "arb"],
            },
            "fx_only": {
                "markets": ["forex"],
                "strategies": ["scalping"],
            },
        },
        "risk": {
            "initial_capital": 100000.0,
            "max_portfolio_risk_pct": 2.0,
            "max_position_risk_pct": 1.0,
            "max_drawdown_pct": 10.0,
            "max_correlation": 0.7,
            "max_positions": 20,
            "max_leverage": 3.0,
        },
    }


def _write_config(tmp_path: Path) -> Path:
    cfg_path = tmp_path / "toggle_test.yaml"
    cfg_path.write_text(yaml.safe_dump(_config_dict()), encoding="utf-8")
    return cfg_path


def test_toggle_manager_market_aliases_and_strategy_filtering():
    manager = MarketStrategyToggleManager(_config_dict())

    assert manager.get_active_markets() == ["crypto", "equities", "forex"]
    assert manager.get_active_strategies() == ["arb", "mean_reversion", "scalping"]

    manager.set_market_enabled("market", False)
    assert manager.get_active_markets() == ["crypto", "forex"]
    assert manager.get_active_strategies() == ["arb", "scalping"]

    manager.set_active_markets(["fx"])
    assert manager.get_active_markets() == ["forex"]
    assert manager.get_active_strategies() == ["scalping"]

    with pytest.raises(ToggleValidationError):
        manager.set_market_enabled("commodities", True)


def test_engine_runtime_toggle_controls(tmp_path):
    config_path = _write_config(tmp_path)
    engine = TradingEngine(str(config_path))

    asyncio.run(engine._init_markets())
    asyncio.run(engine._init_strategies())

    assert sorted(engine.market_adapters.keys()) == ["alpaca", "binance", "oanda"]
    assert engine.active_strategy_names == ["arb", "mean_reversion", "scalping"]

    engine.apply_strategy_profile("crypto_only")
    assert engine.get_toggle_state()["active_markets"] == ["crypto"]
    assert engine.get_toggle_state()["active_strategies"] == ["arb", "scalping"]
    assert sorted(engine.market_adapters.keys()) == ["binance"]
    assert engine.active_strategy_names == ["arb", "scalping"]

    engine.set_strategy_enabled("scalping", False)
    assert engine.get_toggle_state()["active_strategies"] == ["arb"]

    engine.set_market_enabled("crypto", False)
    assert engine.get_toggle_state()["active_markets"] == []
    assert engine.get_toggle_state()["active_strategies"] == []
