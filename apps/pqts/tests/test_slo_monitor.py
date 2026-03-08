"""Tests for SLO evaluation, alert routing, and weekly error-budget review."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.slo_monitor import (
    AlertRoutingConfig,
    SLOThresholds,
    evaluate_service_level_objectives,
    load_reconciliation_incidents,
    load_slo_reports,
    route_slo_alerts,
    weekly_error_budget_review,
)


def test_slo_evaluation_and_alert_routing(tmp_path):
    stream_health = {
        "summary": {"stream_uptime_ratio": 0.90},
        "venues": [
            {
                "venue": "binance",
                "stream_uptime_ratio": 0.90,
                "latency_p95_ms": 800.0,
                "rejection_rate": 0.06,
                "failure_rate": 0.03,
            }
        ],
    }
    incidents = [
        {"timestamp": datetime.now(timezone.utc).isoformat(), "summary": {"mismatches": 1}},
        {"timestamp": datetime.now(timezone.utc).isoformat(), "summary": {"mismatches": 2}},
    ]

    payload = evaluate_service_level_objectives(
        stream_health=stream_health,
        reconciliation_incidents=incidents,
        thresholds=SLOThresholds(
            min_stream_uptime_ratio=0.995,
            max_latency_p95_ms=250.0,
            max_rejection_rate=0.01,
            max_failure_rate=0.01,
            max_reconciliation_incidents=0,
        ),
    )

    assert payload["summary"]["alerts"] == 5
    keys = {row["key"] for row in payload["alerts"]}
    assert "stream_uptime_ratio" in keys
    assert "latency_p95_ms" in keys
    assert "reconciliation_incidents" in keys

    routing = route_slo_alerts(
        slo_payload=payload,
        config=AlertRoutingConfig(alerts_path=str(tmp_path / "slo_alerts.jsonl")),
    )

    assert routing["alerts_written"] == 5
    rows = [
        json.loads(line)
        for line in (tmp_path / "slo_alerts.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(rows) == 5
    assert any(row["channel"] == "pagerduty" for row in rows)


def test_weekly_error_budget_review_and_loaders(tmp_path):
    now = datetime.now(timezone.utc)
    incidents_path = tmp_path / "reconciliation_incidents.jsonl"
    incidents_path.write_text(
        "\n".join(
            [
                json.dumps({"timestamp": (now - timedelta(hours=1)).isoformat(), "id": "recent"}),
                json.dumps({"timestamp": (now - timedelta(days=3)).isoformat(), "id": "old"}),
            ]
        ),
        encoding="utf-8",
    )

    recent = load_reconciliation_incidents(
        incidents_path=str(incidents_path),
        lookback_hours=24.0,
    )
    assert len(recent) == 1
    assert recent[0]["id"] == "recent"

    healthy = evaluate_service_level_objectives(
        stream_health={
            "summary": {"stream_uptime_ratio": 1.0},
            "venues": [
                {
                    "venue": "coinbase",
                    "stream_uptime_ratio": 1.0,
                    "latency_p95_ms": 20.0,
                    "rejection_rate": 0.0,
                    "failure_rate": 0.0,
                }
            ],
        },
        reconciliation_incidents=[],
    )
    breached = evaluate_service_level_objectives(
        stream_health={
            "summary": {"stream_uptime_ratio": 0.96},
            "venues": [
                {
                    "venue": "coinbase",
                    "stream_uptime_ratio": 0.96,
                    "latency_p95_ms": 350.0,
                    "rejection_rate": 0.02,
                    "failure_rate": 0.02,
                }
            ],
        },
        reconciliation_incidents=[{"timestamp": now.isoformat()}],
    )

    report_recent = {
        "timestamp": (now - timedelta(hours=2)).isoformat(),
        "slo_health": breached,
    }
    report_old = {
        "timestamp": (now - timedelta(days=10)).isoformat(),
        "slo_health": healthy,
    }

    report_dir = tmp_path / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "slo_health_recent.json").write_text(
        json.dumps(report_recent),
        encoding="utf-8",
    )
    (report_dir / "slo_health_old.json").write_text(
        json.dumps(report_old),
        encoding="utf-8",
    )

    loaded = load_slo_reports(report_dir=str(report_dir), window_days=7)
    assert len(loaded) == 1

    review = weekly_error_budget_review(slo_reports=loaded, window_days=7)
    assert review["sample_count"] == 1
    keys = {row["key"] for row in review["objectives"]}
    assert "stream_uptime_ratio" in keys
    assert review["summary"]["breached"] >= 1
