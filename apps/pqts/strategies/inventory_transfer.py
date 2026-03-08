"""Inventory risk-transfer logic for market making inventories."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class InventoryTransferOrder:
    symbol: str
    side: str
    quantity: float
    expected_notional: float
    reason: str


class InventoryRiskTransferEngine:
    """Generate de-risking transfer orders when inventory approaches hard limits."""

    def __init__(self, threshold_ratio: float = 0.8, target_ratio: float = 0.3, hedge_ratio: float = 1.0):
        self.threshold_ratio = float(threshold_ratio)
        self.target_ratio = float(target_ratio)
        self.hedge_ratio = float(hedge_ratio)

    def suggest_transfer(
        self,
        *,
        symbol: str,
        inventory: float,
        max_position: float,
        mid_price: float,
    ) -> Optional[InventoryTransferOrder]:
        if max_position <= 0:
            return None

        usage = abs(float(inventory)) / float(max_position)
        if usage < self.threshold_ratio:
            return None

        target_inventory = float(max_position) * self.target_ratio
        excess = max(abs(float(inventory)) - target_inventory, 0.0)
        if excess <= 0:
            return None

        side = "sell" if inventory > 0 else "buy"
        expected_notional = float(excess) * float(mid_price) * self.hedge_ratio
        return InventoryTransferOrder(
            symbol=symbol,
            side=side,
            quantity=float(excess),
            expected_notional=expected_notional,
            reason=f"inventory_usage={usage:.2f}",
        )
