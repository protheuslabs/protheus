"""Dataframe backend selection (pandas default, optional duckdb/polars)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pandas as pd


@dataclass(frozen=True)
class BackendResult:
    backend: str
    dataframe: pd.DataFrame


def choose_backend(prefer: str = "auto") -> str:
    token = str(prefer).strip().lower()
    if token in {"pandas", "duckdb", "polars"}:
        return token
    # auto: prefer duckdb, then polars, else pandas
    try:
        import duckdb  # type: ignore  # noqa: F401

        return "duckdb"
    except Exception:
        pass
    try:
        import polars  # type: ignore  # noqa: F401

        return "polars"
    except Exception:
        pass
    return "pandas"


def load_csv(path: str, *, backend: str = "auto") -> BackendResult:
    chosen = choose_backend(backend)
    if chosen == "duckdb":
        try:
            import duckdb  # type: ignore

            frame = duckdb.sql(f"SELECT * FROM read_csv_auto('{path}')").df()
            return BackendResult(backend="duckdb", dataframe=frame)
        except Exception:
            pass
    if chosen == "polars":
        try:
            import polars as pl  # type: ignore

            frame = pl.read_csv(path).to_pandas()
            return BackendResult(backend="polars", dataframe=frame)
        except Exception:
            pass

    return BackendResult(backend="pandas", dataframe=pd.read_csv(path))
