"""Tenant entitlements for operator UX + strategy access controls."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set


@dataclass(frozen=True)
class TenantEntitlements:
    tenant_id: str
    plan: str
    allowed_markets: Optional[Set[str]]
    strategy_allowlist: Optional[Set[str]]
    min_active_strategies: int
    max_active_strategies: int
    allow_live_trading: bool


@dataclass(frozen=True)
class TenantEnforcementResult:
    selected: List[str]
    active_markets: List[str]
    dropped_markets: List[str]
    dropped_strategies: List[str]
    reasons: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "selected": list(self.selected),
            "active_markets": list(self.active_markets),
            "dropped_markets": list(self.dropped_markets),
            "dropped_strategies": list(self.dropped_strategies),
            "reasons": list(self.reasons),
        }


def _as_set(values: Any) -> Optional[Set[str]]:
    if values is None:
        return None
    if isinstance(values, str):
        token = values.strip()
        return {token} if token else set()
    out: Set[str] = set()
    for value in values:
        token = str(value).strip()
        if token:
            out.add(token)
    return out


def _default_plans() -> Dict[str, TenantEntitlements]:
    return {
        "starter": TenantEntitlements(
            tenant_id="starter",
            plan="starter",
            allowed_markets={"crypto"},
            strategy_allowlist={"trend_following", "mean_reversion", "swing_trend", "hold_carry"},
            min_active_strategies=1,
            max_active_strategies=3,
            allow_live_trading=False,
        ),
        "pro": TenantEntitlements(
            tenant_id="pro",
            plan="pro",
            allowed_markets={"crypto", "equities", "forex"},
            strategy_allowlist=None,
            min_active_strategies=1,
            max_active_strategies=8,
            allow_live_trading=True,
        ),
        "enterprise": TenantEntitlements(
            tenant_id="enterprise",
            plan="enterprise",
            allowed_markets=None,
            strategy_allowlist=None,
            min_active_strategies=1,
            max_active_strategies=64,
            allow_live_trading=True,
        ),
    }


def resolve_tenant_entitlements(
    config: Mapping[str, Any],
    *,
    tenant_id_override: Optional[str] = None,
    plan_override: Optional[str] = None,
) -> TenantEntitlements:
    runtime = config.get("runtime", {})
    tenant_cfg: Mapping[str, Any] = {}
    if isinstance(runtime, Mapping):
        raw = runtime.get("tenant", {}) or {}
        if isinstance(raw, Mapping):
            tenant_cfg = raw

    defaults = _default_plans()
    plan = (
        str(
            plan_override
            or tenant_cfg.get("plan", "")
            or (runtime.get("tenant_plan", "") if isinstance(runtime, Mapping) else "")
            or "enterprise"
        )
        .strip()
        .lower()
    )
    if plan not in defaults:
        supported = ", ".join(sorted(defaults.keys()))
        raise ValueError(f"Unknown tenant plan '{plan}'. Supported: {supported}")
    base = defaults[plan]

    tenant_id = (
        str(tenant_id_override or tenant_cfg.get("tenant_id", "default")).strip() or "default"
    )
    allowed_markets = _as_set(tenant_cfg.get("allowed_markets", base.allowed_markets))
    strategy_allowlist = _as_set(tenant_cfg.get("strategy_allowlist", base.strategy_allowlist))
    min_active = max(int(tenant_cfg.get("min_active_strategies", base.min_active_strategies)), 1)
    max_active = max(
        int(tenant_cfg.get("max_active_strategies", base.max_active_strategies)), min_active
    )
    allow_live = bool(tenant_cfg.get("allow_live_trading", base.allow_live_trading))

    return TenantEntitlements(
        tenant_id=tenant_id,
        plan=plan,
        allowed_markets=allowed_markets,
        strategy_allowlist=strategy_allowlist,
        min_active_strategies=min_active,
        max_active_strategies=max_active,
        allow_live_trading=allow_live,
    )


def enforce_tenant_entitlements(
    *,
    selected: Iterable[str],
    active_markets: Iterable[str],
    ranked_candidates: Iterable[str],
    entitlements: TenantEntitlements,
) -> TenantEnforcementResult:
    selected_list = [str(name) for name in selected if str(name).strip()]
    markets = [str(name) for name in active_markets if str(name).strip()]
    ranked = [str(name) for name in ranked_candidates if str(name).strip()]

    dropped_markets: List[str] = []
    dropped_strategies: List[str] = []
    reasons: List[str] = []

    if entitlements.allowed_markets is not None:
        allowed_markets = set(entitlements.allowed_markets)
        filtered_markets = [market for market in markets if market in allowed_markets]
        dropped_markets = sorted(set(markets).difference(filtered_markets))
        if dropped_markets:
            reasons.append("dropped_markets_not_permitted_by_plan")
        if not filtered_markets and allowed_markets:
            filtered_markets = sorted(allowed_markets)[:1]
            reasons.append("fallback_market_selected_from_allowed_set")
        markets = filtered_markets

    if entitlements.strategy_allowlist is not None:
        allowed_strategies = set(entitlements.strategy_allowlist)
        filtered = [name for name in selected_list if name in allowed_strategies]
        dropped_strategies.extend(sorted(set(selected_list).difference(filtered)))
        if len(filtered) != len(selected_list):
            reasons.append("dropped_strategies_not_permitted_by_plan")
        selected_list = filtered

    # Deduplicate while preserving order.
    seen = set()
    deduped: List[str] = []
    for name in selected_list:
        if name in seen:
            continue
        seen.add(name)
        deduped.append(name)
    selected_list = deduped

    if len(selected_list) > entitlements.max_active_strategies:
        dropped_strategies.extend(selected_list[entitlements.max_active_strategies :])
        selected_list = selected_list[: entitlements.max_active_strategies]
        reasons.append("trimmed_to_plan_max_active_strategies")

    if len(selected_list) < entitlements.min_active_strategies:
        allowlist = (
            set(entitlements.strategy_allowlist)
            if entitlements.strategy_allowlist is not None
            else None
        )
        for candidate in ranked:
            if candidate in selected_list:
                continue
            if allowlist is not None and candidate not in allowlist:
                continue
            selected_list.append(candidate)
            if len(selected_list) >= entitlements.min_active_strategies:
                reasons.append("expanded_to_plan_min_active_strategies")
                break

    return TenantEnforcementResult(
        selected=list(selected_list),
        active_markets=list(markets),
        dropped_markets=sorted(set(dropped_markets)),
        dropped_strategies=sorted(set(dropped_strategies)),
        reasons=list(reasons),
    )
