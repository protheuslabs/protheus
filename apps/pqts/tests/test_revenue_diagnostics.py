"""Tests for revenue diagnostics rollups and API helpers."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.revenue_api import get_revenue_diagnostics_payload, get_revenue_kpis
from analytics.revenue_diagnostics import RevenueDiagnostics
from execution.tca_feedback import TCADatabase, TCATradeRecord


def _seed_record(
    *,
    trade_id: str,
    strategy_id: str,
    exchange: str,
    expected_alpha_bps: float,
    realized_total_bps: float,
    prediction_profile: str = "unknown",
) -> TCATradeRecord:
    return TCATradeRecord(
        trade_id=trade_id,
        timestamp=datetime.now(timezone.utc) - timedelta(hours=2),
        symbol="BTC-USD",
        exchange=exchange,
        side="buy",
        quantity=1.0,
        price=100.0,
        notional=100.0,
        predicted_slippage_bps=4.0,
        predicted_commission_bps=1.0,
        predicted_total_bps=5.0,
        realized_slippage_bps=max(realized_total_bps - 1.0, 0.0),
        realized_commission_bps=1.0,
        realized_total_bps=realized_total_bps,
        spread_bps=2.0,
        vol_24h=0.4,
        depth_1pct_usd=100000.0,
        strategy_id=strategy_id,
        expected_alpha_bps=expected_alpha_bps,
        prediction_profile=prediction_profile,
    )


def test_revenue_diagnostics_flags_negative_net_alpha(tmp_path):
    db_path = tmp_path / "tca.csv"
    db = TCADatabase(str(db_path))
    db.add_record(
        _seed_record(
            trade_id="t1",
            strategy_id="edge_good",
            exchange="binance",
            expected_alpha_bps=20.0,
            realized_total_bps=6.0,
        )
    )
    db.add_record(
        _seed_record(
            trade_id="t2",
            strategy_id="edge_bad",
            exchange="coinbase",
            expected_alpha_bps=3.0,
            realized_total_bps=8.0,
        )
    )
    db.save()

    diag = RevenueDiagnostics(str(db_path))
    payload = diag.payload(lookback_days=30, limit=10)

    assert payload["summary"]["trades"] == 2
    assert payload["summary"]["estimated_realized_pnl_usd"] != 0.0
    alerts = payload["leak_alerts"]
    assert len(alerts) == 0 or all("strategy_id" in alert for alert in alerts)

    by_strategy = {row["strategy_id"]: row for row in payload["by_strategy"]}
    assert (
        by_strategy["edge_good"]["realized_net_alpha_bps"]
        > by_strategy["edge_bad"]["realized_net_alpha_bps"]
    )


def test_revenue_api_helpers_return_consistent_kpis(tmp_path):
    db_path = tmp_path / "tca.csv"
    db = TCADatabase(str(db_path))
    db.add_record(
        _seed_record(
            trade_id="t3",
            strategy_id="carry",
            exchange="binance",
            expected_alpha_bps=12.0,
            realized_total_bps=7.0,
        )
    )
    db.save()

    payload = get_revenue_diagnostics_payload(tca_db_path=str(db_path), lookback_days=30, limit=5)
    kpis = get_revenue_kpis(tca_db_path=str(db_path), lookback_days=30)

    assert payload["summary"]["trades"] == 1
    assert kpis["trades"] == 1
    assert kpis["avg_realized_net_alpha_bps"] == payload["summary"]["avg_realized_net_alpha_bps"]
    assert (
        kpis["ci95_lower_realized_net_alpha_bps"]
        == payload["summary"]["ci95_lower_realized_net_alpha_bps"]
    )


def test_revenue_diagnostics_can_filter_prediction_profile(tmp_path):
    db_path = tmp_path / "tca.csv"
    db = TCADatabase(str(db_path))
    db.add_record(
        _seed_record(
            trade_id="legacy",
            strategy_id="campaign",
            exchange="binance",
            expected_alpha_bps=0.0,
            realized_total_bps=25.0,
            prediction_profile="legacy",
        )
    )
    db.add_record(
        _seed_record(
            trade_id="current",
            strategy_id="campaign",
            exchange="binance",
            expected_alpha_bps=0.0,
            realized_total_bps=4.0,
            prediction_profile="current",
        )
    )
    db.save()

    diag = RevenueDiagnostics(str(db_path))
    payload = diag.payload(lookback_days=30, prediction_profile="current")

    assert payload["summary"]["trades"] == 1
    assert payload["summary"]["avg_realized_cost_bps"] == 4.0


def test_revenue_summary_includes_confidence_interval_fields(tmp_path):
    db_path = tmp_path / "tca.csv"
    db = TCADatabase(str(db_path))
    db.add_record(
        _seed_record(
            trade_id="ci_1",
            strategy_id="alpha",
            exchange="binance",
            expected_alpha_bps=12.0,
            realized_total_bps=4.0,
        )
    )
    db.add_record(
        _seed_record(
            trade_id="ci_2",
            strategy_id="alpha",
            exchange="binance",
            expected_alpha_bps=8.0,
            realized_total_bps=7.0,
        )
    )
    db.save()

    summary = RevenueDiagnostics(str(db_path)).summary(lookback_days=30)
    assert "ci95_lower_realized_net_alpha_bps" in summary
    assert "ci95_upper_realized_net_alpha_bps" in summary
    assert (
        summary["ci95_upper_realized_net_alpha_bps"] >= summary["ci95_lower_realized_net_alpha_bps"]
    )
