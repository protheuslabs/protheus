"""Tests for versioned data-lake pipeline helpers."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.data_lake_pipeline import (
    normalize_funding_row,
    normalize_l2_row,
    normalize_trade_row,
    write_dataset_rows,
)


def test_normalize_rows_include_schema_and_type():
    trade = normalize_trade_row("binance", "BTCUSDT", {"price": 100.0, "qty": 1.5, "side": "buy"})
    l2 = normalize_l2_row("binance", "BTCUSDT", {"bids": [[99.0, 2.0]], "asks": [[101.0, 2.0]]})
    funding = normalize_funding_row("binance", "BTCUSDT", {"funding_rate": 0.0001})

    assert trade["schema_version"] == "1.0.0"
    assert trade["type"] == "trade"
    assert l2["type"] == "l2"
    assert funding["type"] == "funding"


def test_write_dataset_rows_persists_manifest(tmp_path):
    manifest = write_dataset_rows(
        root=str(tmp_path),
        dataset="stream_trades",
        rows=[
            normalize_trade_row(
                "binance",
                "BTCUSDT",
                {
                    "timestamp": "2026-03-01T00:00:00+00:00",
                    "price": 100.0,
                    "qty": 1.0,
                    "side": "buy",
                },
            )
        ],
        partition_date="2026-03-01",
    )

    assert manifest.rows_written == 1
    assert manifest.files
    manifest_file = Path(tmp_path) / "stream_trades" / "manifest.jsonl"
    lines = [json.loads(line) for line in manifest_file.read_text(encoding="utf-8").splitlines()]
    assert lines
    assert lines[-1]["rows_written"] == 1
