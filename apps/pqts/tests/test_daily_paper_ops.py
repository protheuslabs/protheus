"""Tests for daily paper ops wrapper command generation and parsing."""

from __future__ import annotations

import importlib.util
import json
import sys
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "daily_paper_ops.py"
SPEC = importlib.util.spec_from_file_location("daily_paper_ops", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def _args() -> Namespace:
    return Namespace(
        config="config/paper.yaml",
        risk_profile="balanced",
        campaign_symbols="BTCUSDT,ETHUSDT",
        campaign_cycles=120,
        campaign_sleep_seconds=0.0,
        campaign_notional_usd=150.0,
        campaign_readiness_every=30,
        paper_base_slippage_bps=8.0,
        paper_min_slippage_bps=1.0,
        paper_stress_multiplier=3.0,
        paper_stress_fill_ratio_multiplier=0.70,
        tca_db="data/tca_records.csv",
        lookback_days=60,
        min_days=30,
        min_fills=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
        calibration_min_samples=10,
        calibration_adaptation_rate=0.75,
        calibration_max_step_pct=0.80,
        max_degraded_venues=0,
        max_calibration_alerts=0,
        promotion_min_days=30,
        promotion_max_days=90,
        out_dir="data/reports",
        skip_campaign=False,
        require_ready=False,
        require_no_critical_alerts=False,
        switches=["capacity_curves=off"],
    )


def test_parse_json_from_output_reads_last_json_object():
    payload = MODULE._parse_json_from_output('line\n{"a":1}\n{"b":2}\n')
    assert payload == {"b": 2}


def test_build_campaign_cmd_contains_expected_flags():
    cmd = MODULE._build_campaign_cmd(_args())
    joined = " ".join(cmd)
    assert "run_paper_campaign.py" in joined
    assert "--symbols BTCUSDT,ETHUSDT" in joined
    assert "--cycles 120" in joined
    assert "--notional-usd 150.0" in joined
    assert "--paper-stress-multiplier 3.0" in joined
    assert "--risk-profile balanced" in joined
    assert "--switch capacity_curves=off" in joined


def test_build_readiness_cmd_contains_expected_flags():
    cmd = MODULE._build_readiness_cmd(_args())
    joined = " ".join(cmd)
    assert "paper_readiness_report.py" in joined
    assert "--tca-db data/tca_records.csv" in joined
    assert "--min-days 30" in joined


def test_write_summary_persists_json(tmp_path):
    summary = {
        "campaign": {"submitted": 10},
        "readiness": {"ready_for_canary": False},
    }
    path = MODULE._write_summary(tmp_path, summary)
    assert path.exists()
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert parsed["campaign"]["submitted"] == 10
