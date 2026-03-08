"""Tests for tier-aware autopilot policy packs and enforcement."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.autopilot_policy import enforce_autopilot_policy, resolve_autopilot_policy_pack


def test_resolve_autopilot_policy_pack_defaults_by_tier():
    cfg = {"runtime": {}}
    simple = resolve_autopilot_policy_pack(cfg, tier_name="simple")
    pro = resolve_autopilot_policy_pack(cfg, tier_name="pro")

    assert simple.max_active_strategies <= 3
    assert simple.allowed_strategies is not None
    assert pro.allowed_strategies is None
    assert pro.max_active_strategies >= simple.max_active_strategies


def test_enforce_autopilot_policy_drops_non_allowed_and_expands_to_min():
    policy = resolve_autopilot_policy_pack({"runtime": {}}, tier_name="simple")
    enforced = enforce_autopilot_policy(
        selected=["ml", "liquidity_sweep"],
        ranked_candidates=["trend_following", "mean_reversion", "ml"],
        policy=policy,
    )

    assert enforced.selected
    assert "ml" in enforced.dropped
    assert all(name in policy.allowed_strategies for name in enforced.selected)
    assert len(enforced.selected) >= policy.min_active_strategies


def test_enforce_autopilot_policy_respects_max_active():
    policy = resolve_autopilot_policy_pack(
        {
            "runtime": {
                "autopilot_policy_packs": {
                    "pro": {
                        "max_active_strategies": 2,
                    }
                }
            }
        },
        tier_name="pro",
    )
    enforced = enforce_autopilot_policy(
        selected=["a", "b", "c"],
        ranked_candidates=["a", "b", "c"],
        policy=policy,
    )
    assert enforced.selected == ["a", "b"]
