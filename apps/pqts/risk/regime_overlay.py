"""Regime-conditioned exposure throttling for pre-trade quantity control."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple


@dataclass(frozen=True)
class RegimeDecision:
    regime: str
    multiplier: float
    reason: str
    strategy_multiplier: float = 1.0
    strategy_blocked: bool = False


class RegimeExposureOverlay:
    """Classify market regime from microstructure and throttle exposure accordingly."""

    def __init__(self, config: Dict | None = None):
        cfg = config or {}
        self.enabled = bool(cfg.get("enabled", True))
        self.high_spread = float(cfg.get("high_spread", 0.0015))
        self.extreme_spread = float(cfg.get("extreme_spread", 0.004))
        self.low_volume = float(cfg.get("low_volume_24h", 300000.0))
        self.normal_multiplier = float(cfg.get("normal_multiplier", 1.0))
        self.high_vol_multiplier = float(cfg.get("high_vol_multiplier", 0.7))
        self.low_liquidity_multiplier = float(cfg.get("low_liquidity_multiplier", 0.5))
        self.crisis_multiplier = float(cfg.get("crisis_multiplier", 0.25))
        strategy_mult_cfg = cfg.get("strategy_multipliers", {}) or {}
        self.strategy_multipliers: Dict[str, Dict[str, float]] = {}
        for regime, regime_values in dict(strategy_mult_cfg).items():
            if not isinstance(regime_values, dict):
                continue
            self.strategy_multipliers[str(regime)] = {
                str(strategy_id): float(multiplier)
                for strategy_id, multiplier in regime_values.items()
            }
        disabled_cfg = cfg.get("disabled_strategies_by_regime", {}) or {}
        self.disabled_strategies_by_regime: Dict[str, set[str]] = {}
        for regime, values in dict(disabled_cfg).items():
            items = values if isinstance(values, (list, tuple, set)) else [values]
            self.disabled_strategies_by_regime[str(regime)] = {
                str(item).strip() for item in items if str(item).strip()
            }

    def classify(self, symbol: str, market_data: Dict) -> RegimeDecision:
        if not bool(self.enabled):
            return RegimeDecision("disabled", 1.0, "regime_overlay_disabled")

        spread = 0.0
        volume_24h = float(market_data.get("vol_24h", 0.0) or 0.0)

        for venue_payload in market_data.values():
            if not isinstance(venue_payload, dict):
                continue
            if symbol not in venue_payload:
                continue
            quote = venue_payload[symbol]
            if not isinstance(quote, dict):
                continue
            spread = max(spread, float(quote.get("spread", 0.0) or 0.0))
            volume_24h = max(volume_24h, float(quote.get("volume_24h", 0.0) or 0.0))

        if spread >= self.extreme_spread:
            return RegimeDecision("crisis", self.crisis_multiplier, "extreme_spread")
        if volume_24h > 0 and volume_24h <= self.low_volume:
            return RegimeDecision("low_liquidity", self.low_liquidity_multiplier, "low_volume")
        if spread >= self.high_spread:
            return RegimeDecision("high_vol", self.high_vol_multiplier, "high_spread")
        return RegimeDecision("normal", self.normal_multiplier, "within_limits")

    def strategy_adjustment(self, *, regime: str, strategy_id: str) -> Tuple[float, bool, str]:
        strategy_token = str(strategy_id or "").strip()
        if not strategy_token:
            return 1.0, False, "strategy_unspecified"
        blocked = strategy_token in self.disabled_strategies_by_regime.get(str(regime), set())
        if blocked:
            return 0.0, True, "strategy_blocked_for_regime"
        regime_map = self.strategy_multipliers.get(str(regime), {})
        multiplier = float(regime_map.get(strategy_token, 1.0))
        return max(multiplier, 0.0), False, "strategy_regime_multiplier"

    def throttle_quantity(
        self,
        symbol: str,
        quantity: float,
        market_data: Dict,
        *,
        strategy_id: str = "",
    ) -> Tuple[float, RegimeDecision]:
        decision = self.classify(symbol, market_data)
        strategy_multiplier, strategy_blocked, strategy_reason = self.strategy_adjustment(
            regime=decision.regime,
            strategy_id=strategy_id,
        )
        adjusted = float(quantity) * float(decision.multiplier) * float(strategy_multiplier)
        reason = decision.reason
        if strategy_id:
            reason = f"{decision.reason};{strategy_reason}"
        return max(adjusted, 0.0), RegimeDecision(
            regime=decision.regime,
            multiplier=decision.multiplier,
            reason=reason,
            strategy_multiplier=float(strategy_multiplier),
            strategy_blocked=bool(strategy_blocked),
        )
