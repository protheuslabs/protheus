"""Tests for strategy tournament runner and hard data-quality blocking."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.data_lake import DataLakeQualityGate, MarketDataLake
from research.tournament import LakeSymbolSource, StrategyTournamentRunner, TournamentConfig


def _agent_config(tmp_path: Path) -> dict:
    return {
        "db_path": str(tmp_path / "research.db"),
        "search_budget": 4,
        "top_performers": 2,
        "min_sharpe": -1.0,
        "max_drawdown": 1.0,
        "min_profit_factor": 0.0,
        "min_deflated_sharpe": -2.0,
        "max_pbo": 1.0,
        "min_walk_forward_consistency": 0.0,
        "paper_min_days": 1,
        "paper_max_slippage_mape": 100.0,
        "paper_max_kill_switch_triggers": 0,
        "live_allowed_strategy_types": ["market_making", "funding_arbitrage"],
        "capacity": {
            "deployable_capital": 100000.0,
            "max_annual_turnover_notional": 100000000.0,
        },
    }


def _frame(rows: int = 80) -> pd.DataFrame:
    idx = pd.date_range("2026-01-01", periods=rows, freq="h", tz="UTC")
    close = 100.0 + np.linspace(0.0, 5.0, rows) + 0.5 * np.sin(np.linspace(0.0, 8.0, rows))
    return pd.DataFrame(
        {
            "open": close - 0.1,
            "high": close + 0.2,
            "low": close - 0.3,
            "close": close,
            "volume": np.linspace(1000.0, 1500.0, rows),
        },
        index=idx,
    )


def test_tournament_runner_executes_and_writes_report(tmp_path):
    lake = MarketDataLake(str(tmp_path / "lake"))
    lake.write_ohlcv(_frame(), venue="binance", symbol="BTCUSDT")

    runner = StrategyTournamentRunner(
        agent_config=_agent_config(tmp_path),
        lake_root=str(tmp_path / "lake"),
        out_dir=str(tmp_path / "reports"),
        config=TournamentConfig(
            interval_seconds=3600,
            quality_gate=DataLakeQualityGate(min_completeness=0.9, max_missing_intervals=5),
            auto_promote_canary=True,
        ),
    )

    payload = runner.run_once(
        strategy_types=["market_making"],
        sources=[LakeSymbolSource(venue="binance", symbol="BTCUSDT")],
        start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        end=datetime(2026, 1, 5, tzinfo=timezone.utc),
    )

    assert Path(payload["report_path"]).exists()
    assert payload["quality_checks"][0]["quality"]["passed"] is True
    assert "research_report" in payload


def test_tournament_runner_blocks_when_quality_gate_fails(tmp_path):
    lake = MarketDataLake(str(tmp_path / "lake"))
    frame = _frame(rows=4).iloc[[0, 2, 3]].copy()  # one missing interval
    lake.write_ohlcv(frame, venue="binance", symbol="BTCUSDT")

    runner = StrategyTournamentRunner(
        agent_config=_agent_config(tmp_path),
        lake_root=str(tmp_path / "lake"),
        out_dir=str(tmp_path / "reports"),
        config=TournamentConfig(
            interval_seconds=3600,
            quality_gate=DataLakeQualityGate(min_completeness=1.0, max_missing_intervals=0),
            auto_promote_canary=False,
        ),
    )

    with pytest.raises(RuntimeError):
        runner.run_once(
            strategy_types=["market_making"],
            sources=[LakeSymbolSource(venue="binance", symbol="BTCUSDT")],
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 3, tzinfo=timezone.utc),
        )
