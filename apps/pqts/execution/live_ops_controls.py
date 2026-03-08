"""Live-trading operational controls for rate limits, idempotency, and reconciliation."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Callable, Deque, Dict, Optional, Tuple


@dataclass(frozen=True)
class RateLimitConfig:
    """Maximum requests permitted in a rolling window."""

    limit: int
    window_seconds: float


@dataclass(frozen=True)
class RateLimitDecision:
    """Result of a single request admission check."""

    allowed: bool
    remaining: int
    retry_after_seconds: float


class RateLimitTracker:
    """Deterministic rolling-window request limiter by venue and endpoint."""

    def __init__(
        self,
        configs: Dict[Tuple[str, str], RateLimitConfig],
        clock: Optional[Callable[[], float]] = None,
    ):
        self._configs = dict(configs)
        self._clock = clock or time.monotonic
        self._events: Dict[Tuple[str, str], Deque[float]] = defaultdict(deque)

    def _resolve_config(self, venue: str, endpoint: str) -> Optional[RateLimitConfig]:
        return self._configs.get((venue, endpoint)) or self._configs.get((venue, "*"))

    def _prune(self, key: Tuple[str, str], window_seconds: float, now: float) -> Deque[float]:
        q = self._events[key]
        while q and (now - q[0]) >= window_seconds:
            q.popleft()
        return q

    def request(self, venue: str, endpoint: str) -> RateLimitDecision:
        cfg = self._resolve_config(venue, endpoint)
        if cfg is None:
            return RateLimitDecision(allowed=True, remaining=10**9, retry_after_seconds=0.0)

        key = (venue, endpoint if (venue, endpoint) in self._configs else "*")
        now = float(self._clock())
        events = self._prune(key, float(cfg.window_seconds), now)

        if len(events) >= int(cfg.limit):
            retry_after = float(cfg.window_seconds) - (now - events[0])
            return RateLimitDecision(
                allowed=False,
                remaining=0,
                retry_after_seconds=max(float(retry_after), 0.0),
            )

        events.append(now)
        remaining = max(int(cfg.limit) - len(events), 0)
        return RateLimitDecision(allowed=True, remaining=remaining, retry_after_seconds=0.0)


class OrderIdempotencyGuard:
    """TTL cache that blocks duplicate order intent submissions."""

    def __init__(self, ttl_seconds: float = 300.0, clock: Optional[Callable[[], float]] = None):
        self.ttl_seconds = float(ttl_seconds)
        self._clock = clock or time.monotonic
        self._seen_at: Dict[Tuple[str, str], float] = {}

    def _prune(self, now: float) -> None:
        cutoff = now - self.ttl_seconds
        stale = [key for key, seen_at in self._seen_at.items() if seen_at < cutoff]
        for key in stale:
            self._seen_at.pop(key, None)

    def register(self, client_order_id: str, fingerprint: str) -> bool:
        now = float(self._clock())
        self._prune(now)
        key = (str(client_order_id), str(fingerprint))
        if key in self._seen_at:
            return False
        self._seen_at[key] = now
        return True

    def seen(self, client_order_id: str, fingerprint: str) -> bool:
        now = float(self._clock())
        self._prune(now)
        return (str(client_order_id), str(fingerprint)) in self._seen_at


@dataclass(frozen=True)
class PositionDiff:
    symbol: str
    internal_qty: float
    venue_qty: float
    delta_qty: float
    within_tolerance: bool


def reconcile_positions(
    internal_positions: Dict[str, float],
    venue_positions: Dict[str, float],
    tolerance: float = 1e-8,
) -> list[PositionDiff]:
    """Compare internal vs venue positions and flag drift beyond tolerance."""
    symbols = sorted(set(internal_positions) | set(venue_positions))
    out: list[PositionDiff] = []
    for symbol in symbols:
        internal_qty = float(internal_positions.get(symbol, 0.0))
        venue_qty = float(venue_positions.get(symbol, 0.0))
        delta = venue_qty - internal_qty
        out.append(
            PositionDiff(
                symbol=symbol,
                internal_qty=internal_qty,
                venue_qty=venue_qty,
                delta_qty=delta,
                within_tolerance=abs(delta) <= float(tolerance),
            )
        )
    return out


@dataclass(frozen=True)
class SocketStatus:
    venue: str
    url: str
    connected: bool
    retry_count: int
    next_retry_at: float


class WebSocketConnectionManager:
    """Track socket health and deterministic exponential reconnect backoff."""

    def __init__(
        self,
        base_backoff_seconds: float = 1.0,
        max_backoff_seconds: float = 60.0,
        clock: Optional[Callable[[], float]] = None,
    ):
        self.base_backoff_seconds = float(base_backoff_seconds)
        self.max_backoff_seconds = float(max_backoff_seconds)
        self._clock = clock or time.monotonic
        self._sockets: Dict[str, SocketStatus] = {}

    def register(self, venue: str, url: str) -> None:
        self._sockets[str(venue)] = SocketStatus(
            venue=str(venue),
            url=str(url),
            connected=False,
            retry_count=0,
            next_retry_at=0.0,
        )

    def mark_connected(self, venue: str) -> None:
        current = self._sockets[str(venue)]
        self._sockets[str(venue)] = SocketStatus(
            venue=current.venue,
            url=current.url,
            connected=True,
            retry_count=0,
            next_retry_at=0.0,
        )

    def mark_disconnected(self, venue: str) -> None:
        current = self._sockets[str(venue)]
        retry_count = current.retry_count + 1
        backoff = min(
            self.max_backoff_seconds,
            self.base_backoff_seconds * (2 ** (retry_count - 1)),
        )
        now = float(self._clock())
        self._sockets[str(venue)] = SocketStatus(
            venue=current.venue,
            url=current.url,
            connected=False,
            retry_count=retry_count,
            next_retry_at=now + float(backoff),
        )

    def can_reconnect(self, venue: str) -> bool:
        status = self._sockets[str(venue)]
        if status.connected:
            return False
        return float(self._clock()) >= status.next_retry_at

    def get(self, venue: str) -> SocketStatus:
        return self._sockets[str(venue)]
