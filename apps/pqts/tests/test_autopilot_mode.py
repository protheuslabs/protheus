"""Autopilot strategy-selection tests."""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.autopilot import HumanStrategyOverride, StrategyAutopilot
from core.engine import TradingEngine


def test_strategy_autopilot_auto_mode_prefers_ai_ranked_candidates():
    autopilot = StrategyAutopilot(
        {
            "mode": "auto",
            "max_active_strategies": 2,
            "ai_rank_weight": 2.0,
        }
    )
    strategy_configs = {
        "arbitrage": {"enabled": True},
        "ml": {"enabled": True, "complexity_penalty": 0.4},
        "mean_reversion": {"enabled": True, "simple_access_bonus": 0.1},
        "scalping": {"enabled": True},
    }
    decision = autopilot.decide(
        strategy_configs=strategy_configs,
        current_active=[],
        ai_recommendations=["arbitrage", "ml"],
    )

    assert decision.mode == "auto"
    assert decision.selected_strategies == ["arbitrage", "ml"]
    assert "auto_mode_selected_top_ranked_candidates" in decision.reasons


def test_strategy_autopilot_human_overrides_apply_after_ai_selection():
    autopilot = StrategyAutopilot(
        {
            "mode": "auto",
            "max_active_strategies": 3,
            "ai_rank_weight": 2.0,
        }
    )
    strategy_configs = {
        "arbitrage": {"enabled": True},
        "ml": {"enabled": True},
        "mean_reversion": {"enabled": True},
        "trend_following": {"enabled": True},
    }
    decision = autopilot.decide(
        strategy_configs=strategy_configs,
        current_active=[],
        ai_recommendations=["arbitrage", "ml"],
        human_override=HumanStrategyOverride(
            include=["trend_following"],
            exclude=["arbitrage"],
        ),
    )

    assert "arbitrage" not in decision.selected_strategies
    assert "trend_following" in decision.selected_strategies
    assert decision.overrides_applied["exclude"] == ["arbitrage"]
    assert decision.overrides_applied["include"] == ["trend_following"]


def test_strategy_autopilot_manual_mode_preserves_current_set():
    autopilot = StrategyAutopilot({"mode": "manual"})
    strategy_configs = {
        "arbitrage": {"enabled": True},
        "mean_reversion": {"enabled": True},
        "scalping": {"enabled": True},
    }
    decision = autopilot.decide(
        strategy_configs=strategy_configs,
        current_active=["mean_reversion", "scalping"],
        ai_recommendations=["arbitrage"],
    )

    assert decision.selected_strategies == ["mean_reversion", "scalping"]
    assert "manual_mode_preserves_current_set" in decision.reasons


def test_engine_applies_autopilot_selection_and_exposes_state(tmp_path):
    config = {
        "mode": "paper_trading",
        "runtime": {
            "autopilot": {
                "mode": "auto",
                "auto_apply_on_start": False,
                "max_active_strategies": 2,
                "ai_rank_weight": 2.0,
            }
        },
        "markets": {
            "crypto": {"enabled": True},
            "equities": {"enabled": True},
            "forex": {"enabled": False},
        },
        "strategies": {
            "arbitrage": {"enabled": True, "markets": ["crypto"]},
            "scalping": {"enabled": True, "markets": ["crypto"]},
            "mean_reversion": {"enabled": True, "markets": ["equities"]},
        },
        "risk": {"initial_capital": 100000.0},
    }
    config_path = tmp_path / "autopilot.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")

    engine = TradingEngine(str(config_path))
    payload = engine.apply_autopilot_strategy_selection(
        ai_recommendations=["arbitrage", "mean_reversion"],
        include=["scalping"],
        exclude=["mean_reversion"],
    )

    state = engine.get_toggle_state()
    assert payload["mode"] == "auto"
    assert "arbitrage" in state["active_strategies"]
    assert "scalping" in state["active_strategies"]
    assert "mean_reversion" not in state["active_strategies"]
    assert state["autopilot_mode"] == "auto"


def test_engine_autopilot_respects_simple_tier_policy_pack(tmp_path):
    config = {
        "mode": "paper_trading",
        "runtime": {
            "operator_tier": "simple",
            "autopilot": {
                "mode": "auto",
                "auto_apply_on_start": False,
                "max_active_strategies": 4,
                "ai_rank_weight": 3.0,
            },
        },
        "markets": {
            "crypto": {"enabled": True},
            "equities": {"enabled": True},
            "forex": {"enabled": False},
        },
        "strategies": {
            "ml": {"enabled": True, "markets": ["crypto"]},
            "liquidity_sweep": {"enabled": True, "markets": ["crypto"]},
            "trend_following": {"enabled": True, "markets": ["equities"]},
            "mean_reversion": {"enabled": True, "markets": ["equities"]},
        },
        "risk": {"initial_capital": 100000.0},
    }
    config_path = tmp_path / "autopilot_simple.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")

    engine = TradingEngine(str(config_path))
    payload = engine.apply_autopilot_strategy_selection(
        ai_recommendations=["ml", "liquidity_sweep", "trend_following", "mean_reversion"]
    )
    selected = payload["policy_enforcement"]["selected"]

    assert "ml" not in selected
    assert "liquidity_sweep" not in selected
    assert selected
