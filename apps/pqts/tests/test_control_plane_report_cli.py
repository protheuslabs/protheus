"""Tests for control-plane report CLI helpers."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "control_plane_report.py"
SPEC = importlib.util.spec_from_file_location("control_plane_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_window_days():
    parser = MODULE.build_parser()
    args = parser.parse_args(["--window-days", "14", "--tenant-plan", "starter"])
    assert args.window_days == 14
    assert args.tenant_plan == "starter"


def test_write_report_persists_json(tmp_path):
    payload = {"summary": {"tenant_count": 1}}
    path = MODULE._write_report(tmp_path, payload)
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert parsed["summary"]["tenant_count"] == 1
