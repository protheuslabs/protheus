"""Tests for model drift diagnostics."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.model_drift import DriftThresholds, evaluate_model_drift, summarize_stage_metrics


def test_evaluate_model_drift_flags_regression():
    baseline = {
        "samples": 20,
        "avg_sharpe": 1.2,
        "avg_drawdown": 0.08,
        "avg_slippage_mape": 12.0,
    }
    recent = {
        "samples": 10,
        "avg_sharpe": 0.5,
        "avg_drawdown": 0.20,
        "avg_slippage_mape": 35.0,
    }
    payload = evaluate_model_drift(
        baseline=baseline,
        recent=recent,
        thresholds=DriftThresholds(
            max_sharpe_drop=0.30,
            max_drawdown_increase=0.05,
            max_slippage_mape_increase=10.0,
            min_recent_samples=5,
        ),
    )

    assert payload["drift_alert"] is True
    assert payload["checks"]["sharpe_drop"] is False
    assert payload["checks"]["drawdown_increase"] is False
    assert payload["checks"]["slippage_increase"] is False


def test_summarize_stage_metrics_handles_empty_frame():
    frame = pd.DataFrame(columns=["timestamp", "pnl", "sharpe", "drawdown", "slippage_mape"])
    summary = summarize_stage_metrics(frame)
    assert summary["samples"] == 0.0
    assert summary["total_pnl"] == 0.0
