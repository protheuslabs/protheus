"""Deterministic tests for capacity-curve throttling behavior."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.capacity_curves import StrategyCapacityCurveModel


def test_capacity_curve_model_blocks_when_alpha_non_positive(tmp_path):
    model = StrategyCapacityCurveModel(
        enabled=True,
        storage_path=str(tmp_path / "capacity.jsonl"),
        min_points=5,
    )
    decision = model.evaluate_order(
        strategy_id="mm_1",
        venue="binance",
        symbol="BTCUSDT",
        candidate_notional_usd=10000.0,
        predicted_net_alpha_bps=-0.1,
    )

    assert decision.blocked is True
    assert decision.approved_notional_usd == 0.0
    assert decision.reason == "predicted_marginal_alpha_non_positive"


def test_capacity_curve_model_throttles_to_zero_cross(tmp_path):
    model = StrategyCapacityCurveModel(
        enabled=True,
        storage_path=str(tmp_path / "capacity.jsonl"),
        min_points=3,
        throttle_buffer=0.9,
    )
    rows = [
        (1000.0, 4.0),
        (2000.0, 2.0),
        (3000.0, 0.0),
    ]
    for notional, alpha in rows:
        model.record(
            strategy_id="mm_2",
            venue="binance",
            symbol="BTCUSDT",
            notional_usd=notional,
            net_alpha_bps=alpha,
            timestamp=datetime(2026, 3, 1, tzinfo=timezone.utc),
        )

    decision = model.evaluate_order(
        strategy_id="mm_2",
        venue="binance",
        symbol="BTCUSDT",
        candidate_notional_usd=4000.0,
        predicted_net_alpha_bps=1.0,
    )

    assert decision.blocked is False
    assert decision.throttle_ratio == pytest.approx(0.675, abs=1e-3)
    assert decision.approved_notional_usd == pytest.approx(2700.0, abs=1.0)
    assert decision.reason == "negative_marginal_alpha_throttled_to_zero_cross"
