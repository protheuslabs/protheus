"""
TCA Database with format flexibility

Supports: Parquet (preferred) or CSV (fallback)
"""

import logging
from pathlib import Path

import pandas as pd

try:
    import pyarrow  # noqa: F401

    HAS_PYARROW = True
except ImportError:
    HAS_PYARROW = False
    logging.warning("pyarrow not available, using CSV fallback for TCA database")


def load_tca_data(path: Path) -> pd.DataFrame:
    """Load TCA data from file (parquet or csv)."""
    if not path.exists():
        return pd.DataFrame()

    if path.suffix == ".parquet" and HAS_PYARROW:
        return pd.read_parquet(path)
    elif path.suffix == ".csv":
        return pd.read_csv(path, parse_dates=["timestamp"])
    else:
        logging.warning(f"Unknown TCA format: {path}")
        return pd.DataFrame()


def save_tca_data(df: pd.DataFrame, path: Path):
    """Save TCA data to file (parquet or csv)."""
    path.parent.mkdir(parents=True, exist_ok=True)

    if HAS_PYARROW:
        path = path.with_suffix(".parquet")
        df.to_parquet(path)
    else:
        path = path.with_suffix(".csv")
        df.to_csv(path, index=False)

    return path
