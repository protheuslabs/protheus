"""Tests for operator-tier resolution and override constraints."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.operator_tier import resolve_operator_tier, validate_operator_tier_overrides


def test_resolve_operator_tier_uses_override():
    tier = resolve_operator_tier({"runtime": {"operator_tier": "simple"}}, override="pro")
    assert tier.name == "pro"


def test_validate_operator_tier_restricts_simple_overrides():
    tier = resolve_operator_tier({"runtime": {"operator_tier": "simple"}})
    with pytest.raises(ValueError):
        validate_operator_tier_overrides(
            tier=tier,
            has_market_override=True,
            has_strategy_override=False,
            has_symbol_override=False,
        )
