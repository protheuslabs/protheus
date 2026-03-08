"""Structured telemetry for simulation-suite runs and optimization tracking."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import pandas as pd


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_token(*parts: object, length: int = 16) -> str:
    payload = "|".join(str(part) for part in parts)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return digest[:length]


@dataclass(frozen=True)
class SimulationTelemetryEvent:
    """Canonical event for simulation telemetry."""

    event_id: str
    event_type: str
    run_id: str
    market: str
    strategy: str
    timestamp: str
    cycle: int
    metrics: Dict[str, Any]
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class SimulationTelemetryStore:
    """Append-only JSONL telemetry sink with run summaries and leaderboards."""

    def __init__(self, log_path: str = "data/analytics/simulation_events.jsonl"):
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def emit(
        self,
        *,
        event_type: str,
        run_id: str,
        market: str,
        strategy: str,
        cycle: int = 0,
        metrics: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[str] = None,
    ) -> SimulationTelemetryEvent:
        """Persist one simulation event row and return the normalized object."""
        ts = timestamp or _utc_now_iso()
        safe_metrics = dict(metrics or {})
        safe_metadata = dict(metadata or {})
        event = SimulationTelemetryEvent(
            event_id=f"evt_{_hash_token(run_id, event_type, cycle, ts, safe_metrics)}",
            event_type=str(event_type),
            run_id=str(run_id),
            market=str(market),
            strategy=str(strategy),
            timestamp=str(ts),
            cycle=int(cycle),
            metrics=safe_metrics,
            metadata=safe_metadata,
        )
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.to_dict(), sort_keys=True) + "\n")
        return event

    def read_events(
        self,
        *,
        run_id: Optional[str] = None,
        event_type: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Read and optionally filter telemetry rows."""
        if not self.log_path.exists():
            return []

        rows: List[Dict[str, Any]] = []
        with self.log_path.open("r", encoding="utf-8") as handle:
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
                if run_id is not None and str(row.get("run_id")) != str(run_id):
                    continue
                if event_type is not None and str(row.get("event_type")) != str(event_type):
                    continue
                rows.append(row)

        rows.sort(key=lambda row: str(row.get("timestamp", "")))
        return rows

    @staticmethod
    def _safe_float(value: Any, default: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return float(default)

    @staticmethod
    def _safe_bool(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return float(value) != 0.0
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "y"}
        return False

    def summarize_run(self, run_id: str) -> Dict[str, Any]:
        """Build a deterministic run-level summary used by dashboards/optimization."""
        events = self.read_events(run_id=run_id)
        if not events:
            return {
                "run_id": str(run_id),
                "events": 0,
                "market": "unknown",
                "strategy": "unknown",
                "quality_score": 0.0,
                "ready_for_canary": False,
                "promotion_decision": "unknown",
            }

        market = str(events[0].get("market", "unknown"))
        strategy = str(events[0].get("strategy", "unknown"))

        cycle_rows = [row for row in events if str(row.get("event_type")) == "cycle_snapshot"]
        completed_row = next(
            (row for row in reversed(events) if str(row.get("event_type")) == "run_completed"),
            None,
        )

        latest_metrics = dict(cycle_rows[-1].get("metrics", {})) if cycle_rows else {}
        if completed_row is not None:
            latest_metrics.update(dict(completed_row.get("metrics", {})))

        submitted = int(self._safe_float(latest_metrics.get("submitted"), 0.0))
        filled = int(self._safe_float(latest_metrics.get("filled"), 0.0))
        rejected = int(self._safe_float(latest_metrics.get("rejected"), 0.0))
        fill_rate = self._safe_float(latest_metrics.get("fill_rate"), 0.0)
        reject_rate = self._safe_float(latest_metrics.get("reject_rate"), 0.0)
        if submitted > 0:
            fill_rate = filled / submitted
            reject_rate = rejected / submitted

        slippage_mape_values = [
            self._safe_float(row.get("metrics", {}).get("slippage_mape_pct"), 0.0)
            for row in cycle_rows
        ]
        p95_values = [
            self._safe_float(row.get("metrics", {}).get("p95_realized_slippage_bps"), 0.0)
            for row in cycle_rows
        ]
        avg_mape = (
            sum(slippage_mape_values) / len(slippage_mape_values) if slippage_mape_values else 0.0
        )
        avg_p95 = sum(p95_values) / len(p95_values) if p95_values else 0.0

        ready = self._safe_bool(latest_metrics.get("ready_for_canary"))
        metadata = dict(completed_row.get("metadata", {})) if completed_row else {}
        decision = str(
            metadata.get("promotion_decision", latest_metrics.get("promotion_decision", "unknown"))
        )

        slippage_penalty = 1.0 / (1.0 + (avg_mape / 50.0))
        quality = max(0.0, 1.0 - reject_rate) * max(0.0, fill_rate) * slippage_penalty
        if ready:
            quality *= 1.05
        if decision == "promote_to_live_canary":
            quality *= 1.05
        quality = max(0.0, min(quality, 1.0))

        return {
            "run_id": str(run_id),
            "market": market,
            "strategy": strategy,
            "events": len(events),
            "cycles_observed": len(cycle_rows),
            "started_at": str(events[0].get("timestamp", "")),
            "completed_at": str(events[-1].get("timestamp", "")),
            "submitted": submitted,
            "filled": filled,
            "rejected": rejected,
            "fill_rate": float(fill_rate),
            "reject_rate": float(reject_rate),
            "avg_slippage_mape_pct": float(avg_mape),
            "avg_p95_slippage_bps": float(avg_p95),
            "ready_for_canary": bool(ready),
            "promotion_decision": decision,
            "quality_score": float(quality),
        }

    def summarize_all_runs(self) -> List[Dict[str, Any]]:
        """Return summaries for all run IDs seen in telemetry log."""
        rows = self.read_events()
        run_ids = sorted({str(row.get("run_id", "")) for row in rows if row.get("run_id")})
        return [self.summarize_run(run_id) for run_id in run_ids]

    @staticmethod
    def _group_leaderboard(summary_rows: Iterable[Dict[str, Any]]) -> pd.DataFrame:
        frame = pd.DataFrame(list(summary_rows))
        if frame.empty:
            return pd.DataFrame(
                columns=[
                    "market",
                    "strategy",
                    "runs",
                    "avg_quality_score",
                    "avg_fill_rate",
                    "avg_reject_rate",
                    "avg_slippage_mape_pct",
                    "canary_ready_rate",
                    "promote_rate",
                    "optimization_priority",
                ]
            )

        frame["promoted"] = frame["promotion_decision"].astype(str) == "promote_to_live_canary"
        grouped = (
            frame.groupby(["market", "strategy"], as_index=False)
            .agg(
                runs=("run_id", "count"),
                avg_quality_score=("quality_score", "mean"),
                avg_fill_rate=("fill_rate", "mean"),
                avg_reject_rate=("reject_rate", "mean"),
                avg_slippage_mape_pct=("avg_slippage_mape_pct", "mean"),
                canary_ready_rate=("ready_for_canary", "mean"),
                promote_rate=("promoted", "mean"),
            )
            .reset_index(drop=True)
        )

        grouped["optimization_priority"] = (
            (1.0 - grouped["avg_quality_score"])
            + grouped["avg_reject_rate"]
            + (grouped["avg_slippage_mape_pct"] / 100.0)
        )
        grouped = grouped.sort_values(
            by=["avg_quality_score", "canary_ready_rate", "runs"],
            ascending=[False, False, False],
        ).reset_index(drop=True)
        return grouped

    def optimization_leaderboard(self) -> pd.DataFrame:
        """Aggregate run summaries into optimization-ready strategy/market leaderboard."""
        return self._group_leaderboard(self.summarize_all_runs())
