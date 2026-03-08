"""Tests for monthly attribution summaries and allocation feedback."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.monthly_attribution import (
    compute_feedback_multipliers,
    summarize_monthly_attribution,
)
from research.ai_agent import AIResearchAgent
from research.database import Experiment


def _agent_config(tmp_path: Path) -> dict:
    return {
        "db_path": str(tmp_path / "research.db"),
        "search_budget": 4,
        "top_performers": 2,
        "min_sharpe": -1.0,
        "max_drawdown": 1.0,
        "min_deflated_sharpe": -2.0,
        "max_pbo": 1.0,
        "capacity": {
            "deployable_capital": 100000.0,
            "max_annual_turnover_notional": 100000000.0,
        },
        "allocation_feedback": {
            "enabled": True,
            "lookback_days": 120,
            "min_multiplier": 0.5,
            "max_multiplier": 1.5,
        },
        "objective": {
            "max_sharpe": 1.5,
            "max_annual_vol": 0.25,
            "annual_turnover": 6.0,
            "cost_per_turnover": 0.0045,
        },
    }


def test_summarize_monthly_attribution_aggregates_rows():
    rows = [
        {
            "strategy_id": "alpha",
            "timestamp": "2026-01-10T00:00:00+00:00",
            "pnl": 100.0,
            "sharpe": 1.2,
            "drawdown": 0.1,
            "slippage_mape": 12.0,
        },
        {
            "strategy_id": "alpha",
            "timestamp": "2026-01-15T00:00:00+00:00",
            "pnl": 90.0,
            "sharpe": 1.0,
            "drawdown": 0.12,
            "slippage_mape": 10.0,
        },
        {
            "strategy_id": "beta",
            "timestamp": "2026-02-02T00:00:00+00:00",
            "pnl": -30.0,
            "sharpe": 0.3,
            "drawdown": 0.2,
            "slippage_mape": 25.0,
        },
    ]
    summary = summarize_monthly_attribution(rows)

    assert summary
    first = summary[0]
    assert "strategy_id" in first
    assert "month" in first
    assert "score" in first


def test_compute_feedback_multipliers_rewards_positive_pnl():
    rows = [
        {
            "strategy_id": "winner",
            "total_pnl": 1200.0,
            "avg_sharpe": 1.4,
            "avg_drawdown": 0.08,
            "avg_slippage_mape": 12.0,
        },
        {
            "strategy_id": "loser",
            "total_pnl": -900.0,
            "avg_sharpe": 0.4,
            "avg_drawdown": 0.25,
            "avg_slippage_mape": 35.0,
        },
    ]
    multipliers = compute_feedback_multipliers(rows, min_multiplier=0.5, max_multiplier=1.5)
    assert multipliers["winner"] > multipliers["loser"]
    assert 0.5 <= multipliers["loser"] <= 1.5


def test_agent_allocation_feedback_downweights_negative_history(tmp_path):
    agent = AIResearchAgent(_agent_config(tmp_path))
    now = datetime.now(timezone.utc)

    for strategy_id in ("winner", "loser"):
        agent.db.log_experiment(
            Experiment(
                experiment_id=strategy_id,
                strategy_name="market_making",
                variant_id=strategy_id,
                features=["ob_imbalance"],
                parameters={},
                status="paper",
            )
        )

    for day in range(30):
        agent.record_stage_metrics(
            "winner",
            "paper",
            {
                "pnl": 80.0,
                "sharpe": 1.2,
                "drawdown": 0.08,
                "slippage_mape": 12.0,
            },
            timestamp=now - timedelta(days=day),
        )
        agent.record_stage_metrics(
            "loser",
            "paper",
            {
                "pnl": -50.0,
                "sharpe": 0.3,
                "drawdown": 0.22,
                "slippage_mape": 33.0,
            },
            timestamp=now - timedelta(days=day),
        )

    adjusted = agent._apply_monthly_attribution_feedback({"winner": 0.5, "loser": 0.5})
    assert adjusted["winner"] > adjusted["loser"]
