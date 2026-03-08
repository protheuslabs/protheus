"""CLI helper tests for scripts/run_paper_campaign.py."""

from __future__ import annotations

import importlib.util
import inspect
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_paper_campaign.py"
SPEC = importlib.util.spec_from_file_location("run_paper_campaign", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_risk_profile_and_symbols():
    parser = MODULE.build_arg_parser()
    args = parser.parse_args(
        [
            "--risk-profile",
            "professional",
            "--symbols",
            "BTCUSDT,ETHUSDT",
            "--cycles",
            "12",
        ]
    )

    assert args.risk_profile == "professional"
    assert args.symbols == "BTCUSDT,ETHUSDT"
    assert args.cycles == 12


def test_snapshot_computes_revenue_before_promotion_gate():
    source = inspect.getsource(MODULE._run)
    revenue_idx = source.find("revenue_payload = revenue_diagnostics.payload")
    promotion_idx = source.find("promotion_gate = evaluate_promotion_gate")
    assert revenue_idx != -1
    assert promotion_idx != -1
    assert revenue_idx < promotion_idx


def test_parser_accepts_alpha_override_and_research_report():
    parser = MODULE.build_arg_parser()
    args = parser.parse_args(
        [
            "--campaign-expected-alpha-bps",
            "7.5",
            "--research-report",
            "data/research_reports/exp/report.json",
            "--tca-db-path",
            "data/tca/ab_on.csv",
            "--calibration-min-samples",
            "12",
            "--calibration-adaptation-rate",
            "0.6",
            "--calibration-max-step-pct",
            "0.5",
            "--switch",
            "capacity_curves=off",
            "--disable-major-bootstrap",
            "--allow-short-probes",
        ]
    )

    assert args.campaign_expected_alpha_bps == 7.5
    assert args.research_report == "data/research_reports/exp/report.json"
    assert args.tca_db_path == "data/tca/ab_on.csv"
    assert args.calibration_min_samples == 12
    assert args.calibration_adaptation_rate == 0.6
    assert args.calibration_max_step_pct == 0.5
    assert args.switches == ["capacity_curves=off"]
    assert args.disable_major_bootstrap is True
    assert args.allow_short_probes is True


def test_bootstrap_symbols_prefers_major_universe():
    symbols = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "AAPL"]
    selected = MODULE._bootstrap_symbols(symbols, major_only=True)
    assert selected == ["BTCUSDT", "ETHUSDT"]


def test_resolve_campaign_expected_alpha_prefers_research_payload():
    alpha, source = MODULE._resolve_campaign_expected_alpha_bps(
        explicit_expected_alpha_bps=None,
        research_validation={"expected_alpha_bps": 6.0},
        broker_default_expected_alpha_bps=2.0,
    )

    assert alpha == 6.0
    assert source == "research_validation:expected_alpha_bps"


def test_load_research_validation_from_report_maps_validation_fields(tmp_path):
    report_path = tmp_path / "report.json"
    report_path.write_text(
        json.dumps(
            {
                "validation": {
                    "cv_sharpe": 1.2,
                    "walk_forward_sharpe": 1.1,
                    "deflated_sharpe": 0.9,
                    "turnover_annualized": 5.0,
                    "total_return": 0.12,
                },
                "promotion": {
                    "gate_checks": {
                        "validator": True,
                        "walk_forward_sharpe": True,
                        "deflated_sharpe": True,
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    payload = MODULE._load_research_validation_from_report(str(report_path))
    assert payload["purged_cv_sharpe"] == 1.2
    assert payload["walk_forward_sharpe"] == 1.1
    assert payload["deflated_sharpe"] == 0.9
    assert payload["parameter_stability_passed"] is True
    assert payload["regime_robustness_passed"] is True
    assert payload["expected_alpha_bps"] == 25.0
