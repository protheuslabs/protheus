"""Tests for dataframe backend selection helpers."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.frame_backend import choose_backend, load_csv


def test_choose_backend_honors_explicit_choice():
    assert choose_backend("pandas") == "pandas"
    assert choose_backend("duckdb") == "duckdb"
    assert choose_backend("polars") == "polars"


def test_load_csv_returns_frame_with_requested_columns(tmp_path):
    path = tmp_path / "sample.csv"
    path.write_text("a,b\n1,2\n3,4\n", encoding="utf-8")

    result = load_csv(str(path), backend="pandas")
    assert result.backend == "pandas"
    assert list(result.dataframe.columns) == ["a", "b"]
    assert int(result.dataframe["a"].sum()) == 4
