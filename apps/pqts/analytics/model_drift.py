"""Model drift diagnostics for paper/live strategy monitoring."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping

import pandas as pd


@dataclass(frozen=True)
class DriftThresholds:
    max_sharpe_drop: float = 0.40
    max_drawdown_increase: float = 0.05
    max_slippage_mape_increase: float = 10.0
    min_recent_samples: int = 5


def summarize_stage_metrics(frame: pd.DataFrame) -> Dict[str, float]:
    if frame.empty:
        return {
            "samples": 0.0,
            "avg_sharpe": 0.0,
            "avg_drawdown": 0.0,
            "avg_slippage_mape": 0.0,
            "total_pnl": 0.0,
        }
    out = frame.copy()
    numeric = ["sharpe", "drawdown", "slippage_mape", "pnl"]
    for column in numeric:
        if column not in out.columns:
            out[column] = 0.0
        out[column] = pd.to_numeric(out[column], errors="coerce").fillna(0.0)
    return {
        "samples": float(len(out)),
        "avg_sharpe": float(out["sharpe"].mean()),
        "avg_drawdown": float(out["drawdown"].mean()),
        "avg_slippage_mape": float(out["slippage_mape"].mean()),
        "total_pnl": float(out["pnl"].sum()),
    }


def evaluate_model_drift(
    *,
    baseline: Mapping[str, Any],
    recent: Mapping[str, Any],
    thresholds: DriftThresholds = DriftThresholds(),
) -> Dict[str, Any]:
    baseline_samples = float(baseline.get("samples", 0.0) or 0.0)
    recent_samples = float(recent.get("samples", 0.0) or 0.0)

    sharpe_drop = float(baseline.get("avg_sharpe", 0.0) or 0.0) - float(
        recent.get("avg_sharpe", 0.0) or 0.0
    )
    drawdown_increase = float(recent.get("avg_drawdown", 0.0) or 0.0) - float(
        baseline.get("avg_drawdown", 0.0) or 0.0
    )
    slippage_increase = float(recent.get("avg_slippage_mape", 0.0) or 0.0) - float(
        baseline.get("avg_slippage_mape", 0.0) or 0.0
    )

    checks = {
        "enough_recent_samples": recent_samples >= float(thresholds.min_recent_samples),
        "sharpe_drop": sharpe_drop <= float(thresholds.max_sharpe_drop),
        "drawdown_increase": drawdown_increase <= float(thresholds.max_drawdown_increase),
        "slippage_increase": slippage_increase <= float(thresholds.max_slippage_mape_increase),
    }
    reasons = [
        key for key, passed in checks.items() if not bool(passed) and key != "enough_recent_samples"
    ]
    if not checks["enough_recent_samples"]:
        reasons.append("insufficient_recent_samples")
    drift_alert = (baseline_samples > 0.0) and (not all(checks.values()))

    return {
        "drift_alert": bool(drift_alert),
        "checks": checks,
        "reasons": reasons,
        "baseline": dict(baseline),
        "recent": dict(recent),
        "deltas": {
            "sharpe_drop": float(sharpe_drop),
            "drawdown_increase": float(drawdown_increase),
            "slippage_increase": float(slippage_increase),
        },
    }
