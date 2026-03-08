"""CLI helper tests for scripts/run_continuous_paper.py."""

from __future__ import annotations

import importlib.util
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_continuous_paper.py"
SPEC = importlib.util.spec_from_file_location("run_continuous_paper", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def _args() -> Namespace:
    return Namespace(
        config="config/paper.yaml",
        out_dir="data/reports",
        tca_db="data/tca_records.csv",
        risk_profile="balanced",
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
        min_ratio=0.5,
        max_ratio=1.5,
        max_degraded_venues=0,
        max_calibration_alerts=0,
        promotion_min_days=30,
        promotion_max_days=90,
        continuous=False,
        max_slices=1,
        runtime_hours=0.0,
        slice_interval_seconds=0.0,
        switches=["slippage_stress_model=off"],
    )


def test_build_campaign_cmd_contains_expected_flags():
    cmd = MODULE._build_campaign_cmd(_args())
    joined = " ".join(cmd)
    assert "run_paper_campaign.py" in joined
    assert "--symbols BTCUSDT,ETHUSDT" in joined
    assert "--risk-profile balanced" in joined
    assert "--switch slippage_stress_model=off" in joined
    assert "--tca-db-path data/tca_records.csv" in joined


def test_build_drift_and_calibration_cmds_contain_ratio_thresholds():
    drift_cmd = MODULE._build_drift_cmd(_args())
    calibration_cmd = MODULE._build_calibration_cmd(_args())
    drift_joined = " ".join(drift_cmd)
    calibration_joined = " ".join(calibration_cmd)

    assert "execution_drift_report.py" in drift_joined
    assert "--min-ratio 0.5" in drift_joined
    assert "--max-ratio 1.5" in drift_joined
    assert "--min-samples 200" in drift_joined

    assert "calibration_diagnostics_report.py" in calibration_joined
    assert "--min-ratio 0.5" in calibration_joined
    assert "--max-ratio 1.5" in calibration_joined
    assert "--min-samples 200" in calibration_joined
