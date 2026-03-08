"""Tests for websocket ingestion CLI parser."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_ws_ingestion.py"
SPEC = importlib.util.spec_from_file_location("run_ws_ingestion", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_cycles_and_paths():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--cycles",
            "3",
            "--events-path",
            "tmp/ws.jsonl",
            "--max-messages-per-stream",
            "5",
            "--risk-profile",
            "aggressive",
            "--no-live-fetcher",
        ]
    )

    assert args.cycles == 3
    assert args.events_path == "tmp/ws.jsonl"
    assert args.max_messages_per_stream == 5
    assert args.risk_profile == "aggressive"
    assert args.no_live_fetcher is True
