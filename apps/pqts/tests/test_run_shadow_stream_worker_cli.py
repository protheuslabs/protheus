"""Tests for websocket shadow stream worker CLI parser."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_shadow_stream_worker.py"
SPEC = importlib.util.spec_from_file_location("run_shadow_stream_worker", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_cycles_and_risk_profile():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--cycles",
            "4",
            "--sleep-seconds",
            "0.1",
            "--risk-profile",
            "conservative",
        ]
    )

    assert args.cycles == 4
    assert args.sleep_seconds == 0.1
    assert args.risk_profile == "conservative"
