"""CLI helper tests for scripts/monthly_attribution_report.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "monthly_attribution_report.py"
SPEC = importlib.util.spec_from_file_location("monthly_attribution_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_stage_and_lookback():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        ["--db-path", "tmp/research.db", "--stage", "paper", "--lookback-days", "45"]
    )
    assert args.db_path == "tmp/research.db"
    assert args.stage == "paper"
    assert args.lookback_days == 45
