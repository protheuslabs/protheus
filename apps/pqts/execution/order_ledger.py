"""Immutable order lifecycle ledger with idempotent append + replay support."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


class OrderState:
    SUBMITTED = "submitted"
    ACKNOWLEDGED = "acknowledged"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELED = "canceled"
    REJECTED = "rejected"


_ALLOWED_TRANSITIONS = {
    None: {OrderState.SUBMITTED},
    OrderState.SUBMITTED: {OrderState.ACKNOWLEDGED, OrderState.REJECTED, OrderState.CANCELED},
    OrderState.ACKNOWLEDGED: {
        OrderState.PARTIALLY_FILLED,
        OrderState.FILLED,
        OrderState.CANCELED,
        OrderState.REJECTED,
    },
    OrderState.PARTIALLY_FILLED: {
        OrderState.PARTIALLY_FILLED,
        OrderState.FILLED,
        OrderState.CANCELED,
    },
    OrderState.FILLED: set(),
    OrderState.CANCELED: set(),
    OrderState.REJECTED: set(),
}


@dataclass(frozen=True)
class OrderLedgerEvent:
    event_id: str
    timestamp: str
    order_id: str
    state: str
    symbol: str
    side: str
    venue: str
    quantity: float
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ImmutableOrderLedger:
    """Append-only immutable ledger for order state transitions."""

    def __init__(self, path: str = "data/analytics/order_ledger.jsonl"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

        self._seen_event_ids: set[str] = set()
        self._state_by_order_id: Dict[str, str] = {}
        self._load_existing()

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _event_id(
        *,
        order_id: str,
        state: str,
        symbol: str,
        side: str,
        venue: str,
        quantity: float,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        payload = {
            "order_id": str(order_id),
            "state": str(state),
            "symbol": str(symbol),
            "side": str(side),
            "venue": str(venue),
            "quantity": float(quantity),
            "metadata": dict(metadata or {}),
        }
        blob = json.dumps(payload, sort_keys=True)
        token = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:20]
        return f"evt_{token}"

    def _load_existing(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as handle:
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

                event_id = str(row.get("event_id", "")).strip()
                order_id = str(row.get("order_id", "")).strip()
                state = str(row.get("state", "")).strip().lower()
                if not event_id or not order_id or not state:
                    continue
                self._seen_event_ids.add(event_id)
                self._state_by_order_id[order_id] = state

    def _append(self, event: OrderLedgerEvent) -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.to_dict(), sort_keys=True) + "\n")

    def _validate_transition(self, order_id: str, next_state: str) -> None:
        current_state = self._state_by_order_id.get(str(order_id))
        allowed = _ALLOWED_TRANSITIONS.get(current_state, set())
        if str(next_state) not in allowed:
            raise RuntimeError(
                "Invalid order state transition "
                f"for {order_id}: {current_state!r} -> {next_state!r}"
            )

    def record(
        self,
        *,
        order_id: str,
        state: str,
        symbol: str,
        side: str,
        venue: str,
        quantity: float,
        metadata: Optional[Dict[str, Any]] = None,
        event_id: Optional[str] = None,
    ) -> bool:
        state_token = str(state).strip().lower()
        if state_token not in {
            OrderState.SUBMITTED,
            OrderState.ACKNOWLEDGED,
            OrderState.PARTIALLY_FILLED,
            OrderState.FILLED,
            OrderState.CANCELED,
            OrderState.REJECTED,
        }:
            raise ValueError(f"Unsupported order state: {state}")

        resolved_event_id = event_id or self._event_id(
            order_id=order_id,
            state=state_token,
            symbol=symbol,
            side=side,
            venue=venue,
            quantity=float(quantity),
            metadata=metadata,
        )

        if resolved_event_id in self._seen_event_ids:
            return False

        self._validate_transition(order_id=str(order_id), next_state=state_token)

        event = OrderLedgerEvent(
            event_id=resolved_event_id,
            timestamp=self._utc_now_iso(),
            order_id=str(order_id),
            state=state_token,
            symbol=str(symbol),
            side=str(side).lower(),
            venue=str(venue),
            quantity=float(quantity),
            metadata=dict(metadata or {}),
        )
        self._append(event)
        self._seen_event_ids.add(resolved_event_id)
        self._state_by_order_id[str(order_id)] = state_token
        return True

    def current_state(self, order_id: str) -> Optional[str]:
        return self._state_by_order_id.get(str(order_id))

    def replay(self, order_id: Optional[str] = None) -> List[Dict[str, Any]]:
        if not self.path.exists():
            return []

        out: List[Dict[str, Any]] = []
        with self.path.open("r", encoding="utf-8") as handle:
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
                if order_id is not None and str(row.get("order_id")) != str(order_id):
                    continue
                out.append(row)

        out.sort(key=lambda row: str(row.get("timestamp", "")))
        return out
