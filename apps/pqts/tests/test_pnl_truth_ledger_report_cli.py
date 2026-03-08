"""CLI helper tests for scripts/pnl_truth_ledger_report.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "pnl_truth_ledger_report.py"
SPEC = importlib.util.spec_from_file_location("pnl_truth_ledger_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_disable_thresholds():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--tca-db",
            "data/tca_records.csv",
            "--lookback-days",
            "45",
            "--min-trades",
            "20",
            "--disable-threshold-net-alpha-usd",
            "-10",
            "--disable-strategy-venues",
            "--disable-strategy-symbols",
            "--disable-strategy-venue-symbols",
            "--strict",
        ]
    )
    assert args.lookback_days == 45
    assert args.min_trades == 20
    assert args.disable_threshold_net_alpha_usd == -10.0
    assert args.disable_strategy_venues is True
    assert args.disable_strategy_symbols is True
    assert args.disable_strategy_venue_symbols is True
    assert args.strict is True
