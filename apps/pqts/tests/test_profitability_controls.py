"""Deterministic tests for profitability controls and router wiring."""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.market_data_quality import MarketDataQualityMonitor
from execution.fee_optimizer import FeeRebateOptimizer
from execution.reliability import ExecutionReliabilityMonitor
from execution.risk_aware_router import RiskAwareRouter
from execution.smart_router import OrderRequest, OrderType
from portfolio.strategy_allocator import (
    StrategyBudgetInput,
    StrategyCapitalAllocator,
    StrategyUtilityConfig,
)
from risk.kill_switches import RiskLimits
from risk.regime_overlay import RegimeExposureOverlay
from strategies.inventory_transfer import InventoryRiskTransferEngine


def _portfolio_snapshot() -> dict:
    return {
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


def _strategy_inputs() -> tuple[dict, list[float]]:
    strategy_returns = {
        "s1": np.linspace(-0.01, 0.01, 30),
        "s2": np.cos(np.linspace(0.0, 2.0 * np.pi, 30)) * 0.005,
    }
    portfolio_changes = np.linspace(-50.0, 50.0, 30)
    return strategy_returns, list(portfolio_changes)


def test_fee_optimizer_prefers_best_net_fee_and_style():
    optimizer = FeeRebateOptimizer(
        tiers_by_venue={
            "binance": [
                {
                    "monthly_volume_usd": 0,
                    "maker_fee_bps": 8,
                    "taker_fee_bps": 10,
                    "maker_rebate_bps": 1,
                }
            ],
            "coinbase": [
                {
                    "monthly_volume_usd": 0,
                    "maker_fee_bps": 9,
                    "taker_fee_bps": 12,
                    "maker_rebate_bps": 0,
                }
            ],
        }
    )

    assert optimizer.effective_fee_bps("binance", is_maker=True, monthly_volume_usd=0) == 7.0
    assert optimizer.best_venue(["binance", "coinbase"], is_maker=True) == "binance"
    assert (
        optimizer.recommend_order_style(
            venue="binance",
            spread_bps=6.0,
            urgency="GTC",
            monthly_volume_usd=0.0,
        )
        == "maker"
    )
    assert (
        optimizer.recommend_order_style(
            venue="binance",
            spread_bps=6.0,
            urgency="IOC",
            monthly_volume_usd=0.0,
        )
        == "taker"
    )


def test_reliability_monitor_failover_and_cooldown_behavior():
    monitor = ExecutionReliabilityMonitor(
        latency_slo_ms=100.0,
        rejection_slo=0.05,
        failure_slo=0.05,
        cooldown_seconds=300,
    )

    for _ in range(30):
        monitor.record(venue="binance", latency_ms=900.0, rejected=True, failed=True)
        monitor.record(venue="coinbase", latency_ms=15.0, rejected=False, failed=False)

    assert monitor.is_degraded("binance") is True
    first_failover = monitor.choose_failover("binance", ["binance", "coinbase"])
    assert first_failover == "coinbase"

    # Cooldown blocks immediate repeated failover recommendations.
    assert monitor.choose_failover("binance", ["binance", "coinbase"]) is None

    monitor._state["binance"].last_failover_at -= timedelta(seconds=301)
    assert monitor.choose_failover("binance", ["binance", "coinbase"]) == "coinbase"


def test_regime_overlay_throttles_quantity_in_crisis_spread():
    overlay = RegimeExposureOverlay(
        {
            "extreme_spread": 0.002,
            "crisis_multiplier": 0.25,
        }
    )
    market_data = {
        "binance": {
            "BTC-USD": {
                "price": 50000.0,
                "spread": 0.003,
                "volume_24h": 2_000_000,
            }
        }
    }
    adjusted, decision = overlay.throttle_quantity("BTC-USD", 8.0, market_data)

    assert decision.regime == "crisis"
    assert adjusted == 2.0


def test_strategy_allocator_penalizes_capacity_and_normalizes_weights():
    allocator = StrategyCapitalAllocator(max_weight=0.7, min_weight=0.0, capacity_haircut=0.2)
    weights = allocator.allocate(
        [
            StrategyBudgetInput(
                strategy_id="good",
                expected_return=0.28,
                annual_vol=0.2,
                annual_turnover=3.0,
                cost_per_turnover=0.004,
                capacity_ratio=0.8,
            ),
            StrategyBudgetInput(
                strategy_id="capacity_bound",
                expected_return=0.28,
                annual_vol=0.2,
                annual_turnover=3.0,
                cost_per_turnover=0.004,
                capacity_ratio=1.8,
            ),
        ]
    )

    assert abs(sum(weights.values()) - 1.0) < 1e-9
    assert weights["good"] > weights["capacity_bound"]


def test_strategy_allocator_utility_respects_risk_aversion():
    conservative = StrategyCapitalAllocator(
        max_weight=0.9,
        min_weight=0.0,
        capacity_haircut=0.0,
        utility_config=StrategyUtilityConfig(risk_aversion=10.0),
    )
    aggressive = StrategyCapitalAllocator(
        max_weight=0.9,
        min_weight=0.0,
        capacity_haircut=0.0,
        utility_config=StrategyUtilityConfig(risk_aversion=1.0),
    )
    inputs = [
        StrategyBudgetInput(
            strategy_id="high_vol",
            expected_return=0.85,
            annual_vol=0.45,
            annual_turnover=2.0,
            cost_per_turnover=0.004,
            capacity_ratio=0.8,
        ),
        StrategyBudgetInput(
            strategy_id="low_vol",
            expected_return=0.24,
            annual_vol=0.15,
            annual_turnover=2.0,
            cost_per_turnover=0.004,
            capacity_ratio=0.8,
        ),
    ]

    conservative_w = conservative.allocate_utility(inputs)
    aggressive_w = aggressive.allocate_utility(inputs)

    assert conservative_w["low_vol"] > conservative_w["high_vol"]
    assert aggressive_w["high_vol"] > conservative_w["high_vol"]


def test_strategy_allocator_multi_horizon_respects_sleeves():
    allocator = StrategyCapitalAllocator(max_weight=0.95, min_weight=0.0, capacity_haircut=0.0)
    weights = allocator.allocate_multi_horizon(
        [
            StrategyBudgetInput(
                strategy_id="intraday_mm",
                expected_return=0.20,
                annual_vol=0.22,
                annual_turnover=4.0,
                cost_per_turnover=0.004,
                capacity_ratio=0.8,
                horizon="intraday",
            ),
            StrategyBudgetInput(
                strategy_id="swing_trend",
                expected_return=0.18,
                annual_vol=0.16,
                annual_turnover=1.8,
                cost_per_turnover=0.004,
                capacity_ratio=0.7,
                horizon="swing",
            ),
            StrategyBudgetInput(
                strategy_id="hold_carry",
                expected_return=0.12,
                annual_vol=0.10,
                annual_turnover=0.7,
                cost_per_turnover=0.004,
                capacity_ratio=0.6,
                horizon="hold",
            ),
        ],
        sleeve_budgets={"intraday": 0.20, "swing": 0.30, "hold": 0.50},
    )

    assert abs(sum(weights.values()) - 1.0) < 1e-9
    assert abs(weights["intraday_mm"] - 0.20) < 1e-6
    assert abs(weights["swing_trend"] - 0.30) < 1e-6
    assert abs(weights["hold_carry"] - 0.50) < 1e-6


def test_strategy_allocator_constrained_enforces_corr_market_and_borrow_limits():
    allocator = StrategyCapitalAllocator(max_weight=0.9, min_weight=0.0, capacity_haircut=0.0)
    rows = [
        StrategyBudgetInput(
            strategy_id="crypto_mm",
            expected_return=0.30,
            annual_vol=0.24,
            annual_turnover=5.0,
            cost_per_turnover=0.004,
            capacity_ratio=0.8,
            market="crypto",
            short_exposure_ratio=0.10,
            borrow_bps=8.0,
        ),
        StrategyBudgetInput(
            strategy_id="crypto_short",
            expected_return=0.32,
            annual_vol=0.26,
            annual_turnover=5.5,
            cost_per_turnover=0.004,
            capacity_ratio=0.8,
            market="crypto",
            short_exposure_ratio=0.40,
            borrow_bps=60.0,
        ),
        StrategyBudgetInput(
            strategy_id="equity_swing",
            expected_return=0.20,
            annual_vol=0.16,
            annual_turnover=2.0,
            cost_per_turnover=0.004,
            capacity_ratio=0.7,
            market="equities",
            short_exposure_ratio=0.0,
            borrow_bps=0.0,
        ),
    ]
    weights = allocator.allocate_constrained(
        rows,
        correlation_matrix={("crypto_mm", "crypto_short"): 0.95},
        max_pair_correlation=0.80,
        market_caps={"crypto": 0.55, "equities": 0.60},
        max_total_short_exposure=0.18,
        max_weighted_borrow_bps=20.0,
    )

    assert abs(sum(weights.values()) - 1.0) < 1e-9
    assert weights["crypto_mm"] + weights["crypto_short"] <= 0.56
    short_exposure = (
        weights["crypto_mm"] * 0.10 + weights["crypto_short"] * 0.40 + weights["equity_swing"] * 0.0
    )
    assert short_exposure <= 0.1801
    weighted_borrow = (
        weights["crypto_mm"] * 8.0 + weights["crypto_short"] * 60.0 + weights["equity_swing"] * 0.0
    )
    assert weighted_borrow <= 20.1


def test_strategy_allocator_enterprise_enforces_risk_budget_and_drawdown():
    allocator = StrategyCapitalAllocator(max_weight=0.95, min_weight=0.0, capacity_haircut=0.0)
    rows = [
        StrategyBudgetInput(
            strategy_id="low_dd",
            expected_return=0.25,
            annual_vol=0.2,
            annual_turnover=3.0,
            cost_per_turnover=0.004,
            capacity_ratio=0.8,
            risk_budget_pct=0.8,
            drawdown_pct=0.10,
        ),
        StrategyBudgetInput(
            strategy_id="high_dd",
            expected_return=0.30,
            annual_vol=0.25,
            annual_turnover=3.0,
            cost_per_turnover=0.004,
            capacity_ratio=0.8,
            risk_budget_pct=0.5,
            drawdown_pct=0.40,
        ),
    ]
    weights = allocator.allocate_enterprise(
        rows,
        max_drawdown_pct=0.20,
    )

    assert abs(sum(weights.values()) - 1.0) < 1e-9
    assert weights["high_dd"] < weights["low_dd"]


def test_market_data_quality_monitor_flags_drift_and_missing_symbols():
    monitor = MarketDataQualityMonitor(
        min_completeness=0.95,
        max_drift_ms=50.0,
        min_feature_parity=0.99,
    )
    now = datetime(2026, 3, 1, tzinfo=timezone.utc)

    bad = monitor.assess(
        expected_symbols=10,
        observed_symbols=8,
        timestamps=[now - timedelta(milliseconds=120)],
        backtest_features={"x": 1.0},
        live_features={"x": 0.99},
        now=now,
    )
    assert bad.passed is False

    good = monitor.assess(
        expected_symbols=10,
        observed_symbols=10,
        timestamps=[now - timedelta(milliseconds=5)],
        backtest_features={"x": 1.0, "y": 2.0},
        live_features={"x": 1.0, "y": 2.0},
        now=now,
    )
    assert good.passed is True


def test_inventory_transfer_recommends_deleveraging_near_limits():
    engine = InventoryRiskTransferEngine(threshold_ratio=0.8, target_ratio=0.3, hedge_ratio=1.0)
    transfer = engine.suggest_transfer(
        symbol="BTCUSDT",
        inventory=9.0,
        max_position=10.0,
        mid_price=100.0,
    )

    assert transfer is not None
    assert transfer.side == "sell"
    assert transfer.quantity == 6.0
    assert transfer.expected_notional == 600.0


def test_router_regime_overlay_and_execution_feedback_are_logged(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "regime_overlay": {
                "extreme_spread": 0.002,
                "crisis_multiplier": 0.1,
            },
        },
        tca_db_path=str(tmp_path / "router_controls.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=5.0,
        order_type=OrderType.LIMIT,
        price=50000.0,
    )
    market_data = {
        "binance": {
            "BTC-USD": {
                "price": 50000.0,
                "spread": 0.003,
                "volume_24h": 2_000_000,
            }
        },
        "order_book": {
            "bids": [(49990.0, 2.0), (49980.0, 4.0)],
            "asks": [(50010.0, 1.5), (50020.0, 3.0)],
        },
    }
    strategy_returns, portfolio_changes = _strategy_inputs()

    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is True
    assert result.audit_log["regime_overlay"]["regime"] == "crisis"
    assert result.audit_log["regime_overlay"]["approved_quantity"] == 0.5
    assert result.audit_log["execution_quality"]["fill_ratio"] == 1.0
    assert result.exchange in router.smart_router.venue_quality


def test_router_failover_switches_away_from_degraded_primary(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        tca_db_path=str(tmp_path / "router_failover.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

    for _ in range(30):
        router.reliability_monitor.record(
            venue="binance",
            latency_ms=1000.0,
            rejected=True,
            failed=True,
        )
        router.reliability_monitor.record(
            venue="coinbase",
            latency_ms=10.0,
            rejected=False,
            failed=False,
        )

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.5,
        order_type=OrderType.LIMIT,
        price=50000.0,
    )
    market_data = {
        "binance": {
            "BTC-USD": {
                "price": 50000.0,
                "spread": 0.0001,
                "volume_24h": 2_500_000,
            }
        },
        "coinbase": {
            "BTC-USD": {
                "price": 50000.0,
                "spread": 0.00015,
                "volume_24h": 2_000_000,
            }
        },
        "order_book": {
            "bids": [(49990.0, 2.0), (49980.0, 4.0)],
            "asks": [(50010.0, 1.5), (50020.0, 3.0)],
        },
    }
    strategy_returns, portfolio_changes = _strategy_inputs()

    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is True
    assert result.exchange == "coinbase"
    assert result.audit_log.get("routing_failover", {}).get("from_exchange") == "binance"
    assert result.audit_log.get("routing_failover", {}).get("to_exchange") == "coinbase"


def test_router_capacity_curve_blocks_negative_expected_edge(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "capacity_curves": {
                "enabled": True,
                "storage_path": str(tmp_path / "capacity_samples.jsonl"),
                "min_points": 5,
            },
        },
        tca_db_path=str(tmp_path / "router_capacity.csv"),
    )
    router.set_capital(100000.0, source="unit_test")
    strategy_returns, portfolio_changes = _strategy_inputs()
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
    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.2,
        order_type=OrderType.LIMIT,
        price=50000.0,
        strategy_id="mm_blocked",
        expected_alpha_bps=0.0,
    )

    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is False
    assert "CAPACITY_CURVE_BLOCK" in str(result.rejected_reason)


def test_router_tca_records_strategy_and_expected_alpha(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True, "capacity_curves": {"enabled": True}},
        tca_db_path=str(tmp_path / "router_strategy_tca.csv"),
    )
    router.set_capital(100000.0, source="unit_test")
    strategy_returns, portfolio_changes = _strategy_inputs()
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
    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.1,
        order_type=OrderType.LIMIT,
        price=50000.0,
        strategy_id="mm_live",
        expected_alpha_bps=25.0,
    )
    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is True
    assert router.tca_db.records
    latest = router.tca_db.records[-1]
    assert latest.strategy_id == "mm_live"
    assert latest.expected_alpha_bps == 25.0


def test_router_rejects_short_without_locate(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "shorting_controls": {
                "enabled": True,
                "require_locate": True,
                "locates": {"coinbase|BTC-USD": False},
            },
        },
        tca_db_path=str(tmp_path / "router_short_reject.csv"),
    )
    router.set_capital(100000.0, source="unit_test")
    strategy_returns, portfolio_changes = _strategy_inputs()
    market_data = {
        "coinbase": {
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
    order = OrderRequest(
        symbol="BTC-USD",
        side="sell",
        quantity=0.1,
        order_type=OrderType.LIMIT,
        price=50000.0,
        strategy_id="short_no_locate",
    )

    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is False
    assert "SHORTING_CONTROL: no_locate" in str(result.rejected_reason)
    assert result.audit_log["shorting_overlay"]["approved"] is False


def test_router_allows_short_when_locate_borrow_and_squeeze_pass(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "shorting_controls": {
                "enabled": True,
                "max_borrow_bps": 30.0,
                "max_short_exposure_pct": 0.30,
                "borrow_bps": {"binance|BTC-USD": 8.0},
                "locates": {"binance|BTC-USD": True},
                "recalls": {"binance|BTC-USD": False},
                "squeeze": {"binance|BTC-USD": 1.1},
            },
        },
        tca_db_path=str(tmp_path / "router_short_allow.csv"),
    )
    router.set_capital(100000.0, source="unit_test")
    strategy_returns, portfolio_changes = _strategy_inputs()
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
    order = OrderRequest(
        symbol="BTC-USD",
        side="sell",
        quantity=0.1,
        order_type=OrderType.LIMIT,
        price=50000.0,
        strategy_id="short_pass",
    )

    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is True
    assert result.audit_log["shorting_overlay"]["approved"] is True
    assert result.audit_log["shorting_overlay"]["reason"] == "approved"
