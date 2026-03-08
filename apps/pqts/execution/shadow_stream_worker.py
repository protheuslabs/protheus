"""Shadow stream workers for market/order/fill parity telemetry."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from execution.risk_aware_router import RiskAwareRouter


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _event_id(*parts: object) -> str:
    payload = "|".join(str(part) for part in parts)
    token = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"stream_{token}"


@dataclass(frozen=True)
class ShadowStreamEvent:
    event_id: str
    timestamp: str
    venue: str
    channel: str
    symbol: str
    payload: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ShadowStreamEventStore:
    """Append-only store for shadow parity stream events."""

    def __init__(
        self,
        *,
        events_path: str = "data/analytics/shadow_stream_events.jsonl",
        health_path: str = "data/analytics/stream_health.json",
    ):
        self.events_path = Path(events_path)
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        self.health_path = Path(health_path)
        self.health_path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, event: ShadowStreamEvent) -> None:
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.to_dict(), sort_keys=True) + "\n")

    def append_many(self, events: List[ShadowStreamEvent]) -> None:
        if not events:
            return
        with self.events_path.open("a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event.to_dict(), sort_keys=True) + "\n")

    def write_health(self, payload: Dict[str, Any]) -> None:
        self.health_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


class ShadowParityStreamWorker:
    """Collect parity events from router snapshots/audit logs/TCA fills."""

    def __init__(
        self,
        *,
        router: RiskAwareRouter,
        store: ShadowStreamEventStore | None = None,
    ):
        self.router = router
        self.store = store or ShadowStreamEventStore()
        self._last_audit_idx = 0
        self._last_tca_idx = 0
        self._venue_samples: Dict[str, Dict[str, float]] = {}

    def _track_venue_sample(self, venue: str, *, available: bool, connected: bool) -> None:
        state = self._venue_samples.setdefault(
            str(venue),
            {
                "samples": 0.0,
                "connected_samples": 0.0,
                "available": 1.0 if available else 0.0,
            },
        )
        state["samples"] += 1.0
        state["available"] = 1.0 if available else 0.0
        if connected:
            state["connected_samples"] += 1.0

    @staticmethod
    def _is_quote_map(payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        return any(isinstance(value, dict) and "price" in value for value in payload.values())

    async def collect_once(self) -> Dict[str, Any]:
        timestamp = _utc_now_iso()
        registry = self.router.get_stream_registry()
        snapshot = await self.router.fetch_market_snapshot()

        events: List[ShadowStreamEvent] = []
        market_events = 0
        order_events = 0
        fill_events = 0

        venue_market_counts: Dict[str, int] = {}
        for venue, payload in snapshot.items():
            if not self._is_quote_map(payload):
                continue
            for symbol, quote in payload.items():
                if not isinstance(quote, dict):
                    continue
                events.append(
                    ShadowStreamEvent(
                        event_id=_event_id(
                            timestamp, venue, "market", symbol, quote.get("price", 0)
                        ),
                        timestamp=timestamp,
                        venue=str(venue),
                        channel="market",
                        symbol=str(symbol),
                        payload=dict(quote),
                    )
                )
                market_events += 1
                venue_market_counts[venue] = venue_market_counts.get(venue, 0) + 1

        audit_slice = self.router.audit_log[self._last_audit_idx :]
        self._last_audit_idx = len(self.router.audit_log)
        for row in audit_slice:
            order = row.get("order", {}) if isinstance(row, dict) else {}
            symbol = str(order.get("symbol", "UNKNOWN"))
            venue = str((row.get("routing", {}) or {}).get("exchange", "unknown"))
            status = "accepted"
            if bool(row.get("rejected", False)):
                status = "rejected"
            elif bool(row.get("executed", False)):
                status = "executed"
            events.append(
                ShadowStreamEvent(
                    event_id=_event_id(timestamp, venue, "order", row.get("order_id", "")),
                    timestamp=timestamp,
                    venue=venue,
                    channel="order",
                    symbol=symbol,
                    payload={
                        "status": status,
                        "order": dict(order),
                        "order_id": row.get("order_id"),
                        "reject_reason": row.get("reject_reason"),
                    },
                )
            )
            order_events += 1

        tca_slice = self.router.tca_db.records[self._last_tca_idx :]
        self._last_tca_idx = len(self.router.tca_db.records)
        for record in tca_slice:
            events.append(
                ShadowStreamEvent(
                    event_id=_event_id(timestamp, record.exchange, "fill", record.trade_id),
                    timestamp=timestamp,
                    venue=str(record.exchange),
                    channel="fill",
                    symbol=str(record.symbol),
                    payload={
                        "trade_id": record.trade_id,
                        "side": record.side,
                        "quantity": float(record.quantity),
                        "price": float(record.price),
                        "predicted_slippage_bps": float(record.predicted_slippage_bps),
                        "realized_slippage_bps": float(record.realized_slippage_bps),
                    },
                )
            )
            fill_events += 1

        self.store.append_many(events)

        for venue, stream_info in registry.items():
            available = bool(stream_info.get("available", False))
            connected = bool(venue_market_counts.get(venue, 0) > 0)
            self._track_venue_sample(venue, available=available, connected=connected)

        reliability = self.router.get_stats().get("reliability", {})
        venue_rows = []
        for venue, stats in sorted(self._venue_samples.items()):
            samples = float(stats.get("samples", 0.0))
            connected_samples = float(stats.get("connected_samples", 0.0))
            uptime = connected_samples / samples if samples > 0 else 0.0
            venue_rows.append(
                {
                    "venue": venue,
                    "available": bool(stats.get("available", 0.0) >= 1.0),
                    "samples": int(samples),
                    "connected_samples": int(connected_samples),
                    "stream_uptime_ratio": float(uptime),
                    "latency_p95_ms": float(
                        (reliability.get(venue, {}) or {}).get("latency_p95_ms", 0.0)
                    ),
                    "rejection_rate": float(
                        (reliability.get(venue, {}) or {}).get("rejection_rate", 0.0)
                    ),
                    "failure_rate": float(
                        (reliability.get(venue, {}) or {}).get("failure_rate", 0.0)
                    ),
                }
            )
        global_uptime = (
            float(sum(row["stream_uptime_ratio"] for row in venue_rows) / len(venue_rows))
            if venue_rows
            else 0.0
        )

        health_payload = {
            "timestamp": timestamp,
            "summary": {
                "venues": len(venue_rows),
                "stream_uptime_ratio": float(global_uptime),
                "market_events_last_collect": int(market_events),
                "order_events_last_collect": int(order_events),
                "fill_events_last_collect": int(fill_events),
            },
            "venues": venue_rows,
        }
        self.store.write_health(health_payload)

        return {
            "timestamp": timestamp,
            "events_written": len(events),
            "market_events": market_events,
            "order_events": order_events,
            "fill_events": fill_events,
            "health_path": str(self.store.health_path),
            "events_path": str(self.store.events_path),
            "stream_uptime_ratio": float(global_uptime),
        }

    async def run_loop(self, *, cycles: int, sleep_seconds: float = 1.0) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        for _ in range(max(int(cycles), 0)):
            results.append(await self.collect_once())
            if float(sleep_seconds) > 0:
                await asyncio.sleep(float(sleep_seconds))
        return results
