"""CLI helper tests for scripts/calibration_diagnostics_report.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "calibration_diagnostics_report.py"
SPEC = importlib.util.spec_from_file_location("calibration_diagnostics_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_ratio_and_sample_thresholds():
    parser = MODULE.build_arg_parser()
    args = parser.parse_args(
        [
            "--tca-db",
            "data/tca_records.csv",
            "--min-samples",
            "200",
            "--max-mape-pct",
            "30",
            "--min-ratio",
            "0.7",
            "--max-ratio",
            "1.4",
        ]
    )

    assert args.tca_db == "data/tca_records.csv"
    assert args.min_samples == 200
    assert args.max_mape_pct == 30.0
    assert args.min_ratio == 0.7
    assert args.max_ratio == 1.4
