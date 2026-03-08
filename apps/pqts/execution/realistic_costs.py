"""
Realistic Execution Cost Model - FIXED VERSION

Bug fixes:
1. Fixed NameError: commission -> commission_rate
2. Fixed depth_up_to_pct: now accepts side parameter and returns USD notional
3. Fixed should_use_maker_only logic (was inverted)
4. Added proper units typing (NotionalUSD, Quantity, etc.)

Implements Grok's recommendation:
- Volume-based + volatility-adjusted slippage
- Square-root market impact law
- Maker-only optimization
- TWAP/POV slicing for large orders

Every 0.05% fee reduction on $100k at 5x turnover = +$2,500/year
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Tuple, Union

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


# ============================================================================
# Typed Units (prevent silent bugs)
# ============================================================================


class Side(Enum):
    BUY = "buy"
    SELL = "sell"

    def opposite(self) -> "Side":
        return Side.SELL if self == Side.BUY else Side.BUY


class NotionalUSD(float):
    """Dollars - e.g., $10,000"""

    pass


class Quantity(float):
    """Asset units - e.g., 0.5 BTC"""

    pass


class Price(float):
    """USD per unit - e.g., $50,000/BTC"""

    pass


class Bps(float):
    """Basis points - e.g., 5 bps = 0.0005"""

    @classmethod
    def from_pct(cls, pct: float) -> "Bps":
        return cls(pct * 10000)

    def to_decimal(self) -> float:
        return self / 10000


class AnnualVol(float):
    """Annualized volatility - e.g., 0.50 = 50%"""

    pass


# ============================================================================
# ORDER BOOK WITH TYPED DEPTH
# ============================================================================


@dataclass
class OrderBookLevel:
    """Single price level in order book"""

    price: Price
    quantity: Quantity
    notional: NotionalUSD = field(init=False)

    def __post_init__(self):
        self.notional = NotionalUSD(self.price * self.quantity)


@dataclass
class OrderBook:
    """
    Order book with typed depth functions.

    CRITICAL FIX: depth functions now return USD notional, not quantity.
    """

    bids: List[OrderBookLevel]  # Sorted descending (best first)
    asks: List[OrderBookLevel]  # Sorted ascending (best first)

    @property
    def spread(self) -> float:
        return float(self.best_ask - self.best_bid)

    @property
    def best_bid(self) -> Price:
        return self.bids[0].price if self.bids else Price(0)

    @property
    def best_ask(self) -> Price:
        return self.asks[0].price if self.asks else Price(0)

    @property
    def mid_price(self) -> Price:
        return Price((float(self.best_bid) + float(self.best_ask)) / 2)

    @classmethod
    def from_snapshots(cls, bid_snapshots: list, ask_snapshots: list):
        """
        Convert raw snapshots [(price, qty), ...] to typed OrderBook.
        """
        bids = [OrderBookLevel(Price(p), Quantity(s)) for p, s in bid_snapshots]
        asks = [OrderBookLevel(Price(p), Quantity(s)) for p, s in ask_snapshots]
        return cls(bids=bids, asks=asks)

    def depth_at_price(self, price: Price, side: Side) -> Quantity:
        """Get quantity available at better-than-or-equal-to price level"""
        levels = self.bids if side == Side.BUY else self.asks

        total_qty = Quantity(0)
        for level in levels:
            if (side == Side.BUY and level.price >= price) or (
                side == Side.SELL and level.price <= price
            ):
                total_qty = Quantity(total_qty + level.quantity)

        return total_qty

    def depth_notional_up_to_pct(self, pct: float, side: Side) -> NotionalUSD:
        """
        Get USD notional depth within X% of mid price for a side.

        CRITICAL FIX: Returns USD notional, not quantity.
        Side-aware: buy looks at asks, sell looks at bids.

        Args:
            pct: Price deviation from mid (e.g., 0.01 = 1%)
            side: BUY or SELL

        Returns:
            USD notional depth available
        """
        mid = float(self.mid_price)

        if side == Side.BUY:
            # Buying: need to look at asks (how much can we buy)
            target_price = Price(mid * (1 + pct))
            levels = self.asks
            qualifying = [l for l in levels if l.price <= target_price]
        else:
            # Selling: need to look at bids (how much can we sell)
            target_price = Price(mid * (1 - pct))
            levels = self.bids
            qualifying = [l for l in levels if l.price >= target_price]

        total = NotionalUSD(sum(l.notional for l in qualifying))
        return total

    def get_depth_summary(self) -> Dict:
        """Human-readable depth summary."""
        buy_depth_1pct = self.depth_notional_up_to_pct(0.01, Side.BUY)
        sell_depth_1pct = self.depth_notional_up_to_pct(0.01, Side.SELL)

        return {
            "best_bid": float(self.best_bid),
            "best_ask": float(self.best_ask),
            "spread_bps": Bps.from_pct(self.spread / float(self.mid_price)),
            "buy_depth_1pct_usd": float(buy_depth_1pct),
            "sell_depth_1pct_usd": float(sell_depth_1pct),
            "min_depth_1pct_usd": float(min(buy_depth_1pct, sell_depth_1pct)),
        }


# ============================================================================
# REALISTIC COST MODEL - FIXED
# ============================================================================


@dataclass
class CostBreakdown:
    """Detailed transaction cost components."""

    commission: NotionalUSD
    slippage: NotionalUSD
    spread_cross: NotionalUSD
    market_impact: NotionalUSD
    total_cost: NotionalUSD
    total_bps: Bps

    def to_dict(self) -> Dict:
        return {
            "commission": float(self.commission),
            "slippage": float(self.slippage),
            "spread_cross": float(self.spread_cross),
            "market_impact": float(self.market_impact),
            "total_cost": float(self.total_cost),
            "total_bps": float(self.total_bps),
        }


class RealisticCostModel:
    """
    Market impact model with correct units and side-awareness.

    References:
    - Almgren et al. (2005): square-root law
    - Bouchaud et al. (2002): order book dynamics
    """

    def __init__(
        self,
        commission_rate: float = 0.001,  # 0.1% (maker rebate or taker fee)
        base_volatility: float = 0.50,  # 50% annualized
        impact_constant: float = 0.5,
        impact_volatility_scale: float | None = None,
    ):  # Empirical constant
        self.commission = commission_rate
        self.base_vol = base_volatility
        self.eta = impact_constant  # Market impact coefficient
        self.impact_volatility_scale = (
            float(impact_volatility_scale)
            if impact_volatility_scale is not None
            else float(1.0 / np.sqrt(252.0))
        )

        # FIX: Use commission_rate, not undefined 'commission'
        logger.info(f"Cost model: commission_rate={commission_rate:.3%}")

    def estimate_slippage(
        self,
        order_size_usd: NotionalUSD,
        order_book: OrderBook,
        side: Side,
        current_volatility: AnnualVol,
        is_market_order: bool = False,
    ) -> float:
        """
        Estimate slippage using square-root market impact law.

        Market impact = σ × √( participation )

        FIX: Now side-aware. Depth is calculated appropriately for BUY vs SELL.

        Args:
            order_size_usd: Notional USD size
            order_book: Current order book
            side: BUY or SELL
            current_volatility: Annualized volatility
            is_market_order: Whether this is a market order

        Returns:
            Slippage as decimal (e.g., 0.001 = 0.1%)
        """
        # FIX: Use side-aware depth calculation
        depth = order_book.depth_notional_up_to_pct(0.01, side)

        if float(depth) == 0:
            # Thin market - high slippage
            logger.warning(f"Zero depth detected for side={side.value}")
            return 0.01  # 1%

        participation = float(order_size_usd) / float(depth)
        participation = max(participation, 1e-8)  # Prevent div by zero

        # Convert annualized volatility to execution-horizon volatility.
        horizon_vol = max(float(current_volatility) * self.impact_volatility_scale, 1e-9)

        # Temporary impact (what we pay immediately)
        temp_impact = self.eta * horizon_vol * np.sqrt(participation)

        # Permanent impact (long-term price change)
        # Usually 10-20% of temporary
        permanent = temp_impact * 0.1

        total = temp_impact + permanent

        # Market orders pay approximately half the spread additionally
        if is_market_order:
            spread_pct = order_book.spread / float(order_book.mid_price)
            total += spread_pct / 2

        return total

    def get_execution_slices(
        self,
        total_notional: NotionalUSD,
        order_book: OrderBook,
        side: Side,
        max_participation: float = 0.05,
    ) -> List[Dict]:
        """
        Split large orders to minimize market impact.

        Target: Each slice < 5% of market depth.

        FIX: Now uses notional and is side-aware.
        """
        # Use minimum depth for conservative sizing
        buy_depth = order_book.depth_notional_up_to_pct(0.01, Side.BUY)
        sell_depth = order_book.depth_notional_up_to_pct(0.01, Side.SELL)
        depth = NotionalUSD(min(float(buy_depth), float(sell_depth)))

        max_slice = NotionalUSD(float(depth) * max_participation)

        n_slices = int(np.ceil(float(total_notional) / float(max_slice)))
        base_slice = float(total_notional) / n_slices

        slices = []
        for i in range(n_slices):
            # Adjust final slice for rounding
            if i == n_slices - 1:
                slice_notional = float(total_notional) - sum(s["size_usd"] for s in slices)
            else:
                slice_notional = base_slice

            slice_notional_typed = NotionalUSD(slice_notional)

            # Estimate impact for this slice
            est_impact = self.estimate_slippage(
                slice_notional_typed,
                order_book,
                side,
                AnnualVol(self.base_vol),
                is_market_order=False,
            )

            slices.append(
                {
                    "slice_num": i + 1,
                    "size_usd": slice_notional,
                    "delay_s": 10,  # 10 seconds between slices
                    "type": "post_only",  # Maker order
                    "est_slippage_bps": Bps.from_pct(est_impact),
                    "side": side.value,
                }
            )

        return slices

    def should_use_maker_only(
        self, order_book: OrderBook, urgency: str = "normal", spread_multiple: float = 2.0
    ) -> bool:
        """
        Decide if we should use maker-only orders.

        FIX: Corrected logic - was inverted before.

        Rules:
        - Urgent order: Use taker (market) to fill fast
        - Normal order + wide spread: Use maker to capture spread
        - Normal order + tight spread: Still prefer maker (lower fees)

        Args:
            order_book: Current book
            urgency: 'normal' or 'urgent'
            spread_multiple: Multiple of commission to justify maker

        Returns:
            True if should use maker-only (post-only limit)
            False if taker is better (market order)
        """
        spread_pct = order_book.spread / float(order_book.mid_price)
        commission_pct = self.commission

        if urgency == "urgent":
            # FIX: Was inverted - urgent orders should use taker, not maker
            if spread_pct < commission_pct * spread_multiple:
                # Tight spread + urgent = accept taker fee to fill
                return False
            else:
                # Wide spread - still consider maker
                return True

        # Normal urgency: prefer maker if spread justifies it
        # Spread capture > commission
        return spread_pct > commission_pct * spread_multiple

    def calculate_total_cost(
        self,
        notional: NotionalUSD,
        price: Price,
        order_book: OrderBook,
        side: Side,
        volatility: AnnualVol = None,
        is_maker: bool = True,
    ) -> CostBreakdown:
        """
        Calculate all transaction costs with proper unit handling.

        Args:
            notional: USD notional amount
            price: Execution price
            order_book: Current book
            side: BUY or SELL
            volatility: Current volatility (uses base if None)
            is_maker: Whether this is a maker order

        Returns:
            CostBreakdown with all components
        """
        if volatility is None:
            volatility = AnnualVol(self.base_vol)

        # Commission
        commission = NotionalUSD(float(notional) * self.commission)

        # Slippage estimate
        slippage_pct = self.estimate_slippage(
            notional, order_book, side, volatility, is_market_order=not is_maker
        )
        slippage_cost = NotionalUSD(float(notional) * slippage_pct)

        # Spread crossing (only for market orders)
        if not is_maker:
            spread_cost = NotionalUSD(
                float(notional) * (order_book.spread / float(order_book.mid_price)) / 2
            )
        else:
            spread_cost = NotionalUSD(0)

        # Market impact (included in slippage estimate)
        impact_cost = slippage_cost  # Simplified

        total = NotionalUSD(float(commission) + float(slippage_cost) + float(spread_cost))
        total_bps = Bps.from_pct(float(total) / float(notional))

        return CostBreakdown(
            commission=commission,
            slippage=slippage_cost,
            spread_cross=spread_cost,
            market_impact=impact_cost,
            total_cost=total,
            total_bps=total_bps,
        )

    def compare_execution_styles(
        self, notional: NotionalUSD, order_book: OrderBook, side: Side, volatility: AnnualVol
    ) -> Dict:
        """
        Compare costs of different execution styles.

        Returns dict with costs for maker, taker, twap.
        """
        maker_cost = self.calculate_total_cost(
            notional, order_book.mid_price, order_book, side, volatility, is_maker=True
        )

        taker_cost = self.calculate_total_cost(
            notional, order_book.mid_price, order_book, side, volatility, is_maker=False
        )

        # TWAP: multiple maker orders
        twap_slices = self.get_execution_slices(notional, order_book, side)
        total_twap_cost = NotionalUSD(0)
        for s in twap_slices:
            slice_cost = self.calculate_total_cost(
                NotionalUSD(s["size_usd"]),
                order_book.mid_price,
                order_book,
                side,
                volatility,
                is_maker=True,
            )
            total_twap_cost = NotionalUSD(float(total_twap_cost) + float(slice_cost.total_cost))

        return {
            "maker": maker_cost.to_dict(),
            "taker": taker_cost.to_dict(),
            "twap": {
                "n_slices": len(twap_slices),
                "total_cost": float(total_twap_cost),
                "total_bps": float(Bps.from_pct(float(total_twap_cost) / float(notional))),
            },
            "recommendation": "maker" if maker_cost.total_bps < taker_cost.total_bps else "taker",
        }
