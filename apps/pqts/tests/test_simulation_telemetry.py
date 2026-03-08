"""Tests for simulation telemetry persistence and optimization summaries."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.simulation_telemetry import SimulationTelemetryStore


def test_simulation_telemetry_round_trip_and_summary(tmp_path):
    store = SimulationTelemetryStore(str(tmp_path / "simulation_events.jsonl"))
    run_id = "sim_run_1"

    store.emit(
        event_type="run_started",
        run_id=run_id,
        market="crypto",
        strategy="market_making",
        cycle=0,
        metrics={"cycles_target": 6, "capital_usd": 10000.0},
    )
    store.emit(
        event_type="cycle_snapshot",
        run_id=run_id,
        market="crypto",
        strategy="market_making",
        cycle=3,
        metrics={
            "submitted": 3,
            "filled": 2,
            "rejected": 1,
            "fill_rate": 2.0 / 3.0,
            "reject_rate": 1.0 / 3.0,
            "p95_realized_slippage_bps": 12.0,
            "slippage_mape_pct": 18.0,
            "ready_for_canary": 0,
        },
        metadata={"promotion_decision": "remain_in_paper"},
    )
    store.emit(
        event_type="run_completed",
        run_id=run_id,
        market="crypto",
        strategy="market_making",
        cycle=6,
        metrics={
            "submitted": 6,
            "filled": 4,
            "rejected": 2,
            "fill_rate": 4.0 / 6.0,
            "reject_rate": 2.0 / 6.0,
            "p95_realized_slippage_bps": 11.0,
            "slippage_mape_pct": 17.0,
            "ready_for_canary": 1,
        },
        metadata={"promotion_decision": "promote_to_live_canary"},
    )

    events = store.read_events(run_id=run_id)
    summary = store.summarize_run(run_id)

    assert len(events) == 3
    assert summary["submitted"] == 6
    assert summary["filled"] == 4
    assert summary["rejected"] == 2
    assert summary["promotion_decision"] == "promote_to_live_canary"
    assert summary["ready_for_canary"] is True
    assert 0.0 < summary["quality_score"] <= 1.0


def test_optimization_leaderboard_aggregates_by_market_and_strategy(tmp_path):
    store = SimulationTelemetryStore(str(tmp_path / "simulation_events.jsonl"))

    for run_id, mape, filled, rejected in (
        ("run_a", 12.0, 8, 2),
        ("run_b", 28.0, 6, 4),
    ):
        store.emit(
            event_type="run_started",
            run_id=run_id,
            market="crypto",
            strategy="funding_arbitrage",
            metrics={"cycles_target": 10},
        )
        store.emit(
            event_type="cycle_snapshot",
            run_id=run_id,
            market="crypto",
            strategy="funding_arbitrage",
            cycle=10,
            metrics={
                "submitted": 10,
                "filled": filled,
                "rejected": rejected,
                "fill_rate": filled / 10.0,
                "reject_rate": rejected / 10.0,
                "p95_realized_slippage_bps": 10.0 + mape / 10.0,
                "slippage_mape_pct": mape,
                "ready_for_canary": int(mape < 20.0),
            },
            metadata={"promotion_decision": "remain_in_paper"},
        )
        store.emit(
            event_type="run_completed",
            run_id=run_id,
            market="crypto",
            strategy="funding_arbitrage",
            cycle=10,
            metrics={
                "submitted": 10,
                "filled": filled,
                "rejected": rejected,
                "fill_rate": filled / 10.0,
                "reject_rate": rejected / 10.0,
                "p95_realized_slippage_bps": 10.0 + mape / 10.0,
                "slippage_mape_pct": mape,
                "ready_for_canary": int(mape < 20.0),
            },
            metadata={"promotion_decision": "remain_in_paper"},
        )

    leaderboard = store.optimization_leaderboard()
    assert not leaderboard.empty
    row = leaderboard.iloc[0].to_dict()
    assert row["market"] == "crypto"
    assert row["strategy"] == "funding_arbitrage"
    assert int(row["runs"]) == 2
    assert "optimization_priority" in row
