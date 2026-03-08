"""Tests for centralized mechanism switch resolution and application."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.mechanism_switches import (
    apply_mechanism_switches,
    list_switches,
    parse_switch_overrides,
    resolve_mechanism_switches,
)


def test_parse_switch_overrides_accepts_aliases_and_boolean_tokens():
    overrides = parse_switch_overrides(
        [
            "capacity=on",
            "routing_failover=off",
            "slippage_stress=false",
            "md_resilience=1",
            "confidence=on",
            "alpha_gate=on",
        ]
    )

    assert overrides["capacity_curves"] is True
    assert overrides["routing_failover"] is False
    assert overrides["slippage_stress_model"] is False
    assert overrides["market_data_resilience"] is True
    assert overrides["confidence_allocator"] is True
    assert overrides["profitability_gate"] is True


def test_parse_switch_overrides_rejects_invalid_entries():
    with pytest.raises(ValueError):
        parse_switch_overrides(["capacity_curves"])
    with pytest.raises(ValueError):
        parse_switch_overrides(["unknown=on"])
    with pytest.raises(ValueError):
        parse_switch_overrides(["capacity_curves=maybe"])


def test_resolve_mechanism_switches_uses_config_defaults_then_overrides():
    config = {
        "execution": {
            "capacity_curves": {"enabled": False},
            "allocation_controls": {"enabled": True},
            "regime_overlay": {"enabled": True},
            "maker_urgency_ladder": {"enabled": True},
            "confidence_allocator": {"enabled": False},
            "shorting_controls": {"enabled": False},
            "profitability_gate": {"enabled": True},
            "market_data_resilience": {"enabled": True},
            "reliability": {"enable_failover": True},
            "tca_calibration": {"enabled": True},
            "paper_fill_model": {"reality_stress_mode": True},
        },
        "mechanism_switches": {
            "capacity_curves": True,
            "allocation_controls": False,
        },
    }
    resolved = resolve_mechanism_switches(
        config,
        overrides={
            "capacity_curves": False,
            "market_data_resilience": False,
            "profitability_gate": False,
        },
    )

    assert set(resolved.keys()) == set(list_switches())
    assert resolved["capacity_curves"] is False
    assert resolved["allocation_controls"] is False
    assert resolved["market_data_resilience"] is False
    assert resolved["profitability_gate"] is False
    assert resolved["routing_failover"] is True
    assert resolved["maker_urgency_ladder"] is True
    assert resolved["confidence_allocator"] is False


def test_apply_mechanism_switches_materializes_execution_paths():
    switched, state = apply_mechanism_switches(
        {"execution": {}, "mechanism_switches": {"regime_overlay": False}},
        overrides={"shorting_controls": True, "tca_calibration_feedback": False},
    )

    assert state["regime_overlay"] is False
    assert state["shorting_controls"] is True
    assert state["tca_calibration_feedback"] is False

    execution = switched["execution"]
    assert execution["regime_overlay"]["enabled"] is False
    assert execution["shorting_controls"]["enabled"] is True
    assert execution["profitability_gate"]["enabled"] is False
    assert execution["tca_calibration"]["enabled"] is False
    assert execution["maker_urgency_ladder"]["enabled"] is True
    assert execution["confidence_allocator"]["enabled"] is False
    assert switched["mechanism_switches"]["shorting_controls"] is True
