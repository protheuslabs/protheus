"""Tests for dashboard-facing research analytics API."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.research_api import ResearchDashboardAPI
from research.auto_generator import StrategyVariant
from research.database import Experiment, ResearchDatabase
from research.report_builder import ResearchAnalyticsReportBuilder


def _seed_experiment(db: ResearchDatabase, experiment_id: str, status: str = "paper") -> None:
    db.log_experiment(
        Experiment(
            experiment_id=experiment_id,
            strategy_name="market_making",
            variant_id=experiment_id,
            features=["ob_imbalance"],
            parameters={"spread_bps": 12},
            status=status,
        )
    )


def _log_stage_sample(
    db: ResearchDatabase,
    *,
    experiment_id: str,
    stage: str,
    timestamp: datetime,
    sharpe: float,
    drawdown: float,
    slippage_mape: float,
    pnl: float,
    kills: int,
    arm: str,
) -> None:
    db.log_stage_metric(
        experiment_id,
        stage,
        {
            "pnl": pnl,
            "sharpe": sharpe,
            "drawdown": drawdown,
            "slippage_mape": slippage_mape,
            "kill_switch_triggers": kills,
            "notes": {"arm": arm},
        },
        timestamp=timestamp,
    )


def _insert_promotion_audit(
    db: ResearchDatabase,
    *,
    experiment_id: str,
    from_stage: str,
    to_stage: str,
    timestamp: datetime,
    reason: str,
) -> None:
    db.conn.execute(
        """
        INSERT INTO promotion_audit (experiment_id, from_stage, to_stage, reason, timestamp)
        VALUES (?, ?, ?, ?, ?)
        """,
        (experiment_id, from_stage, to_stage, reason, timestamp.isoformat()),
    )
    db.conn.commit()


def test_stage_gate_health_reports_pass_fail_breakdown(tmp_path):
    db_path = tmp_path / "research.db"
    db = ResearchDatabase(str(db_path))
    _seed_experiment(db, "exp_pass")
    _seed_experiment(db, "exp_fail")

    now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    for offset in range(30):
        ts = now - timedelta(days=offset)
        _log_stage_sample(
            db,
            experiment_id="exp_pass",
            stage="paper",
            timestamp=ts,
            sharpe=1.2,
            drawdown=0.08,
            slippage_mape=12.0,
            pnl=120.0,
            kills=0,
            arm="control",
        )

    for offset in range(15):
        ts = now - timedelta(days=offset)
        _log_stage_sample(
            db,
            experiment_id="exp_fail",
            stage="paper",
            timestamp=ts,
            sharpe=0.4,
            drawdown=0.25,
            slippage_mape=60.0,
            pnl=-20.0,
            kills=1,
            arm="treatment",
        )

    db.close()

    api = ResearchDashboardAPI(str(db_path))
    health = api.get_stage_gate_health(target_stage="live_canary", lookback_days=365)
    api.close()

    assert health["total_candidates"] == 2
    assert health["passed_candidates"] == 1
    assert health["pass_rate"] == pytest.approx(0.5)

    by_id = {row["experiment_id"]: row for row in health["strategies"]}
    assert by_id["exp_pass"]["passed"] is True
    assert by_id["exp_pass"]["checks"]["slippage_mape"] is True
    assert by_id["exp_fail"]["passed"] is False
    assert by_id["exp_fail"]["checks"]["sharpe"] is False
    assert by_id["exp_fail"]["checks"]["drawdown"] is False
    assert by_id["exp_fail"]["checks"]["slippage_mape"] is False


def test_pilot_ab_metrics_compute_differentials_and_false_promotions(tmp_path):
    db_path = tmp_path / "research.db"
    db = ResearchDatabase(str(db_path))
    _seed_experiment(db, "exp_control")
    _seed_experiment(db, "exp_treatment")

    now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    for offset in range(3):
        ts = now - timedelta(days=offset)
        _log_stage_sample(
            db,
            experiment_id="exp_control",
            stage="paper",
            timestamp=ts,
            sharpe=1.0,
            drawdown=0.10,
            slippage_mape=10.0,
            pnl=100.0,
            kills=0,
            arm="control",
        )
        _log_stage_sample(
            db,
            experiment_id="exp_treatment",
            stage="paper",
            timestamp=ts,
            sharpe=1.3,
            drawdown=0.11,
            slippage_mape=14.0,
            pnl=120.0,
            kills=1,
            arm="treatment",
        )

    _insert_promotion_audit(
        db,
        experiment_id="exp_control",
        from_stage="paper",
        to_stage="live_canary",
        timestamp=now - timedelta(days=6),
        reason="passed_paper_gate",
    )
    _insert_promotion_audit(
        db,
        experiment_id="exp_treatment",
        from_stage="paper",
        to_stage="live_canary",
        timestamp=now - timedelta(days=6),
        reason="passed_paper_gate",
    )
    _insert_promotion_audit(
        db,
        experiment_id="exp_treatment",
        from_stage="live_canary",
        to_stage="paper",
        timestamp=now - timedelta(days=4),
        reason="demote_after_breach",
    )
    db.close()

    api = ResearchDashboardAPI(str(db_path))
    metrics = api.get_pilot_ab_metrics(lookback_days=90, stage="paper")
    api.close()

    assert metrics["samples_labeled"] == 6
    assert metrics["arms"]["control"]["samples"] == 3
    assert metrics["arms"]["treatment"]["samples"] == 3
    assert metrics["arms"]["control"]["promotion_events"] == 1
    assert metrics["arms"]["treatment"]["promotion_events"] == 1
    assert metrics["arms"]["control"]["false_promotion_rate"] == pytest.approx(0.0)
    assert metrics["arms"]["treatment"]["false_promotion_rate"] == pytest.approx(1.0)

    delta = metrics["differential"]
    assert delta["sharpe"] == pytest.approx(0.3)
    assert delta["net_pnl"] == pytest.approx(60.0)
    assert delta["false_promotion_rate"] == pytest.approx(1.0)
    assert delta["slippage_mape"] == pytest.approx(4.0)
    assert delta["kill_switch_triggers"] == 3


def test_lineage_drilldown_returns_latest_artifact_payload(tmp_path):
    db_path = tmp_path / "research.db"
    db = ResearchDatabase(str(db_path))
    builder = ResearchAnalyticsReportBuilder(
        output_dir=str(tmp_path / "reports"),
        schema_version="1.0.0",
        db=db,
    )

    variant = StrategyVariant(
        strategy_id="exp_lineage",
        strategy_type="market_making",
        features=["ob_imbalance"],
        parameters={"spread_bps": 15},
    )
    _seed_experiment(db, "exp_lineage")

    report, report_path, _ = builder.build_and_save_from_result_row(
        result_row={
            "variant": variant,
            "metrics": {
                "sharpe": 1.1,
                "total_return": 0.14,
                "max_drawdown": 0.07,
                "win_rate": 0.58,
                "total_trades": 80,
                "turnover_annualized": 4.8,
                "cost_drag_bps": 190.0,
                "capacity_ratio": 0.6,
            },
            "cv": {"cv_sharpe": 1.0, "cv_sharpe_std": 0.2, "cv_drawdown": 0.1},
            "deflated_sharpe": 0.9,
            "pbo_estimate": 0.2,
            "validator_passed": True,
            "validator_reasons": [],
            "fitness": 1.0,
        },
        data_lineage={
            "dataset_id": "lineage_dataset",
            "symbols": ["BTCUSDT"],
            "start": "2025-01-01T00:00:00+00:00",
            "end": "2025-01-31T00:00:00+00:00",
            "bars": 744,
            "timezone": "UTC",
            "source": "unit_test",
            "code_sha": "deadbeef",
            "config_hash": "cfg_1",
        },
        objective_assessment={"objective_valid": True},
        promotion_stage="paper",
        promoted=False,
        promotion_reason="ranked_below_cutoff",
        promotion_gate_checks={"validator": True},
        decision={
            "action": "hold",
            "rationale": "ranked below promotion cutoff",
            "supporting_card_ids": ["card_1"],
            "counterevidence_card_ids": ["card_2"],
            "confidence": 0.6,
            "operator": "pilot",
        },
    )

    assert report_path.exists()
    _insert_promotion_audit(
        db,
        experiment_id="exp_lineage",
        from_stage="backtest",
        to_stage="paper",
        timestamp=datetime(2026, 2, 1, tzinfo=timezone.utc),
        reason="passed_research_gate",
    )
    db.close()

    api = ResearchDashboardAPI(str(db_path))
    drilldown = api.get_lineage_drilldown("exp_lineage")
    api.close()

    assert drilldown["found"] is True
    assert drilldown["artifact_count"] == 1
    assert drilldown["latest"]["report_id"] == report.report_id
    assert drilldown["latest"]["report_path"] == str(report_path)
    assert drilldown["lineage"]["dataset_id"] == "lineage_dataset"
    assert drilldown["decision"]["action"] == "hold"
    assert drilldown["decision"]["operator"] == "pilot"
    assert drilldown["validation"]["deflated_sharpe"] == pytest.approx(0.9)
    assert len(drilldown["promotion_audit"]) == 1
