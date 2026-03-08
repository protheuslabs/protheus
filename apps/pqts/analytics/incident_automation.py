"""Deterministic incident generation from ops events."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional

from analytics.ops_observability import OpsEventStore
from execution.distributed_ops_state import DistributedOpsState, DistributedStateConfig


@dataclass(frozen=True)
class IncidentThresholds:
    max_reject_rate: float = 0.25
    max_slippage_mape_pct: float = 35.0
    dedupe_ttl_seconds: int = 3600


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _incident_id(row: Mapping[str, Any], suffix: str = "") -> str:
    seed = {
        "timestamp": str(row.get("timestamp", "")),
        "category": str(row.get("category", "")),
        "severity": str(row.get("severity", "")),
        "message": str(row.get("message", "")),
        "suffix": str(suffix),
    }
    digest = hashlib.sha256(json.dumps(seed, sort_keys=True).encode("utf-8")).hexdigest()[:20]
    return f"inc_{digest}"


def _runbook_action(category: str, message: str) -> str:
    token = str(category).strip().lower()
    msg = str(message).strip().lower()
    if token == "execution" and "reject" in msg:
        return "check_router_risk_limits_and_exchange_capacity"
    if token == "autopilot":
        return "review_autopilot_policy_pack_and_override_logs"
    if token == "market_data":
        return "verify_stream_health_and_data_quality_gate"
    return "review_ops_event_context"


class IncidentAutomation:
    """Generate incident records and de-duplicate via distributed/local state."""

    def __init__(
        self,
        *,
        incident_log_path: str = "data/analytics/incidents.jsonl",
        state: Optional[DistributedOpsState] = None,
        state_namespace: str = "pqts_incidents",
    ):
        self.incident_log_path = Path(incident_log_path)
        self.incident_log_path.parent.mkdir(parents=True, exist_ok=True)
        self.state = state or DistributedOpsState(
            DistributedStateConfig(
                redis_url="",
                namespace=str(state_namespace),
                ttl_seconds=3600,
            )
        )

    @staticmethod
    def _event_incident(row: Mapping[str, Any], *, reason: str) -> Dict[str, Any]:
        category = str(row.get("category", "unknown"))
        message = str(row.get("message", ""))
        return {
            "incident_id": _incident_id(row, suffix=reason),
            "timestamp": _utc_now_iso(),
            "source_timestamp": str(row.get("timestamp", "")),
            "category": category,
            "severity": "critical",
            "reason": reason,
            "message": message,
            "runbook_action": _runbook_action(category, message),
            "metrics": dict(row.get("metrics", {}) if isinstance(row.get("metrics"), dict) else {}),
            "metadata": dict(
                row.get("metadata", {}) if isinstance(row.get("metadata"), dict) else {}
            ),
        }

    def _dedup(self, incident_id: str) -> bool:
        if self.state.seen_recently(incident_id):
            return True
        self.state.put(incident_id, {"seen": True, "timestamp": _utc_now_iso()})
        return False

    def process_events(
        self,
        rows: Iterable[Mapping[str, Any]],
        *,
        thresholds: IncidentThresholds = IncidentThresholds(),
    ) -> Dict[str, Any]:
        candidates: List[Dict[str, Any]] = []
        rows_list = [dict(row) for row in rows]
        for row in rows_list:
            severity = str(row.get("severity", "")).strip().lower()
            if severity == "critical":
                candidates.append(self._event_incident(row, reason="critical_event"))
            metrics = row.get("metrics", {}) if isinstance(row.get("metrics"), dict) else {}
            reject_rate = metrics.get("reject_rate")
            if reject_rate is not None and float(reject_rate) > float(thresholds.max_reject_rate):
                enriched = dict(row)
                enriched["message"] = (
                    f"reject_rate {float(reject_rate):.3f} exceeds "
                    f"{float(thresholds.max_reject_rate):.3f}"
                )
                candidates.append(self._event_incident(enriched, reason="metric_alert_reject_rate"))
            mape = metrics.get("slippage_mape_pct")
            if mape is not None and float(mape) > float(thresholds.max_slippage_mape_pct):
                enriched = dict(row)
                enriched["message"] = (
                    f"slippage_mape_pct {float(mape):.2f} exceeds "
                    f"{float(thresholds.max_slippage_mape_pct):.2f}"
                )
                candidates.append(
                    self._event_incident(enriched, reason="metric_alert_slippage_mape")
                )

        incidents: List[Dict[str, Any]] = []
        for row in candidates:
            incident_id = str(row["incident_id"])
            if self._dedup(incident_id):
                continue
            incidents.append(row)

        if incidents:
            with self.incident_log_path.open("a", encoding="utf-8") as handle:
                for row in incidents:
                    handle.write(json.dumps(row, sort_keys=True) + "\n")

        return {
            "generated_at": _utc_now_iso(),
            "incidents_created": int(len(incidents)),
            "candidate_count": int(len(candidates)),
            "incident_log_path": str(self.incident_log_path),
            "incidents": incidents,
        }

    def run_from_store(
        self,
        *,
        store: OpsEventStore,
        since_minutes: int = 60,
        thresholds: IncidentThresholds = IncidentThresholds(),
    ) -> Dict[str, Any]:
        rows = store.read_events(since_minutes=int(since_minutes))
        payload = self.process_events(rows, thresholds=thresholds)
        payload["events_considered"] = int(len(rows))
        payload["since_minutes"] = int(since_minutes)
        return payload
