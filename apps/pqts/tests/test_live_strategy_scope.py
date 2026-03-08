"""Tests for hard live-strategy scope enforcement in stage promotion."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.ai_agent import AIResearchAgent
from research.database import Experiment


def _config(tmp_path: Path) -> dict:
    return {
        "db_path": str(tmp_path / "research.db"),
        "min_sharpe": 0.1,
        "max_drawdown": 0.5,
        "min_deflated_sharpe": -1.0,
        "max_pbo": 1.0,
        "live_allowed_strategy_types": ["market_making"],
        "paper_min_days": 1,
        "paper_max_slippage_mape": 100.0,
        "paper_max_kill_switch_triggers": 0,
    }


def _log_paper(agent: AIResearchAgent, strategy_id: str) -> None:
    now = datetime.now(timezone.utc)
    for day in range(2):
        agent.record_stage_metrics(
            strategy_id,
            "paper",
            {
                "pnl": 10.0,
                "sharpe": 1.5,
                "drawdown": 0.05,
                "slippage_mape": 5.0,
                "kill_switch_triggers": 0,
            },
            timestamp=now - timedelta(days=day),
        )


def test_live_scope_blocks_non_whitelisted_strategy(tmp_path):
    agent = AIResearchAgent(_config(tmp_path))
    strategy_id = "cross_exchange_variant"

    agent.db.log_experiment(
        Experiment(
            experiment_id=strategy_id,
            strategy_name="cross_exchange",
            variant_id="v1",
            features=["spread"],
            parameters={},
            status="paper",
        )
    )
    _log_paper(agent, strategy_id)

    assert agent.promote_from_stage(strategy_id, "live_canary") is False
    assert agent.db.get_experiment_status(strategy_id) == "paper"
