"""Tests for tenant entitlement enforcement."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import TradingEngine
from core.multi_tenant import enforce_tenant_entitlements, resolve_tenant_entitlements


def test_resolve_tenant_entitlements_defaults_to_enterprise():
    entitlements = resolve_tenant_entitlements({"runtime": {}})
    assert entitlements.plan == "enterprise"
    assert entitlements.allowed_markets is None
    assert entitlements.allow_live_trading is True


def test_enforce_tenant_entitlements_filters_starter_scope():
    entitlements = resolve_tenant_entitlements({"runtime": {"tenant": {"plan": "starter"}}})
    result = enforce_tenant_entitlements(
        selected=["ml", "trend_following", "mean_reversion"],
        active_markets=["crypto", "forex"],
        ranked_candidates=["trend_following", "mean_reversion", "ml"],
        entitlements=entitlements,
    )

    assert result.active_markets == ["crypto"]
    assert "ml" not in result.selected
    assert set(result.selected) == {"trend_following", "mean_reversion"}


def test_engine_autopilot_applies_tenant_enforcement(tmp_path):
    config = {
        "mode": "paper_trading",
        "runtime": {
            "tenant": {"tenant_id": "starter_tenant", "plan": "starter"},
            "autopilot": {"mode": "auto", "auto_apply_on_start": False, "max_active_strategies": 4},
        },
        "markets": {
            "crypto": {"enabled": True},
            "forex": {"enabled": True},
        },
        "strategies": {
            "ml": {"enabled": True, "markets": ["crypto"]},
            "trend_following": {"enabled": True, "markets": ["crypto", "forex"]},
            "mean_reversion": {"enabled": True, "markets": ["crypto"]},
        },
        "risk": {"initial_capital": 100000.0},
    }
    config_path = tmp_path / "tenant.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")
    engine = TradingEngine(str(config_path))

    payload = engine.apply_autopilot_strategy_selection(
        ai_recommendations=["ml", "trend_following", "mean_reversion"]
    )
    selected = payload["tenant_enforcement"]["selected"]

    assert "ml" not in selected
    assert selected
    state = engine.get_toggle_state()
    assert state["tenant_plan"] == "starter"
    assert state["tenant_id"] == "starter_tenant"


def test_engine_start_blocks_live_mode_for_starter_plan(tmp_path):
    config = {
        "mode": "live_trading",
        "runtime": {
            "tenant": {"plan": "starter"},
            "autopilot": {"mode": "manual"},
        },
        "markets": {
            "crypto": {
                "enabled": True,
                "exchanges": [
                    {
                        "name": "binance",
                        "api_key": "prod_key",
                        "api_secret": "prod_secret",
                        "symbols": ["BTCUSDT"],
                    }
                ],
            }
        },
        "strategies": {"trend_following": {"enabled": True, "markets": ["crypto"]}},
        "risk": {"initial_capital": 250000.0},
    }
    config_path = tmp_path / "starter_live.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")
    engine = TradingEngine(str(config_path))

    with pytest.raises(RuntimeError):
        asyncio.run(engine.start())
