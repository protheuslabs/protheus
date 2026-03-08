"""Tests for calibration diagnostics analysis and report persistence."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.calibration_diagnostics import (
    CalibrationDiagnosticsThresholds,
    analyze_calibration_diagnostics,
    write_calibration_diagnostics_report,
)
from execution.tca_feedback import TCADatabase, TCATradeRecord


def _record(
    *,
    idx: int,
    symbol: str,
    exchange: str,
    predicted: float,
    realized: float,
) -> TCATradeRecord:
    return TCATradeRecord(
        trade_id=f"diag_{idx}",
        timestamp=datetime.now(timezone.utc) - timedelta(hours=1),
        symbol=symbol,
        exchange=exchange,
        side="buy",
        quantity=1.0,
        price=100.0,
        notional=100.0,
        predicted_slippage_bps=float(predicted),
        predicted_commission_bps=1.0,
        predicted_total_bps=float(predicted) + 1.0,
        realized_slippage_bps=float(realized),
        realized_commission_bps=1.0,
        realized_total_bps=float(realized) + 1.0,
        spread_bps=2.0,
        vol_24h=100000.0,
        depth_1pct_usd=25000.0,
    )


def test_calibration_diagnostics_flags_alert_and_eta_direction(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(40):
        db.add_record(
            _record(
                idx=idx,
                symbol="BTC-USD",
                exchange="binance",
                predicted=4.0,
                realized=10.0,
            )
        )

    payload = analyze_calibration_diagnostics(
        tca_db=db,
        lookback_days=30,
        thresholds=CalibrationDiagnosticsThresholds(
            min_samples=30,
            max_mape_pct=20.0,
            min_realized_to_predicted_ratio=0.8,
            max_realized_to_predicted_ratio=1.2,
        ),
    )

    assert payload["summary"]["pairs"] == 1
    assert payload["summary"]["alerts"] == 1
    row = payload["pairs"][0]
    assert row["status"] == "alert"
    assert row["eta_direction"] == "increase_eta"
    assert row["recommended_eta_multiplier"] > 1.0


def test_calibration_diagnostics_marks_warmup_below_min_samples(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(5):
        db.add_record(
            _record(
                idx=idx,
                symbol="ETH-USD",
                exchange="coinbase",
                predicted=10.0,
                realized=1.0,
            )
        )

    payload = analyze_calibration_diagnostics(
        tca_db=db,
        lookback_days=30,
        thresholds=CalibrationDiagnosticsThresholds(min_samples=20),
    )

    assert payload["summary"]["alerts"] == 0
    assert payload["summary"]["warmup_pairs"] == 1
    assert payload["pairs"][0]["status"] == "warmup"


def test_write_calibration_diagnostics_report_persists_json(tmp_path):
    db_path = tmp_path / "tca.csv"
    db = TCADatabase(str(db_path))
    for idx in range(10):
        db.add_record(
            _record(
                idx=idx,
                symbol="SOL-USD",
                exchange="coinbase",
                predicted=6.0,
                realized=6.5,
            )
        )
    db.save()

    report_path = write_calibration_diagnostics_report(
        tca_db_path=str(db_path),
        out_dir=str(tmp_path / "reports"),
        lookback_days=30,
        thresholds=CalibrationDiagnosticsThresholds(min_samples=5),
    )
    payload = json.loads(report_path.read_text(encoding="utf-8"))

    assert report_path.exists()
    assert payload["summary"]["pairs"] == 1
    assert payload["pairs"][0]["symbol"] == "SOL-USD"
