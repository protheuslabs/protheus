"""Operator UX tiers for simple vs pro runtime controls."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional


@dataclass(frozen=True)
class OperatorTier:
    name: str
    description: str
    allow_market_override: bool
    allow_strategy_override: bool
    allow_direct_symbol_list: bool


_TIERS = {
    "simple": OperatorTier(
        name="simple",
        description="Safe defaults for non-technical operators.",
        allow_market_override=False,
        allow_strategy_override=False,
        allow_direct_symbol_list=False,
    ),
    "pro": OperatorTier(
        name="pro",
        description="Full runtime override controls for quant operators.",
        allow_market_override=True,
        allow_strategy_override=True,
        allow_direct_symbol_list=True,
    ),
}


def resolve_operator_tier(
    config: Mapping[str, Any],
    *,
    override: Optional[str] = None,
) -> OperatorTier:
    runtime = config.get("runtime", {})
    configured = ""
    if isinstance(runtime, Mapping):
        configured = str(runtime.get("operator_tier", ""))
    selected = str(override or configured or "pro").strip().lower()
    if selected not in _TIERS:
        supported = ", ".join(sorted(_TIERS.keys()))
        raise ValueError(f"Unknown operator tier '{selected}'. Supported: {supported}")
    return _TIERS[selected]


def validate_operator_tier_overrides(
    *,
    tier: OperatorTier,
    has_market_override: bool,
    has_strategy_override: bool,
    has_symbol_override: bool = False,
) -> None:
    if has_market_override and not tier.allow_market_override:
        raise ValueError(
            f"operator tier '{tier.name}' does not allow direct market overrides. "
            "Use --profile for curated presets."
        )
    if has_strategy_override and not tier.allow_strategy_override:
        raise ValueError(
            f"operator tier '{tier.name}' does not allow direct strategy overrides. "
            "Use --profile for curated presets."
        )
    if has_symbol_override and not tier.allow_direct_symbol_list:
        raise ValueError(
            f"operator tier '{tier.name}' does not allow direct symbol overrides. "
            "Use config defaults or curated profiles."
        )
