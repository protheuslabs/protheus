"""Event-replay simulation utilities for queue-aware execution stress tests."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from execution.paper_fill_model import MicrostructurePaperFillProvider, PaperFillModelConfig


@dataclass(frozen=True)
class ReplayEvent:
    order_id: str
    symbol: str
    venue: str
    side: str
    requested_qty: float
    reference_price: float
    order_book: Dict[str, Any]
    queue_ahead_qty: float = 0.0
    timestamp: Optional[str] = None


@dataclass(frozen=True)
class ReplayFill:
    order_id: str
    symbol: str
    venue: str
    side: str
    requested_qty: float
    executed_qty: float
    reference_price: float
    executed_price: float
    slippage_bps: float
    fill_ratio: float
    timestamp: str


class EventReplaySimulator:
    """Run deterministic replay events through paper fill model."""

    def __init__(self, fill_provider: Optional[MicrostructurePaperFillProvider] = None):
        self.fill_provider = fill_provider or MicrostructurePaperFillProvider(
            config=PaperFillModelConfig(reality_stress_mode=True)
        )

    async def replay(self, events: List[ReplayEvent]) -> Dict[str, Any]:
        fills: List[ReplayFill] = []
        for event in events:
            fill = await self.fill_provider.get_fill(
                order_id=str(event.order_id),
                symbol=str(event.symbol),
                venue=str(event.venue),
                side=str(event.side),
                requested_qty=float(event.requested_qty),
                reference_price=float(event.reference_price),
                order_book=dict(event.order_book or {}),
                queue_ahead_qty=float(event.queue_ahead_qty),
            )
            if str(event.side).lower() == "buy":
                slip_pct = max(
                    (float(fill.executed_price) - float(event.reference_price))
                    / max(float(event.reference_price), 1e-12),
                    0.0,
                )
            else:
                slip_pct = max(
                    (float(event.reference_price) - float(fill.executed_price))
                    / max(float(event.reference_price), 1e-12),
                    0.0,
                )
            slippage_bps = float(slip_pct * 10000.0)
            fill_ratio = float(fill.executed_qty) / max(float(event.requested_qty), 1e-12)
            fills.append(
                ReplayFill(
                    order_id=str(event.order_id),
                    symbol=str(event.symbol),
                    venue=str(event.venue),
                    side=str(event.side),
                    requested_qty=float(event.requested_qty),
                    executed_qty=float(fill.executed_qty),
                    reference_price=float(event.reference_price),
                    executed_price=float(fill.executed_price),
                    slippage_bps=slippage_bps,
                    fill_ratio=fill_ratio,
                    timestamp=(
                        str(event.timestamp)
                        if event.timestamp
                        else datetime.now(timezone.utc).isoformat()
                    ),
                )
            )

        avg_fill_ratio = sum(row.fill_ratio for row in fills) / max(len(fills), 1) if fills else 0.0
        avg_slippage_bps = (
            sum(row.slippage_bps for row in fills) / max(len(fills), 1) if fills else 0.0
        )
        return {
            "events": len(events),
            "fills": len(fills),
            "avg_fill_ratio": float(avg_fill_ratio),
            "avg_slippage_bps": float(avg_slippage_bps),
            "rows": [asdict(row) for row in fills],
        }


def replay_sync(
    events: List[ReplayEvent],
    *,
    fill_provider: Optional[MicrostructurePaperFillProvider] = None,
) -> Dict[str, Any]:
    simulator = EventReplaySimulator(fill_provider=fill_provider)
    return asyncio.run(simulator.replay(events))
