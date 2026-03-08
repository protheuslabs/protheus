"""Tests for promotion pipeline CLI helper command construction."""

from __future__ import annotations

import importlib.util
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_promotion_pipeline.py"
SPEC = importlib.util.spec_from_file_location("run_promotion_pipeline", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def _args() -> Namespace:
    return Namespace(
        config="config/paper.yaml",
        risk_profile="balanced",
        out_dir="data/reports",
        tca_db="data/tca_records.csv",
        research_validation="",
        research_report="",
        research_reports_dir="data/research_reports",
        epochs=10,
        campaign_symbols="BTCUSDT,ETHUSDT",
        campaign_cycles=120,
        campaign_sleep_seconds=0.0,
        campaign_notional_usd=150.0,
        campaign_readiness_every=30,
        lookback_days=60,
        min_days=30,
        min_fills=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
        calibration_min_samples=10,
        calibration_adaptation_rate=0.75,
        calibration_max_step_pct=0.80,
        max_calibration_alerts=0,
        promotion_min_days=30,
        promotion_max_days=90,
        promotion_min_purged_cv_sharpe=1.0,
        promotion_min_walk_forward_sharpe=1.0,
        promotion_min_deflated_sharpe=0.8,
        promotion_min_parameter_stability_score=0.55,
        promotion_min_regime_robustness_score=0.55,
        promotion_min_realized_net_alpha_bps=0.0,
        promotion_min_ci95_lower_realized_net_alpha_bps=0.0,
        canary_state_path="data/analytics/canary_ramp_state.json",
        canary_min_days_per_step=14,
        canary_max_slippage_mape_pct=25.0,
        canary_max_tca_drift_mape_pct=35.0,
        require_promotion=False,
        halt_on_canary_breach=False,
        switches=["tca_calibration_feedback=off"],
    )


def test_build_campaign_cmd_includes_research_validation_and_thresholds():
    cmd = MODULE._build_campaign_cmd(
        args=_args(),
        research_validation_path="data/reports/research_validation_payload.json",
    )
    joined = " ".join(cmd)
    assert "run_paper_campaign.py" in joined
    assert "--research-validation data/reports/research_validation_payload.json" in joined
    assert "--promotion-min-purged-cv-sharpe 1.0" in joined
    assert "--promotion-min-parameter-stability-score 0.55" in joined
    assert "--promotion-min-ci95-lower-realized-net-alpha-bps 0.0" in joined
    assert "--symbols BTCUSDT,ETHUSDT" in joined
    assert "--switch tca_calibration_feedback=off" in joined


def test_build_canary_cmd_includes_limits():
    cmd = MODULE._build_canary_cmd(args=_args())
    joined = " ".join(cmd)
    assert "run_canary_ramp.py" in joined
    assert "--max-slippage-mape-pct 25.0" in joined
    assert "--max-tca-drift-mape-pct 35.0" in joined
    assert "--risk-profile balanced" in joined
