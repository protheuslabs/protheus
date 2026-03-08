"""User risk-tolerance profiles and deterministic risk-limit scaling."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, Mapping


@dataclass(frozen=True)
class RiskToleranceProfile:
    """Normalized risk-tolerance profile."""

    name: str
    description: str
    risk_limit_scale: float
    canary_allocation_scale: float


_BUILTIN_PROFILES: Dict[str, RiskToleranceProfile] = {
    "conservative": RiskToleranceProfile(
        name="conservative",
        description="Lower risk appetite and tighter hard limits.",
        risk_limit_scale=0.60,
        canary_allocation_scale=0.65,
    ),
    "balanced": RiskToleranceProfile(
        name="balanced",
        description="Default profile with baseline hard limits.",
        risk_limit_scale=1.00,
        canary_allocation_scale=1.00,
    ),
    "aggressive": RiskToleranceProfile(
        name="aggressive",
        description="Higher risk appetite with wider hard limits.",
        risk_limit_scale=1.35,
        canary_allocation_scale=1.25,
    ),
    "professional": RiskToleranceProfile(
        name="professional",
        description="Expert profile for desks with strict monitoring and fast intervention.",
        risk_limit_scale=1.60,
        canary_allocation_scale=1.40,
    ),
}

_ALIASES = {
    "low": "conservative",
    "medium": "balanced",
    "moderate": "balanced",
    "high": "aggressive",
    "pro": "professional",
}

_SCALABLE_FLOAT_FIELDS = (
    "max_portfolio_risk_pct",
    "max_position_risk_pct",
    "max_daily_loss_pct",
    "max_drawdown_pct",
    "max_leverage",
    "max_gross_leverage",
    "max_order_notional",
    "max_participation",
    "max_single_position_pct",
    "max_slippage_bps",
    "daily_loss_limit",
)
_SCALABLE_INT_FIELDS = (
    "max_positions",
    "max_orders_per_minute",
)


def _normalize_name(value: str | None) -> str:
    token = str(value or "").strip().lower()
    if not token:
        return "balanced"
    return _ALIASES.get(token, token)


def _parse_profile(name: str, payload: Mapping[str, Any]) -> RiskToleranceProfile:
    scale = float(payload.get("risk_limit_scale", 1.0))
    canary = float(payload.get("canary_allocation_scale", scale))
    if scale <= 0:
        raise ValueError(f"risk_limit_scale must be > 0 for profile '{name}'")
    if canary <= 0:
        raise ValueError(f"canary_allocation_scale must be > 0 for profile '{name}'")
    return RiskToleranceProfile(
        name=name,
        description=str(payload.get("description", f"Custom profile '{name}'")),
        risk_limit_scale=scale,
        canary_allocation_scale=canary,
    )


def _custom_profiles(config: Mapping[str, Any]) -> Dict[str, RiskToleranceProfile]:
    risk_cfg = config.get("risk", {})
    if not isinstance(risk_cfg, Mapping):
        return {}
    payload = risk_cfg.get("risk_tolerance_profiles", {})
    if not isinstance(payload, Mapping):
        return {}

    profiles: Dict[str, RiskToleranceProfile] = {}
    for raw_name, raw_profile in payload.items():
        name = _normalize_name(str(raw_name))
        if not isinstance(raw_profile, Mapping):
            raise ValueError(f"Profile '{raw_name}' must be a mapping")
        profiles[name] = _parse_profile(name, raw_profile)
    return profiles


def resolve_risk_tolerance_profile(
    config: Mapping[str, Any],
    *,
    override_profile: str | None = None,
) -> RiskToleranceProfile:
    """Resolve profile from config and optional CLI/runtime override."""

    risk_cfg = config.get("risk", {})
    config_profile = ""
    if isinstance(risk_cfg, Mapping):
        config_profile = str(risk_cfg.get("risk_tolerance_profile", ""))
    selected = _normalize_name(override_profile or config_profile or "balanced")

    available: Dict[str, RiskToleranceProfile] = dict(_BUILTIN_PROFILES)
    available.update(_custom_profiles(config))
    if selected not in available:
        supported = ", ".join(sorted(available.keys()))
        raise ValueError(
            f"Unknown risk tolerance profile '{selected}'. Supported profiles: {supported}"
        )
    return available[selected]


def _scale_number(value: Any, scale: float) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return max(int(round(float(value) * float(scale))), 1)
    if isinstance(value, float):
        return max(float(value) * float(scale), 1e-9)
    return value


def _scale_mapping_values(payload: Mapping[str, Any], scale: float) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, value in payload.items():
        out[str(key)] = _scale_number(value, scale)
    return out


def resolve_effective_risk_config(
    config: Mapping[str, Any],
    *,
    override_profile: str | None = None,
) -> tuple[Dict[str, Any], RiskToleranceProfile]:
    """Return scaled risk config and resolved profile."""

    risk_cfg = config.get("risk", {})
    if not isinstance(risk_cfg, Mapping):
        risk_cfg = {}
    profile = resolve_risk_tolerance_profile(config, override_profile=override_profile)

    scaled: Dict[str, Any] = dict(risk_cfg)
    scale = float(profile.risk_limit_scale)

    for key in _SCALABLE_FLOAT_FIELDS:
        if key in scaled:
            value = scaled.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                scaled[key] = max(float(value) * scale, 1e-9)
    for key in _SCALABLE_INT_FIELDS:
        if key in scaled:
            value = scaled.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                scaled[key] = max(int(round(float(value) * scale)), 1)
    for key in ("max_symbol_notional", "max_venue_notional"):
        value = scaled.get(key)
        if isinstance(value, Mapping):
            scaled[key] = _scale_mapping_values(value, scale)

    return scaled, profile


def scale_canary_steps_for_profile(
    steps: Iterable[float],
    *,
    profile: RiskToleranceProfile,
) -> list[float]:
    """Scale canary allocation steps by profile and clamp into [0, 1]."""

    scaled_steps: list[float] = []
    previous = 0.0
    for raw in steps:
        value = float(raw) * float(profile.canary_allocation_scale)
        value = max(min(value, 1.0), 0.0)
        value = max(value, previous)
        rounded = round(value, 6)
        if not scaled_steps or rounded != scaled_steps[-1]:
            scaled_steps.append(rounded)
        previous = value
    if not scaled_steps:
        scaled_steps.append(0.01)
    return scaled_steps


def risk_profile_payload(profile: RiskToleranceProfile) -> Dict[str, Any]:
    return {
        "name": profile.name,
        "description": profile.description,
        "risk_limit_scale": float(profile.risk_limit_scale),
        "canary_allocation_scale": float(profile.canary_allocation_scale),
    }
