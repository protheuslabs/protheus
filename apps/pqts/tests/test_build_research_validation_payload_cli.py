"""Tests for research-validation payload builder CLI helpers."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "build_research_validation_payload.py"
SPEC = importlib.util.spec_from_file_location("build_research_validation_payload", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_build_payload_maps_validation_and_gate_checks():
    report = {
        "report_id": "rep_1",
        "experiment_id": "exp_1",
        "validation": {
            "cv_sharpe": 1.25,
            "walk_forward_sharpe": 1.10,
            "deflated_sharpe": 0.95,
            "turnover_annualized": 5.0,
            "total_return": 0.15,
        },
        "promotion": {
            "gate_checks": {
                "validator": True,
                "walk_forward_sharpe": True,
                "deflated_sharpe": True,
            }
        },
    }
    payload = MODULE._build_payload(
        report=report,
        report_path=Path("/tmp/report.json"),
        min_purged_cv_sharpe=1.0,
        min_walk_forward_sharpe=1.0,
        min_deflated_sharpe=0.8,
        min_parameter_stability_score=0.55,
        min_regime_robustness_score=0.55,
        max_expected_alpha_bps=25.0,
    )

    assert payload["purged_cv_sharpe"] == 1.25
    assert payload["walk_forward_sharpe"] == 1.10
    assert payload["deflated_sharpe"] == 0.95
    assert payload["purged_cv_passed"] is True
    assert payload["walk_forward_passed"] is True
    assert payload["deflated_sharpe_passed"] is True
    assert payload["parameter_stability_passed"] is True
    assert payload["regime_robustness_passed"] is True
    assert payload["expected_alpha_bps"] == 25.0


def test_select_best_report_prefers_promotable_payload(tmp_path):
    weak = tmp_path / "swing" / "weak.json"
    strong = tmp_path / "hold" / "strong.json"
    weak.parent.mkdir(parents=True, exist_ok=True)
    strong.parent.mkdir(parents=True, exist_ok=True)
    weak.write_text(
        json.dumps(
            {
                "report_id": "rep_weak",
                "experiment_id": "exp_weak",
                "validation": {
                    "cv_sharpe": 0.1,
                    "walk_forward_sharpe": 0.1,
                    "deflated_sharpe": 0.1,
                    "turnover_annualized": 1.0,
                    "total_return": 0.50,
                },
            }
        ),
        encoding="utf-8",
    )
    strong.write_text(
        json.dumps(
            {
                "report_id": "rep_strong",
                "experiment_id": "exp_strong",
                "validation": {
                    "cv_sharpe": 1.3,
                    "walk_forward_sharpe": 1.1,
                    "deflated_sharpe": 0.9,
                    "turnover_annualized": 4.0,
                    "total_return": 0.04,
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

    report_path, payload, mode = MODULE._select_best_report_payload(
        reports_dir=tmp_path,
        min_purged_cv_sharpe=1.0,
        min_walk_forward_sharpe=1.0,
        min_deflated_sharpe=0.8,
        min_parameter_stability_score=0.55,
        min_regime_robustness_score=0.55,
        max_expected_alpha_bps=25.0,
    )

    assert mode == "best_promotable"
    assert report_path == strong
    assert payload["report_id"] == "rep_strong"


def test_build_payload_derives_expected_alpha_from_extras_net_return():
    report = {
        "report_id": "rep_2",
        "experiment_id": "exp_2",
        "validation": {
            "cv_sharpe": 1.1,
            "walk_forward_sharpe": 1.0,
            "deflated_sharpe": 0.9,
            "turnover_annualized": 10.0,
            "total_return": 0.0,
        },
        "extras": {
            "net_expected_return": 0.03,
        },
    }
    payload = MODULE._build_payload(
        report=report,
        report_path=Path("/tmp/report_2.json"),
        min_purged_cv_sharpe=1.0,
        min_walk_forward_sharpe=1.0,
        min_deflated_sharpe=0.8,
        min_parameter_stability_score=0.55,
        min_regime_robustness_score=0.55,
        max_expected_alpha_bps=50.0,
    )

    assert payload["expected_alpha_bps"] == 30.0
