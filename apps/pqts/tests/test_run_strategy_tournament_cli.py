"""Tests for strategy tournament CLI helpers."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_strategy_tournament.py"
SPEC = importlib.util.spec_from_file_location("run_strategy_tournament", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parse_sources_extracts_venue_symbol_pairs():
    rows = MODULE._parse_sources("binance:BTCUSDT, coinbase:BTC-USD, bad")
    assert len(rows) == 2
    assert rows[0].venue == "binance"
    assert rows[0].symbol == "BTCUSDT"


def test_parse_datetime_normalizes_utc():
    dt = MODULE._parse_datetime("2026-01-01T00:00:00Z")
    assert dt.isoformat().endswith("+00:00")
