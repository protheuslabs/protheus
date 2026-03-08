"""Tests for engine configuration validation."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config_validation import validate_engine_config


def test_validate_engine_config_flags_missing_sections():
    issues = validate_engine_config({"mode": "paper_trading"})
    keys = {issue.key for issue in issues}
    assert "markets" in keys
    assert "strategies" in keys
    assert "risk" in keys


def test_validate_engine_config_accepts_valid_minimum():
    config = {
        "mode": "paper_trading",
        "markets": {"crypto": {"enabled": True}},
        "strategies": {"trend_following": {"enabled": True}},
        "risk": {"initial_capital": 100000.0},
        "runtime": {"autopilot": {"mode": "manual"}},
    }
    issues = validate_engine_config(config)
    assert issues == []
