"""Tests for scripts/slo_health_report.py helper functions."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "slo_health_report.py"
SPEC = importlib.util.spec_from_file_location("slo_health_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_threshold_flags():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--min-stream-uptime-ratio",
            "0.99",
            "--max-latency-p95-ms",
            "300",
            "--max-reconciliation-incidents",
            "2",
        ]
    )

    assert args.min_stream_uptime_ratio == 0.99
    assert args.max_latency_p95_ms == 300.0
    assert args.max_reconciliation_incidents == 2


def test_write_report_persists_json(tmp_path):
    payload = {"slo_health": {"summary": {"alerts": 1}}}
    path = MODULE._write_report(tmp_path, payload)
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert parsed["slo_health"]["summary"]["alerts"] == 1
