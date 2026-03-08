"""CLI helper tests for scripts/weekly_kpi_report.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "weekly_kpi_report.py"
SPEC = importlib.util.spec_from_file_location("weekly_kpi_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_weekly_kpi_thresholds():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--tca-db",
            "data/tca_records.csv",
            "--lookback-days",
            "14",
            "--max-slippage-mape-pct",
            "30",
            "--min-ci95-lower-net-alpha-bps",
            "0.5",
            "--max-reconciliation-incidents",
            "1",
        ]
    )
    assert args.lookback_days == 14
    assert args.max_slippage_mape_pct == 30.0
    assert args.min_ci95_lower_net_alpha_bps == 0.5
    assert args.max_reconciliation_incidents == 1
