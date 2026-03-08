"""Deterministic shorting risk controls for long/short routing."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class ShortingPolicy:
    enabled: bool = False
    require_locate: bool = True
    max_borrow_bps: float = 40.0
    max_short_exposure_pct: float = 0.30
    max_squeeze_multiplier: float = 2.0
    default_borrow_bps: float = 5.0


@dataclass(frozen=True)
class ShortingDecision:
    approved: bool
    reason: str
    requires_short_borrow: bool
    locate_available: bool
    recall_active: bool
    borrow_bps: float
    squeeze_multiplier: float
    projected_short_exposure_pct: float
    stressed_short_exposure_pct: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "approved": bool(self.approved),
            "reason": str(self.reason),
            "requires_short_borrow": bool(self.requires_short_borrow),
            "locate_available": bool(self.locate_available),
            "recall_active": bool(self.recall_active),
            "borrow_bps": float(self.borrow_bps),
            "squeeze_multiplier": float(self.squeeze_multiplier),
            "projected_short_exposure_pct": float(self.projected_short_exposure_pct),
            "stressed_short_exposure_pct": float(self.stressed_short_exposure_pct),
        }


class ShortBorrowRegistry:
    """
    Deterministic locate/borrow registry backed by config dictionaries.

    Supported keys:
      - symbol level: "AAPL", "BTC-USD"
      - venue + symbol level: "binance|BTC-USD" or "binance:BTC-USD"
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        cfg = config or {}
        self.borrow_bps = {str(k): float(v) for k, v in (cfg.get("borrow_bps", {}) or {}).items()}
        self.locates = {str(k): bool(v) for k, v in (cfg.get("locates", {}) or {}).items()}
        self.recalls = {str(k): bool(v) for k, v in (cfg.get("recalls", {}) or {}).items()}
        self.squeeze = {str(k): float(v) for k, v in (cfg.get("squeeze", {}) or {}).items()}

    @staticmethod
    def _lookup(
        table: Dict[str, Any],
        *,
        symbol: str,
        venue: str,
        default: Any,
    ) -> Any:
        venue_key_pipe = f"{venue}|{symbol}" if venue else ""
        venue_key_colon = f"{venue}:{symbol}" if venue else ""
        if venue_key_pipe and venue_key_pipe in table:
            return table[venue_key_pipe]
        if venue_key_colon and venue_key_colon in table:
            return table[venue_key_colon]
        if symbol in table:
            return table[symbol]
        return default

    def get_borrow_bps(self, *, symbol: str, venue: str, default_borrow_bps: float) -> float:
        value = self._lookup(
            self.borrow_bps, symbol=symbol, venue=venue, default=default_borrow_bps
        )
        return float(value)

    def locate_available(self, *, symbol: str, venue: str) -> bool:
        return bool(self._lookup(self.locates, symbol=symbol, venue=venue, default=True))

    def recall_active(self, *, symbol: str, venue: str) -> bool:
        return bool(self._lookup(self.recalls, symbol=symbol, venue=venue, default=False))

    def squeeze_multiplier(self, *, symbol: str, venue: str) -> float:
        value = self._lookup(self.squeeze, symbol=symbol, venue=venue, default=1.0)
        return float(max(value, 1.0))


class ShortingRiskOverlay:
    """Pre-trade shorting guardrail: locate/borrow/recall/squeeze checks."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        cfg = config or {}
        self.policy = ShortingPolicy(
            enabled=bool(cfg.get("enabled", False)),
            require_locate=bool(cfg.get("require_locate", True)),
            max_borrow_bps=float(cfg.get("max_borrow_bps", 40.0)),
            max_short_exposure_pct=float(cfg.get("max_short_exposure_pct", 0.30)),
            max_squeeze_multiplier=float(cfg.get("max_squeeze_multiplier", 2.0)),
            default_borrow_bps=float(cfg.get("default_borrow_bps", 5.0)),
        )
        self.registry = ShortBorrowRegistry(cfg)

    def evaluate(
        self,
        *,
        symbol: str,
        venue: str,
        side: str,
        order_qty: float,
        order_price: float,
        portfolio: Dict[str, Any],
        capital: float,
    ) -> ShortingDecision:
        side_token = str(side).strip().lower()
        if not self.policy.enabled:
            return ShortingDecision(
                approved=True,
                reason="shorting_controls_disabled",
                requires_short_borrow=False,
                locate_available=True,
                recall_active=False,
                borrow_bps=0.0,
                squeeze_multiplier=1.0,
                projected_short_exposure_pct=0.0,
                stressed_short_exposure_pct=0.0,
            )
        if side_token != "sell":
            return ShortingDecision(
                approved=True,
                reason="not_sell_side",
                requires_short_borrow=False,
                locate_available=True,
                recall_active=False,
                borrow_bps=0.0,
                squeeze_multiplier=1.0,
                projected_short_exposure_pct=0.0,
                stressed_short_exposure_pct=0.0,
            )

        positions = portfolio.get("positions", {}) or {}
        current_qty = float(positions.get(symbol, 0.0))
        post_qty = float(current_qty - float(order_qty))
        current_short_qty = abs(min(current_qty, 0.0))
        post_short_qty = abs(min(post_qty, 0.0))

        if post_short_qty <= current_short_qty + 1e-12:
            # Sell reduced a long but did not increase short borrow exposure.
            return ShortingDecision(
                approved=True,
                reason="no_incremental_short",
                requires_short_borrow=False,
                locate_available=True,
                recall_active=False,
                borrow_bps=0.0,
                squeeze_multiplier=1.0,
                projected_short_exposure_pct=0.0,
                stressed_short_exposure_pct=0.0,
            )

        if float(order_price) <= 0.0 or float(capital) <= 0.0:
            return ShortingDecision(
                approved=False,
                reason="invalid_short_pricing_or_capital",
                requires_short_borrow=True,
                locate_available=False,
                recall_active=False,
                borrow_bps=0.0,
                squeeze_multiplier=1.0,
                projected_short_exposure_pct=float("inf"),
                stressed_short_exposure_pct=float("inf"),
            )

        locate_available = self.registry.locate_available(symbol=symbol, venue=venue)
        recall_active = self.registry.recall_active(symbol=symbol, venue=venue)
        borrow_bps = self.registry.get_borrow_bps(
            symbol=symbol,
            venue=venue,
            default_borrow_bps=self.policy.default_borrow_bps,
        )
        squeeze_multiplier = self.registry.squeeze_multiplier(symbol=symbol, venue=venue)

        projected_short_notional = float(post_short_qty) * float(order_price)
        projected_short_exposure_pct = projected_short_notional / max(float(capital), 1e-12)
        stressed_short_exposure_pct = projected_short_exposure_pct * squeeze_multiplier

        if self.policy.require_locate and not locate_available:
            return ShortingDecision(
                approved=False,
                reason="no_locate",
                requires_short_borrow=True,
                locate_available=locate_available,
                recall_active=recall_active,
                borrow_bps=borrow_bps,
                squeeze_multiplier=squeeze_multiplier,
                projected_short_exposure_pct=projected_short_exposure_pct,
                stressed_short_exposure_pct=stressed_short_exposure_pct,
            )

        if recall_active:
            return ShortingDecision(
                approved=False,
                reason="recall_active",
                requires_short_borrow=True,
                locate_available=locate_available,
                recall_active=recall_active,
                borrow_bps=borrow_bps,
                squeeze_multiplier=squeeze_multiplier,
                projected_short_exposure_pct=projected_short_exposure_pct,
                stressed_short_exposure_pct=stressed_short_exposure_pct,
            )

        if borrow_bps > self.policy.max_borrow_bps:
            return ShortingDecision(
                approved=False,
                reason="borrow_too_expensive",
                requires_short_borrow=True,
                locate_available=locate_available,
                recall_active=recall_active,
                borrow_bps=borrow_bps,
                squeeze_multiplier=squeeze_multiplier,
                projected_short_exposure_pct=projected_short_exposure_pct,
                stressed_short_exposure_pct=stressed_short_exposure_pct,
            )

        if squeeze_multiplier > self.policy.max_squeeze_multiplier:
            return ShortingDecision(
                approved=False,
                reason="squeeze_risk_multiplier",
                requires_short_borrow=True,
                locate_available=locate_available,
                recall_active=recall_active,
                borrow_bps=borrow_bps,
                squeeze_multiplier=squeeze_multiplier,
                projected_short_exposure_pct=projected_short_exposure_pct,
                stressed_short_exposure_pct=stressed_short_exposure_pct,
            )

        if projected_short_exposure_pct > self.policy.max_short_exposure_pct:
            return ShortingDecision(
                approved=False,
                reason="short_exposure_limit",
                requires_short_borrow=True,
                locate_available=locate_available,
                recall_active=recall_active,
                borrow_bps=borrow_bps,
                squeeze_multiplier=squeeze_multiplier,
                projected_short_exposure_pct=projected_short_exposure_pct,
                stressed_short_exposure_pct=stressed_short_exposure_pct,
            )

        if stressed_short_exposure_pct > self.policy.max_short_exposure_pct:
            return ShortingDecision(
                approved=False,
                reason="squeeze_adjusted_exposure_limit",
                requires_short_borrow=True,
                locate_available=locate_available,
                recall_active=recall_active,
                borrow_bps=borrow_bps,
                squeeze_multiplier=squeeze_multiplier,
                projected_short_exposure_pct=projected_short_exposure_pct,
                stressed_short_exposure_pct=stressed_short_exposure_pct,
            )

        return ShortingDecision(
            approved=True,
            reason="approved",
            requires_short_borrow=True,
            locate_available=locate_available,
            recall_active=recall_active,
            borrow_bps=borrow_bps,
            squeeze_multiplier=squeeze_multiplier,
            projected_short_exposure_pct=projected_short_exposure_pct,
            stressed_short_exposure_pct=stressed_short_exposure_pct,
        )
