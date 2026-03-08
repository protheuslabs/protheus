"""CLI helper tests for scripts/run_incident_automation.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_incident_automation.py"
SPEC = importlib.util.spec_from_file_location("run_incident_automation", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_threshold_flags():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--ops-events",
            "tmp/ops.jsonl",
            "--incident-log",
            "tmp/incidents.jsonl",
            "--since-minutes",
            "120",
            "--max-reject-rate",
            "0.3",
            "--max-slippage-mape-pct",
            "40",
        ]
    )
    assert args.ops_events == "tmp/ops.jsonl"
    assert args.incident_log == "tmp/incidents.jsonl"
    assert args.since_minutes == 120
    assert args.max_reject_rate == 0.3
    assert args.max_slippage_mape_pct == 40
