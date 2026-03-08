"""Deterministic tests for execution-model tuning enhancements."""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.engine import TradingEngine
from execution.paper_fill_model import MicrostructurePaperFillProvider, PaperFillModelConfig
from execution.risk_aware_router import RiskAwareRouter
from execution.smart_router import OrderRequest, OrderType, RouteDecision, SmartOrderRouter
from execution.tca_feedback import ExecutionFill
from risk.kill_switches import RiskLimits


def _strategy_inputs() -> tuple[dict, list[float]]:
    strategy_returns = {
        "s1": np.linspace(-0.01, 0.01, 30),
        "s2": np.cos(np.linspace(0.0, 2.0 * np.pi, 30)) * 0.005,
    }
    portfolio_changes = np.linspace(-50.0, 50.0, 30)
    return strategy_returns, list(portfolio_changes)


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


def test_paper_fill_provider_is_deterministic_with_partial_fills():
    provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            partial_fill_notional_usd=1000.0,
            min_partial_fill_ratio=0.5,
            hard_reject_notional_usd=20000.0,
        )
    )

    fill_1 = asyncio.run(
        provider.get_fill(
            order_id="ord_1",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=5000.0,
        )
    )
    fill_2 = asyncio.run(
        provider.get_fill(
            order_id="ord_1",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=5000.0,
        )
    )

    assert fill_1.executed_qty < 1.0
    assert fill_1.executed_qty == fill_2.executed_qty
    assert fill_1.executed_price == fill_2.executed_price


def test_paper_fill_provider_hard_rejects_extreme_notional():
    provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            hard_reject_notional_usd=1000.0,
        )
    )

    fill = asyncio.run(
        provider.get_fill(
            order_id="ord_reject",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=5000.0,
        )
    )

    assert fill.executed_qty == 0.0


def test_paper_fill_provider_applies_queue_position_penalty():
    provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            partial_fill_notional_usd=1000.0,
            min_partial_fill_ratio=0.10,
            queue_penalty_floor=0.10,
            adverse_selection_bps=8.0,
            min_slippage_bps=0.1,
            queue_slippage_bps_per_turnover=0.5,
        )
    )

    low_queue = asyncio.run(
        provider.get_fill(
            order_id="ord_queue",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=1000.0,
            queue_ahead_qty=0.0,
        )
    )
    high_queue = asyncio.run(
        provider.get_fill(
            order_id="ord_queue",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=1000.0,
            queue_ahead_qty=10.0,
        )
    )

    assert high_queue.executed_qty < low_queue.executed_qty
    assert high_queue.executed_price > low_queue.executed_price


def test_paper_fill_provider_small_order_faces_less_queue_slippage():
    provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            partial_fill_notional_usd=1000.0,
            min_partial_fill_ratio=0.10,
            queue_penalty_floor=0.10,
            queue_slippage_bps_per_turnover=0.50,
            adverse_selection_bps=8.0,
            min_slippage_bps=1.0,
            reality_stress_mode=False,
        )
    )

    small = asyncio.run(
        provider.get_fill(
            order_id="ord_small_vs_large",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=0.1,
            reference_price=1000.0,
            queue_ahead_qty=10.0,
        )
    )
    large = asyncio.run(
        provider.get_fill(
            order_id="ord_small_vs_large",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=1000.0,
            queue_ahead_qty=10.0,
        )
    )

    small_slip_bps = ((small.executed_price / 1000.0) - 1.0) * 10000.0
    large_slip_bps = ((large.executed_price / 1000.0) - 1.0) * 10000.0
    assert small_slip_bps < large_slip_bps


def test_paper_fill_provider_expected_slippage_estimator_scales_with_stress():
    baseline_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            adverse_selection_bps=4.0,
            min_slippage_bps=0.5,
            reality_stress_mode=False,
        )
    )
    stress_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            adverse_selection_bps=4.0,
            min_slippage_bps=0.5,
            reality_stress_mode=True,
            stress_slippage_multiplier=2.0,
        )
    )

    baseline_bps = baseline_provider.estimate_expected_slippage_bps(
        symbol="BTC-USD",
        venue="binance",
        side="buy",
        requested_qty=0.2,
        reference_price=50000.0,
        queue_ahead_qty=0.0,
    )
    stress_bps = stress_provider.estimate_expected_slippage_bps(
        symbol="BTC-USD",
        venue="binance",
        side="buy",
        requested_qty=0.2,
        reference_price=50000.0,
        queue_ahead_qty=0.0,
    )

    assert baseline_bps > 0.0
    assert stress_bps == pytest.approx(baseline_bps * 2.0)


def test_router_blends_predicted_slippage_with_paper_estimator(tmp_path):
    class _BlendedFillProvider:
        async def get_fill(
            self,
            *,
            order_id,
            symbol,
            venue,
            side,
            requested_qty,
            reference_price,
            order_book=None,
            queue_ahead_qty=None,
        ):
            _ = (order_id, symbol, venue, side, order_book, queue_ahead_qty)
            return ExecutionFill(
                executed_price=float(reference_price),
                executed_qty=float(requested_qty),
                timestamp=datetime.now(timezone.utc),
                venue=str(venue),
                symbol=str(symbol),
            )

        def estimate_expected_slippage_bps(self, **kwargs):
            _ = kwargs
            return 9.0

    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "paper_prediction_blend": 1.0,
        },
        fill_provider=_BlendedFillProvider(),
        tca_db_path=str(tmp_path / "blend.csv"),
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
            "BTC-USD": {"price": 50000.0, "spread": 0.0002, "volume_24h": 2_000_000}
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

    assert result.success
    tca_payload = result.audit_log.get("tca", {})
    assert tca_payload["predicted_slippage_bps"] == pytest.approx(9.0)


def test_router_rejects_order_when_fill_provider_returns_no_fill(tmp_path):
    fill_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(hard_reject_notional_usd=100.0)
    )
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        fill_provider=fill_provider,
        tca_db_path=str(tmp_path / "no_fill.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=1.0,
        order_type=OrderType.LIMIT,
        price=500.0,
    )
    market_data = {
        "binance": {
            "BTC-USD": {
                "price": 500.0,
                "spread": 0.0002,
                "volume_24h": 2_000_000,
            }
        },
        "order_book": {
            "bids": [(499.9, 20.0), (499.8, 40.0)],
            "asks": [(500.1, 15.0), (500.2, 30.0)],
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

    assert result.success is False
    assert "NO_FILL" in (result.rejected_reason or "")


def test_router_cost_model_uses_broker_maker_fee_bps(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "default_maker_fee_bps": 2.5,
        },
        tca_db_path=str(tmp_path / "maker_fee_cost_model.csv"),
    )
    assert router.cost_model.commission == pytest.approx(0.00025)


def test_router_passes_queue_context_to_fill_provider(tmp_path):
    class _CaptureQueueFillProvider:
        def __init__(self):
            self.queue_ahead_qty = None
            self.order_book = None

        async def get_fill(
            self,
            *,
            order_id,
            symbol,
            venue,
            side,
            requested_qty,
            reference_price,
            order_book=None,
            queue_ahead_qty=None,
        ):
            self.queue_ahead_qty = queue_ahead_qty
            self.order_book = order_book
            return ExecutionFill(
                executed_price=float(reference_price),
                executed_qty=float(requested_qty),
                timestamp=datetime.now(timezone.utc),
                venue=venue,
                symbol=symbol,
            )

    fill_provider = _CaptureQueueFillProvider()
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        fill_provider=fill_provider,
        tca_db_path=str(tmp_path / "queue_capture.csv"),
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
            "bids": [(49990.0, 2.25), (49980.0, 4.0)],
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
    assert fill_provider.order_book == market_data["order_book"]
    assert fill_provider.queue_ahead_qty == pytest.approx(2.25)


def test_router_blocks_degraded_venue_when_no_failover(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        tca_db_path=str(tmp_path / "degraded.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

    for _ in range(30):
        router.reliability_monitor.record(
            venue="binance",
            latency_ms=1000.0,
            rejected=True,
            failed=True,
        )

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.2,
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

    assert result.success is False
    assert "DEGRADED_VENUE_NO_FAILOVER" in (result.rejected_reason or "")


def test_router_can_disable_failover_switch(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "reliability": {"enable_failover": False},
        },
        tca_db_path=str(tmp_path / "failover_disabled.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

    async def _forced_route(*_args, **_kwargs):
        return RouteDecision(
            exchange="binance",
            order_type=OrderType.LIMIT,
            price=50000.0,
            split_orders=[],
            expected_cost=1.0,
            expected_slippage=1.0,
            ranked_exchanges=["binance", "coinbase"],
        )

    router.smart_router.route_order = _forced_route  # type: ignore[assignment]

    for _ in range(30):
        router.reliability_monitor.record(
            venue="binance",
            latency_ms=1000.0,
            rejected=True,
            failed=True,
        )
        router.reliability_monitor.record(
            venue="coinbase",
            latency_ms=25.0,
            rejected=False,
            failed=False,
        )

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.2,
        order_type=OrderType.LIMIT,
        price=50000.0,
    )
    market_data = {
        "binance": {"BTC-USD": {"price": 50000.0, "spread": 0.0002, "volume_24h": 2_000_000}},
        "coinbase": {"BTC-USD": {"price": 50001.0, "spread": 0.0003, "volume_24h": 2_000_000}},
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

    assert result.success is False
    assert "DEGRADED_VENUE_NO_FAILOVER" in (result.rejected_reason or "")


def test_router_can_disable_tca_calibration_feedback(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={
            "enabled": True,
            "tca_calibration": {"enabled": False},
        },
        tca_db_path=str(tmp_path / "no_calibration.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

    updated, analyses = router.run_weekly_tca_calibration(
        eta_by_symbol_venue={("BTC-USD", "binance"): 0.5},
        min_samples=2,
        alert_threshold_pct=10.0,
        lookback_days=7,
    )

    assert updated == {("BTC-USD", "binance"): 0.5}
    assert analyses[0]["status"] == "disabled"
    assert analyses[0]["reason"] == "tca_calibration_feedback_disabled"


def test_smart_router_tracks_monthly_volume_and_slippage_guard():
    router = SmartOrderRouter(
        {
            "enabled": True,
            "slippage_guard_ratio": 1.5,
            "monthly_volume_by_venue": {"binance": 1000.0},
        }
    )
    router.venue_quality["binance"] = {
        "slippage_ratio": 2.0,
        "fill_ratio": 1.0,
        "latency_ms": 20.0,
    }

    request = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.1,
        order_type=OrderType.MARKET,
        price=None,
        time_in_force="GTC",
    )
    decision = asyncio.run(
        router.route_order(
            request,
            {
                "binance": {
                    "BTC-USD": {
                        "price": 50000.0,
                        "spread": 0.0002,
                        "volume_24h": 1_500_000,
                    }
                }
            },
        )
    )

    assert decision.order_type == OrderType.LIMIT

    router.record_executed_notional(
        "binance", 500.0, timestamp=datetime(2026, 3, 5, tzinfo=timezone.utc)
    )
    assert router.get_monthly_volume("binance") == 1500.0

    router.record_executed_notional(
        "binance", 200.0, timestamp=datetime(2026, 4, 1, tzinfo=timezone.utc)
    )
    assert router.get_monthly_volume("binance") == 1200.0


def test_engine_builds_microstructure_paper_fill_provider(tmp_path):
    config = {
        "mode": "paper_trading",
        "markets": {
            "crypto": {"enabled": True, "exchanges": [{"name": "binance", "symbols": ["BTC-USD"]}]}
        },
        "risk": {
            "initial_capital": 100000.0,
            "max_portfolio_risk_pct": 2.0,
            "max_drawdown_pct": 10.0,
            "max_leverage": 3.0,
        },
        "execution": {
            "paper_fill_model": {
                "enabled": True,
                "partial_fill_notional_usd": 1000.0,
                "hard_reject_notional_usd": 50000.0,
            }
        },
    }
    config_path = tmp_path / "engine_config.yaml"
    config_path.write_text(yaml.safe_dump(config), encoding="utf-8")

    engine = TradingEngine(str(config_path))
    router = engine._build_router()

    assert isinstance(router.fill_provider, MicrostructurePaperFillProvider)


def test_paper_fill_reality_stress_mode_applies_higher_slippage_and_lower_fill():
    baseline_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            partial_fill_notional_usd=10_000.0,
            hard_reject_notional_usd=100_000.0,
            reality_stress_mode=False,
        )
    )
    stress_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            partial_fill_notional_usd=10_000.0,
            hard_reject_notional_usd=100_000.0,
            reality_stress_mode=True,
            stress_slippage_multiplier=2.5,
            stress_fill_ratio_multiplier=0.70,
        )
    )

    baseline_fill = asyncio.run(
        baseline_provider.get_fill(
            order_id="stress_cmp",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=5000.0,
        )
    )
    stress_fill = asyncio.run(
        stress_provider.get_fill(
            order_id="stress_cmp",
            symbol="BTC-USD",
            venue="binance",
            side="buy",
            requested_qty=1.0,
            reference_price=5000.0,
        )
    )

    baseline_slip_bps = ((baseline_fill.executed_price / 5000.0) - 1.0) * 10000.0
    stress_slip_bps = ((stress_fill.executed_price / 5000.0) - 1.0) * 10000.0

    assert stress_fill.executed_qty == pytest.approx(baseline_fill.executed_qty * 0.70)
    assert stress_slip_bps == pytest.approx(baseline_slip_bps * 2.5)


def test_paper_fill_stress_mode_reduces_risk_adjusted_execution_edge():
    baseline_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            partial_fill_notional_usd=2_000.0,
            hard_reject_notional_usd=100_000.0,
            adverse_selection_bps=6.0,
            reality_stress_mode=False,
        )
    )
    stress_provider = MicrostructurePaperFillProvider(
        config=PaperFillModelConfig(
            partial_fill_notional_usd=2_000.0,
            hard_reject_notional_usd=100_000.0,
            adverse_selection_bps=6.0,
            reality_stress_mode=True,
            stress_slippage_multiplier=2.5,
            stress_fill_ratio_multiplier=0.70,
        )
    )

    expected_alpha_bps = 20.0
    commission_bps = 1.0
    reference_price = 1_000.0
    requested_qty = 4.0  # Force partial fills for both providers.
    requested_notional = requested_qty * reference_price

    def _per_order_returns(provider: MicrostructurePaperFillProvider) -> np.ndarray:
        values = []
        for idx in range(80):
            side = "buy" if idx % 2 == 0 else "sell"
            fill = asyncio.run(
                provider.get_fill(
                    order_id=f"stress_edge_{idx}",
                    symbol="BTC-USD",
                    venue="binance",
                    side=side,
                    requested_qty=requested_qty,
                    reference_price=reference_price,
                )
            )
            executed_notional = fill.executed_qty * fill.executed_price
            if side == "buy":
                realized_slippage_bps = ((fill.executed_price / reference_price) - 1.0) * 10000.0
            else:
                realized_slippage_bps = (1.0 - (fill.executed_price / reference_price)) * 10000.0
            realized_total_bps = realized_slippage_bps + commission_bps
            expected_alpha_usd = executed_notional * expected_alpha_bps / 10000.0
            realized_cost_usd = executed_notional * realized_total_bps / 10000.0
            values.append((expected_alpha_usd - realized_cost_usd) / requested_notional)
        return np.asarray(values, dtype=float)

    baseline_returns = _per_order_returns(baseline_provider)
    stress_returns = _per_order_returns(stress_provider)

    def _sharpe(returns: np.ndarray) -> float:
        std = float(np.std(returns))
        if std <= 1e-12:
            return 0.0
        return float(np.mean(returns) / std * np.sqrt(252.0))

    assert float(np.mean(stress_returns)) < float(np.mean(baseline_returns))
    assert _sharpe(stress_returns) < _sharpe(baseline_returns)


def test_router_rejects_post_trade_position_limit_breach(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
            max_single_position_pct=0.20,
        ),
        broker_config={"enabled": True},
        tca_db_path=str(tmp_path / "position_limit.csv"),
    )
    router.set_capital(100000.0, source="unit_test")

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
                "spread": 0.0002,
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

    assert result.success is False
    assert "POSITION_LIMIT" in (result.rejected_reason or "")


def test_router_submit_order_serializes_concurrent_admissions(tmp_path):
    class BlockingFillProvider:
        def __init__(self):
            self.active = 0
            self.max_active = 0

        async def get_fill(
            self,
            *,
            order_id,
            symbol,
            venue,
            side,
            requested_qty,
            reference_price,
            order_book=None,
            queue_ahead_qty=None,
        ):
            _ = order_id, side, order_book, queue_ahead_qty
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            await asyncio.sleep(0.02)
            self.active -= 1
            return ExecutionFill(
                executed_price=float(reference_price),
                executed_qty=float(requested_qty),
                timestamp=datetime.now(timezone.utc),
                venue=venue,
                symbol=symbol,
            )

    fill_provider = BlockingFillProvider()
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        fill_provider=fill_provider,
        tca_db_path=str(tmp_path / "serialized_submit.csv"),
    )
    router.set_capital(100000.0, source="unit_test")
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
    strategy_returns, portfolio_changes = _strategy_inputs()

    async def submit_once(order_id_suffix: str):
        order = OrderRequest(
            symbol="BTC-USD",
            side="buy",
            quantity=0.1,
            order_type=OrderType.LIMIT,
            price=50000.0,
            time_in_force=f"GTC-{order_id_suffix}",
        )
        return await router.submit_order(
            order=order,
            market_data=market_data,
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )

    async def run_pair():
        return await asyncio.gather(submit_once("a"), submit_once("b"))

    first, second = asyncio.run(run_pair())
    assert first.success is True
    assert second.success is True
    assert fill_provider.max_active == 1


def test_router_rejects_when_emergency_state_already_active(tmp_path):
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.2,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
        tca_db_path=str(tmp_path / "emergency_gate.csv"),
    )
    router.set_capital(100000.0, source="unit_test")
    router.risk_engine.is_halted = True

    order = OrderRequest(
        symbol="BTC-USD",
        side="buy",
        quantity=0.1,
        order_type=OrderType.LIMIT,
        price=50000.0,
    )
    strategy_returns, portfolio_changes = _strategy_inputs()
    result = asyncio.run(
        router.submit_order(
            order=order,
            market_data={
                "last_price": 50000.0,
                "order_book": {
                    "bids": [(49990.0, 2.0)],
                    "asks": [(50010.0, 2.0)],
                },
            },
            portfolio=_portfolio_snapshot(),
            strategy_returns=strategy_returns,
            portfolio_changes=portfolio_changes,
        )
    )

    assert result.success is False
    assert result.decision.value == "halt"
    assert "HALT" in (result.rejected_reason or "")
