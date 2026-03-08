"""Deterministic tests for historical data downloader and quality checks."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.historical_data import HistoricalDataDownloader, load_research_frames


def _dt(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=timezone.utc)


def test_binance_download_paginates_and_normalizes():
    start = _dt(2025, 1, 1, 0)
    end = _dt(2025, 1, 1, 3)

    page_1 = [
        [1735689600000, "100", "101", "99", "100.5", "10"],
        [1735693200000, "100.5", "102", "100", "101.0", "11"],
    ]
    page_2 = [
        [1735696800000, "101", "103", "100", "102.0", "12"],
        [1735700400000, "102", "104", "101", "103.0", "13"],
    ]

    def fake_request(_url: str, params: dict):
        start_time = int(params["startTime"])
        if start_time == 1735689600000:
            return page_1
        if start_time == 1735696800000:
            return page_2
        return []

    downloader = HistoricalDataDownloader(request_json=fake_request)
    frame = downloader.download_binance_ohlcv(
        symbol="BTCUSDT",
        interval="1h",
        start=start,
        end=end,
        limit=2,
    )

    assert len(frame) == 4
    assert frame.index.is_monotonic_increasing
    assert frame.iloc[0]["open"] == 100.0
    assert frame.iloc[-1]["close"] == 103.0


def test_coinbase_download_chunking_and_dedup_sorting():
    start = _dt(2025, 1, 1, 0)
    end = _dt(2025, 1, 1, 6)

    def fake_request(_url: str, params: dict):
        # Coinbase candles: [time, low, high, open, close, volume]
        if params["start"].startswith("2025-01-01T00:00:00"):
            return [
                [1735689660, 100, 102, 101, 101.5, 9],   # 00:01
                [1735689600, 99, 101, 100, 100.5, 8],    # 00:00
            ]
        return [
            [1735689720, 101, 103, 102, 102.5, 10],      # 00:02
            [1735689660, 100, 102, 101, 101.5, 9],       # duplicate 00:01
        ]

    downloader = HistoricalDataDownloader(request_json=fake_request)
    frame = downloader.download_coinbase_ohlcv(
        product_id="BTC-USD",
        interval="1m",
        start=start,
        end=end,
    )

    assert len(frame) == 3
    assert frame.index.is_monotonic_increasing
    assert float(frame.iloc[0]["close"]) == 100.5
    assert float(frame.iloc[-1]["close"]) == 102.5


def test_quality_summary_and_save_manifest(tmp_path):
    idx = pd.to_datetime(
        [
            "2026-01-01T00:00:00Z",
            "2026-01-01T01:00:00Z",
            "2026-01-01T03:00:00Z",
        ],
        utc=True,
    )
    frame = pd.DataFrame(
        {
            "open": [100.0, 101.0, 103.0],
            "high": [101.0, 102.0, 104.0],
            "low": [99.0, 100.0, 102.0],
            "close": [100.5, 101.5, 103.5],
            "volume": [10.0, 11.0, 12.0],
        },
        index=idx,
    )

    downloader = HistoricalDataDownloader(output_dir=str(tmp_path))
    quality = downloader.quality_summary(frame, interval="1h")

    assert quality.rows == 3
    assert quality.missing_intervals == 1
    assert quality.completeness == 0.75

    path = downloader.save_dataset(
        frame,
        venue="binance",
        symbol="BTCUSDT",
        interval="1h",
        start=_dt(2026, 1, 1, 0),
        end=_dt(2026, 1, 2, 0),
        fmt="csv",
    )

    assert path.exists()
    manifest = path.with_suffix(".manifest.json")
    assert manifest.exists()


def test_load_research_frames_reads_csv_format(tmp_path):
    idx = pd.to_datetime(["2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"], utc=True)
    frame = pd.DataFrame(
        {
            "open": [100.0, 101.0],
            "high": [101.0, 102.0],
            "low": [99.0, 100.0],
            "close": [100.5, 101.5],
            "volume": [10.0, 11.0],
        },
        index=idx,
    )
    csv_path = tmp_path / "BTCUSDT.csv"
    frame.to_csv(csv_path, index_label="timestamp")

    loaded = load_research_frames({"BTCUSDT": csv_path})
    assert "BTCUSDT" in loaded
    assert len(loaded["BTCUSDT"]) == 2
    assert loaded["BTCUSDT"].index.is_monotonic_increasing
