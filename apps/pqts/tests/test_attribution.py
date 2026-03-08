"""Tests for launch attribution event logging."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from analytics.attribution import log_event


def test_log_event_appends_jsonl(tmp_path):
    path = tmp_path / "events.jsonl"
    out = log_event(
        event="demo_run",
        source="x_thread",
        metadata={"market": "crypto"},
        log_path=str(path),
        timestamp="2026-03-04T00:00:00+00:00",
    )

    assert out == path
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1

    payload = json.loads(lines[0])
    assert payload["event"] == "demo_run"
    assert payload["source"] == "x_thread"
    assert payload["metadata"]["market"] == "crypto"
