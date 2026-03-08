"""Tests for confidence-weighted allocation scaling."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.confidence_allocator import ConfidenceWeightedAllocator
from execution.tca_feedback import TCADatabase, TCATradeRecord


def _record(
    *,
    trade_id: str,
    strategy_id: str,
    expected_alpha_bps: float,
    realized_total_bps: float,
) -> TCATradeRecord:
    return TCATradeRecord(
        trade_id=trade_id,
        timestamp=datetime.now(timezone.utc) - timedelta(hours=1),
        symbol="BTC-USD",
        exchange="binance",
        side="buy",
        quantity=1.0,
        price=100.0,
        notional=100.0,
        predicted_slippage_bps=2.0,
        predicted_commission_bps=1.0,
        predicted_total_bps=3.0,
        realized_slippage_bps=max(realized_total_bps - 1.0, 0.0),
        realized_commission_bps=1.0,
        realized_total_bps=realized_total_bps,
        spread_bps=2.0,
        vol_24h=1_000_000.0,
        depth_1pct_usd=50_000.0,
        strategy_id=strategy_id,
        expected_alpha_bps=expected_alpha_bps,
    )


def test_confidence_allocator_returns_neutral_when_disabled(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    allocator = ConfidenceWeightedAllocator(enabled=False)
    decision = allocator.evaluate(strategy_id="alpha", tca_db=db)
    assert decision.multiplier == 1.0
    assert decision.reason == "confidence_allocator_disabled"


def test_confidence_allocator_uses_floor_on_negative_lower_bound(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(20):
        db.add_record(
            _record(
                trade_id=f"neg_{idx}",
                strategy_id="alpha",
                expected_alpha_bps=2.0,
                realized_total_bps=8.0,
            )
        )

    allocator = ConfidenceWeightedAllocator(
        enabled=True,
        min_samples=10,
        min_multiplier=0.3,
        max_multiplier=1.5,
        target_lower_bps=2.0,
        response_slope=0.5,
        hard_floor_on_negative_lower=True,
    )
    decision = allocator.evaluate(strategy_id="alpha", tca_db=db)
    assert decision.samples == 20
    assert decision.ci_lower_bps < 0.0
    assert decision.multiplier == 0.3


def test_confidence_allocator_scales_up_when_lower_bound_positive(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(20):
        db.add_record(
            _record(
                trade_id=f"pos_{idx}",
                strategy_id="alpha",
                expected_alpha_bps=14.0,
                realized_total_bps=6.0,
            )
        )

    allocator = ConfidenceWeightedAllocator(
        enabled=True,
        min_samples=10,
        min_multiplier=0.3,
        max_multiplier=1.5,
        target_lower_bps=2.0,
        response_slope=0.5,
        hard_floor_on_negative_lower=True,
    )
    decision = allocator.evaluate(strategy_id="alpha", tca_db=db)
    assert decision.ci_lower_bps > 0.0
    assert decision.multiplier > 1.0
