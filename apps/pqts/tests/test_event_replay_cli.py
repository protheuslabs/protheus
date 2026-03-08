"""CLI helper tests for scripts/run_event_replay.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_event_replay.py"
SPEC = importlib.util.spec_from_file_location("run_event_replay", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_requires_events_json():
    parser = MODULE.build_parser()
    args = parser.parse_args(["--events-json", "data/replay.json"])
    assert args.events_json == "data/replay.json"
