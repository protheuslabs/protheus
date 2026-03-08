"""Venue fee/rebate optimization for routing and maker/taker decisions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional


@dataclass(frozen=True)
class FeeTier:
    """Fee tier schedule for one venue."""

    monthly_volume_usd: float
    maker_fee_bps: float
    taker_fee_bps: float
    maker_rebate_bps: float = 0.0


class FeeRebateOptimizer:
    """Deterministic fee calculator and order-style advisor."""

    def __init__(
        self,
        tiers_by_venue: Optional[Dict[str, List[Dict]]] = None,
        default_maker_fee_bps: float = 10.0,
        default_taker_fee_bps: float = 12.0,
    ):
        self.default_maker_fee_bps = float(default_maker_fee_bps)
        self.default_taker_fee_bps = float(default_taker_fee_bps)
        self.tiers_by_venue: Dict[str, List[FeeTier]] = {}

        for venue, rows in (tiers_by_venue or {}).items():
            parsed = [
                FeeTier(
                    monthly_volume_usd=float(item.get("monthly_volume_usd", 0.0)),
                    maker_fee_bps=float(item.get("maker_fee_bps", self.default_maker_fee_bps)),
                    taker_fee_bps=float(item.get("taker_fee_bps", self.default_taker_fee_bps)),
                    maker_rebate_bps=float(item.get("maker_rebate_bps", 0.0)),
                )
                for item in rows
            ]
            parsed.sort(key=lambda t: t.monthly_volume_usd)
            self.tiers_by_venue[str(venue).lower()] = parsed

    def get_tier(self, venue: str, monthly_volume_usd: float) -> FeeTier:
        tiers = self.tiers_by_venue.get(str(venue).lower(), [])
        if not tiers:
            return FeeTier(
                monthly_volume_usd=0.0,
                maker_fee_bps=self.default_maker_fee_bps,
                taker_fee_bps=self.default_taker_fee_bps,
                maker_rebate_bps=0.0,
            )

        current = tiers[0]
        for tier in tiers:
            if monthly_volume_usd >= tier.monthly_volume_usd:
                current = tier
            else:
                break
        return current

    def effective_fee_bps(self, venue: str, *, is_maker: bool, monthly_volume_usd: float) -> float:
        tier = self.get_tier(venue, monthly_volume_usd)
        if is_maker:
            return float(tier.maker_fee_bps - tier.maker_rebate_bps)
        return float(tier.taker_fee_bps)

    def best_venue(
        self,
        venues: Iterable[str],
        *,
        is_maker: bool,
        monthly_volume_by_venue: Optional[Dict[str, float]] = None,
    ) -> Optional[str]:
        best = None
        best_fee = float("inf")
        for venue in venues:
            monthly_volume = float((monthly_volume_by_venue or {}).get(venue, 0.0))
            fee = self.effective_fee_bps(
                venue, is_maker=is_maker, monthly_volume_usd=monthly_volume
            )
            if fee < best_fee:
                best_fee = fee
                best = venue
        return best

    def recommend_order_style(
        self,
        *,
        venue: str,
        spread_bps: float,
        urgency: str,
        monthly_volume_usd: float,
    ) -> str:
        """
        Decide between maker and taker using fee/rebate and spread economics.

        Returns:
            "maker" or "taker"
        """
        if str(urgency).lower() in {"urgent", "ioc"}:
            return "taker"

        maker_fee = self.effective_fee_bps(
            venue, is_maker=True, monthly_volume_usd=monthly_volume_usd
        )
        taker_fee = self.effective_fee_bps(
            venue, is_maker=False, monthly_volume_usd=monthly_volume_usd
        )

        # Approximate all-in: maker may capture half-spread, taker pays half-spread.
        maker_all_in = maker_fee - (float(spread_bps) * 0.5)
        taker_all_in = taker_fee + (float(spread_bps) * 0.5)
        return "maker" if maker_all_in <= taker_all_in else "taker"
