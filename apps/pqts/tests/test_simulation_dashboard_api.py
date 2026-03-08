"""Tests for simulation leaderboard dashboard API helpers."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.simulation_api import get_simulation_kpis, get_simulation_leaderboard
from analytics.simulation_telemetry import SimulationTelemetryStore


def _emit_run(
    store: SimulationTelemetryStore,
    *,
    run_id: str,
    market: str,
    strategy: str,
    submitted: int,
    filled: int,
    rejected: int,
    mape: float,
    ready: bool,
) -> None:
    store.emit(
        event_type="run_started",
        run_id=run_id,
        market=market,
        strategy=strategy,
        metrics={"cycles_target": 10},
    )
    store.emit(
        event_type="cycle_snapshot",
        run_id=run_id,
        market=market,
        strategy=strategy,
        cycle=10,
        metrics={
            "submitted": submitted,
            "filled": filled,
            "rejected": rejected,
            "fill_rate": filled / max(submitted, 1),
            "reject_rate": rejected / max(submitted, 1),
            "p95_realized_slippage_bps": 10.0,
            "slippage_mape_pct": mape,
            "ready_for_canary": int(ready),
        },
        metadata={"promotion_decision": "promote_to_live_canary" if ready else "remain_in_paper"},
    )
    store.emit(
        event_type="run_completed",
        run_id=run_id,
        market=market,
        strategy=strategy,
        cycle=10,
        metrics={
            "submitted": submitted,
            "filled": filled,
            "rejected": rejected,
            "fill_rate": filled / max(submitted, 1),
            "reject_rate": rejected / max(submitted, 1),
            "p95_realized_slippage_bps": 10.0,
            "slippage_mape_pct": mape,
            "ready_for_canary": int(ready),
        },
        metadata={"promotion_decision": "promote_to_live_canary" if ready else "remain_in_paper"},
    )


def test_get_simulation_leaderboard_empty_when_log_missing(tmp_path):
    rows = get_simulation_leaderboard(
        telemetry_log_path=str(tmp_path / "missing.jsonl"),
        limit=5,
    )
    assert rows == []


def test_get_simulation_leaderboard_returns_ranked_rows(tmp_path):
    log_path = tmp_path / "simulation_events.jsonl"
    store = SimulationTelemetryStore(str(log_path))
    _emit_run(
        store,
        run_id="run_good",
        market="crypto",
        strategy="market_making",
        submitted=10,
        filled=9,
        rejected=1,
        mape=12.0,
        ready=True,
    )
    _emit_run(
        store,
        run_id="run_bad",
        market="crypto",
        strategy="cross_exchange",
        submitted=10,
        filled=5,
        rejected=5,
        mape=80.0,
        ready=False,
    )

    rows = get_simulation_leaderboard(telemetry_log_path=str(log_path), limit=10)

    assert len(rows) == 2
    assert rows[0]["rank"] == 1
    assert rows[0]["avg_quality_score"] >= rows[1]["avg_quality_score"]
    assert rows[0]["market"] == "crypto"
    assert "optimization_priority" in rows[0]


def test_get_simulation_kpis_returns_defaults_when_no_log(tmp_path):
    payload = get_simulation_kpis(telemetry_log_path=str(tmp_path / "none.jsonl"))

    assert payload["scenario_count"] == 0
    assert payload["best_quality"]["strategy"] == "n/a"
    assert payload["top_optimization_target"]["strategy"] == "n/a"


def test_get_simulation_kpis_identifies_best_and_target(tmp_path):
    log_path = tmp_path / "simulation_events.jsonl"
    store = SimulationTelemetryStore(str(log_path))
    _emit_run(
        store,
        run_id="run_best",
        market="crypto",
        strategy="funding_arbitrage",
        submitted=10,
        filled=9,
        rejected=1,
        mape=10.0,
        ready=True,
    )
    _emit_run(
        store,
        run_id="run_target",
        market="forex",
        strategy="market_making",
        submitted=10,
        filled=4,
        rejected=6,
        mape=120.0,
        ready=False,
    )

    payload = get_simulation_kpis(telemetry_log_path=str(log_path))

    assert payload["scenario_count"] == 2
    assert payload["best_quality"]["strategy"] == "funding_arbitrage"
    assert payload["best_quality"]["market"] == "crypto"
    assert payload["top_optimization_target"]["strategy"] == "market_making"
    assert payload["top_optimization_target"]["market"] == "forex"
