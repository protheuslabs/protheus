"""Operational health checks and deterministic alert generation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, List


@dataclass(frozen=True)
class OpsThresholds:
    """Alert thresholds for paper/live operational readiness."""

    max_reject_rate: float = 0.40
    max_p95_slippage_bps: float = 20.0
    max_mape_pct: float = 35.0
    max_degraded_venues: int = 0
    max_calibration_alerts: int = 0


def _alert(
    *,
    key: str,
    severity: str,
    message: str,
    value: float | int | str | bool,
    threshold: float | int | str | bool,
) -> Dict[str, Any]:
    return {
        "key": key,
        "severity": str(severity),
        "message": str(message),
        "value": value,
        "threshold": threshold,
    }


def build_ops_alerts(
    *,
    campaign_stats: Dict[str, Any],
    readiness: Dict[str, Any],
    reliability: Dict[str, Dict[str, float]],
    calibration: List[Dict[str, Any]],
    thresholds: OpsThresholds,
) -> List[Dict[str, Any]]:
    """Build deterministic alert list for operational gate decisions."""
    alerts: List[Dict[str, Any]] = []

    reject_rate = float(campaign_stats.get("reject_rate", 0.0))
    if reject_rate > float(thresholds.max_reject_rate):
        alerts.append(
            _alert(
                key="reject_rate",
                severity="critical",
                message="Campaign reject-rate exceeded threshold",
                value=reject_rate,
                threshold=float(thresholds.max_reject_rate),
            )
        )

    ready = bool(readiness.get("ready_for_canary", False))
    if not ready:
        alerts.append(
            _alert(
                key="readiness",
                severity="warning",
                message="Paper readiness gate not satisfied",
                value=ready,
                threshold=True,
            )
        )

    p95 = float(readiness.get("p95_realized_slippage_bps", 0.0))
    if p95 > float(thresholds.max_p95_slippage_bps):
        alerts.append(
            _alert(
                key="p95_slippage_bps",
                severity="critical",
                message="Realized p95 slippage exceeded threshold",
                value=p95,
                threshold=float(thresholds.max_p95_slippage_bps),
            )
        )

    mape = float(readiness.get("slippage_mape_pct", 0.0))
    if mape > float(thresholds.max_mape_pct):
        alerts.append(
            _alert(
                key="slippage_mape_pct",
                severity="critical",
                message="Slippage MAPE exceeded threshold",
                value=mape,
                threshold=float(thresholds.max_mape_pct),
            )
        )

    degraded = sum(
        1 for payload in reliability.values() if float(payload.get("degraded", 0.0)) >= 1.0
    )
    if degraded > int(thresholds.max_degraded_venues):
        alerts.append(
            _alert(
                key="degraded_venues",
                severity="critical",
                message="Execution reliability indicates degraded venues",
                value=degraded,
                threshold=int(thresholds.max_degraded_venues),
            )
        )

    calibration_alerts = sum(
        1 for row in calibration if str(row.get("status", "")).lower() == "alert"
    )
    if calibration_alerts > int(thresholds.max_calibration_alerts):
        alerts.append(
            _alert(
                key="calibration_alerts",
                severity="warning",
                message="Weekly TCA calibration emitted drift alerts",
                value=calibration_alerts,
                threshold=int(thresholds.max_calibration_alerts),
            )
        )

    return alerts


def summarize_ops_alerts(alerts: List[Dict[str, Any]]) -> Dict[str, Any]:
    critical = sum(1 for alert in alerts if str(alert.get("severity", "")).lower() == "critical")
    warning = sum(1 for alert in alerts if str(alert.get("severity", "")).lower() == "warning")
    return {
        "critical": critical,
        "warning": warning,
        "total": len(alerts),
        "healthy": critical == 0,
    }


def evaluate_operational_health(
    *,
    campaign_stats: Dict[str, Any],
    readiness: Dict[str, Any],
    reliability: Dict[str, Dict[str, float]],
    calibration: List[Dict[str, Any]],
    thresholds: OpsThresholds | None = None,
) -> Dict[str, Any]:
    """Single-call ops health evaluation payload for snapshots/reporting."""
    threshold_cfg = thresholds or OpsThresholds()
    alerts = build_ops_alerts(
        campaign_stats=campaign_stats,
        readiness=readiness,
        reliability=reliability,
        calibration=calibration,
        thresholds=threshold_cfg,
    )
    return {
        "thresholds": asdict(threshold_cfg),
        "alerts": alerts,
        "summary": summarize_ops_alerts(alerts),
    }
