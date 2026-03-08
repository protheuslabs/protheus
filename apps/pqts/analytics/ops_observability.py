"""Structured observability events for runtime operations and autopilot decisions."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from analytics.telemetry_backbone import TelemetryBackbone
from core.persistence import EventPersistenceStore


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class OpsEvent:
    timestamp: str
    category: str
    severity: str
    message: str
    metrics: Dict[str, Any]
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "category": self.category,
            "severity": self.severity,
            "message": self.message,
            "metrics": dict(self.metrics),
            "metadata": dict(self.metadata),
        }


class OpsEventStore:
    """Append-only JSONL sink with deterministic summaries for alerting."""

    def __init__(
        self,
        path: str = "data/analytics/ops_events.jsonl",
        database_url: str = "",
        telemetry_enabled: bool = False,
    ):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.persistence = EventPersistenceStore(database_url) if database_url else None
        self.telemetry = TelemetryBackbone(service_name="pqts", enabled=bool(telemetry_enabled))

    def emit(
        self,
        *,
        category: str,
        severity: str,
        message: str,
        metrics: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[datetime] = None,
    ) -> OpsEvent:
        event = OpsEvent(
            timestamp=(timestamp or _utc_now()).isoformat(),
            category=str(category),
            severity=str(severity).lower(),
            message=str(message),
            metrics=dict(metrics or {}),
            metadata=dict(metadata or {}),
        )
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.to_dict(), sort_keys=True) + "\n")
        if self.persistence is not None:
            self.persistence.append(category=event.category, payload=event.to_dict())
        self.telemetry.record_event(category=event.category, metrics=event.metrics)
        return event

    def read_events(self, *, since_minutes: Optional[int] = None) -> List[Dict[str, Any]]:
        if not self.path.exists():
            return []
        cutoff = None
        if since_minutes is not None:
            cutoff = _utc_now() - timedelta(minutes=max(int(since_minutes), 0))

        rows: List[Dict[str, Any]] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            payload = line.strip()
            if not payload:
                continue
            try:
                row = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            if cutoff is not None:
                try:
                    ts = datetime.fromisoformat(str(row.get("timestamp", "")))
                except Exception:
                    continue
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                if ts < cutoff:
                    continue
            rows.append(row)
        return rows

    def summarize(self, *, since_minutes: Optional[int] = None) -> Dict[str, Any]:
        rows = self.read_events(since_minutes=since_minutes)
        by_category: Dict[str, int] = {}
        by_severity: Dict[str, int] = {}
        for row in rows:
            category = str(row.get("category", "unknown"))
            severity = str(row.get("severity", "info")).lower()
            by_category[category] = by_category.get(category, 0) + 1
            by_severity[severity] = by_severity.get(severity, 0) + 1
        return {
            "events": len(rows),
            "by_category": by_category,
            "by_severity": by_severity,
        }

    def critical_alerts(self, *, since_minutes: int = 60) -> List[Dict[str, Any]]:
        rows = self.read_events(since_minutes=since_minutes)
        return [row for row in rows if str(row.get("severity", "")).lower() == "critical"]


def build_ops_alerts(
    *,
    rows: Iterable[Dict[str, Any]],
    max_reject_rate: float = 0.25,
    max_slippage_mape_pct: float = 35.0,
) -> List[str]:
    alerts: List[str] = []
    for row in rows:
        metrics = row.get("metrics", {}) if isinstance(row, dict) else {}
        if not isinstance(metrics, dict):
            continue
        reject_rate = metrics.get("reject_rate")
        if reject_rate is not None and float(reject_rate) > float(max_reject_rate):
            alerts.append(
                f"reject_rate {float(reject_rate):.3f} exceeds threshold {float(max_reject_rate):.3f}"
            )
        mape = metrics.get("slippage_mape_pct")
        if mape is not None and float(mape) > float(max_slippage_mape_pct):
            alerts.append(
                f"slippage_mape_pct {float(mape):.2f} exceeds threshold {float(max_slippage_mape_pct):.2f}"
            )
    return alerts
