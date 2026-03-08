"""Execution stream contracts for market/order/fill parity instrumentation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict


@dataclass(frozen=True)
class StreamDescriptor:
    """One streaming endpoint definition for a venue."""

    channel: str
    transport: str
    url: str
    heartbeat_seconds: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def build_stream_registry(
    *,
    market_url: str,
    order_url: str,
    fill_url: str,
    transport: str = "websocket",
    heartbeat_seconds: float = 15.0,
) -> Dict[str, Dict[str, Any]]:
    """Build a canonical stream registry payload for adapters."""
    return {
        "market": StreamDescriptor(
            channel="market",
            transport=str(transport),
            url=str(market_url),
            heartbeat_seconds=float(heartbeat_seconds),
        ).to_dict(),
        "order": StreamDescriptor(
            channel="order",
            transport=str(transport),
            url=str(order_url),
            heartbeat_seconds=float(heartbeat_seconds),
        ).to_dict(),
        "fill": StreamDescriptor(
            channel="fill",
            transport=str(transport),
            url=str(fill_url),
            heartbeat_seconds=float(heartbeat_seconds),
        ).to_dict(),
    }
