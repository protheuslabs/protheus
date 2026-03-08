"""Service-level objective monitoring, alert routing, and weekly error-budget review."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _avg(values: Iterable[float]) -> float:
    rows = [float(v) for v in values]
    return float(sum(rows) / len(rows)) if rows else 0.0


@dataclass(frozen=True)
class SLOThresholds:
    """Operational SLO thresholds for stream/reconciliation/execution reliability."""

    min_stream_uptime_ratio: float = 0.995
    max_latency_p95_ms: float = 250.0
    max_rejection_rate: float = 0.01
    max_failure_rate: float = 0.01
    max_reconciliation_incidents: int = 0


@dataclass(frozen=True)
class AlertRoutingConfig:
    """Alert-routing destinations by severity."""

    alerts_path: str = "data/alerts/slo_alerts.jsonl"
    critical_channel: str = "pagerduty"
    warning_channel: str = "slack"
    info_channel: str = "log"


def _objective_min(
    *,
    key: str,
    value: float,
    threshold: float,
    message: str,
) -> Dict[str, Any]:
    value_f = float(value)
    threshold_f = float(threshold)
    budget = max(1.0 - threshold_f, 1e-12)
    consumed = max(threshold_f - value_f, 0.0)
    burn_rate = consumed / budget
    breached = value_f < threshold_f
    severity = "critical" if breached and burn_rate >= 1.0 else "warning" if breached else "info"
    return {
        "key": str(key),
        "operator": ">=",
        "value": value_f,
        "threshold": threshold_f,
        "message": str(message),
        "breached": bool(breached),
        "severity": severity,
        "error_budget": float(budget),
        "consumed": float(consumed),
        "burn_rate": float(burn_rate),
    }


def _objective_max(
    *,
    key: str,
    value: float,
    threshold: float,
    message: str,
) -> Dict[str, Any]:
    value_f = float(value)
    threshold_f = float(threshold)
    budget = max(threshold_f, 1e-12)
    consumed = max(value_f - threshold_f, 0.0)
    burn_rate = consumed / budget
    breached = value_f > threshold_f
    severity = "critical" if breached and burn_rate >= 1.0 else "warning" if breached else "info"
    return {
        "key": str(key),
        "operator": "<=",
        "value": value_f,
        "threshold": threshold_f,
        "message": str(message),
        "breached": bool(breached),
        "severity": severity,
        "error_budget": float(budget),
        "consumed": float(consumed),
        "burn_rate": float(burn_rate),
    }


def _objective_max_int(
    *,
    key: str,
    value: int,
    threshold: int,
    message: str,
) -> Dict[str, Any]:
    value_i = int(value)
    threshold_i = int(threshold)
    budget = max(threshold_i, 1)
    consumed = max(value_i - threshold_i, 0)
    burn_rate = float(consumed) / float(budget)
    breached = value_i > threshold_i
    severity = "critical" if breached and burn_rate >= 1.0 else "warning" if breached else "info"
    return {
        "key": str(key),
        "operator": "<=",
        "value": value_i,
        "threshold": threshold_i,
        "message": str(message),
        "breached": bool(breached),
        "severity": severity,
        "error_budget": int(budget),
        "consumed": int(consumed),
        "burn_rate": float(burn_rate),
    }


def _extract_stream_metrics(stream_health: Dict[str, Any]) -> Dict[str, float]:
    venues = stream_health.get("venues", [])
    venue_rows = [row for row in venues if isinstance(row, dict)]

    uptime_values = [_safe_float(row.get("stream_uptime_ratio"), 0.0) for row in venue_rows]
    latency_values = [_safe_float(row.get("latency_p95_ms"), 0.0) for row in venue_rows]
    rejection_values = [_safe_float(row.get("rejection_rate"), 0.0) for row in venue_rows]
    failure_values = [_safe_float(row.get("failure_rate"), 0.0) for row in venue_rows]

    summary = stream_health.get("summary", {}) if isinstance(stream_health, dict) else {}
    global_uptime = _safe_float(summary.get("stream_uptime_ratio"), _avg(uptime_values))

    return {
        "venues": float(len(venue_rows)),
        "stream_uptime_ratio": float(global_uptime),
        "latency_p95_ms": float(max(latency_values) if latency_values else 0.0),
        "rejection_rate": float(max(rejection_values) if rejection_values else 0.0),
        "failure_rate": float(max(failure_values) if failure_values else 0.0),
    }


def evaluate_service_level_objectives(
    *,
    stream_health: Dict[str, Any],
    reconciliation_incidents: List[Dict[str, Any]],
    thresholds: SLOThresholds | None = None,
) -> Dict[str, Any]:
    """Evaluate current operational posture against explicit SLO thresholds."""
    cfg = thresholds or SLOThresholds()
    stream_metrics = _extract_stream_metrics(stream_health)
    incidents = [row for row in reconciliation_incidents if isinstance(row, dict)]

    objectives = [
        _objective_min(
            key="stream_uptime_ratio",
            value=stream_metrics["stream_uptime_ratio"],
            threshold=float(cfg.min_stream_uptime_ratio),
            message="Global stream uptime below target.",
        ),
        _objective_max(
            key="latency_p95_ms",
            value=stream_metrics["latency_p95_ms"],
            threshold=float(cfg.max_latency_p95_ms),
            message="Venue latency p95 exceeded SLO.",
        ),
        _objective_max(
            key="rejection_rate",
            value=stream_metrics["rejection_rate"],
            threshold=float(cfg.max_rejection_rate),
            message="Order rejection rate exceeded SLO.",
        ),
        _objective_max(
            key="failure_rate",
            value=stream_metrics["failure_rate"],
            threshold=float(cfg.max_failure_rate),
            message="Order send failure rate exceeded SLO.",
        ),
        _objective_max_int(
            key="reconciliation_incidents",
            value=len(incidents),
            threshold=int(cfg.max_reconciliation_incidents),
            message="Reconciliation mismatch incidents exceeded allowance.",
        ),
    ]

    alerts = [row for row in objectives if bool(row.get("breached", False))]
    critical = sum(1 for row in alerts if str(row.get("severity", "")) == "critical")
    warning = sum(1 for row in alerts if str(row.get("severity", "")) == "warning")

    return {
        "timestamp": _utc_now_iso(),
        "thresholds": asdict(cfg),
        "metrics": {
            "stream": stream_metrics,
            "reconciliation_incidents": len(incidents),
        },
        "objectives": objectives,
        "alerts": alerts,
        "summary": {
            "critical": int(critical),
            "warning": int(warning),
            "alerts": int(len(alerts)),
            "healthy": int(len(alerts) == 0),
        },
    }


def route_slo_alerts(
    *,
    slo_payload: Dict[str, Any],
    config: AlertRoutingConfig | None = None,
) -> Dict[str, Any]:
    """Route SLO alerts to deterministic file-backed channels."""
    cfg = config or AlertRoutingConfig()
    alerts = list(slo_payload.get("alerts", []))

    path = Path(cfg.alerts_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    channel_counts: Dict[str, int] = {}
    written = 0
    timestamp = _utc_now_iso()

    with path.open("a", encoding="utf-8") as handle:
        for row in alerts:
            if not isinstance(row, dict):
                continue
            severity = str(row.get("severity", "info")).lower()
            if severity == "critical":
                channel = cfg.critical_channel
            elif severity == "warning":
                channel = cfg.warning_channel
            else:
                channel = cfg.info_channel

            payload = {
                "timestamp": timestamp,
                "channel": str(channel),
                "severity": severity,
                "alert": row,
            }
            handle.write(json.dumps(payload, sort_keys=True) + "\n")
            channel_counts[channel] = channel_counts.get(channel, 0) + 1
            written += 1

    return {
        "alerts_path": str(path),
        "alerts_written": int(written),
        "channels": channel_counts,
    }


def _report_timestamp(report: Dict[str, Any]) -> datetime:
    ts = report.get("timestamp")
    if ts is None and isinstance(report.get("slo_health"), dict):
        ts = report["slo_health"].get("timestamp")
    if ts is None:
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(timezone.utc)


def _normalize_slo_report(report: Dict[str, Any]) -> Dict[str, Any]:
    payload = report.get("slo_health") if isinstance(report.get("slo_health"), dict) else report
    if not isinstance(payload, dict):
        return {"timestamp": _utc_now_iso(), "objectives": []}
    return payload


def weekly_error_budget_review(
    *,
    slo_reports: List[Dict[str, Any]],
    window_days: int = 7,
) -> Dict[str, Any]:
    """Aggregate SLO reports into a weekly error-budget review summary."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=max(int(window_days), 1))

    scoped: List[Dict[str, Any]] = []
    for report in slo_reports:
        if not isinstance(report, dict):
            continue
        report_ts = _report_timestamp(report)
        if report_ts < cutoff:
            continue
        scoped.append({"timestamp": report_ts, "payload": _normalize_slo_report(report)})

    scoped.sort(key=lambda row: row["timestamp"])

    objective_rows: Dict[str, List[Dict[str, Any]]] = {}
    for row in scoped:
        for objective in row["payload"].get("objectives", []):
            if not isinstance(objective, dict):
                continue
            key = str(objective.get("key", "unknown"))
            objective_rows.setdefault(key, []).append(objective)

    review_rows: List[Dict[str, Any]] = []
    for key in sorted(objective_rows):
        rows = objective_rows[key]
        samples = len(rows)
        breaches = sum(1 for row in rows if bool(row.get("breached", False)))
        breach_rate = float(breaches / samples) if samples else 0.0
        avg_burn = _avg(_safe_float(row.get("burn_rate"), 0.0) for row in rows)
        max_burn = max((_safe_float(row.get("burn_rate"), 0.0) for row in rows), default=0.0)
        latest = rows[-1] if rows else {}

        status = "healthy"
        if bool(latest.get("breached", False)):
            status = "breached"
        elif breach_rate > 0.0 or avg_burn > 0.0:
            status = "watch"

        review_rows.append(
            {
                "key": key,
                "samples": int(samples),
                "breaches": int(breaches),
                "breach_rate": float(breach_rate),
                "avg_burn_rate": float(avg_burn),
                "max_burn_rate": float(max_burn),
                "latest_value": latest.get("value"),
                "threshold": latest.get("threshold"),
                "status": status,
                "error_budget_remaining_pct": float(max(0.0, 100.0 - min(avg_burn * 100.0, 100.0))),
            }
        )

    breached = sum(1 for row in review_rows if row["status"] == "breached")
    watch = sum(1 for row in review_rows if row["status"] == "watch")

    return {
        "timestamp": _utc_now_iso(),
        "window_days": max(int(window_days), 1),
        "sample_count": len(scoped),
        "objectives": review_rows,
        "summary": {
            "breached": int(breached),
            "watch": int(watch),
            "healthy": int(sum(1 for row in review_rows if row["status"] == "healthy")),
        },
    }


def load_reconciliation_incidents(
    *,
    incidents_path: str,
    lookback_hours: float = 24.0,
) -> List[Dict[str, Any]]:
    """Load reconciliation incident JSONL rows within lookback window."""
    path = Path(incidents_path)
    if not path.exists():
        return []

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=max(float(lookback_hours), 0.0))
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            payload = line.strip()
            if not payload:
                continue
            try:
                row = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            timestamp = row.get("timestamp")
            if timestamp is None:
                rows.append(row)
                continue
            try:
                ts = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00")).astimezone(
                    timezone.utc
                )
            except ValueError:
                continue
            if ts >= cutoff:
                rows.append(row)
    return rows


def load_slo_reports(
    *,
    report_dir: str,
    pattern: str = "slo_health_*.json",
    window_days: int = 7,
) -> List[Dict[str, Any]]:
    """Load recent SLO report JSON files from directory."""
    root = Path(report_dir)
    if not root.exists():
        return []

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=max(int(window_days), 1))

    rows: List[Dict[str, Any]] = []
    for path in sorted(root.glob(pattern)):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(payload, dict):
            continue

        ts = _report_timestamp(payload)
        if ts < cutoff:
            continue
        rows.append(payload)
    return rows
