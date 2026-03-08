"""Tests for immutable pilot assignment and promotion economics gates."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.ai_agent import AIResearchAgent
from research.auto_generator import StrategyVariant
from research.database import Experiment, ResearchDatabase


def _agent_config(tmp_path: Path) -> dict:
    return {
        "db_path": str(tmp_path / "research.db"),
        "search_budget": 6,
        "top_performers": 3,
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
        "costs": {
            "commission_bps": 6.0,
            "slippage_bps": 8.0,
            "borrow_funding_bps": 4.0,
        },
        "allocation": {
            "max_weight": 0.8,
            "min_weight": 0.0,
            "capacity_haircut": 0.05,
        },
        "objective": {
            "max_sharpe": 1.5,
            "max_annual_vol": 0.25,
            "annual_turnover": 6.0,
            "cost_per_turnover": 0.0045,
        },
    }


def test_assign_pilot_arm_is_immutable(tmp_path):
    db = ResearchDatabase(str(tmp_path / "research.db"))
    db.log_experiment(
        Experiment(
            experiment_id="exp_1",
            strategy_name="market_making",
            variant_id="v1",
            features=["f1"],
            parameters={},
            status="backtest",
        )
    )

    first = db.assign_pilot_arm("exp_1")
    second = db.assign_pilot_arm("exp_1", arm="treatment")
    stored = db.get_pilot_assignment("exp_1")

    assert first in {"control", "treatment"}
    assert second == first
    assert stored is not None
    assert stored["arm"] == first
    assert len(db.list_pilot_assignments()) == 1


def test_promotion_gate_blocks_negative_economics_and_sets_allocations(tmp_path):
    agent = AIResearchAgent(_agent_config(tmp_path))

    losing_variant = StrategyVariant(
        strategy_id="losing_strategy",
        strategy_type="market_making",
        features=["ob_imbalance"],
        parameters={"spread_bps": 10},
    )
    winning_variant_1 = StrategyVariant(
        strategy_id="winning_strategy_1",
        strategy_type="market_making",
        features=["ob_imbalance"],
        parameters={"spread_bps": 20},
    )
    winning_variant_2 = StrategyVariant(
        strategy_id="winning_strategy_2",
        strategy_type="market_making",
        features=["ob_imbalance"],
        parameters={"spread_bps": 25},
    )

    for variant in (losing_variant, winning_variant_1, winning_variant_2):
        agent.db.log_experiment(
            Experiment(
                experiment_id=variant.strategy_id,
                strategy_name=variant.strategy_type,
                variant_id=variant.strategy_id,
                features=variant.features,
                parameters=variant.parameters,
                status="backtest",
            )
        )

    validated = [
        {
            "variant": losing_variant,
            "validator_passed": True,
            "metrics": {
                "max_drawdown": 0.08,
                "capacity_ratio": 0.6,
                "total_return": 0.01,
                "annual_return_estimate": 0.01,
                "turnover_annualized": 40.0,
                "sharpe": 1.0,
            },
            "walk_forward_sharpe": 1.1,
            "walk_forward_drawdown": 0.08,
            "walk_forward_consistency": 0.7,
            "deflated_sharpe": 1.0,
            "pbo_estimate": 0.2,
            "r_validator_passed": True,
            "r_analytics": {"status": "disabled", "validator_passed_r": True},
        },
        {
            "variant": winning_variant_1,
            "validator_passed": True,
            "metrics": {
                "max_drawdown": 0.07,
                "capacity_ratio": 0.5,
                "total_return": 0.2,
                "annual_return_estimate": 0.35,
                "turnover_annualized": 2.0,
                "sharpe": 1.3,
            },
            "walk_forward_sharpe": 1.2,
            "walk_forward_drawdown": 0.07,
            "walk_forward_consistency": 0.8,
            "deflated_sharpe": 1.0,
            "pbo_estimate": 0.2,
            "r_validator_passed": True,
            "r_analytics": {"status": "disabled", "validator_passed_r": True},
        },
        {
            "variant": winning_variant_2,
            "validator_passed": True,
            "metrics": {
                "max_drawdown": 0.06,
                "capacity_ratio": 0.55,
                "total_return": 0.18,
                "annual_return_estimate": 0.30,
                "turnover_annualized": 2.5,
                "sharpe": 1.15,
            },
            "walk_forward_sharpe": 1.1,
            "walk_forward_drawdown": 0.06,
            "walk_forward_consistency": 0.75,
            "deflated_sharpe": 0.95,
            "pbo_estimate": 0.25,
            "r_validator_passed": True,
            "r_analytics": {"status": "disabled", "validator_passed_r": True},
        },
    ]

    promoted = agent._promote_to_paper(validated)

    assert "losing_strategy" not in promoted
    assert set(promoted) == {"winning_strategy_1", "winning_strategy_2"}
    assert agent.db.get_experiment_status("losing_strategy") == "backtest"
    assert abs(sum(agent.last_allocation_weights.values()) - 1.0) < 1e-9

    assignment_1 = agent.db.get_pilot_assignment("winning_strategy_1")
    assignment_2 = agent.db.get_pilot_assignment("winning_strategy_2")
    assert assignment_1 is not None
    assert assignment_2 is not None

    notes_rows = agent.db.conn.execute(
        "SELECT experiment_id, notes FROM stage_metrics WHERE stage = 'paper' ORDER BY experiment_id"
    ).fetchall()
    assert len(notes_rows) == 2
    roles = {}
    for row in notes_rows:
        payload = json.loads(row["notes"])
        assert "target_weight" in payload
        assert "net_expected_return" in payload
        assert payload["horizon"] == "intraday"
        hook = payload["promotion_hook"]
        assert hook["champion_id"] == "winning_strategy_1"
        roles[row["experiment_id"]] = hook["role"]
    assert roles["winning_strategy_1"] == "champion"
    assert roles["winning_strategy_2"] == "challenger"

    # Re-assignment requests should not mutate immutable arm.
    assert agent.db.assign_pilot_arm("winning_strategy_1", arm="control") == assignment_1["arm"]
