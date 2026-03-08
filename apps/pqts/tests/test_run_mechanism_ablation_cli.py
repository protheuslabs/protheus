"""CLI helper tests for scripts/run_mechanism_ablation.py."""

from __future__ import annotations

import importlib.util
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_mechanism_ablation.py"
SPEC = importlib.util.spec_from_file_location("run_mechanism_ablation", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def _args() -> Namespace:
    return Namespace(
        config="config/paper.yaml",
        out_dir="data/reports",
        tca_dir="data/tca/ablation",
        reports_dir="data/research_reports",
        report="",
        research_validation="data/reports/research_validation_payload.json",
        risk_profile="balanced",
        symbols="BTCUSDT,ETHUSDT",
        mechanisms="routing_failover,capacity_curves",
        cycles=120,
        sleep_seconds=0.0,
        notional_usd=150.0,
        readiness_every=30,
        lookback_days=60,
        min_days=1,
        min_fills=1,
        paper_base_slippage_bps=3.0,
        paper_min_slippage_bps=0.5,
        paper_stress_multiplier=1.25,
        paper_stress_fill_ratio_multiplier=0.9,
        min_purged_cv_sharpe=1.0,
        min_walk_forward_sharpe=1.0,
        min_deflated_sharpe=0.8,
        min_parameter_stability_score=0.55,
        min_regime_robustness_score=0.55,
        include_agent_off=False,
        switches=[],
    )


def test_build_campaign_cmd_includes_switches_and_tca_path():
    cmd = MODULE._build_campaign_cmd(
        args=_args(),
        tca_db_path="data/tca/ablation/case.csv",
        switch_state={"routing_failover": True, "capacity_curves": False},
        research_validation_path="data/reports/research_validation_payload.json",
        expected_alpha_bps=None,
    )
    joined = " ".join(cmd)
    assert "run_paper_campaign.py" in joined
    assert "--tca-db-path data/tca/ablation/case.csv" in joined
    assert "--switch routing_failover=on" in joined
    assert "--switch capacity_curves=off" in joined
    assert "--research-validation data/reports/research_validation_payload.json" in joined


def test_parse_mechanisms_validates_tokens():
    parsed = MODULE._parse_mechanisms("routing_failover,capacity_curves")
    assert parsed == ["routing_failover", "capacity_curves"]
