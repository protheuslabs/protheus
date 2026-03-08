"""Tests for incident automation and de-duplication."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.incident_automation import IncidentAutomation, IncidentThresholds
from analytics.ops_observability import OpsEventStore


def test_incident_automation_creates_incidents_from_critical_and_metric_alerts(tmp_path):
    ops_path = tmp_path / "ops_events.jsonl"
    incidents_path = tmp_path / "incidents.jsonl"
    store = OpsEventStore(path=str(ops_path))
    store.emit(
        category="execution",
        severity="critical",
        message="venue_disconnect",
        metrics={"reject_rate": 0.35},
    )
    store.emit(
        category="execution",
        severity="warning",
        message="high_reject_rate",
        metrics={"reject_rate": 0.50},
    )

    automation = IncidentAutomation(incident_log_path=str(incidents_path))
    payload = automation.run_from_store(
        store=store,
        since_minutes=120,
        thresholds=IncidentThresholds(max_reject_rate=0.25, max_slippage_mape_pct=35.0),
    )

    assert payload["events_considered"] == 2
    assert payload["incidents_created"] >= 2
    assert incidents_path.exists()


def test_incident_automation_deduplicates_repeated_events(tmp_path):
    ops_path = tmp_path / "ops_events.jsonl"
    incidents_path = tmp_path / "incidents.jsonl"
    store = OpsEventStore(path=str(ops_path))
    store.emit(
        category="execution",
        severity="critical",
        message="reconciliation_failure",
        metrics={"slippage_mape_pct": 55.0},
    )

    automation = IncidentAutomation(incident_log_path=str(incidents_path))
    first = automation.run_from_store(store=store, since_minutes=60)
    second = automation.run_from_store(store=store, since_minutes=60)

    assert first["incidents_created"] >= 1
    assert second["incidents_created"] == 0
