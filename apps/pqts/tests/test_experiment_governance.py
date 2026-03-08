"""Tests for immutable experiment run registry and rollback provenance."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.research_api import ResearchDashboardAPI
from research.database import Experiment, ResearchDatabase


def _seed_experiment(db: ResearchDatabase, experiment_id: str, status: str = "backtest") -> None:
    db.log_experiment(
        Experiment(
            experiment_id=experiment_id,
            strategy_name="market_making",
            variant_id="v1",
            features=["ob_imbalance"],
            parameters={"spread_bps": 12},
            status=status,
        )
    )


def test_experiment_run_registry_is_append_only(tmp_path):
    db = ResearchDatabase(str(tmp_path / "research.db"))
    _seed_experiment(db, "exp_a", status="paper")
    run_id = db.register_experiment_run(
        experiment_id="exp_a",
        stage="paper",
        decision_action="promote_to_paper",
        operator="autopilot",
        config_hash="cfg_a",
        evidence={"report_id": "rep_1"},
    )

    assert run_id.startswith("run_")
    with pytest.raises(sqlite3.DatabaseError):
        db.conn.execute(
            "UPDATE experiment_run_registry SET stage = 'live' WHERE run_id = ?",
            (run_id,),
        )


def test_status_regression_logs_rollback_provenance(tmp_path):
    db = ResearchDatabase(str(tmp_path / "research.db"))
    _seed_experiment(db, "exp_b", status="paper")
    run_id = db.register_experiment_run(
        experiment_id="exp_b",
        stage="paper",
        decision_action="promote_to_paper",
        operator="autopilot",
        config_hash="cfg_b",
        evidence={"report_id": "rep_2"},
    )
    assert run_id

    assert db.update_experiment_status("exp_b", "backtest", reason="risk_breach") is True
    rollbacks = db.list_rollback_events("exp_b")

    assert len(rollbacks) == 1
    assert rollbacks.iloc[0]["experiment_id"] == "exp_b"
    assert rollbacks.iloc[0]["from_run_id"] == run_id
    assert rollbacks.iloc[0]["reason"] == "risk_breach"


def test_research_dashboard_api_exposes_governance_payload(tmp_path):
    db_path = tmp_path / "research.db"
    db = ResearchDatabase(str(db_path))
    _seed_experiment(db, "exp_c", status="paper")
    db.register_experiment_run(
        experiment_id="exp_c",
        stage="paper",
        decision_action="promote_to_paper",
        operator="autopilot",
        config_hash="cfg_c",
        evidence={"report_id": "rep_3"},
    )
    db.update_experiment_status("exp_c", "backtest", reason="rollback_test")
    db.close()

    api = ResearchDashboardAPI(str(db_path))
    payload = api.get_experiment_governance("exp_c")
    api.close()

    assert payload["experiment_id"] == "exp_c"
    assert payload["run_count"] >= 1
    assert payload["rollback_count"] >= 1
    assert isinstance(payload["runs"], list)
    assert isinstance(payload["rollbacks"], list)
