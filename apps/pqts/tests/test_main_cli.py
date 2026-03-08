"""CLI toggle wiring tests for main.py."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import TradingEngine
from main import apply_cli_toggles, build_arg_parser


def _base_config() -> dict:
    return {
        "mode": "paper_trading",
        "markets": {
            "crypto": {"enabled": True},
            "equities": {"enabled": True},
            "forex": {"enabled": True},
        },
        "strategies": {
            "scalping": {"enabled": True, "markets": ["crypto", "forex"]},
            "arb": {"enabled": True, "markets": ["crypto"]},
            "mean_reversion": {"enabled": True, "markets": ["equities"]},
        },
        "strategy_profiles": {
            "crypto_only": {
                "markets": ["crypto"],
                "strategies": ["scalping", "arb"],
            },
            "casual_core": {
                "markets": ["equities"],
                "strategies": ["mean_reversion"],
            },
            "pro_quant": {
                "markets": ["crypto", "equities", "forex"],
                "strategies": ["scalping", "arb", "mean_reversion"],
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
    config_path = tmp_path / "cli_test.yaml"
    config_path.write_text(yaml.safe_dump(_base_config()), encoding="utf-8")
    return config_path


def test_parser_accepts_toggle_flags():
    parser = build_arg_parser()
    args = parser.parse_args(
        [
            "config/paper.yaml",
            "--profile",
            "crypto_only",
            "--markets",
            "crypto,forex",
            "--strategies",
            "scalping,arb",
            "--autopilot-mode",
            "hybrid",
            "--autopilot-include",
            "mean_reversion",
            "--autopilot-exclude",
            "arb",
            "--risk-profile",
            "conservative",
            "--operator-tier",
            "pro",
            "--show-toggles",
        ]
    )

    assert args.config == "config/paper.yaml"
    assert args.profile == "crypto_only"
    assert args.markets == "crypto,forex"
    assert args.strategies == "scalping,arb"
    assert args.autopilot_mode == "hybrid"
    assert args.autopilot_include == "mean_reversion"
    assert args.autopilot_exclude == "arb"
    assert args.risk_profile == "conservative"
    assert args.operator_tier == "pro"
    assert args.show_toggles is True


def test_apply_cli_toggles_overrides_profile(tmp_path):
    config_path = _write_config(tmp_path)
    engine = TradingEngine(str(config_path))

    parser = build_arg_parser()
    args = parser.parse_args(
        [
            str(config_path),
            "--profile",
            "crypto_only",
            "--markets",
            "forex",
            "--strategies",
            "scalping",
            "--risk-profile",
            "conservative",
        ]
    )

    apply_cli_toggles(engine, args)
    state = engine.get_toggle_state()

    assert state["active_markets"] == ["forex"]
    assert state["active_strategies"] == ["scalping"]
    assert state["risk_profile"] == "conservative"


def test_apply_cli_toggles_autopilot_mode_and_human_overrides(tmp_path):
    config_path = _write_config(tmp_path)
    engine = TradingEngine(str(config_path))

    parser = build_arg_parser()
    args = parser.parse_args(
        [
            str(config_path),
            "--autopilot-mode",
            "auto",
            "--autopilot-include",
            "mean_reversion",
            "--autopilot-exclude",
            "arb",
        ]
    )

    apply_cli_toggles(engine, args)
    state = engine.get_toggle_state()
    assert state["autopilot_mode"] == "auto"
    assert "mean_reversion" in state["active_strategies"]
    assert "arb" not in state["active_strategies"]


def test_apply_cli_toggles_blocks_simple_tier_direct_overrides(tmp_path):
    config = _base_config()
    config["runtime"] = {"operator_tier": "simple"}
    config_path = tmp_path / "cli_simple.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")
    engine = TradingEngine(str(config_path))

    parser = build_arg_parser()
    args = parser.parse_args(
        [
            str(config_path),
            "--markets",
            "crypto",
        ]
    )
    with pytest.raises(ValueError):
        apply_cli_toggles(engine, args)


def test_apply_cli_toggles_applies_simple_mode_defaults(tmp_path):
    config = _base_config()
    config["runtime"] = {"operator_tier": "simple"}
    config_path = tmp_path / "cli_simple_defaults.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")
    engine = TradingEngine(str(config_path))

    parser = build_arg_parser()
    args = parser.parse_args([str(config_path)])
    apply_cli_toggles(engine, args)
    state = engine.get_toggle_state()

    assert state["operator_tier"] == "simple"
    assert state["active_markets"] == ["equities"]
    assert state["active_strategies"] == ["mean_reversion"]
    assert state["autopilot_mode"] == "auto"
