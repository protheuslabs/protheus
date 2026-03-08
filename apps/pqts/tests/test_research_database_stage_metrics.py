"""Tests for stage-metrics window/list helpers in research DB."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.database import Experiment, ResearchDatabase


def test_get_and_list_stage_metrics_parse_notes(tmp_path):
    db = ResearchDatabase(str(tmp_path / "research.db"))
    db.log_experiment(
        Experiment(
            experiment_id="exp_1",
            strategy_name="market_making",
            variant_id="v1",
            features=["ob_imbalance"],
            parameters={},
            status="paper",
        )
    )
    db.log_stage_metric(
        "exp_1",
        "paper",
        {
            "pnl": 12.0,
            "sharpe": 1.1,
            "drawdown": 0.1,
            "slippage_mape": 15.0,
            "notes": {"arm": "control"},
        },
        timestamp=datetime.now(timezone.utc),
    )

    scoped = db.get_stage_metrics("exp_1", "paper", lookback_days=30)
    listed = db.list_stage_metrics(stage="paper", lookback_days=30)

    assert len(scoped) == 1
    assert scoped.iloc[0]["notes"]["arm"] == "control"
    assert len(listed) >= 1
