"""Tier-aware autopilot policy packs for strategy accessibility and safety."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set


@dataclass(frozen=True)
class AutopilotPolicyPack:
    name: str
    allowed_strategies: Optional[Set[str]]
    min_active_strategies: int
    max_active_strategies: int


@dataclass(frozen=True)
class EnforcedAutopilotSelection:
    selected: List[str]
    dropped: List[str]
    added: List[str]
    reasons: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "selected": list(self.selected),
            "dropped": list(self.dropped),
            "added": list(self.added),
            "reasons": list(self.reasons),
        }


def _set_or_none(values: Any) -> Optional[Set[str]]:
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


def _default_policy_packs() -> Dict[str, AutopilotPolicyPack]:
    return {
        "simple": AutopilotPolicyPack(
            name="simple",
            allowed_strategies={
                "trend_following",
                "mean_reversion",
                "swing_trend",
                "hold_carry",
            },
            min_active_strategies=1,
            max_active_strategies=3,
        ),
        "pro": AutopilotPolicyPack(
            name="pro",
            allowed_strategies=None,
            min_active_strategies=1,
            max_active_strategies=10,
        ),
    }


def resolve_autopilot_policy_pack(
    config: Mapping[str, Any],
    *,
    tier_name: str,
) -> AutopilotPolicyPack:
    tier = str(tier_name).strip().lower()
    defaults = _default_policy_packs()
    base = defaults.get(tier, defaults["pro"])

    runtime = config.get("runtime", {})
    raw = {}
    if isinstance(runtime, Mapping):
        raw = runtime.get("autopilot_policy_packs", {}) or {}
    tier_cfg = raw.get(tier, {}) if isinstance(raw, Mapping) else {}
    if not isinstance(tier_cfg, Mapping):
        tier_cfg = {}

    allowed = _set_or_none(tier_cfg.get("allowed_strategies", base.allowed_strategies))
    min_active = max(int(tier_cfg.get("min_active_strategies", base.min_active_strategies)), 1)
    max_active = max(
        int(tier_cfg.get("max_active_strategies", base.max_active_strategies)), min_active
    )

    return AutopilotPolicyPack(
        name=tier,
        allowed_strategies=allowed,
        min_active_strategies=min_active,
        max_active_strategies=max_active,
    )


def enforce_autopilot_policy(
    *,
    selected: Iterable[str],
    ranked_candidates: Iterable[str],
    policy: AutopilotPolicyPack,
) -> EnforcedAutopilotSelection:
    selected_list = [str(name) for name in selected if str(name).strip()]
    ranked_list = [str(name) for name in ranked_candidates if str(name).strip()]
    reasons: List[str] = []
    dropped: List[str] = []
    added: List[str] = []

    if policy.allowed_strategies is not None:
        allowed = set(policy.allowed_strategies)
        filtered = []
        for name in selected_list:
            if name in allowed:
                filtered.append(name)
            else:
                dropped.append(name)
        selected_list = filtered
        if dropped:
            reasons.append("dropped_not_allowed_for_tier")

    # Deduplicate while preserving order.
    seen = set()
    deduped = []
    for name in selected_list:
        if name in seen:
            continue
        seen.add(name)
        deduped.append(name)
    selected_list = deduped

    if len(selected_list) > policy.max_active_strategies:
        dropped.extend(selected_list[policy.max_active_strategies :])
        selected_list = selected_list[: policy.max_active_strategies]
        reasons.append("trimmed_to_max_active_strategies")

    if len(selected_list) < policy.min_active_strategies:
        allowed = set(policy.allowed_strategies) if policy.allowed_strategies is not None else None
        for name in ranked_list:
            if name in selected_list:
                continue
            if allowed is not None and name not in allowed:
                continue
            selected_list.append(name)
            added.append(name)
            if len(selected_list) >= policy.min_active_strategies:
                break
        if added:
            reasons.append("expanded_to_min_active_strategies")

    if not selected_list and ranked_list:
        allowed = set(policy.allowed_strategies) if policy.allowed_strategies is not None else None
        for name in ranked_list:
            if allowed is None or name in allowed:
                selected_list = [name]
                added.append(name)
                reasons.append("fallback_ranked_candidate_selected")
                break

    return EnforcedAutopilotSelection(
        selected=selected_list,
        dropped=sorted(set(dropped)),
        added=sorted(set(added)),
        reasons=reasons,
    )
