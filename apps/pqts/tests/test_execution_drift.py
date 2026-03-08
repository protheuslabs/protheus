"""Tests for execution drift analysis and report persistence."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.execution_drift import (
    DriftThresholds,
    analyze_execution_drift,
    write_execution_drift_report,
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
        trade_id=f"drift_{idx}",
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


def test_analyze_execution_drift_flags_alert_when_realized_far_exceeds_predicted(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(40):
        db.add_record(
            _record(
                idx=idx,
                symbol="BTC-USD",
                exchange="binance",
                predicted=5.0,
                realized=15.0,
            )
        )

    payload = analyze_execution_drift(
        tca_db=db,
        lookback_days=30,
        thresholds=DriftThresholds(
            min_samples=30,
            max_mape_pct=20.0,
            max_realized_to_predicted_ratio=1.5,
        ),
    )

    assert payload["summary"]["pairs"] == 1
    assert payload["summary"]["alerts"] == 1
    assert payload["pairs"][0]["status"] == "alert"
    assert payload["pairs"][0]["realized_to_predicted_ratio"] > 1.5


def test_write_execution_drift_report_persists_json(tmp_path):
    db_path = tmp_path / "tca.csv"
    db = TCADatabase(str(db_path))
    for idx in range(10):
        db.add_record(
            _record(
                idx=idx,
                symbol="ETH-USD",
                exchange="coinbase",
                predicted=10.0,
                realized=10.5,
            )
        )
    db.save()

    report = write_execution_drift_report(
        tca_db_path=str(db_path),
        out_dir=str(tmp_path / "reports"),
        lookback_days=30,
        thresholds=DriftThresholds(min_samples=5),
    )

    assert report.exists()
    parsed = json.loads(report.read_text(encoding="utf-8"))
    assert parsed["summary"]["pairs"] == 1
    assert parsed["pairs"][0]["symbol"] == "ETH-USD"


def test_execution_drift_mape_uses_bps_denominator_floor(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(40):
        db.add_record(
            _record(
                idx=idx,
                symbol="BTC-USD",
                exchange="binance",
                predicted=2.0,
                realized=0.0,
            )
        )

    payload = analyze_execution_drift(
        tca_db=db,
        lookback_days=30,
        thresholds=DriftThresholds(min_samples=10, max_mape_pct=500.0),
    )

    assert payload["pairs"][0]["slippage_mape_pct"] == 200.0


def test_execution_drift_warmup_suppresses_alerts_below_min_samples(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(5):
        db.add_record(
            _record(
                idx=idx,
                symbol="SOL-USD",
                exchange="coinbase",
                predicted=5.0,
                realized=20.0,
            )
        )

    payload = analyze_execution_drift(
        tca_db=db,
        lookback_days=30,
        thresholds=DriftThresholds(
            min_samples=30,
            max_mape_pct=5.0,
            max_realized_to_predicted_ratio=1.01,
        ),
    )

    assert payload["summary"]["alerts"] == 0
    assert payload["summary"]["warmup_pairs"] == 1
    assert payload["pairs"][0]["status"] == "warmup"
    assert any("insufficient_samples" in note for note in payload["pairs"][0].get("notes", []))
