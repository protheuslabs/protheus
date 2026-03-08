"""Tests for canonical research analytics reporting layer."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.ai_agent import AIResearchAgent
from research.auto_generator import StrategyVariant
from research.database import Experiment, ResearchDatabase
from research.report_builder import ResearchAnalyticsReportBuilder


def _historical_data() -> dict[str, pd.DataFrame]:
    index = pd.date_range("2025-01-01", periods=240, freq="h")
    btc = (
        100.0 + np.linspace(0.0, 6.0, len(index)) + 0.5 * np.sin(np.linspace(0.0, 9.0, len(index)))
    )
    eth = (
        60.0 + np.linspace(0.0, 4.0, len(index)) + 0.4 * np.cos(np.linspace(0.0, 10.0, len(index)))
    )
    return {
        "BTCUSDT": pd.DataFrame({"close": btc}, index=index),
        "ETHUSDT": pd.DataFrame({"close": eth}, index=index),
    }


def _agent_config(tmp_path: Path) -> dict:
    return {
        "db_path": str(tmp_path / "research.db"),
        "search_budget": 6,
        "top_performers": 2,
        "min_sharpe": -1.0,
        "max_drawdown": 1.0,
        "min_profit_factor": 0.0,
        "min_deflated_sharpe": -2.0,
        "max_pbo": 1.0,
        "capacity": {
            "deployable_capital": 200000.0,
            "max_annual_turnover_notional": 200000000.0,
        },
        "objective": {
            "max_sharpe": 1.5,
            "max_annual_vol": 0.25,
            "annual_turnover": 6.0,
            "cost_per_turnover": 0.0045,
        },
        "analytics": {
            "report_dir": str(tmp_path / "reports"),
            "report_schema_version": "1.0.0",
        },
    }


def test_report_builder_persists_canonical_artifact_and_db_entry(tmp_path):
    db = ResearchDatabase(str(tmp_path / "research.db"))
    builder = ResearchAnalyticsReportBuilder(
        output_dir=str(tmp_path / "reports"),
        schema_version="1.0.0",
        db=db,
    )

    variant = StrategyVariant(
        strategy_id="mm_variant_001",
        strategy_type="market_making",
        features=["ob_imbalance", "vol_regime"],
        parameters={"spread_bps": 20},
    )
    db.log_experiment(
        Experiment(
            experiment_id=variant.strategy_id,
            strategy_name=variant.strategy_type,
            variant_id="001",
            features=variant.features,
            parameters=variant.parameters,
            status="backtest",
        )
    )

    row = {
        "variant": variant,
        "metrics": {
            "sharpe": 1.2,
            "total_return": 0.18,
            "max_drawdown": 0.08,
            "win_rate": 0.57,
            "total_trades": 120,
            "turnover_annualized": 5.4,
            "cost_drag_bps": 220.0,
            "capacity_ratio": 0.7,
        },
        "cv": {"cv_sharpe": 1.1, "cv_sharpe_std": 0.2, "cv_drawdown": 0.09},
        "deflated_sharpe": 0.95,
        "pbo_estimate": 0.22,
        "validator_passed": True,
        "validator_reasons": [],
        "fitness": 1.03,
    }

    report, path, report_hash = builder.build_and_save_from_result_row(
        result_row=row,
        data_lineage={
            "dataset_id": "unit_dataset",
            "symbols": ["BTCUSDT"],
            "start": "2025-01-01T00:00:00+00:00",
            "end": "2025-01-10T00:00:00+00:00",
            "bars": 240,
            "timezone": "UTC",
            "source": "unit_test",
            "code_sha": "abc123",
            "config_hash": "cfg123",
        },
        objective_assessment={"objective_valid": True},
        promotion_stage="paper",
        promoted=True,
        promotion_reason="passed_research_gate",
        promotion_gate_checks={"validator": True},
        decision={
            "action": "promote_to_paper",
            "rationale": "all gates passed",
            "supporting_card_ids": ["card_1"],
            "counterevidence_card_ids": [],
            "confidence": 0.85,
            "operator": "pilot",
        },
    )

    assert path.exists()
    assert report_hash
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["experiment_id"] == variant.strategy_id
    assert payload["validation"]["deflated_sharpe"] == 0.95
    assert payload["decision"]["action"] == "promote_to_paper"

    artifacts = db.get_report_artifacts(variant.strategy_id)
    assert len(artifacts) == 1
    assert artifacts.iloc[0]["report_id"] == report.report_id
    assert artifacts.iloc[0]["report_path"] == str(path)


def test_agent_research_cycle_emits_strategy_report_artifacts(tmp_path):
    agent = AIResearchAgent(_agent_config(tmp_path))
    data = _historical_data()

    report = agent.research_cycle(data, strategy_types=["market_making"])
    analytics = report["analytics"]

    assert analytics["report_count"] == report["summary"]["backtests_run"]
    assert analytics["report_schema_version"] == "1.0.0"
    assert analytics["reports"]
    assert analytics["artifact_manifest_count"] == analytics["report_count"]
    for item in analytics["reports"]:
        assert Path(item["path"]).exists()
        assert Path(item["artifact_manifest"]).exists()

    artifacts = agent.db.get_report_artifacts()
    assert len(artifacts) == analytics["report_count"]


def test_tca_summary_supports_regime_conditioned_attribution():
    records = [
        {
            "timestamp": "2026-03-01T00:00:00Z",
            "predicted_slippage_bps": 5.0,
            "realized_slippage_bps": 6.0,
            "requested_qty": 10.0,
            "filled_qty": 10.0,
        },
        {
            "timestamp": "2026-03-01T01:00:00Z",
            "predicted_slippage_bps": 4.0,
            "realized_slippage_bps": 8.0,
            "requested_qty": 20.0,
            "filled_qty": 15.0,
        },
    ]
    regime_map = {
        "2026-03-01T00:00:00Z": "range",
        "2026-03-01T01:00:00Z": "high_vol",
    }

    summary = ResearchAnalyticsReportBuilder.summarize_tca_by_regime(
        tca_records=records,
        regime_by_timestamp=regime_map,
    )

    assert summary["tca_samples"] == 2
    assert summary["fill_ratio"] < 1.0
    assert "range" in summary["regime_tca"]
    assert "high_vol" in summary["regime_tca"]
