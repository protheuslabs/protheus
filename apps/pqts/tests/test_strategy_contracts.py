"""Tests for strategy contract validation."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.strategy_contracts import validate_strategy_contract, validate_strategy_contracts


def test_validate_strategy_contract_accepts_valid_config():
    result = validate_strategy_contract(
        "swing_trend",
        {
            "enabled": True,
            "markets": ["crypto", "equities"],
            "max_positions": 4,
            "risk_budget_pct": 0.25,
        },
    )
    assert result.valid is True
    assert result.violations == []


def test_validate_strategy_contract_rejects_unknown_markets_and_bad_limits():
    result = validate_strategy_contract(
        "bad_strategy",
        {
            "enabled": "yes",
            "markets": ["crypto", "futures"],
            "max_positions": 0,
            "risk_budget_pct": 150.0,
        },
    )
    assert result.valid is False
    assert "enabled_must_be_bool" in result.violations
    assert any(token.startswith("unknown_markets:") for token in result.violations)
    assert "max_positions_must_be_positive" in result.violations
    assert "risk_budget_pct_out_of_range" in result.violations


def test_validate_strategy_contracts_bulk():
    results = validate_strategy_contracts(
        {
            "a": {"enabled": True},
            "b": {"enabled": True, "markets": []},
        }
    )
    assert results["a"].valid is True
    assert results["b"].valid is False
