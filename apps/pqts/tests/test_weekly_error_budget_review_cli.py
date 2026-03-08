"""Tests for scripts/weekly_error_budget_review.py helpers."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "weekly_error_budget_review.py"
SPEC = importlib.util.spec_from_file_location("weekly_error_budget_review", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_expected_flags():
    parser = MODULE.build_parser()
    args = parser.parse_args(["--reports-dir", "tmp/reports", "--window-days", "14"])

    assert args.reports_dir == "tmp/reports"
    assert args.window_days == 14


def test_write_report_persists_json(tmp_path):
    payload = {"review": {"summary": {"breached": 2}}}
    path = MODULE._write_report(tmp_path, payload)
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert parsed["review"]["summary"]["breached"] == 2
