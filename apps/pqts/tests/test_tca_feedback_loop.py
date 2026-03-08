"""Deterministic tests for TCA persistence and calibration feedback."""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.risk_aware_router import RiskAwareRouter
from execution.smart_router import OrderRequest, OrderType
from execution.tca_feedback import (
    MIN_CALIBRATED_ETA,
    TCACalibrator,
    TCADatabase,
    TCATradeRecord,
    slippage_mape_pct,
    weekly_calibrate_eta,
)
from risk.kill_switches import RiskLimits


def _record(
    *,
    trade_id: str,
    symbol: str,
    exchange: str,
    predicted_slippage_bps: float,
    realized_slippage_bps: float,
    prediction_profile: str = "unknown",
) -> TCATradeRecord:
    return TCATradeRecord(
        trade_id=trade_id,
        timestamp=datetime.now(timezone.utc) - timedelta(hours=1),
        symbol=symbol,
        exchange=exchange,
        side="buy",
        quantity=1.0,
        price=100.0,
        notional=100.0,
        predicted_slippage_bps=predicted_slippage_bps,
        predicted_commission_bps=1.0,
        predicted_total_bps=predicted_slippage_bps + 1.0,
        realized_slippage_bps=realized_slippage_bps,
        realized_commission_bps=1.0,
        realized_total_bps=realized_slippage_bps + 1.0,
        spread_bps=2.0,
        vol_24h=0.4,
        depth_1pct_usd=100000.0,
        prediction_profile=prediction_profile,
    )


def test_tca_database_persistence(tmp_path):
    db_path = tmp_path / "tca_records.csv"
    db = TCADatabase(str(db_path))

    db.add_record(
        _record(
            trade_id="trade_1",
            symbol="BTC-USD",
            exchange="binance",
            predicted_slippage_bps=5.0,
            realized_slippage_bps=7.5,
        )
    )
    saved_path = db.save()

    reloaded = TCADatabase(str(db_path))

    assert saved_path.exists()
    assert len(reloaded.records) == 1
    assert reloaded.records[0].trade_id == "trade_1"
    assert reloaded.records[0].exchange == "binance"


def test_eta_calibration_moves_up_when_realized_exceeds_predicted(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))

    for idx in range(8):
        db.add_record(
            _record(
                trade_id=f"hi_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=4.0,
                realized_slippage_bps=8.0,
            )
        )

    calibrator = TCACalibrator(db, min_samples=5, alert_threshold_pct=200.0)
    new_eta, analysis = calibrator.calibrate_eta("BTC-USD", "binance", current_eta=0.4)

    assert new_eta > 0.4
    assert analysis["status"] in {"ok", "alert"}
    assert analysis["ratio_realized_to_predicted"] > 1.0


def test_drift_alert_triggers_on_high_mape(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))

    for idx in range(8):
        db.add_record(
            _record(
                trade_id=f"drift_{idx}",
                symbol="ETH-USD",
                exchange="coinbase",
                predicted_slippage_bps=2.0,
                realized_slippage_bps=12.0,
            )
        )

    calibrator = TCACalibrator(db, min_samples=5, alert_threshold_pct=30.0)
    analysis = calibrator.analyze_symbol_venue("ETH-USD", "coinbase")

    assert analysis["status"] == "alert"
    assert any("MAPE" in msg for msg in analysis["alerts"])


def test_weekly_calibration_updates_eta_by_symbol_venue(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(8):
        db.add_record(
            _record(
                trade_id=f"weekly_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=3.0,
                realized_slippage_bps=9.0,
            )
        )

    updated, analyses = weekly_calibrate_eta(
        tca_db=db,
        current_eta_by_market={("BTC-USD", "binance"): 0.3},
        min_samples=5,
        alert_threshold_pct=200.0,
        days=30,
    )

    assert updated[("BTC-USD", "binance")] > 0.3
    assert analyses[0]["symbol"] == "BTC-USD"
    assert analyses[0]["exchange"] == "binance"


def test_slippage_mape_uses_bps_floor_for_near_zero_realized():
    mape = slippage_mape_pct(
        predicted_slippage_bps=[1.0, 2.0],
        realized_slippage_bps=[0.0, 0.0],
    )
    assert mape == 150.0


def test_eta_calibration_can_move_below_legacy_floor(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(8):
        db.add_record(
            _record(
                trade_id=f"lo_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=10.0,
                realized_slippage_bps=0.1,
            )
        )

    calibrator = TCACalibrator(db, min_samples=5, alert_threshold_pct=500.0)
    new_eta, _analysis = calibrator.calibrate_eta("BTC-USD", "binance", current_eta=0.1)

    assert new_eta < 0.05
    assert new_eta >= MIN_CALIBRATED_ETA


def test_eta_calibration_ratio_reduces_mape_when_reapplied(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    predicted = np.full(24, 4.0)
    realized = np.full(24, 8.0)

    for idx in range(24):
        db.add_record(
            _record(
                trade_id=f"cal_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=float(predicted[idx]),
                realized_slippage_bps=float(realized[idx]),
            )
        )

    before = slippage_mape_pct(
        predicted_slippage_bps=predicted,
        realized_slippage_bps=realized,
    )
    calibrator = TCACalibrator(db, min_samples=10, alert_threshold_pct=500.0)
    _eta_after, analysis = calibrator.calibrate_eta("BTC-USD", "binance", current_eta=0.5)
    ratio = float(analysis["ratio_realized_to_predicted"])
    adjusted = predicted * ratio
    after = slippage_mape_pct(
        predicted_slippage_bps=adjusted,
        realized_slippage_bps=realized,
    )

    assert ratio > 1.0
    assert after < before
    assert after <= 5.0


def test_eta_calibration_respects_max_step_pct(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(20):
        db.add_record(
            _record(
                trade_id=f"cap_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=4.0,
                realized_slippage_bps=40.0,
            )
        )

    calibrator = TCACalibrator(
        db,
        min_samples=10,
        alert_threshold_pct=500.0,
        adaptation_rate=1.0,
        max_step_pct=0.20,
    )
    eta_after, _analysis = calibrator.calibrate_eta("BTC-USD", "binance", current_eta=0.5)

    assert eta_after == pytest.approx(0.6)


def test_eta_calibration_uses_venue_fallback_for_sparse_symbol(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(2):
        db.add_record(
            _record(
                trade_id=f"sparse_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=10.0,
                realized_slippage_bps=2.0,
            )
        )
    for idx in range(20):
        db.add_record(
            _record(
                trade_id=f"venue_{idx}",
                symbol=f"ALT-{idx}",
                exchange="binance",
                predicted_slippage_bps=10.0,
                realized_slippage_bps=2.0,
            )
        )

    calibrator = TCACalibrator(
        db,
        min_samples=10,
        alert_threshold_pct=500.0,
        adaptation_rate=1.0,
        max_step_pct=1.0,
    )
    eta_after, analysis = calibrator.calibrate_eta("BTC-USD", "binance", current_eta=0.5)

    assert eta_after < 0.5
    assert analysis["calibration_scope"] == "venue_fallback"
    assert analysis["calibration_samples"] == 22


def test_router_persists_eta_calibration_across_sessions(tmp_path):
    eta_store_path = tmp_path / "eta_store.json"
    tca_db_path = tmp_path / "tca.csv"

    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "eta_store_path": str(eta_store_path),
        },
        tca_db_path=str(tca_db_path),
    )

    for idx in range(20):
        router.tca_db.add_record(
            _record(
                trade_id=f"persist_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=4.0,
                realized_slippage_bps=8.0,
            )
        )

    updated, _analyses = router.run_weekly_tca_calibration(
        eta_by_symbol_venue={("BTC-USD", "binance"): 0.4},
        min_samples=10,
        alert_threshold_pct=500.0,
        adaptation_rate=1.0,
        max_step_pct=1.0,
        lookback_days=30,
    )

    assert eta_store_path.exists()
    expected_eta = updated[("BTC-USD", "binance")]

    reloaded = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "eta_store_path": str(eta_store_path),
        },
        tca_db_path=str(tmp_path / "reloaded_tca.csv"),
    )

    assert reloaded.eta_by_symbol_venue[("BTC-USD", "binance")] == pytest.approx(expected_eta)
    assert reloaded.cost_model.eta == pytest.approx(expected_eta)


def test_weekly_calibration_filters_prediction_profile(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(12):
        db.add_record(
            _record(
                trade_id=f"legacy_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=100.0,
                realized_slippage_bps=10.0,
                prediction_profile="legacy",
            )
        )
    for idx in range(12):
        db.add_record(
            _record(
                trade_id=f"current_{idx}",
                symbol="BTC-USD",
                exchange="binance",
                predicted_slippage_bps=5.0,
                realized_slippage_bps=10.0,
                prediction_profile="current",
            )
        )

    updated, analyses = weekly_calibrate_eta(
        tca_db=db,
        current_eta_by_market={("BTC-USD", "binance"): 0.4},
        min_samples=10,
        alert_threshold_pct=500.0,
        adaptation_rate=1.0,
        max_step_pct=1.0,
        days=30,
        prediction_profile="current",
    )

    assert updated[("BTC-USD", "binance")] > 0.4
    assert analyses[0]["calibration_samples"] == 12


def test_router_records_predicted_vs_realized_slippage(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        tca_db_path=str(tmp_path / "router_tca.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.1,
        order_type=OrderType.LIMIT,
        price=50000.0,
    )

    market_data = {
        "binance": {
            "BTC-USD": {
                "price": 50000.0,
                "spread": 0.0002,
                "volume_24h": 2_000_000,
            }
        },
        "order_book": {
            "bids": [(49990.0, 2.0), (49980.0, 4.0)],
            "asks": [(50010.0, 1.5), (50020.0, 3.0)],
        },
    }

    portfolio = {
        "positions": {"BTC": 0.25},
        "prices": {"BTC": 50000.0},
        "total_pnl": 0.0,
        "unrealized_pnl": 0.0,
        "realized_pnl": 0.0,
        "gross_exposure": 12500.0,
        "net_exposure": 12500.0,
        "leverage": 0.25,
        "open_orders": [],
    }

    strategy_returns = {
        "s1": np.linspace(-0.01, 0.01, 30),
        "s2": np.cos(np.linspace(0.0, 2.0 * np.pi, 30)) * 0.005,
    }
    portfolio_changes = np.linspace(-50.0, 50.0, 30)

    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=portfolio,
            strategy_returns=strategy_returns,
            portfolio_changes=list(portfolio_changes),
        )
    )

    assert result.success
    assert len(router.tca_db.records) == 1
    tca_payload = result.audit_log.get("tca", {})
    assert "predicted_slippage_bps" in tca_payload
    assert "realized_slippage_bps" in tca_payload
