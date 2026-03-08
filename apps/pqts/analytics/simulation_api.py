"""Dashboard-facing helpers for simulation telemetry and optimization leaderboards."""

from __future__ import annotations

from typing import Any, Dict, List

import pandas as pd

from analytics.simulation_telemetry import SimulationTelemetryStore


def _normalize_leaderboard(frame: pd.DataFrame, limit: int) -> List[Dict[str, Any]]:
    if frame.empty:
        return []

    scoped = frame.head(max(int(limit), 0)).copy()
    scoped["rank"] = range(1, len(scoped) + 1)

    records: List[Dict[str, Any]] = []
    for _, row in scoped.iterrows():
        records.append(
            {
                "rank": int(row["rank"]),
                "market": str(row["market"]),
                "strategy": str(row["strategy"]),
                "runs": int(row["runs"]),
                "avg_quality_score": float(row["avg_quality_score"]),
                "avg_fill_rate": float(row["avg_fill_rate"]),
                "avg_reject_rate": float(row["avg_reject_rate"]),
                "avg_slippage_mape_pct": float(row["avg_slippage_mape_pct"]),
                "canary_ready_rate": float(row["canary_ready_rate"]),
                "promote_rate": float(row["promote_rate"]),
                "optimization_priority": float(row["optimization_priority"]),
            }
        )
    return records


def _default_kpis() -> Dict[str, Any]:
    return {
        "scenario_count": 0,
        "best_quality": {
            "market": "n/a",
            "strategy": "n/a",
            "avg_quality_score": 0.0,
            "runs": 0,
            "canary_ready_rate": 0.0,
        },
        "top_optimization_target": {
            "market": "n/a",
            "strategy": "n/a",
            "optimization_priority": 0.0,
            "avg_slippage_mape_pct": 0.0,
            "avg_reject_rate": 0.0,
            "runs": 0,
        },
    }


def get_simulation_leaderboard(
    *,
    telemetry_log_path: str = "data/analytics/simulation_events.jsonl",
    limit: int = 8,
) -> List[Dict[str, Any]]:
    """Return normalized leaderboard rows for dashboard rendering."""
    telemetry = SimulationTelemetryStore(log_path=telemetry_log_path)
    leaderboard = telemetry.optimization_leaderboard()
    return _normalize_leaderboard(leaderboard, limit=limit)


def get_simulation_kpis(
    *,
    telemetry_log_path: str = "data/analytics/simulation_events.jsonl",
) -> Dict[str, Any]:
    """
    Return high-level simulation KPIs for top-of-dashboard cards.

    KPIs:
    - best_quality: highest avg_quality_score row
    - top_optimization_target: highest optimization_priority row
    """
    telemetry = SimulationTelemetryStore(log_path=telemetry_log_path)
    leaderboard = telemetry.optimization_leaderboard()
    if leaderboard.empty:
        return _default_kpis()

    best_row = leaderboard.sort_values(
        by=["avg_quality_score", "canary_ready_rate", "runs"],
        ascending=[False, False, False],
    ).iloc[0]
    opt_row = leaderboard.sort_values(
        by=["optimization_priority", "avg_slippage_mape_pct", "avg_reject_rate"],
        ascending=[False, False, False],
    ).iloc[0]

    return {
        "scenario_count": int(leaderboard["runs"].sum()),
        "best_quality": {
            "market": str(best_row["market"]),
            "strategy": str(best_row["strategy"]),
            "avg_quality_score": float(best_row["avg_quality_score"]),
            "runs": int(best_row["runs"]),
            "canary_ready_rate": float(best_row["canary_ready_rate"]),
        },
        "top_optimization_target": {
            "market": str(opt_row["market"]),
            "strategy": str(opt_row["strategy"]),
            "optimization_priority": float(opt_row["optimization_priority"]),
            "avg_slippage_mape_pct": float(opt_row["avg_slippage_mape_pct"]),
            "avg_reject_rate": float(opt_row["avg_reject_rate"]),
            "runs": int(opt_row["runs"]),
        },
    }
