"""Tests for event-replay simulator."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.event_replay import EventReplaySimulator, ReplayEvent
from execution.paper_fill_model import MicrostructurePaperFillProvider, PaperFillModelConfig


def _event(order_id: str, queue_ahead_qty: float) -> ReplayEvent:
    return ReplayEvent(
        order_id=order_id,
        symbol="BTC-USD",
        venue="binance",
        side="buy",
        requested_qty=0.5,
        reference_price=50000.0,
        queue_ahead_qty=queue_ahead_qty,
        order_book={
            "bids": [(49990.0, 2.0), (49980.0, 3.0)],
            "asks": [(50010.0, 1.5), (50020.0, 4.0)],
        },
    )


def test_event_replay_deterministic_summary():
    simulator = EventReplaySimulator(
        fill_provider=MicrostructurePaperFillProvider(
            config=PaperFillModelConfig(reality_stress_mode=True)
        )
    )
    events = [_event("ord-1", 0.0), _event("ord-2", 4.0)]
    first = asyncio.run(simulator.replay(events))
    second = asyncio.run(simulator.replay(events))

    assert first["events"] == 2
    assert first["fills"] == 2
    assert first["avg_fill_ratio"] == second["avg_fill_ratio"]
    assert first["avg_slippage_bps"] == second["avg_slippage_bps"]


def test_event_replay_queue_ahead_reduces_fill_ratio():
    simulator = EventReplaySimulator(
        fill_provider=MicrostructurePaperFillProvider(
            config=PaperFillModelConfig(reality_stress_mode=False)
        )
    )
    low_queue = asyncio.run(simulator.replay([_event("ord-low", 0.0)]))
    high_queue = asyncio.run(simulator.replay([_event("ord-high", 12.0)]))

    assert high_queue["rows"][0]["fill_ratio"] < low_queue["rows"][0]["fill_ratio"]
