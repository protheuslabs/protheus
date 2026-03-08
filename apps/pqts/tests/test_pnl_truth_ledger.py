"""Tests for PnL truth ledger decomposition and strategy disable decisions."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.pnl_truth_ledger import (
    build_pnl_truth_ledger,
    detect_negative_net_alpha_scopes,
    detect_negative_net_alpha_strategies,
)
from execution.tca_feedback import TCADatabase, TCATradeRecord


def _record(
    *,
    trade_id: str,
    strategy_id: str,
    exchange: str,
    expected_alpha_bps: float,
    realized_slippage_bps: float,
    realized_commission_bps: float,
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
        predicted_slippage_bps=2.0,
        predicted_commission_bps=1.0,
        predicted_total_bps=3.0,
        realized_slippage_bps=realized_slippage_bps,
        realized_commission_bps=realized_commission_bps,
        realized_total_bps=realized_slippage_bps + realized_commission_bps,
        spread_bps=2.0,
        vol_24h=1000000.0,
        depth_1pct_usd=50000.0,
        strategy_id=strategy_id,
        expected_alpha_bps=expected_alpha_bps,
    )


def test_pnl_truth_ledger_decomposes_costs_by_strategy_venue(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    db.add_record(
        _record(
            trade_id="t1",
            strategy_id="alpha",
            exchange="binance",
            expected_alpha_bps=10.0,
            realized_slippage_bps=2.0,
            realized_commission_bps=1.0,
        )
    )
    db.add_record(
        _record(
            trade_id="t2",
            strategy_id="alpha",
            exchange="binance",
            expected_alpha_bps=10.0,
            realized_slippage_bps=3.0,
            realized_commission_bps=1.0,
        )
    )

    summary, rows = build_pnl_truth_ledger(db, lookback_days=30)

    assert summary["trades"] == 2
    assert len(rows) == 1
    row = rows[0]
    assert row["strategy_id"] == "alpha"
    assert row["exchange"] == "binance"
    assert row["gross_alpha_usd"] > 0.0
    assert row["commission_cost_usd"] > 0.0
    assert row["slippage_cost_usd"] > 0.0
    assert (
        abs(
            row["net_alpha_usd"]
            - (row["gross_alpha_usd"] - row["commission_cost_usd"] - row["slippage_cost_usd"])
        )
        < 1e-9
    )


def test_detect_negative_net_alpha_strategies_respects_trade_minimum(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(5):
        db.add_record(
            _record(
                trade_id=f"n{idx}",
                strategy_id="bad_strategy",
                exchange="coinbase",
                expected_alpha_bps=0.0,
                realized_slippage_bps=8.0,
                realized_commission_bps=2.0,
            )
        )
    summary, rows = build_pnl_truth_ledger(db, lookback_days=30)
    _ = summary

    decisions = detect_negative_net_alpha_strategies(
        rows,
        min_trades=3,
        max_net_alpha_usd=0.0,
    )
    assert len(decisions) == 1
    assert decisions[0].strategy_id == "bad_strategy"
    assert decisions[0].net_alpha_usd < 0.0


def test_net_alpha_declines_monotonically_with_higher_realized_costs(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    db.add_record(
        _record(
            trade_id="mono_low_cost",
            strategy_id="low_cost",
            exchange="binance",
            expected_alpha_bps=15.0,
            realized_slippage_bps=2.0,
            realized_commission_bps=1.0,
        )
    )
    db.add_record(
        _record(
            trade_id="mono_high_cost",
            strategy_id="high_cost",
            exchange="binance",
            expected_alpha_bps=15.0,
            realized_slippage_bps=8.0,
            realized_commission_bps=1.0,
        )
    )

    _summary, rows = build_pnl_truth_ledger(db, lookback_days=30)
    by_strategy = {row["strategy_id"]: row for row in rows}

    low = by_strategy["low_cost"]
    high = by_strategy["high_cost"]

    assert abs(float(low["gross_alpha_usd"]) - float(high["gross_alpha_usd"])) < 1e-12
    assert float(high["slippage_cost_usd"]) > float(low["slippage_cost_usd"])
    assert float(high["net_alpha_usd"]) < float(low["net_alpha_usd"])


def test_detect_negative_net_alpha_scopes_finds_symbol_and_venue_rows(tmp_path):
    db = TCADatabase(str(tmp_path / "tca.csv"))
    for idx in range(6):
        db.add_record(
            _record(
                trade_id=f"scope_{idx}",
                strategy_id="bad_scope",
                exchange="coinbase",
                expected_alpha_bps=0.0,
                realized_slippage_bps=8.0,
                realized_commission_bps=2.0,
            )
        )

    _summary, rows = build_pnl_truth_ledger(db, lookback_days=30)
    scoped = detect_negative_net_alpha_scopes(rows, min_trades=3, max_net_alpha_usd=0.0)
    assert scoped["strategy_venues"]
    assert scoped["strategy_symbols"]
    assert scoped["strategy_venue_symbols"]
