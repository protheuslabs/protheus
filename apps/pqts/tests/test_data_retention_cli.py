"""CLI helper tests for scripts/enforce_data_retention.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "enforce_data_retention.py"
SPEC = importlib.util.spec_from_file_location("enforce_data_retention", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_retention_thresholds():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--root",
            "data",
            "--max-age-days",
            "90",
            "--max-total-files",
            "5000",
            "--suffixes",
            ".csv,.jsonl",
        ]
    )
    assert args.root == "data"
    assert args.max_age_days == 90
    assert args.max_total_files == 5000
    assert args.suffixes == ".csv,.jsonl"
