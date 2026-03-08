"""Monthly attribution and allocation-feedback helpers."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping

import numpy as np
import pandas as pd


def _to_frame(rows: Iterable[Mapping[str, Any]]) -> pd.DataFrame:
    frame = pd.DataFrame(list(rows))
    if frame.empty:
        return frame
    frame = frame.copy()
    if "strategy_id" not in frame.columns:
        frame["strategy_id"] = "unknown"
    if "timestamp" not in frame.columns:
        frame["timestamp"] = pd.Timestamp.utcnow().isoformat()
    for column in ("pnl", "sharpe", "drawdown", "slippage_mape"):
        if column not in frame.columns:
            frame[column] = 0.0
        frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0.0)
    frame["strategy_id"] = frame["strategy_id"].astype(str)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    frame = frame[frame["timestamp"].notna()]
    return frame


def summarize_monthly_attribution(rows: Iterable[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    frame = _to_frame(rows)
    if frame.empty:
        return []

    frame["month"] = frame["timestamp"].dt.strftime("%Y-%m")
    grouped = (
        frame.groupby(["strategy_id", "month"], dropna=False)
        .agg(
            samples=("timestamp", "count"),
            total_pnl=("pnl", "sum"),
            avg_sharpe=("sharpe", "mean"),
            avg_drawdown=("drawdown", "mean"),
            avg_slippage_mape=("slippage_mape", "mean"),
        )
        .reset_index()
    )
    grouped["score"] = (
        grouped["total_pnl"]
        + (250.0 * grouped["avg_sharpe"])
        - (200.0 * grouped["avg_drawdown"])
        - (10.0 * grouped["avg_slippage_mape"])
    )
    grouped = grouped.sort_values(["month", "score"], ascending=[False, False])
    return grouped.to_dict(orient="records")


def compute_feedback_multipliers(
    rows: Iterable[Mapping[str, Any]],
    *,
    min_multiplier: float = 0.50,
    max_multiplier: float = 1.50,
) -> Dict[str, float]:
    """Compute per-strategy allocation multipliers from attribution summaries."""
    frame = pd.DataFrame(list(rows))
    if frame.empty:
        return {}
    out = frame.copy()
    if "strategy_id" not in out.columns:
        return {}

    for column in ("total_pnl", "avg_sharpe", "avg_drawdown", "avg_slippage_mape"):
        if column not in out.columns:
            out[column] = 0.0
        out[column] = pd.to_numeric(out[column], errors="coerce").fillna(0.0)
    out["strategy_id"] = out["strategy_id"].astype(str)

    pnl_scale = max(float(out["total_pnl"].abs().median()), 1.0)
    out["pnl_term"] = np.tanh(out["total_pnl"] / pnl_scale)
    out["sharpe_term"] = np.clip((out["avg_sharpe"] - 0.5) / 1.5, -1.0, 1.0)
    out["drawdown_term"] = np.clip(out["avg_drawdown"], 0.0, 1.0)
    out["slippage_term"] = np.clip(out["avg_slippage_mape"] / 100.0, 0.0, 1.0)

    raw_score = (
        (0.60 * out["pnl_term"])
        + (0.35 * out["sharpe_term"])
        - (0.25 * out["drawdown_term"])
        - (0.20 * out["slippage_term"])
    )
    multiplier = 1.0 + (0.50 * raw_score)
    multiplier = np.clip(multiplier, float(min_multiplier), float(max_multiplier))

    return {
        strategy_id: float(value)
        for strategy_id, value in zip(out["strategy_id"].tolist(), multiplier.tolist())
    }
