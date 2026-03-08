"""Tests for funnel analytics helpers."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.funnel import load_attribution_events, summarize_funnel


def test_load_and_summarize_funnel(tmp_path):
    path = tmp_path / "events.jsonl"
    rows = [
        {"event": "demo_run", "source": "x"},
        {"event": "demo_report_open", "source": "x"},
        {"event": "upgrade_to_protheus", "source": "x"},
    ]
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")

    events = load_attribution_events(str(path))
    summary = summarize_funnel(events)
    assert summary["events"] == 3
    assert summary["demo_runs"] == 1
    assert summary["report_opens"] == 1
    assert summary["upgrade_clicks"] == 1
