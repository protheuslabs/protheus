# Core Trading Engine
import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import yaml

from analytics.ops_observability import OpsEventStore
from core.autopilot import HumanStrategyOverride, StrategyAutopilot
from core.autopilot_policy import enforce_autopilot_policy, resolve_autopilot_policy_pack
from core.config_validation import validate_engine_config
from core.market_data_quality import DataQualityReport, MarketDataQualityMonitor
from core.mechanism_switches import apply_mechanism_switches
from core.multi_tenant import enforce_tenant_entitlements, resolve_tenant_entitlements
from core.operator_tier import resolve_operator_tier
from core.secret_manager import SecretResolutionMetadata, hydrate_config_secrets
from core.secrets_policy import enforce_live_secrets
from core.strategy_contracts import validate_strategy_contract
from core.toggle_manager import MarketStrategyToggleManager, ToggleValidationError
from execution.paper_fill_model import MicrostructurePaperFillProvider, PaperFillModelConfig
from execution.risk_aware_router import OrderResult, RiskAwareRouter
from execution.smart_router import OrderRequest as RouterOrderRequest, OrderType as RouterOrderType
from risk.kill_switches import RiskLimits as KillSwitchLimits
from risk.risk_tolerance import (
    RiskToleranceProfile,
    resolve_effective_risk_config,
    risk_profile_payload,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class MarketType(Enum):
    CRYPTO = "crypto"
    EQUITIES = "equities"
    FOREX = "forex"


class OrderSide(Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


@dataclass
class Order:
    id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: float
    price: Optional[float] = None
    stop_price: Optional[float] = None
    market: MarketType = MarketType.CRYPTO
    timestamp: datetime = field(default_factory=_utc_now)
    status: str = "pending"
    filled_quantity: float = 0.0
    avg_fill_price: float = 0.0


@dataclass
class Position:
    symbol: str
    quantity: float
    avg_entry_price: float
    market: MarketType
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0
    timestamp: datetime = field(default_factory=_utc_now)


@dataclass
class MarketData:
    symbol: str
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    market: MarketType
    bid: Optional[float] = None
    ask: Optional[float] = None


class TradingEngine:
    """Main trading execution engine"""

    def __init__(self, config_path: str):
        self.config, self.secret_resolution = self._load_config(config_path)
        self._validate_config()
        self.mode = self.config.get("mode", "paper_trading")
        self.toggle_manager = MarketStrategyToggleManager(self.config)
        runtime_cfg = self.config.get("runtime", {})
        self.tenant_entitlements = resolve_tenant_entitlements(self.config)
        self.operator_tier = resolve_operator_tier(self.config)
        self.autopilot = StrategyAutopilot(runtime_cfg.get("autopilot", {}))
        self.autopilot_policy = resolve_autopilot_policy_pack(
            self.config,
            tier_name=self.operator_tier.name,
        )
        self.autopilot_auto_apply_on_start = bool(
            runtime_cfg.get("autopilot", {}).get(
                "auto_apply_on_start",
                self.autopilot.mode != "manual",
            )
        )
        self.strict_strategy_contracts = bool(runtime_cfg.get("strict_strategy_contracts", True))
        self.last_autopilot_decision: Dict[str, Any] = {}
        self.ops_events = OpsEventStore(
            path=str(runtime_cfg.get("ops_events_path", "data/analytics/ops_events.jsonl")),
            database_url=str(runtime_cfg.get("ops_events_db", "")).strip(),
            telemetry_enabled=bool(runtime_cfg.get("telemetry_enabled", False)),
        )
        self.positions: Dict[str, Position] = {}
        self.orders: Dict[str, Order] = {}
        self.market_data: Dict[str, MarketData] = {}
        self.market_adapters: Dict[str, Dict[str, Any]] = {}
        self.strategy_configs: Dict[str, Dict[str, Any]] = {}
        self.active_strategy_names: List[str] = []
        self.strategies: List[Any] = []
        self.risk_manager = None
        self.portfolio_manager = None
        self.router: Optional[RiskAwareRouter] = None
        self.latest_router_snapshot: Dict[str, Any] = {}
        quality_cfg = self.config.get("analytics", {}).get("market_data_quality", {})
        self.market_data_quality_monitor = MarketDataQualityMonitor(
            min_completeness=float(quality_cfg.get("min_completeness", 0.99)),
            max_drift_ms=float(quality_cfg.get("max_drift_ms", 5000.0)),
            min_feature_parity=float(quality_cfg.get("min_feature_parity", 0.95)),
        )
        self.latest_data_quality_report: Optional[DataQualityReport] = None
        self._portfolio_change_history: List[float] = [0.0] * 30
        self._risk_profile_override: Optional[str] = None
        self.state_path = Path(runtime_cfg.get("state_path", "data/engine_state.json"))
        self.state_version = 1
        self.running = False
        self._load_persisted_state()

        logger.info(f"TradingEngine initialized in {self.mode} mode")
        logger.info("Toggle state: %s", self.toggle_manager.snapshot())
        _, profile = self._effective_risk_config()
        logger.info("Risk tolerance profile: %s", profile.name)
        logger.info(
            "Secret resolution: backend=%s resolved=%s/%s unresolved=%s",
            self.secret_resolution.backend,
            self.secret_resolution.placeholders_resolved,
            self.secret_resolution.placeholders_total,
            self.secret_resolution.unresolved_keys,
        )
        logger.info(
            "Tenant entitlements: id=%s plan=%s",
            self.tenant_entitlements.tenant_id,
            self.tenant_entitlements.plan,
        )

    def _load_config(self, path: str) -> tuple[dict, SecretResolutionMetadata]:
        with open(path, "r", encoding="utf-8") as f:
            payload = yaml.safe_load(f) or {}
        hydrated, metadata = hydrate_config_secrets(payload)
        switched, _state = apply_mechanism_switches(hydrated)
        return switched, metadata

    def _validate_config(self) -> None:
        issues = validate_engine_config(self.config)
        errors = [issue for issue in issues if str(issue.severity).lower() == "error"]
        warnings = [issue for issue in issues if str(issue.severity).lower() != "error"]
        if errors:
            messages = "; ".join(f"{issue.key}: {issue.message}" for issue in errors)
            raise ValueError(f"Engine config validation failed: {messages}")
        for issue in warnings:
            logger.warning("Engine config warning [%s]: %s", issue.key, issue.message)
        enforce_live_secrets(self.config)

    async def start(self):
        """Start the trading engine"""
        logger.info("Starting trading engine...")
        if (
            self.mode in {"live", "live_trading"}
            and not self.tenant_entitlements.allow_live_trading
        ):
            raise RuntimeError(
                f"Tenant plan '{self.tenant_entitlements.plan}' does not permit live trading."
            )
        self.running = True

        # Initialize market adapters
        await self._init_markets()

        # Initialize risk manager
        await self._init_risk_manager()

        if self.autopilot_auto_apply_on_start:
            self.apply_autopilot_strategy_selection()

        # Initialize strategies
        await self._init_strategies()

        # Start main loop
        await self._main_loop()

    async def _init_markets(self):
        """Initialize router-owned market adapters."""
        if self.router is None:
            self.router = self._build_router()

        self.router.configure_market_adapters(self.config.get("markets", {}))
        await self.router.start_market_data()
        self.market_adapters = self.router.get_market_registry()
        logger.info(
            "Initialized %s market venues through RiskAwareRouter", len(self.market_adapters)
        )

    def _build_router(self) -> RiskAwareRouter:
        risk_limits = self._build_router_risk_limits()
        broker_config = self._build_router_broker_config()
        fill_provider = self._build_fill_provider()
        router = RiskAwareRouter(
            risk_config=risk_limits,
            broker_config=broker_config,
            fill_provider=fill_provider,
        )
        risk_cfg, _profile = self._effective_risk_config()
        initial_capital = risk_cfg.get("initial_capital")
        if initial_capital is None:
            raise ValueError(
                "risk.initial_capital must be set in config. Capital injection is required."
            )
        router.set_capital(float(initial_capital), source="engine_config")
        return router

    def _build_fill_provider(self):
        if self.config.get("mode") == "live_trading":
            return None

        execution_cfg = self.config.get("execution", {})
        paper_cfg = execution_cfg.get("paper_fill_model", {})
        if not bool(paper_cfg.get("enabled", True)):
            return None

        model_cfg = PaperFillModelConfig(
            base_latency_ms=float(paper_cfg.get("base_latency_ms", 35.0)),
            latency_jitter_ms=float(paper_cfg.get("latency_jitter_ms", 45.0)),
            partial_fill_notional_usd=float(paper_cfg.get("partial_fill_notional_usd", 25000.0)),
            min_partial_fill_ratio=float(paper_cfg.get("min_partial_fill_ratio", 0.55)),
            adverse_selection_bps=float(paper_cfg.get("adverse_selection_bps", 8.0)),
            min_slippage_bps=float(paper_cfg.get("min_slippage_bps", 1.0)),
            reality_stress_mode=bool(paper_cfg.get("reality_stress_mode", False)),
            stress_slippage_multiplier=float(paper_cfg.get("stress_slippage_multiplier", 2.5)),
            stress_fill_ratio_multiplier=float(paper_cfg.get("stress_fill_ratio_multiplier", 0.70)),
            hard_reject_notional_usd=float(paper_cfg.get("hard_reject_notional_usd", 250000.0)),
        )
        return MicrostructurePaperFillProvider(config=model_cfg)

    @staticmethod
    def _pct(value: float, default: float) -> float:
        if value is None:
            return default
        value = float(value)
        return value / 100.0 if value > 1.0 else value

    def _build_router_risk_limits(self) -> KillSwitchLimits:
        risk_cfg, _profile = self._effective_risk_config()
        return KillSwitchLimits(
            max_daily_loss_pct=self._pct(
                risk_cfg.get("max_daily_loss_pct", risk_cfg.get("max_portfolio_risk_pct", 2.0)),
                0.02,
            ),
            max_drawdown_pct=self._pct(risk_cfg.get("max_drawdown_pct", 0.15), 0.15),
            max_gross_leverage=float(risk_cfg.get("max_leverage", 2.0)),
            max_order_notional=float(risk_cfg.get("max_order_notional", 50000)),
            max_participation=self._pct(risk_cfg.get("max_participation", 0.05), 0.05),
            max_slippage_bps=float(risk_cfg.get("max_slippage_bps", 50)),
        )

    def _build_router_broker_config(self) -> Dict[str, Any]:
        risk_cfg, _profile = self._effective_risk_config()
        execution_cfg = self.config.get("execution", {})
        broker_config = {
            "enabled": True,
            "live_execution": bool(self.config.get("mode") == "live_trading"),
            "max_symbol_notional": risk_cfg.get("max_symbol_notional", {}),
            "max_venue_notional": risk_cfg.get("max_venue_notional", {}),
            "tca_db_path": self.config.get("analytics", {}).get(
                "tca_db_path", "data/tca_records.csv"
            ),
            "exchanges": {},
            "max_single_order_size": execution_cfg.get("max_single_order_size", 1.0),
            "twap_interval_seconds": execution_cfg.get("twap_interval_seconds", 60),
            "prefer_maker": execution_cfg.get("prefer_maker", True),
            "default_monthly_volume_usd": execution_cfg.get("default_monthly_volume_usd", 0.0),
            "monthly_volume_by_venue": execution_cfg.get("monthly_volume_by_venue", {}),
            "fee_tiers": execution_cfg.get("fee_tiers", {}),
            "default_maker_fee_bps": execution_cfg.get("default_maker_fee_bps", 10.0),
            "default_taker_fee_bps": execution_cfg.get("default_taker_fee_bps", 12.0),
            "reliability": execution_cfg.get("reliability", {}),
            "regime_overlay": execution_cfg.get("regime_overlay", {}),
            "capacity_curves": execution_cfg.get("capacity_curves", {}),
            "expected_alpha_bps_by_strategy": execution_cfg.get(
                "expected_alpha_bps_by_strategy",
                {},
            ),
            "profitability_gate": execution_cfg.get("profitability_gate", {}),
            "require_live_client_order_id": execution_cfg.get(
                "require_live_client_order_id",
                True,
            ),
            "idempotency_ttl_seconds": execution_cfg.get("idempotency_ttl_seconds", 300.0),
            "distributed_ops_state": execution_cfg.get("distributed_ops_state", {}),
            "rate_limits": execution_cfg.get("rate_limits", {}),
            "strategy_disable_list_path": execution_cfg.get(
                "strategy_disable_list_path",
                "data/analytics/strategy_disable_list.json",
            ),
            "strategy_disable_reload_seconds": execution_cfg.get(
                "strategy_disable_reload_seconds",
                30.0,
            ),
            "allocation_controls": execution_cfg.get("allocation_controls", {}),
            "market_data_resilience": execution_cfg.get("market_data_resilience", {}),
            "tca_calibration": execution_cfg.get("tca_calibration", {}),
            "confidence_allocator": execution_cfg.get("confidence_allocator", {}),
            "maker_urgency_ladder": execution_cfg.get("maker_urgency_ladder", {}),
            "paper_prediction_blend": execution_cfg.get("paper_prediction_blend", 1.0),
            "risk_profile": risk_profile_payload(_profile),
            "tenant_plan": self.tenant_entitlements.plan,
            "tenant_id": self.tenant_entitlements.tenant_id,
        }
        return broker_config

    async def _init_risk_manager(self):
        """Initialize risk management"""
        from .risk_manager import RiskManager

        risk_cfg, _profile = self._effective_risk_config()
        self.risk_manager = RiskManager(risk_cfg)
        logger.info("Risk manager initialized")

    def _effective_risk_config(self) -> tuple[Dict[str, Any], RiskToleranceProfile]:
        return resolve_effective_risk_config(
            self.config,
            override_profile=self._risk_profile_override,
        )

    async def _init_strategies(self):
        """Initialize trading strategies"""
        self.strategy_configs.clear()
        active_markets = set(self.toggle_manager.get_active_markets())
        active_strategies = set(self.toggle_manager.get_active_strategies())
        strategy_targets = {
            target.strategy: set(target.markets)
            for target in self.toggle_manager.get_strategy_targets()
        }

        for strategy_name in sorted(active_strategies):
            strategy_cfg = self.toggle_manager.get_strategy_config(strategy_name)
            contract = validate_strategy_contract(
                strategy_name,
                strategy_cfg,
                known_markets=tuple(self.toggle_manager.list_markets()),
            )
            if not contract.valid:
                if self.strict_strategy_contracts:
                    raise ValueError(
                        f"Strategy contract failed for {strategy_name}: {contract.violations}"
                    )
                logger.warning(
                    "Strategy skipped due to contract failure (%s): %s",
                    strategy_name,
                    contract.violations,
                )
                continue
            target_markets = strategy_targets.get(strategy_name, set())
            enabled_markets = sorted(target_markets.intersection(active_markets))
            if not enabled_markets:
                logger.warning(
                    "Strategy disabled at runtime (no active markets): %s",
                    strategy_name,
                )
                continue
            strategy_cfg["enabled_markets"] = enabled_markets
            strategy_cfg["contract_violations"] = list(contract.violations)
            self.strategy_configs[strategy_name] = strategy_cfg
            logger.info(
                "Strategy enabled: %s (markets=%s)",
                strategy_name,
                enabled_markets,
            )

        self.active_strategy_names = sorted(self.strategy_configs.keys())

    async def _main_loop(self):
        """Main trading loop"""
        while self.running:
            try:
                # Update market data
                await self._update_market_data()

                # Run strategies
                await self._run_strategies()

                # Check risk limits
                await self._check_risk_limits()

                # Sleep for tick interval
                await asyncio.sleep(1)

            except Exception as e:
                logger.error(f"Error in main loop: {e}")
                await asyncio.sleep(5)

    async def _update_market_data(self):
        """Fetch latest market data"""
        if self.router is None:
            return

        snapshot = await self.router.fetch_market_snapshot()
        self.latest_router_snapshot = snapshot
        now = _utc_now()
        updated: Dict[str, MarketData] = {}

        for venue_name, venue_quotes in snapshot.items():
            if venue_name in {"order_book", "last_price", "vol_24h"}:
                continue
            if not isinstance(venue_quotes, dict):
                continue
            market_name = self.market_adapters.get(venue_name, {}).get("market", "crypto")
            market_type = MarketType(market_name)
            for symbol, quote in venue_quotes.items():
                price = float(quote.get("price", 0.0))
                spread = float(quote.get("spread", 0.0))
                bid = price * (1 - spread / 2) if price else None
                ask = price * (1 + spread / 2) if price else None
                updated[symbol] = MarketData(
                    symbol=symbol,
                    timestamp=now,
                    open=price,
                    high=price,
                    low=price,
                    close=price,
                    volume=float(quote.get("volume_24h", 0.0)),
                    market=market_type,
                    bid=bid,
                    ask=ask,
                )

        expected_symbols = 0
        for venue in self.market_adapters.values():
            expected_symbols += len(venue.get("symbols", []))
        expected_symbols = max(expected_symbols, len(updated))

        timestamps = [row.timestamp for row in updated.values()]
        report = self.market_data_quality_monitor.assess(
            expected_symbols=expected_symbols,
            observed_symbols=len(updated),
            timestamps=timestamps,
            backtest_features={},
            live_features={},
        )
        self.latest_data_quality_report = report

        if report.passed:
            self.market_data = updated
        else:
            logger.warning(
                "Market data quality gate failed: completeness=%.3f drift_ms=%.1f parity=%.3f",
                report.completeness,
                report.max_timestamp_drift_ms,
                report.feature_parity,
            )

    async def _run_strategies(self):
        """Execute trading strategies"""
        for strategy in self.strategies:
            try:
                strategy_name = getattr(strategy, "name", strategy.__class__.__name__.lower())
                if strategy_name not in self.active_strategy_names:
                    continue
                signals = await strategy.generate_signals(self.market_data)
                for signal in signals:
                    await self._process_signal(signal)
            except Exception as e:
                logger.error(f"Strategy error: {e}")

    async def _process_signal(self, signal: dict):
        """Process trading signal"""
        market_name = signal.get("market", "crypto")
        try:
            normalized_market = self.toggle_manager.resolve_market(market_name)
        except ToggleValidationError:
            logger.warning("Signal rejected: unknown market '%s'", market_name)
            return

        if not self.toggle_manager.is_market_enabled(normalized_market):
            logger.info("Signal skipped: market disabled (%s)", normalized_market)
            return

        # Check risk limits
        if not await self.risk_manager.check_signal(signal):
            return

        # Create order
        order = Order(
            id=self._generate_order_id(),
            symbol=signal["symbol"],
            side=OrderSide(signal["side"]),
            order_type=OrderType(signal.get("order_type", "market")),
            quantity=signal["quantity"],
            price=signal.get("price"),
            market=MarketType(normalized_market),
        )

        # Enqueue order for router submission
        await self._enqueue_order(order)

    async def _enqueue_order(self, order: Order):
        """Queue order for risk-aware routing."""
        logger.info(f"Submitting order: {order}")
        self.orders[order.id] = order
        if self.router is None:
            raise RuntimeError("RiskAwareRouter is not initialized")

        router_order = RouterOrderRequest(
            symbol=order.symbol,
            side=order.side.value,
            quantity=float(order.quantity),
            order_type=self._to_router_order_type(order.order_type),
            price=order.price,
            stop_price=order.stop_price,
        )
        market_snapshot = self.latest_router_snapshot or await self.router.fetch_market_snapshot()
        result = await self.router.submit_order(
            order=router_order,
            market_data=market_snapshot,
            portfolio=self._build_portfolio_snapshot(),
            strategy_returns=self._build_strategy_returns(),
            portfolio_changes=list(self._portfolio_change_history[-30:]),
        )
        self._apply_order_result(order, result)

    def _to_router_order_type(self, order_type: OrderType) -> RouterOrderType:
        mapping = {
            OrderType.MARKET: RouterOrderType.MARKET,
            OrderType.LIMIT: RouterOrderType.LIMIT,
            OrderType.STOP: RouterOrderType.STOP_LIMIT,
            OrderType.STOP_LIMIT: RouterOrderType.STOP_LIMIT,
        }
        return mapping.get(order_type, RouterOrderType.MARKET)

    def _build_portfolio_snapshot(self) -> Dict[str, Any]:
        prices = {symbol: md.close for symbol, md in self.market_data.items()}
        gross_exposure = 0.0
        for symbol, position in self.positions.items():
            px = prices.get(symbol, position.avg_entry_price)
            gross_exposure += abs(position.quantity * px)
        capital = (
            self.router.get_capital()
            if self.router is not None
            else float(self._effective_risk_config()[0].get("initial_capital", 0.0))
        )
        leverage = gross_exposure / capital if capital > 0 else 0.0
        return {
            "positions": {symbol: pos.quantity for symbol, pos in self.positions.items()},
            "prices": prices,
            "total_pnl": sum(
                pos.realized_pnl + pos.unrealized_pnl for pos in self.positions.values()
            ),
            "unrealized_pnl": sum(pos.unrealized_pnl for pos in self.positions.values()),
            "realized_pnl": sum(pos.realized_pnl for pos in self.positions.values()),
            "gross_exposure": gross_exposure,
            "net_exposure": sum(
                pos.quantity * prices.get(symbol, pos.avg_entry_price)
                for symbol, pos in self.positions.items()
            ),
            "leverage": leverage,
            "open_orders": [
                {
                    "id": o.id,
                    "symbol": o.symbol,
                    "side": o.side.value,
                    "quantity": o.quantity,
                    "status": o.status,
                }
                for o in self.orders.values()
                if o.status in {"pending", "submitted"}
            ],
        }

    def _build_strategy_returns(self) -> Dict[str, np.ndarray]:
        # Placeholder strategy return vectors for router correlation checks.
        # Values are deterministic and replaced when strategy PnL tracking is wired.
        return {"engine_default": np.linspace(-0.001, 0.001, 30)}

    def _apply_order_result(self, order: Order, result: OrderResult) -> None:
        if result.success:
            order.status = "filled"
            fill = result.audit_log.get("fill", {})
            order.filled_quantity = float(fill.get("executed_qty", order.quantity))
            order.avg_fill_price = float(fill.get("executed_price", order.price or 0.0))
            self._update_position_from_fill(order)
            self._portfolio_change_history.append(0.0)
        else:
            order.status = "rejected"
            self._portfolio_change_history.append(0.0)
        if len(self._portfolio_change_history) > 1000:
            self._portfolio_change_history = self._portfolio_change_history[-1000:]
        self.orders[order.id] = order
        self._persist_state()

    def _update_position_from_fill(self, order: Order) -> None:
        signed_qty = (
            order.filled_quantity if order.side == OrderSide.BUY else -order.filled_quantity
        )
        existing = self.positions.get(order.symbol)
        if existing is None:
            self.positions[order.symbol] = Position(
                symbol=order.symbol,
                quantity=signed_qty,
                avg_entry_price=order.avg_fill_price,
                market=order.market,
            )
        else:
            new_qty = existing.quantity + signed_qty
            if abs(new_qty) < 1e-12:
                del self.positions[order.symbol]
            else:
                # Preserve average entry when reducing an existing position.
                if existing.quantity == 0 or np.sign(existing.quantity) != np.sign(new_qty):
                    new_avg_price = order.avg_fill_price
                elif np.sign(existing.quantity) == np.sign(signed_qty):
                    total_qty = abs(existing.quantity) + abs(signed_qty)
                    new_avg_price = (
                        (existing.avg_entry_price * abs(existing.quantity))
                        + (order.avg_fill_price * abs(signed_qty))
                    ) / total_qty
                else:
                    new_avg_price = existing.avg_entry_price

                existing.quantity = new_qty
                existing.avg_entry_price = float(new_avg_price)
                self.positions[order.symbol] = existing

    async def _check_risk_limits(self):
        """Check and enforce risk limits"""
        if self.risk_manager:
            await self.risk_manager.check_limits(self.positions, self.orders)

    def _generate_order_id(self) -> str:
        """Generate unique order ID"""
        import uuid

        return str(uuid.uuid4())[:8]

    @staticmethod
    def _serialize_order(order: Order) -> Dict[str, Any]:
        return {
            "id": order.id,
            "symbol": order.symbol,
            "side": order.side.value,
            "order_type": order.order_type.value,
            "quantity": float(order.quantity),
            "price": order.price,
            "stop_price": order.stop_price,
            "market": order.market.value,
            "timestamp": order.timestamp.isoformat(),
            "status": order.status,
            "filled_quantity": float(order.filled_quantity),
            "avg_fill_price": float(order.avg_fill_price),
        }

    @staticmethod
    def _serialize_position(position: Position) -> Dict[str, Any]:
        return {
            "symbol": position.symbol,
            "quantity": float(position.quantity),
            "avg_entry_price": float(position.avg_entry_price),
            "market": position.market.value,
            "unrealized_pnl": float(position.unrealized_pnl),
            "realized_pnl": float(position.realized_pnl),
            "timestamp": position.timestamp.isoformat(),
        }

    @staticmethod
    def _deserialize_order(payload: Dict[str, Any]) -> Order:
        return Order(
            id=str(payload["id"]),
            symbol=str(payload["symbol"]),
            side=OrderSide(str(payload["side"])),
            order_type=OrderType(str(payload["order_type"])),
            quantity=float(payload["quantity"]),
            price=payload.get("price"),
            stop_price=payload.get("stop_price"),
            market=MarketType(str(payload.get("market", MarketType.CRYPTO.value))),
            timestamp=datetime.fromisoformat(str(payload["timestamp"])),
            status=str(payload.get("status", "pending")),
            filled_quantity=float(payload.get("filled_quantity", 0.0)),
            avg_fill_price=float(payload.get("avg_fill_price", 0.0)),
        )

    @staticmethod
    def _deserialize_position(payload: Dict[str, Any]) -> Position:
        return Position(
            symbol=str(payload["symbol"]),
            quantity=float(payload["quantity"]),
            avg_entry_price=float(payload["avg_entry_price"]),
            market=MarketType(str(payload.get("market", MarketType.CRYPTO.value))),
            unrealized_pnl=float(payload.get("unrealized_pnl", 0.0)),
            realized_pnl=float(payload.get("realized_pnl", 0.0)),
            timestamp=datetime.fromisoformat(str(payload["timestamp"])),
        )

    def _persist_state(self) -> None:
        """Persist engine state for crash recovery."""
        state_payload = {
            "version": self.state_version,
            "saved_at": _utc_now().isoformat(),
            "mode": self.mode,
            "positions": [
                self._serialize_position(position)
                for position in sorted(self.positions.values(), key=lambda p: p.symbol)
            ],
            "orders": [
                self._serialize_order(order)
                for order in sorted(self.orders.values(), key=lambda o: o.id)
            ],
            "portfolio_change_history": list(self._portfolio_change_history[-1000:]),
        }
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
            temp_path.write_text(
                json.dumps(state_payload, sort_keys=True, indent=2),
                encoding="utf-8",
            )
            temp_path.replace(self.state_path)
        except Exception as exc:
            logger.error("State persistence failed (%s): %s", self.state_path, exc)

    def _load_persisted_state(self) -> None:
        """Load persisted state (if available) for restart recovery."""
        if not self.state_path.exists():
            return
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            positions_payload = payload.get("positions", [])
            orders_payload = payload.get("orders", [])
            self.positions = {
                p.symbol: p for p in (self._deserialize_position(row) for row in positions_payload)
            }
            self.orders = {
                o.id: o for o in (self._deserialize_order(row) for row in orders_payload)
            }
            history = [float(x) for x in payload.get("portfolio_change_history", [0.0] * 30)]
            self._portfolio_change_history = history[-1000:] if history else [0.0] * 30
            logger.info(
                "Recovered persisted engine state: %s positions, %s orders",
                len(self.positions),
                len(self.orders),
            )
        except Exception as exc:
            logger.warning("State recovery failed (%s): %s", self.state_path, exc)

    def _cancel_pending_orders(self) -> int:
        cancelled = 0
        cancel_states = {"pending", "submitted", "accepted", "open"}
        for order in self.orders.values():
            if order.status in cancel_states:
                order.status = "cancelled"
                cancelled += 1
        return cancelled

    def _flatten_positions_for_shutdown(self) -> int:
        flattened = 0
        for symbol, position in list(self.positions.items()):
            if abs(position.quantity) < 1e-12:
                del self.positions[symbol]
                continue

            mark_price = (
                self.market_data.get(symbol).close
                if symbol in self.market_data
                else position.avg_entry_price
            )
            close_side = OrderSide.SELL if position.quantity > 0 else OrderSide.BUY
            close_order = Order(
                id=f"{self._generate_order_id()}_shutdown",
                symbol=symbol,
                side=close_side,
                order_type=OrderType.MARKET,
                quantity=abs(position.quantity),
                price=float(mark_price),
                market=position.market,
                status="filled",
                filled_quantity=abs(position.quantity),
                avg_fill_price=float(mark_price),
            )
            self.orders[close_order.id] = close_order
            del self.positions[symbol]
            flattened += 1
        return flattened

    async def stop(self):
        """Stop the trading engine with cancel/flatten/persist guarantees."""
        logger.info("Stopping trading engine...")
        self.running = False
        cancelled_orders = self._cancel_pending_orders()
        flattened_positions = self._flatten_positions_for_shutdown()
        logger.info(
            "Graceful shutdown actions: cancelled=%s flattened=%s",
            cancelled_orders,
            flattened_positions,
        )
        if self.router is not None:
            await self.router.stop_market_data()
        self._persist_state()

    def set_market_enabled(self, market: str, enabled: bool):
        """Enable/disable a market domain at runtime."""
        if enabled and self.tenant_entitlements.allowed_markets is not None:
            if market not in self.tenant_entitlements.allowed_markets:
                raise ToggleValidationError(
                    f"Market '{market}' is not permitted for tenant plan "
                    f"'{self.tenant_entitlements.plan}'."
                )
        self.toggle_manager.set_market_enabled(market, enabled)
        self._sync_toggle_state()

    def set_strategy_enabled(self, strategy: str, enabled: bool):
        """Enable/disable a strategy at runtime."""
        self.toggle_manager.set_strategy_enabled(strategy, enabled)
        self._sync_toggle_state()

    def set_active_markets(self, markets: List[str]):
        """Replace active market set with the provided list."""
        if self.tenant_entitlements.allowed_markets is not None:
            disallowed = [
                market
                for market in markets
                if market not in self.tenant_entitlements.allowed_markets
            ]
            if disallowed:
                raise ToggleValidationError(
                    f"Markets not permitted for plan '{self.tenant_entitlements.plan}': {disallowed}"
                )
        self.toggle_manager.set_active_markets(markets)
        self._sync_toggle_state()

    def set_active_strategies(self, strategies: List[str]):
        """Replace active strategy set with the provided list."""
        if self.tenant_entitlements.strategy_allowlist is not None:
            disallowed = [
                name
                for name in strategies
                if name not in self.tenant_entitlements.strategy_allowlist
            ]
            if disallowed:
                raise ToggleValidationError(
                    f"Strategies not permitted for plan '{self.tenant_entitlements.plan}': {disallowed}"
                )
        if len(strategies) > int(self.tenant_entitlements.max_active_strategies):
            raise ToggleValidationError(
                f"Plan '{self.tenant_entitlements.plan}' allows at most "
                f"{self.tenant_entitlements.max_active_strategies} active strategies."
            )
        self.toggle_manager.set_active_strategies(strategies)
        self._sync_toggle_state()

    def apply_strategy_profile(self, profile_name: str):
        """Apply configured profile of market + strategy toggles."""
        self.toggle_manager.apply_strategy_profile(profile_name)
        self._sync_toggle_state()

    def set_risk_tolerance_profile(self, profile_name: str):
        """Set risk tolerance profile to scale hard limits before startup."""
        if self.router is not None or self.risk_manager is not None:
            raise RuntimeError(
                "Risk tolerance profile must be set before market/risk initialization."
            )
        profile = str(profile_name).strip()
        if not profile:
            raise ValueError("Risk tolerance profile cannot be empty")
        try:
            _, resolved = resolve_effective_risk_config(self.config, override_profile=profile)
        except ValueError as exc:
            raise ToggleValidationError(str(exc)) from exc
        self._risk_profile_override = resolved.name
        logger.info("Applied risk tolerance profile override: %s", resolved.name)

    def get_toggle_state(self) -> Dict[str, Any]:
        """Return full runtime toggle snapshot."""
        state = self.toggle_manager.snapshot()
        _, profile = self._effective_risk_config()
        state["risk_profile"] = profile.name
        state["risk_profile_scale"] = float(profile.risk_limit_scale)
        state["operator_tier"] = self.operator_tier.name
        state["autopilot_mode"] = self.autopilot.mode
        state["autopilot_last_decision"] = dict(self.last_autopilot_decision)
        state["tenant_id"] = self.tenant_entitlements.tenant_id
        state["tenant_plan"] = self.tenant_entitlements.plan
        return state

    def _sync_toggle_state(self):
        """
        Re-sync local enabled market/strategy state from toggle manager.

        Keeps runtime metadata coherent even before full dynamic module loading
        is wired for each market adapter and strategy class.
        """
        active_markets = set(self.toggle_manager.get_active_markets())
        if self.tenant_entitlements.allowed_markets is not None:
            active_markets = active_markets.intersection(self.tenant_entitlements.allowed_markets)
        if self.router is not None:
            # Reconfigure router-owned venue registry against toggled market set.
            filtered_markets: Dict[str, Any] = {}
            for market_name in active_markets:
                filtered_markets[market_name] = self.config.get("markets", {}).get(market_name, {})
            self.router.configure_market_adapters(filtered_markets)
            if self.running:
                try:
                    asyncio.create_task(self.router.start_market_data())
                except RuntimeError:
                    pass
            self.market_adapters = self.router.get_market_registry()
        else:
            self.market_adapters = {}

        # Recompute strategy metadata from new market toggle set.
        strategy_targets = {
            target.strategy: set(target.markets)
            for target in self.toggle_manager.get_strategy_targets()
        }
        active_strategies = set(self.toggle_manager.get_active_strategies())
        if self.tenant_entitlements.strategy_allowlist is not None:
            active_strategies = active_strategies.intersection(
                self.tenant_entitlements.strategy_allowlist
            )
        self.strategy_configs = {}
        for strategy_name in sorted(active_strategies):
            config = self.toggle_manager.get_strategy_config(strategy_name)
            enabled_markets = sorted(
                strategy_targets.get(strategy_name, set()).intersection(active_markets)
            )
            if enabled_markets:
                config["enabled_markets"] = enabled_markets
                self.strategy_configs[strategy_name] = config
        self.active_strategy_names = sorted(self.strategy_configs.keys())

    def set_autopilot_mode(self, mode: str) -> None:
        self.autopilot.set_mode(mode)
        logger.info("Autopilot mode set to %s", self.autopilot.mode)

    def set_operator_tier(self, tier_name: str) -> None:
        self.operator_tier = resolve_operator_tier(self.config, override=tier_name)
        self.autopilot_policy = resolve_autopilot_policy_pack(
            self.config,
            tier_name=self.operator_tier.name,
        )
        logger.info("Operator tier set to %s", self.operator_tier.name)

    def apply_autopilot_strategy_selection(
        self,
        *,
        ai_recommendations: Optional[List[str]] = None,
        include: Optional[List[str]] = None,
        exclude: Optional[List[str]] = None,
        replace_with: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Select active strategies using autopilot with optional human overrides.

        `ai_recommendations` is typically sourced from research AI outputs.
        """
        strategy_names = self.toggle_manager.list_strategies()
        strategy_configs = {
            name: self.toggle_manager.get_strategy_config(name) for name in strategy_names
        }
        current_active = self.toggle_manager.get_active_strategies()
        override = HumanStrategyOverride(
            include=list(include or []),
            exclude=list(exclude or []),
            replace_with=(list(replace_with) if replace_with is not None else None),
        )
        decision = self.autopilot.decide(
            strategy_configs=strategy_configs,
            current_active=current_active,
            ai_recommendations=(ai_recommendations or []),
            human_override=override,
        )
        enforced = enforce_autopilot_policy(
            selected=decision.selected_strategies,
            ranked_candidates=list(decision.candidate_scores.keys()),
            policy=self.autopilot_policy,
        )
        tenant_enforced = enforce_tenant_entitlements(
            selected=enforced.selected,
            active_markets=self.toggle_manager.get_active_markets(),
            ranked_candidates=list(decision.candidate_scores.keys()),
            entitlements=self.tenant_entitlements,
        )
        self.toggle_manager.set_active_markets(tenant_enforced.active_markets)
        self.toggle_manager.set_active_strategies(tenant_enforced.selected)
        self.last_autopilot_decision = {
            **decision.to_dict(),
            "operator_tier": self.operator_tier.name,
            "tenant": {
                "tenant_id": self.tenant_entitlements.tenant_id,
                "plan": self.tenant_entitlements.plan,
            },
            "policy_pack": {
                "name": self.autopilot_policy.name,
                "allowed_strategies": (
                    sorted(self.autopilot_policy.allowed_strategies)
                    if self.autopilot_policy.allowed_strategies is not None
                    else []
                ),
                "min_active_strategies": int(self.autopilot_policy.min_active_strategies),
                "max_active_strategies": int(self.autopilot_policy.max_active_strategies),
            },
            "policy_enforcement": enforced.to_dict(),
            "tenant_enforcement": tenant_enforced.to_dict(),
        }
        self._sync_toggle_state()
        self.ops_events.emit(
            category="autopilot",
            severity="info",
            message="autopilot_strategy_selection_applied",
            metrics={
                "selected_count": len(tenant_enforced.selected),
                "dropped_count": len(enforced.dropped) + len(tenant_enforced.dropped_strategies),
                "added_count": len(enforced.added),
            },
            metadata={
                "mode": decision.mode,
                "operator_tier": self.operator_tier.name,
                "tenant_plan": self.tenant_entitlements.plan,
                "selected_strategies": list(tenant_enforced.selected),
                "policy_reasons": list(enforced.reasons),
                "tenant_reasons": list(tenant_enforced.reasons),
            },
        )
        logger.info(
            "Autopilot applied: mode=%s selected=%s",
            decision.mode,
            tenant_enforced.selected,
        )
        return dict(self.last_autopilot_decision)

    def get_autopilot_state(self) -> Dict[str, Any]:
        return {
            "mode": self.autopilot.mode,
            "auto_apply_on_start": bool(self.autopilot_auto_apply_on_start),
            "decision": dict(self.last_autopilot_decision),
        }


if __name__ == "__main__":
    import sys

    config_path = sys.argv[1] if len(sys.argv) > 1 else "config/paper.yaml"
    engine = TradingEngine(config_path)

    try:
        asyncio.run(engine.start())
    except KeyboardInterrupt:
        asyncio.run(engine.stop())
