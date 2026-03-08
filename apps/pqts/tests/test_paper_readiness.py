"""Deterministic tests for paper track-record and slippage readiness gates."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.paper_readiness import PaperTrackRecordEvaluator
from execution.risk_aware_router import RiskAwareRouter
from execution.tca_feedback import TCADatabase, TCATradeRecord
from risk.kill_switches import RiskLimits


def _record(
    *,
    trade_id: str,
    timestamp: datetime,
    predicted: float,
    realized: float,
    prediction_profile: str = "unknown",
) -> TCATradeRecord:
    return TCATradeRecord(
        trade_id=trade_id,
        timestamp=timestamp,
        symbol="BTC-USD",
        exchange="binance",
        side="buy",
        quantity=1.0,
        price=100.0,
        notional=100.0,
        predicted_slippage_bps=predicted,
        predicted_commission_bps=1.0,
        predicted_total_bps=predicted + 1.0,
        realized_slippage_bps=realized,
        realized_commission_bps=1.0,
        realized_total_bps=realized + 1.0,
        spread_bps=2.0,
        vol_24h=1000000.0,
        depth_1pct_usd=100000.0,
        prediction_profile=prediction_profile,
    )


def _seed_db(
    db: TCADatabase,
    *,
    days: int,
    fills_per_day: int,
    predicted: float,
    realized: float,
    prediction_profile: str = "unknown",
) -> None:
    now = datetime.now(timezone.utc)
    for d in range(days):
        for i in range(fills_per_day):
            db.add_record(
                _record(
                    trade_id=f"t_{d}_{i}",
                    timestamp=now - timedelta(days=d, minutes=i),
                    predicted=predicted,
                    realized=realized,
                    prediction_profile=prediction_profile,
                )
            )
    db.save()


def test_paper_readiness_passes_with_track_record_and_acceptable_slippage(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    _seed_db(db, days=35, fills_per_day=10, predicted=10.0, realized=12.0)

    result = PaperTrackRecordEvaluator(db).evaluate(
        lookback_days=60,
        min_days_required=30,
        min_fills_required=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
    )

    assert result.passed_track_record is True
    assert result.passed_slippage is True
    assert result.ready_for_canary is True


def test_paper_readiness_fails_on_insufficient_track_record(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    _seed_db(db, days=10, fills_per_day=5, predicted=10.0, realized=11.0)

    result = PaperTrackRecordEvaluator(db).evaluate(
        lookback_days=60,
        min_days_required=30,
        min_fills_required=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
    )

    assert result.passed_track_record is False
    assert result.ready_for_canary is False


def test_paper_readiness_fails_on_high_realized_slippage(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    _seed_db(db, days=40, fills_per_day=8, predicted=10.0, realized=35.0)

    result = PaperTrackRecordEvaluator(db).evaluate(
        lookback_days=60,
        min_days_required=30,
        min_fills_required=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
    )

    assert result.passed_track_record is True
    assert result.passed_slippage is False
    assert result.ready_for_canary is False


def test_router_exposes_paper_readiness_assessment(tmp_path):
    db_path = tmp_path / "router_tca.csv"
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        tca_db_path=str(db_path),
    )
    router.set_capital(100000.0, source="unit_test")

    _seed_db(router.tca_db, days=35, fills_per_day=10, predicted=9.0, realized=12.0)
    for rec in router.tca_db.records:
        rec.prediction_profile = router.prediction_profile
    router.tca_db.save()

    assessment = router.evaluate_paper_live_readiness(
        lookback_days=60,
        min_days_required=30,
        min_fills_required=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
    )

    assert assessment["passed_track_record"] is True
    assert assessment["passed_slippage"] is True
    assert assessment["ready_for_canary"] is True


def test_paper_readiness_uses_robust_slippage_mape_floor(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    _seed_db(db, days=35, fills_per_day=10, predicted=3.0, realized=0.0)

    result = PaperTrackRecordEvaluator(db).evaluate(
        lookback_days=60,
        min_days_required=30,
        min_fills_required=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=500.0,
    )

    assert result.slippage_mape_pct == 300.0


def test_paper_readiness_filters_by_prediction_profile(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    _seed_db(
        db,
        days=35,
        fills_per_day=8,
        predicted=100.0,
        realized=10.0,
        prediction_profile="legacy_profile",
    )
    _seed_db(
        db,
        days=35,
        fills_per_day=8,
        predicted=12.0,
        realized=12.0,
        prediction_profile="current_profile",
    )

    result = PaperTrackRecordEvaluator(db).evaluate(
        lookback_days=60,
        min_days_required=30,
        min_fills_required=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
        prediction_profile="current_profile",
    )

    assert result.passed_track_record is True
    assert result.passed_slippage is True
    assert result.slippage_mape_pct == 0.0
