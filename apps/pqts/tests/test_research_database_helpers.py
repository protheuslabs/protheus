"""Tests for additional research database helper accessors."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.database import Experiment, ResearchDatabase


def test_get_experiment_and_list_experiments(tmp_path):
    db = ResearchDatabase(str(tmp_path / "research.db"))
    db.log_experiment(
        Experiment(
            experiment_id="exp_1",
            strategy_name="market_making",
            variant_id="v1",
            features=["a"],
            parameters={"x": 1},
            status="paper",
        )
    )
    db.log_experiment(
        Experiment(
            experiment_id="exp_2",
            strategy_name="funding_arbitrage",
            variant_id="v2",
            features=["b"],
            parameters={"y": 2},
            status="backtest",
        )
    )

    row = db.get_experiment("exp_1")
    assert row is not None
    assert row["strategy_name"] == "market_making"

    paper = db.list_experiments(status="paper")
    assert len(paper) == 1
    assert paper.iloc[0]["experiment_id"] == "exp_1"
