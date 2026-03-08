"""Funnel analytics for demo-to-upgrade attribution events."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


def load_attribution_events(path: str) -> List[Dict[str, Any]]:
    log = Path(path)
    if not log.exists():
        return []
    rows: List[Dict[str, Any]] = []
    for line in log.read_text(encoding="utf-8").splitlines():
        payload = line.strip()
        if not payload:
            continue
        try:
            row = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def summarize_funnel(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    demo_runs = [row for row in events if str(row.get("event", "")) == "demo_run"]
    report_opens = [row for row in events if str(row.get("event", "")) == "demo_report_open"]
    upgrade_clicks = [row for row in events if str(row.get("event", "")) == "upgrade_to_protheus"]
    return {
        "events": len(events),
        "demo_runs": len(demo_runs),
        "report_opens": len(report_opens),
        "upgrade_clicks": len(upgrade_clicks),
        "report_open_rate": (len(report_opens) / max(len(demo_runs), 1)),
        "upgrade_click_rate": (len(upgrade_clicks) / max(len(demo_runs), 1)),
    }
