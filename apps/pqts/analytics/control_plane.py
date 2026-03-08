"""B2B control-plane usage metering and revenue analytics for PQTS SaaS."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

import pandas as pd


@dataclass(frozen=True)
class UsageEvent:
    event_id: str
    timestamp: str
    tenant_id: str
    event_type: str
    units: float
    revenue_hint_usd: float
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class UsageEntitlement:
    """Tenant usage limits and allowed event-types."""

    plan: str
    max_events_per_day: int
    max_units_per_day: float
    allowed_event_types: Optional[List[str]] = None

    def allows_event_type(self, event_type: str) -> bool:
        if self.allowed_event_types is None:
            return True
        return str(event_type) in set(str(token) for token in self.allowed_event_types)


def resolve_usage_entitlement(plan: str) -> UsageEntitlement:
    token = str(plan or "").strip().lower()
    if token == "starter":
        return UsageEntitlement(
            plan="starter",
            max_events_per_day=1000,
            max_units_per_day=50000.0,
            allowed_event_types=["backtest_run", "risk_report", "paper_order"],
        )
    if token == "pro":
        return UsageEntitlement(
            plan="pro",
            max_events_per_day=20000,
            max_units_per_day=1_000_000.0,
            allowed_event_types=None,
        )
    return UsageEntitlement(
        plan="enterprise",
        max_events_per_day=200000,
        max_units_per_day=50_000_000.0,
        allowed_event_types=None,
    )


class ControlPlaneMeter:
    """Append-only tenant usage/event meter with deterministic revenue rollups."""

    def __init__(self, log_path: str = "data/analytics/control_plane_usage.jsonl"):
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _event_id(
        *, tenant_id: str, event_type: str, timestamp: str, units: float, revenue_hint_usd: float
    ) -> str:
        payload = f"{tenant_id}|{event_type}|{timestamp}|{units:.8f}|{revenue_hint_usd:.8f}"
        token = abs(hash(payload))
        return f"cp_{token:016x}"[:20]

    def emit(
        self,
        *,
        tenant_id: str,
        event_type: str,
        units: float,
        revenue_hint_usd: float = 0.0,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[str] = None,
        entitlement: Optional[UsageEntitlement] = None,
        billing_hook: Optional[Callable[[UsageEvent], float]] = None,
    ) -> UsageEvent:
        ts = timestamp or self._utc_now_iso()
        if entitlement is not None:
            self._enforce_entitlement(
                tenant_id=str(tenant_id),
                event_type=str(event_type),
                units=float(units),
                entitlement=entitlement,
                timestamp=str(ts),
            )

        event = UsageEvent(
            event_id=self._event_id(
                tenant_id=str(tenant_id),
                event_type=str(event_type),
                timestamp=str(ts),
                units=float(units),
                revenue_hint_usd=float(revenue_hint_usd),
            ),
            timestamp=str(ts),
            tenant_id=str(tenant_id),
            event_type=str(event_type),
            units=float(units),
            revenue_hint_usd=float(revenue_hint_usd),
            metadata=dict(metadata or {}),
        )
        if billing_hook is not None:
            billed_amount = float(max(billing_hook(event), 0.0))
            event.metadata["billed_amount_usd"] = billed_amount
            if event.revenue_hint_usd <= 0.0:
                event = UsageEvent(
                    event_id=event.event_id,
                    timestamp=event.timestamp,
                    tenant_id=event.tenant_id,
                    event_type=event.event_type,
                    units=event.units,
                    revenue_hint_usd=billed_amount,
                    metadata=dict(event.metadata),
                )
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.to_dict(), sort_keys=True) + "\n")
        return event

    def _events_on_day(self, *, tenant_id: str, day: str) -> Sequence[Dict[str, Any]]:
        rows = self.read_events(tenant_id=tenant_id)
        out = []
        for row in rows:
            ts = str(row.get("timestamp", ""))
            if not ts.startswith(f"{day}T"):
                continue
            out.append(row)
        return out

    def _enforce_entitlement(
        self,
        *,
        tenant_id: str,
        event_type: str,
        units: float,
        entitlement: UsageEntitlement,
        timestamp: str,
    ) -> None:
        if not entitlement.allows_event_type(event_type):
            raise RuntimeError(
                f"Entitlement blocked event_type '{event_type}' for plan '{entitlement.plan}'."
            )
        day = str(timestamp).split("T")[0]
        day_rows = self._events_on_day(tenant_id=tenant_id, day=day)
        events_today = len(day_rows)
        units_today = sum(float(row.get("units", 0.0)) for row in day_rows)
        if (events_today + 1) > int(entitlement.max_events_per_day):
            raise RuntimeError(
                f"Entitlement exceeded max_events_per_day for tenant '{tenant_id}' "
                f"({events_today + 1}>{int(entitlement.max_events_per_day)})."
            )
        if (units_today + float(units)) > float(entitlement.max_units_per_day):
            raise RuntimeError(
                f"Entitlement exceeded max_units_per_day for tenant '{tenant_id}' "
                f"({units_today + float(units):.4f}>{float(entitlement.max_units_per_day):.4f})."
            )

    def read_events(self, *, tenant_id: Optional[str] = None) -> List[Dict[str, Any]]:
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
                if tenant_id is not None and str(row.get("tenant_id")) != str(tenant_id):
                    continue
                rows.append(row)

        rows.sort(key=lambda row: str(row.get("timestamp", "")))
        return rows

    def usage_summary(self, *, window_days: int = 30) -> Dict[str, Any]:
        rows = self.read_events()
        if not rows:
            return {
                "tenants": [],
                "summary": {
                    "tenant_count": 0,
                    "events": 0,
                    "window_days": int(window_days),
                    "mrr_estimate_usd": 0.0,
                    "arr_estimate_usd": 0.0,
                },
            }

        frame = pd.DataFrame(rows)
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame = frame.dropna(subset=["timestamp"])
        cutoff = datetime.now(timezone.utc) - timedelta(days=max(int(window_days), 1))
        scoped = frame[frame["timestamp"] >= cutoff]
        if scoped.empty:
            return {
                "tenants": [],
                "summary": {
                    "tenant_count": 0,
                    "events": 0,
                    "window_days": int(window_days),
                    "mrr_estimate_usd": 0.0,
                    "arr_estimate_usd": 0.0,
                },
            }

        grouped = (
            scoped.groupby("tenant_id", as_index=False)
            .agg(
                events=("event_id", "count"),
                total_units=("units", "sum"),
                revenue_hint_usd=("revenue_hint_usd", "sum"),
            )
            .sort_values("revenue_hint_usd", ascending=False)
            .reset_index(drop=True)
        )

        tenants = []
        for _, row in grouped.iterrows():
            tenants.append(
                {
                    "tenant_id": str(row["tenant_id"]),
                    "events": int(row["events"]),
                    "total_units": float(row["total_units"]),
                    "revenue_hint_usd": float(row["revenue_hint_usd"]),
                }
            )

        mrr = float(grouped["revenue_hint_usd"].sum())
        return {
            "tenants": tenants,
            "summary": {
                "tenant_count": int(len(tenants)),
                "events": int(len(scoped)),
                "window_days": int(window_days),
                "mrr_estimate_usd": mrr,
                "arr_estimate_usd": mrr * 12.0,
            },
        }

    @staticmethod
    def _hash_row(payload: Dict[str, Any], prev_hash: str) -> str:
        serial = json.dumps({"prev_hash": prev_hash, "payload": payload}, sort_keys=True)
        return f"sha256:{hashlib.sha256(serial.encode('utf-8')).hexdigest()}"

    def audit_usage_report(self, *, window_days: int = 30) -> Dict[str, Any]:
        rows = self.read_events()
        if not rows:
            return {
                "generated_at": self._utc_now_iso(),
                "window_days": int(window_days),
                "rows": [],
                "summary": {"events": 0, "tenants": 0, "chain_head": ""},
            }

        frame = pd.DataFrame(rows)
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame = frame.dropna(subset=["timestamp"])
        cutoff = datetime.now(timezone.utc) - timedelta(days=max(int(window_days), 1))
        scoped = frame[frame["timestamp"] >= cutoff].copy()
        if scoped.empty:
            return {
                "generated_at": self._utc_now_iso(),
                "window_days": int(window_days),
                "rows": [],
                "summary": {"events": 0, "tenants": 0, "chain_head": ""},
            }

        scoped["day"] = scoped["timestamp"].dt.strftime("%Y-%m-%d")
        grouped = (
            scoped.groupby(["day", "tenant_id", "event_type"], as_index=False)
            .agg(
                events=("event_id", "count"),
                units=("units", "sum"),
                revenue_hint_usd=("revenue_hint_usd", "sum"),
            )
            .sort_values(["day", "tenant_id", "event_type"])
            .reset_index(drop=True)
        )

        out_rows: List[Dict[str, Any]] = []
        prev_hash = ""
        for _, row in grouped.iterrows():
            payload = {
                "day": str(row["day"]),
                "tenant_id": str(row["tenant_id"]),
                "event_type": str(row["event_type"]),
                "events": int(row["events"]),
                "units": float(row["units"]),
                "revenue_hint_usd": float(row["revenue_hint_usd"]),
            }
            row_hash = self._hash_row(payload, prev_hash)
            out_rows.append({**payload, "prev_hash": prev_hash, "row_hash": row_hash})
            prev_hash = row_hash

        return {
            "generated_at": self._utc_now_iso(),
            "window_days": int(window_days),
            "rows": out_rows,
            "summary": {
                "events": int(len(scoped)),
                "tenants": int(scoped["tenant_id"].nunique()),
                "chain_head": prev_hash,
            },
        }


def pricing_tier_recommendation(
    *,
    total_units: float,
    monthly_events: int,
) -> Dict[str, Any]:
    """Deterministic tier recommendation for B2B packaging decisions."""
    units = float(total_units)
    events = int(monthly_events)

    if units >= 100000.0 or events >= 20000:
        tier = "enterprise"
        base_price = 2499.0
    elif units >= 20000.0 or events >= 5000:
        tier = "pro"
        base_price = 999.0
    else:
        tier = "starter"
        base_price = 599.0

    return {
        "tier": tier,
        "base_price_usd": float(base_price),
        "inputs": {
            "total_units": units,
            "monthly_events": events,
        },
    }
