# Smart Order Router
import asyncio
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Optional, Tuple

from execution.fee_optimizer import FeeRebateOptimizer

logger = logging.getLogger(__name__)


class OrderType(Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP_LIMIT = "stop_limit"
    ICEBERG = "iceberg"
    TWAP = "twap"
    VWAP = "vwap"


@dataclass
class OrderRequest:
    symbol: str
    side: str  # 'buy' or 'sell'
    quantity: float
    order_type: OrderType
    price: Optional[float] = None
    stop_price: Optional[float] = None
    time_in_force: str = "GTC"  # GTC, IOC, FOK
    strategy_id: str = "unknown"
    expected_alpha_bps: float = 0.0
    client_order_id: Optional[str] = None


@dataclass
class RouteDecision:
    exchange: str
    order_type: OrderType
    price: Optional[float]
    split_orders: List[OrderRequest]
    expected_cost: float
    expected_slippage: float
    ranked_exchanges: List[str] = field(default_factory=list)


class SmartOrderRouter:
    """
    Intelligent order routing to minimize costs and slippage.

    Features:
    - Exchange selection based on liquidity/fees
    - Order type optimization
    - Large order splitting (TWAP/VWAP)
    - Maker vs taker decision
    """

    def __init__(self, config: dict):
        self.config = config
        self.enabled = config.get("enabled", True)
        self.max_single_order_size = config.get("max_single_order_size", 1.0)  # BTC
        self.twap_interval_seconds = config.get("twap_interval_seconds", 60)
        self.prefer_maker = config.get("prefer_maker", True)
        self.default_monthly_volume_usd = float(config.get("default_monthly_volume_usd", 0.0))

        # Exchange configs
        self.exchanges = config.get("exchanges", {})
        self.base_monthly_volume_by_venue = {
            str(k): float(v) for k, v in config.get("monthly_volume_by_venue", {}).items()
        }
        self.monthly_volume_by_venue = dict(self.base_monthly_volume_by_venue)
        self.venue_quality: Dict[str, Dict[str, float]] = {}
        self._volume_month = datetime.now(timezone.utc).strftime("%Y-%m")
        self.slippage_guard_ratio = float(config.get("slippage_guard_ratio", 1.5))
        self.fee_optimizer = FeeRebateOptimizer(
            tiers_by_venue=config.get("fee_tiers", {}),
            default_maker_fee_bps=float(config.get("default_maker_fee_bps", 10.0)),
            default_taker_fee_bps=float(config.get("default_taker_fee_bps", 12.0)),
        )
        maker_ladder_cfg = config.get("maker_urgency_ladder", {}) or {}
        self.maker_urgency_ladder_enabled = bool(maker_ladder_cfg.get("enabled", True))
        raw_thresholds = maker_ladder_cfg.get("urgency_alpha_thresholds_bps", {}) or {}
        self.maker_ladder_thresholds_bps = {
            "normal": float(raw_thresholds.get("normal", 2.0)),
            "urgent": float(raw_thresholds.get("urgent", 0.5)),
        }
        self.maker_ladder_cost_buffer_bps = float(
            maker_ladder_cfg.get("incremental_cost_buffer_bps", 0.5)
        )

        logger.info(f"SmartOrderRouter initialized")

    @staticmethod
    def _urgency_bucket(time_in_force: str) -> str:
        token = str(time_in_force or "").upper().strip()
        if token in {"IOC", "FOK"}:
            return "urgent"
        return "normal"

    def _maker_ladder_decision(
        self,
        *,
        request: OrderRequest,
        exchange: str,
        spread_bps: float,
    ) -> Optional[OrderType]:
        if not bool(self.maker_urgency_ladder_enabled):
            return None
        monthly_volume = float(
            self.monthly_volume_by_venue.get(exchange, self.default_monthly_volume_usd)
        )
        maker_fee = self.fee_optimizer.effective_fee_bps(
            exchange,
            is_maker=True,
            monthly_volume_usd=monthly_volume,
        )
        taker_fee = self.fee_optimizer.effective_fee_bps(
            exchange,
            is_maker=False,
            monthly_volume_usd=monthly_volume,
        )
        incremental_cross_cost_bps = (
            max(float(spread_bps), 0.0)
            + max(float(taker_fee) - float(maker_fee), 0.0)
            + float(self.maker_ladder_cost_buffer_bps)
        )
        urgency = self._urgency_bucket(request.time_in_force)
        threshold = float(self.maker_ladder_thresholds_bps.get(urgency, 0.0))
        required_alpha_bps = float(incremental_cross_cost_bps + threshold)
        if float(request.expected_alpha_bps) >= required_alpha_bps:
            return OrderType.MARKET
        return OrderType.LIMIT

    async def route_order(self, request: OrderRequest, market_data: Dict) -> RouteDecision:
        """Determine optimal routing for order"""

        ranked_exchanges = self._rank_exchanges(
            symbol=request.symbol,
            market_data=market_data,
            prefer_maker=self.prefer_maker,
        )
        exchange = ranked_exchanges[0] if ranked_exchanges else "binance"

        # Determine order type
        order_type = self._select_order_type(request, market_data, exchange=exchange)

        # Split large orders
        split_orders = self._split_order(request, market_data)

        # Calculate costs
        expected_cost, expected_slippage = self._estimate_costs(
            request, exchange, order_type, market_data
        )

        # Optimize price
        price = self._optimize_price(request, order_type, market_data)

        return RouteDecision(
            exchange=exchange,
            order_type=order_type,
            price=price,
            split_orders=split_orders,
            expected_cost=expected_cost,
            expected_slippage=expected_slippage,
            ranked_exchanges=ranked_exchanges,
        )

    def _iter_exchange_views(self, market_data: Dict) -> List[Tuple[str, Dict]]:
        """
        Yield normalized exchange -> symbol quote maps.

        Market snapshots can include scalar metadata keys such as
        `last_price`/`vol_24h` plus nested order book payloads. These are
        ignored here to keep routing deterministic and robust.
        """
        views: List[Tuple[str, Dict]] = []
        for exchange, payload in market_data.items():
            if not isinstance(payload, Mapping):
                continue
            if exchange == "order_book":
                continue
            if any(isinstance(v, Mapping) and "price" in v for v in payload.values()):
                views.append((exchange, dict(payload)))
        return views

    def _venue_quality_score(self, venue: str) -> float:
        stats = self.venue_quality.get(str(venue), {})
        realized_vs_expected = float(stats.get("slippage_ratio", 1.0))
        fill_ratio = float(stats.get("fill_ratio", 1.0))
        latency_ms = float(stats.get("latency_ms", 0.0))
        # Penalize venues with worse slippage, lower fills, higher latency.
        return (
            (1.0 / max(realized_vs_expected, 0.25)) * 0.5
            + max(min(fill_ratio, 1.0), 0.0) * 0.3
            + (1.0 / (1.0 + max(latency_ms, 0.0) / 500.0)) * 0.2
        )

    def _rank_exchanges(self, symbol: str, market_data: Dict, prefer_maker: bool) -> List[str]:
        scored: List[Tuple[str, float]] = []
        for exchange, data in self._iter_exchange_views(market_data):
            if symbol not in data:
                continue

            symbol_data = data[symbol]
            spread = float(symbol_data.get("spread", 0.01) or 0.01)
            spread_score = 1 / (1 + spread * 100)
            volume = float(symbol_data.get("volume_24h", 0) or 0)
            volume_score = min(volume / 1_000_000, 1.0)
            monthly_volume = float(
                self.monthly_volume_by_venue.get(exchange, self.default_monthly_volume_usd)
            )
            fee_bps = self.fee_optimizer.effective_fee_bps(
                exchange,
                is_maker=bool(prefer_maker),
                monthly_volume_usd=monthly_volume,
            )
            fee_score = 1 / (1 + max(fee_bps, -5.0) / 10.0)
            quality_score = self._venue_quality_score(exchange)
            score = (
                spread_score * 0.30 + volume_score * 0.30 + fee_score * 0.20 + quality_score * 0.20
            )
            scored.append((exchange, score))

        scored.sort(key=lambda item: item[1], reverse=True)
        return [venue for venue, _ in scored]

    def _select_exchange(self, symbol: str, market_data: Dict) -> str:
        ranked = self._rank_exchanges(
            symbol=symbol, market_data=market_data, prefer_maker=self.prefer_maker
        )
        return ranked[0] if ranked else "binance"

    def _select_order_type(
        self, request: OrderRequest, market_data: Dict, exchange: str
    ) -> OrderType:
        """Select optimal order type"""
        venue_quality = self.venue_quality.get(str(exchange), {})
        if (
            float(venue_quality.get("slippage_ratio", 1.0)) >= self.slippage_guard_ratio
            and request.time_in_force != "IOC"
        ):
            # When realized slippage drifts above expectation, bias toward maker.
            return OrderType.LIMIT

        # Large orders: use TWAP
        if request.quantity > self.max_single_order_size:
            return OrderType.TWAP

        spread_bps = self._get_spread_for_venue(exchange, request.symbol, market_data) * 10000.0
        maker_ladder_decision = self._maker_ladder_decision(
            request=request,
            exchange=exchange,
            spread_bps=spread_bps,
        )
        if maker_ladder_decision is not None:
            return maker_ladder_decision

        # If we can get filled as maker, use limit
        if self.prefer_maker and request.price:
            current_price = self._get_current_price(request.symbol, market_data)

            if request.side == "buy" and request.price < current_price:
                return OrderType.LIMIT
            elif request.side == "sell" and request.price > current_price:
                return OrderType.LIMIT

        # Urgent execution: market order
        if request.time_in_force == "IOC":
            return OrderType.MARKET

        monthly_volume = float(
            self.monthly_volume_by_venue.get(exchange, self.default_monthly_volume_usd)
        )
        style = self.fee_optimizer.recommend_order_style(
            venue=exchange,
            spread_bps=spread_bps,
            urgency=request.time_in_force,
            monthly_volume_usd=monthly_volume,
        )
        return OrderType.LIMIT if style == "maker" else OrderType.MARKET

    def _split_order(self, request: OrderRequest, market_data: Dict) -> List[OrderRequest]:
        """Split large orders for optimal execution"""

        if request.quantity <= self.max_single_order_size:
            return [request]

        # TWAP splitting
        num_slices = int(request.quantity / self.max_single_order_size) + 1
        slice_size = request.quantity / num_slices

        splits = []
        for i in range(num_slices):
            split = OrderRequest(
                symbol=request.symbol,
                side=request.side,
                quantity=slice_size,
                order_type=OrderType.LIMIT,
                price=request.price,
                time_in_force=request.time_in_force,
                strategy_id=request.strategy_id,
                expected_alpha_bps=float(request.expected_alpha_bps),
            )
            splits.append(split)

        return splits

    def _estimate_costs(
        self, request: OrderRequest, exchange: str, order_type: OrderType, market_data: Dict
    ) -> tuple:
        """Estimate trading costs"""

        exchange_config = self.exchanges.get(exchange, {})
        monthly_volume = float(
            self.monthly_volume_by_venue.get(exchange, self.default_monthly_volume_usd)
        )
        use_maker = order_type in {
            OrderType.LIMIT,
            OrderType.TWAP,
            OrderType.ICEBERG,
            OrderType.VWAP,
        }
        fee_bps = self.fee_optimizer.effective_fee_bps(
            exchange,
            is_maker=use_maker,
            monthly_volume_usd=monthly_volume,
        )

        if use_maker:
            slippage = 0.0001  # Minimal for maker
        else:
            slippage = 0.001  # Higher for taker

        # Adjust for order size
        size_factor = min(request.quantity / 10, 1.0)  # Larger = more slippage
        slippage *= 1 + size_factor

        notional = request.quantity * (
            request.price or self._get_current_price(request.symbol, market_data)
        )
        expected_cost = notional * (fee_bps / 10000.0)
        expected_slippage = notional * slippage

        return expected_cost, expected_slippage

    def _optimize_price(
        self, request: OrderRequest, order_type: OrderType, market_data: Dict
    ) -> Optional[float]:
        """Optimize order price for best execution"""

        if order_type == OrderType.MARKET:
            return None

        current_price = self._get_current_price(request.symbol, market_data)

        if not current_price:
            return request.price

        # Add small buffer for better fill probability
        if request.side == "buy":
            # Bid slightly above to get maker fill
            return current_price * 0.9995
        else:
            # Ask slightly below
            return current_price * 1.0005

    def _get_current_price(self, symbol: str, market_data: Dict) -> Optional[float]:
        """Get current market price"""
        for _, exchange_data in self._iter_exchange_views(market_data):
            if symbol in exchange_data:
                return exchange_data[symbol].get("price")
        return None

    def _get_spread_for_venue(self, venue: str, symbol: str, market_data: Dict) -> float:
        payload = market_data.get(venue, {})
        if isinstance(payload, Mapping):
            quote = payload.get(symbol, {})
            if isinstance(quote, Mapping):
                return float(quote.get("spread", 0.0) or 0.0)
        return 0.0

    def record_execution_outcome(
        self,
        *,
        exchange: str,
        symbol: str,
        expected_slippage_bps: float,
        realized_slippage_bps: float,
        fill_ratio: float,
        latency_ms: float,
    ) -> None:
        _ = symbol  # retained for future symbol-conditioned venue stats
        venue_key = str(exchange)
        stats = self.venue_quality.get(
            venue_key,
            {
                "slippage_ratio": 1.0,
                "fill_ratio": 1.0,
                "latency_ms": 0.0,
            },
        )
        alpha = 0.2
        baseline = max(float(expected_slippage_bps), 1e-6)
        ratio = float(realized_slippage_bps) / baseline
        stats["slippage_ratio"] = (1 - alpha) * float(stats["slippage_ratio"]) + alpha * ratio
        stats["fill_ratio"] = (1 - alpha) * float(stats["fill_ratio"]) + alpha * float(fill_ratio)
        stats["latency_ms"] = (1 - alpha) * float(stats["latency_ms"]) + alpha * float(latency_ms)
        self.venue_quality[venue_key] = stats

    def _roll_month_if_needed(self, timestamp: Optional[datetime] = None) -> None:
        ts = timestamp or datetime.now(timezone.utc)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        month_key = ts.strftime("%Y-%m")
        if month_key != self._volume_month:
            self.monthly_volume_by_venue = dict(self.base_monthly_volume_by_venue)
            self._volume_month = month_key

    def record_executed_notional(
        self,
        exchange: str,
        notional: float,
        timestamp: Optional[datetime] = None,
    ) -> None:
        self._roll_month_if_needed(timestamp)
        venue = str(exchange)
        updated = float(self.monthly_volume_by_venue.get(venue, 0.0)) + max(float(notional), 0.0)
        self.monthly_volume_by_venue[venue] = updated

    def get_monthly_volume(self, exchange: str) -> float:
        return float(self.monthly_volume_by_venue.get(str(exchange), 0.0))

    async def execute_route(self, decision: RouteDecision) -> bool:
        """Execute the routing decision"""
        logger.info(f"Executing route: {decision.exchange}, {decision.order_type.value}")

        try:
            if decision.order_type == OrderType.TWAP:
                # Execute TWAP over time
                for i, order in enumerate(decision.split_orders):
                    if i > 0:
                        await asyncio.sleep(self.twap_interval_seconds)

                    logger.info(f"TWAP slice {i+1}/{len(decision.split_orders)}: {order.quantity}")
                    # Execute order...
            else:
                # Execute single order
                pass

            return True

        except Exception as e:
            logger.error(f"Route execution failed: {e}")
            return False
