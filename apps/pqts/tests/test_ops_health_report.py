"""Tests for ops health reporting script helpers."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "ops_health_report.py"
SPEC = importlib.util.spec_from_file_location("ops_health_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_latest_snapshot_selects_most_recent_name(tmp_path):
    first = tmp_path / "paper_campaign_snapshot_20260101T000000000000Z.json"
    second = tmp_path / "paper_campaign_snapshot_20260102T000000000000Z.json"
    first.write_text("{}", encoding="utf-8")
    second.write_text("{}", encoding="utf-8")

    assert MODULE._latest_snapshot(tmp_path) == second


def test_write_report_persists_json(tmp_path):
    payload = {"ops_health": {"summary": {"critical": 0}}}
    path = MODULE._write_report(tmp_path, payload)
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert parsed["ops_health"]["summary"]["critical"] == 0
