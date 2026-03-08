"""Tests for partitioned data lake writes, replay ordering, and quality gates."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.data_lake import DataLakeQualityGate, MarketDataLake


def _frame() -> pd.DataFrame:
    idx = pd.to_datetime(
        [
            "2026-01-01T00:00:00Z",
            "2026-01-01T01:00:00Z",
            "2026-01-01T02:00:00Z",
            "2026-01-02T00:00:00Z",
        ],
        utc=True,
    )
    return pd.DataFrame(
        {
            "open": [100.0, 101.0, 102.0, 103.0],
            "high": [101.0, 102.0, 103.0, 104.0],
            "low": [99.0, 100.0, 101.0, 102.0],
            "close": [100.5, 101.5, 102.5, 103.5],
            "volume": [10.0, 11.0, 12.0, 13.0],
        },
        index=idx,
    )


def test_data_lake_write_load_and_replay_are_deterministic(tmp_path):
    lake = MarketDataLake(root_dir=str(tmp_path / "lake"))
    written = lake.write_ohlcv(_frame(), venue="binance", symbol="BTCUSDT")

    assert len(written) == 2

    loaded = lake.load_ohlcv_range(
        venue="binance",
        symbol="BTCUSDT",
        start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        end=datetime(2026, 1, 2, 23, 59, tzinfo=timezone.utc),
    )
    assert len(loaded) == 4
    assert loaded.index.is_monotonic_increasing

    replay = list(
        lake.replay_ohlcv(
            venue="binance",
            symbol="BTCUSDT",
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 2, 23, 59, tzinfo=timezone.utc),
        )
    )
    assert [row["sequence"] for row in replay] == [0, 1, 2, 3]
    assert replay[0]["close"] == 100.5
    assert replay[-1]["close"] == 103.5


def test_data_lake_quality_gate_blocks_on_missing_intervals():
    idx = pd.to_datetime(
        [
            "2026-01-01T00:00:00Z",
            "2026-01-01T02:00:00Z",
        ],
        utc=True,
    )
    frame = pd.DataFrame(
        {
            "open": [1.0, 2.0],
            "high": [1.0, 2.0],
            "low": [1.0, 2.0],
            "close": [1.0, 2.0],
            "volume": [1.0, 1.0],
        },
        index=idx,
    )

    summary = MarketDataLake.quality_summary(frame, interval_seconds=3600)
    assert summary.missing_intervals == 1

    try:
        MarketDataLake.enforce_quality_gate(
            summary=summary,
            gate=DataLakeQualityGate(min_completeness=0.99, max_missing_intervals=0),
        )
        raised = False
    except RuntimeError:
        raised = True

    assert raised is True
