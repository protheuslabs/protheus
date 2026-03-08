"""Tests for optional R analytics bridge and promotion gating."""

from __future__ import annotations

from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.ai_agent import AIResearchAgent
from research.auto_generator import StrategyVariant
from research.database import Experiment
from research.r_analytics_bridge import RAnalyticsBridge


def _agent_config(tmp_path: Path) -> dict:
    return {
        "db_path": str(tmp_path / "research.db"),
        "search_budget": 6,
        "top_performers": 2,
        "min_sharpe": 0.1,
        "max_drawdown": 0.5,
        "min_profit_factor": 0.0,
        "min_deflated_sharpe": -1.0,
        "max_pbo": 1.0,
        "min_walk_forward_consistency": 0.0,
        "capacity": {
            "deployable_capital": 100000.0,
            "max_annual_turnover_notional": 100000000.0,
        },
        "objective": {
            "max_sharpe": 1.5,
            "max_annual_vol": 0.25,
            "annual_turnover": 6.0,
            "cost_per_turnover": 0.0045,
        },
    }


def test_r_bridge_parses_valid_json_contract(monkeypatch, tmp_path):
    script_path = tmp_path / "validate_experiment.R"
    script_path.write_text("#!/usr/bin/env Rscript\n", encoding="utf-8")
    bridge = RAnalyticsBridge(script_path=str(script_path), rscript_bin="Rscript")

    payload = (
        '{"status":"ok","validator_passed_r":true,"deflated_sharpe_r":1.2,'
        '"pbo_estimate_r":0.2,"cv_sharpe_mean_r":1.3,"cv_sharpe_std_r":0.1,'
        '"bootstrap_mean_ci":[1.1,1.5],"reasons":[]}'
    )

    monkeypatch.setattr(
        "research.r_analytics_bridge.shutil.which",
        lambda _name: "/usr/bin/Rscript",
    )
    monkeypatch.setattr(
        "research.r_analytics_bridge.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=payload, stderr=""),
    )

    result = bridge.run_cv_validation(
        cv_sharpes=[1.1, 1.3, 1.5],
        n_trials=20,
        min_deflated_sharpe=0.8,
        max_pbo=0.5,
        min_cv_sharpe=0.6,
    )

    assert result["status"] == "ok"
    assert result["validator_passed_r"] is True
    assert result["deflated_sharpe_r"] == pytest.approx(1.2)
    assert result["pbo_estimate_r"] == pytest.approx(0.2)


def test_r_bridge_raises_on_failed_process(monkeypatch, tmp_path):
    script_path = tmp_path / "validate_experiment.R"
    script_path.write_text("#!/usr/bin/env Rscript\n", encoding="utf-8")
    bridge = RAnalyticsBridge(script_path=str(script_path), rscript_bin="Rscript")

    monkeypatch.setattr(
        "research.r_analytics_bridge.shutil.which",
        lambda _name: "/usr/bin/Rscript",
    )
    monkeypatch.setattr(
        "research.r_analytics_bridge.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=2, stdout="", stderr="boom"),
    )

    with pytest.raises(RuntimeError, match="R analytics validation failed"):
        bridge.run_cv_validation(
            cv_sharpes=[0.1, 0.2],
            n_trials=5,
            min_deflated_sharpe=0.0,
            max_pbo=1.0,
            min_cv_sharpe=0.0,
        )


def test_promote_to_paper_blocks_when_required_r_validator_fails(tmp_path):
    config = _agent_config(tmp_path)
    config["r_analytics"] = {"enabled": True, "required": True}
    agent = AIResearchAgent(config)

    variant = StrategyVariant(
        strategy_id="r_gate_strategy",
        strategy_type="trend_following",
        features=["price_momentum_1h"],
        parameters={"lookback_periods": 20},
    )
    agent.db.log_experiment(
        Experiment(
            experiment_id=variant.strategy_id,
            strategy_name=variant.strategy_type,
            variant_id="rg1",
            features=variant.features,
            parameters=variant.parameters,
            status="backtest",
        )
    )

    failing_row = {
        "variant": variant,
        "validator_passed": True,
        "metrics": {
            "max_drawdown": 0.1,
            "capacity_ratio": 0.5,
            "total_return": 0.2,
        },
        "walk_forward_sharpe": 1.0,
        "walk_forward_drawdown": 0.08,
        "walk_forward_consistency": 0.7,
        "deflated_sharpe": 1.0,
        "pbo_estimate": 0.2,
        "r_analytics": {"status": "ok", "validator_passed_r": False, "reasons": ["high_pbo_r"]},
        "r_validator_passed": False,
    }

    promoted = agent._promote_to_paper([failing_row])
    assert promoted == []

    passing_row = dict(failing_row)
    passing_row["r_analytics"] = {"status": "ok", "validator_passed_r": True, "reasons": []}
    passing_row["r_validator_passed"] = True
    promoted = agent._promote_to_paper([passing_row])
    assert promoted == [variant.strategy_id]
