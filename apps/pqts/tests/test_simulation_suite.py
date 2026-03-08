"""Deterministic tests for simulation-suite orchestration and artifact emission."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.simulation_suite import SimulationSuiteRunner


def test_build_scenarios_respects_market_strategy_matrix(tmp_path):
    runner = SimulationSuiteRunner(
        config_path="config/paper.yaml",
        out_dir=str(tmp_path / "reports"),
        telemetry_log_path=str(tmp_path / "analytics" / "simulation_events.jsonl"),
        tca_dir=str(tmp_path / "tca"),
    )

    scenarios = runner.build_scenarios(
        markets=["crypto", "forex"],
        strategies=["market_making", "funding_arbitrage"],
        cycles_per_scenario=8,
        notional_usd=120.0,
        symbols_per_market=1,
    )

    assert len(scenarios) == 4
    assert all(len(s.symbols) == 1 for s in scenarios)
    assert {s.market for s in scenarios} == {"crypto", "forex"}


def test_run_suite_emits_report_leaderboard_and_telemetry(tmp_path):
    runner = SimulationSuiteRunner(
        config_path="config/paper.yaml",
        out_dir=str(tmp_path / "reports"),
        telemetry_log_path=str(tmp_path / "analytics" / "simulation_events.jsonl"),
        tca_dir=str(tmp_path / "tca"),
        min_days=0,
        min_fills=1,
    )

    payload = asyncio.run(
        runner.run_suite(
            markets=["crypto"],
            strategies=["market_making"],
            cycles_per_scenario=6,
            notional_usd=100.0,
            symbols_per_market=1,
            readiness_every=3,
            sleep_seconds=0.0,
        )
    )

    assert payload["scenario_count"] == 1
    assert isinstance(payload.get("mechanism_switches"), dict)
    assert Path(payload["report_path"]).exists()
    assert Path(payload["leaderboard_path"]).exists()

    report = json.loads(Path(payload["report_path"]).read_text(encoding="utf-8"))
    assert report["scenario_count"] == 1
    assert len(report["results"]) == 1
    run_id = str(report["results"][0]["run_id"])

    events = runner.telemetry.read_events(run_id=run_id)
    event_types = [str(row.get("event_type")) for row in events]
    assert "run_started" in event_types
    assert "run_completed" in event_types

    summary = runner.telemetry.summarize_run(run_id)
    assert summary["market"] == "crypto"
    assert summary["strategy"] == "market_making"
    assert summary["events"] >= 2
    assert 0.0 <= summary["quality_score"] <= 1.0
