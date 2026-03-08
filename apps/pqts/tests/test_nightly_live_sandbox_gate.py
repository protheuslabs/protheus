"""Tests for nightly live sandbox gate threshold evaluation."""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "nightly_live_sandbox_gate.py"
SPEC = importlib.util.spec_from_file_location("nightly_live_sandbox_gate", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_count_recent_reconciliation_incidents_respects_lookback(tmp_path):
    path = tmp_path / "incidents.jsonl"
    now = datetime.now(timezone.utc)
    rows = [
        {"timestamp": (now - timedelta(hours=1)).isoformat(), "summary": {"mismatches": 1}},
        {"timestamp": (now - timedelta(hours=30)).isoformat(), "summary": {"mismatches": 1}},
    ]
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")

    count = MODULE._count_recent_reconciliation_incidents(str(path), lookback_hours=24)
    assert count == 1


def test_gate_fails_when_thresholds_exceeded(tmp_path):
    cert_path = tmp_path / "cert.json"
    cert_path.write_text(
        json.dumps(
            {
                "all_passed": True,
                "totals": {
                    "reject_rate": 0.20,
                    "timeout_rate": 0.10,
                },
            }
        ),
        encoding="utf-8",
    )
    incident_path = tmp_path / "incidents.jsonl"
    incident_path.write_text(
        json.dumps({"timestamp": datetime.now(timezone.utc).isoformat()}),
        encoding="utf-8",
    )

    class _Args:
        cert_report = str(cert_path)
        reconciliation_incidents = str(incident_path)
        reconciliation_lookback_hours = 24
        max_reject_rate = 0.05
        max_timeout_rate = 0.02
        max_reconciliation_mismatches = 0

    payload = MODULE._evaluate(_Args())
    assert payload["passed"] is False
    assert "reject_rate_exceeded" in payload["failures"]
    assert "timeout_rate_exceeded" in payload["failures"]
    assert "reconciliation_mismatch_exceeded" in payload["failures"]
