"""Deterministic tests for live operational controls."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.live_ops_controls import (
    OrderIdempotencyGuard,
    RateLimitConfig,
    RateLimitTracker,
    WebSocketConnectionManager,
    reconcile_positions,
)


class _FakeClock:
    def __init__(self, now: float = 0.0):
        self.now = float(now)

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += float(seconds)


def test_rate_limit_tracker_blocks_and_recovers_after_window():
    clock = _FakeClock(100.0)
    tracker = RateLimitTracker(
        {("binance", "orders"): RateLimitConfig(limit=2, window_seconds=10.0)},
        clock=clock,
    )

    d1 = tracker.request("binance", "orders")
    d2 = tracker.request("binance", "orders")
    d3 = tracker.request("binance", "orders")

    assert d1.allowed is True
    assert d2.allowed is True
    assert d3.allowed is False
    assert d3.retry_after_seconds > 0.0

    clock.advance(10.1)
    d4 = tracker.request("binance", "orders")
    assert d4.allowed is True


def test_order_idempotency_guard_ttl_behavior():
    clock = _FakeClock(0.0)
    guard = OrderIdempotencyGuard(ttl_seconds=5.0, clock=clock)

    assert guard.register("oid-1", "payload-a") is True
    assert guard.register("oid-1", "payload-a") is False
    assert guard.seen("oid-1", "payload-a") is True

    clock.advance(5.1)
    assert guard.seen("oid-1", "payload-a") is False
    assert guard.register("oid-1", "payload-a") is True


def test_reconcile_positions_flags_drift():
    diffs = reconcile_positions(
        internal_positions={"BTC-USD": 1.0, "ETH-USD": -2.0},
        venue_positions={"BTC-USD": 1.000001, "ETH-USD": -1.5, "SOL-USD": 0.2},
        tolerance=1e-5,
    )
    by_symbol = {row.symbol: row for row in diffs}

    assert by_symbol["BTC-USD"].within_tolerance is True
    assert by_symbol["ETH-USD"].within_tolerance is False
    assert by_symbol["SOL-USD"].within_tolerance is False


def test_websocket_manager_exponential_backoff_and_reset():
    clock = _FakeClock(50.0)
    ws = WebSocketConnectionManager(
        base_backoff_seconds=2.0,
        max_backoff_seconds=10.0,
        clock=clock,
    )
    ws.register("binance", "wss://example")

    ws.mark_disconnected("binance")
    first = ws.get("binance")
    assert first.retry_count == 1
    assert first.next_retry_at == 52.0
    assert ws.can_reconnect("binance") is False

    clock.advance(2.0)
    assert ws.can_reconnect("binance") is True

    ws.mark_disconnected("binance")
    second = ws.get("binance")
    assert second.retry_count == 2
    assert second.next_retry_at == 56.0

    ws.mark_connected("binance")
    connected = ws.get("binance")
    assert connected.connected is True
    assert connected.retry_count == 0
    assert connected.next_retry_at == 0.0
