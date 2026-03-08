"""Centralized mechanism switch resolution for A/B and ablation testing."""

from __future__ import annotations

import copy
from collections.abc import Mapping, MutableMapping
from typing import Any, Dict, Iterable

SWITCH_KEYS: tuple[str, ...] = (
    "routing_failover",
    "capacity_curves",
    "allocation_controls",
    "regime_overlay",
    "maker_urgency_ladder",
    "confidence_allocator",
    "shorting_controls",
    "profitability_gate",
    "market_data_resilience",
    "tca_calibration_feedback",
    "slippage_stress_model",
)

_ALIASES: Dict[str, str] = {
    "routing_failover": "routing_failover",
    "failover": "routing_failover",
    "capacity_curves": "capacity_curves",
    "capacity": "capacity_curves",
    "allocation_controls": "allocation_controls",
    "allocation": "allocation_controls",
    "regime_overlay": "regime_overlay",
    "regime": "regime_overlay",
    "maker_urgency_ladder": "maker_urgency_ladder",
    "maker_ladder": "maker_urgency_ladder",
    "urgency_ladder": "maker_urgency_ladder",
    "confidence_allocator": "confidence_allocator",
    "confidence_alloc": "confidence_allocator",
    "confidence": "confidence_allocator",
    "shorting_controls": "shorting_controls",
    "shorting": "shorting_controls",
    "profitability_gate": "profitability_gate",
    "profitability": "profitability_gate",
    "alpha_gate": "profitability_gate",
    "market_data_resilience": "market_data_resilience",
    "market_data": "market_data_resilience",
    "md_resilience": "market_data_resilience",
    "tca_calibration_feedback": "tca_calibration_feedback",
    "tca_calibration": "tca_calibration_feedback",
    "calibration": "tca_calibration_feedback",
    "slippage_stress_model": "slippage_stress_model",
    "slippage_stress": "slippage_stress_model",
    "stress_model": "slippage_stress_model",
}

_TRUE_TOKENS = {"1", "true", "on", "yes", "enabled"}
_FALSE_TOKENS = {"0", "false", "off", "no", "disabled"}


def list_switches() -> tuple[str, ...]:
    return SWITCH_KEYS


def _normalize_switch_name(name: str) -> str:
    token = str(name or "").strip().lower().replace("-", "_")
    if token in _ALIASES:
        return _ALIASES[token]
    raise ValueError(f"Unknown mechanism switch '{name}'. Valid switches: {', '.join(SWITCH_KEYS)}")


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return bool(value)
    token = str(value or "").strip().lower()
    if token in _TRUE_TOKENS:
        return True
    if token in _FALSE_TOKENS:
        return False
    raise ValueError(f"Invalid switch value '{value}'. Use one of on/off,true/false,1/0.")


def parse_switch_overrides(raw_switches: Iterable[str] | None) -> Dict[str, bool]:
    if raw_switches is None:
        return {}
    overrides: Dict[str, bool] = {}
    for row in raw_switches:
        token = str(row or "").strip()
        if not token:
            continue
        if "=" not in token:
            raise ValueError(f"Invalid --switch '{token}'. Expected format '<mechanism>=on|off'.")
        name, value = token.split("=", 1)
        overrides[_normalize_switch_name(name)] = _coerce_bool(value)
    return overrides


def _switch_defaults(config: Mapping[str, Any]) -> Dict[str, bool]:
    execution_cfg = config.get("execution", {})
    if not isinstance(execution_cfg, Mapping):
        execution_cfg = {}

    reliability_cfg = execution_cfg.get("reliability", {})
    capacity_cfg = execution_cfg.get("capacity_curves", {})
    allocation_cfg = execution_cfg.get("allocation_controls", {})
    regime_cfg = execution_cfg.get("regime_overlay", {})
    maker_ladder_cfg = execution_cfg.get("maker_urgency_ladder", {})
    confidence_alloc_cfg = execution_cfg.get("confidence_allocator", {})
    shorting_cfg = execution_cfg.get("shorting_controls", {})
    profitability_cfg = execution_cfg.get("profitability_gate", {})
    md_resilience_cfg = execution_cfg.get("market_data_resilience", {})
    tca_calibration_cfg = execution_cfg.get("tca_calibration", {})
    paper_fill_cfg = execution_cfg.get("paper_fill_model", {})

    if not isinstance(reliability_cfg, Mapping):
        reliability_cfg = {}
    if not isinstance(capacity_cfg, Mapping):
        capacity_cfg = {}
    if not isinstance(allocation_cfg, Mapping):
        allocation_cfg = {}
    if not isinstance(regime_cfg, Mapping):
        regime_cfg = {}
    if not isinstance(maker_ladder_cfg, Mapping):
        maker_ladder_cfg = {}
    if not isinstance(confidence_alloc_cfg, Mapping):
        confidence_alloc_cfg = {}
    if not isinstance(shorting_cfg, Mapping):
        shorting_cfg = {}
    if not isinstance(profitability_cfg, Mapping):
        profitability_cfg = {}
    if not isinstance(md_resilience_cfg, Mapping):
        md_resilience_cfg = {}
    if not isinstance(tca_calibration_cfg, Mapping):
        tca_calibration_cfg = {}
    if not isinstance(paper_fill_cfg, Mapping):
        paper_fill_cfg = {}

    return {
        "routing_failover": bool(reliability_cfg.get("enable_failover", True)),
        "capacity_curves": bool(capacity_cfg.get("enabled", False)),
        "allocation_controls": bool(allocation_cfg.get("enabled", False)),
        "regime_overlay": bool(regime_cfg.get("enabled", True)),
        "maker_urgency_ladder": bool(maker_ladder_cfg.get("enabled", True)),
        "confidence_allocator": bool(confidence_alloc_cfg.get("enabled", False)),
        "shorting_controls": bool(shorting_cfg.get("enabled", False)),
        "profitability_gate": bool(profitability_cfg.get("enabled", False)),
        "market_data_resilience": bool(md_resilience_cfg.get("enabled", True)),
        "tca_calibration_feedback": bool(tca_calibration_cfg.get("enabled", True)),
        "slippage_stress_model": bool(paper_fill_cfg.get("reality_stress_mode", True)),
    }


def resolve_mechanism_switches(
    config: Mapping[str, Any],
    *,
    overrides: Mapping[str, bool] | None = None,
) -> Dict[str, bool]:
    defaults = _switch_defaults(config)
    configured = config.get("mechanism_switches", {})
    if not isinstance(configured, Mapping):
        configured = {}

    resolved: Dict[str, bool] = {}
    for key in SWITCH_KEYS:
        value = configured.get(key, defaults[key])
        resolved[key] = _coerce_bool(value)

    for raw_key, raw_value in (overrides or {}).items():
        key = _normalize_switch_name(str(raw_key))
        resolved[key] = _coerce_bool(raw_value)

    return resolved


def _ensure_dict(parent: MutableMapping[str, Any], key: str) -> MutableMapping[str, Any]:
    value = parent.get(key, {})
    if not isinstance(value, MutableMapping):
        value = {}
    parent[key] = value
    return value


def apply_mechanism_switches(
    config: Mapping[str, Any],
    *,
    overrides: Mapping[str, bool] | None = None,
) -> tuple[Dict[str, Any], Dict[str, bool]]:
    switched = copy.deepcopy(dict(config))
    state = resolve_mechanism_switches(switched, overrides=overrides)

    execution_cfg = _ensure_dict(switched, "execution")
    reliability_cfg = _ensure_dict(execution_cfg, "reliability")
    capacity_cfg = _ensure_dict(execution_cfg, "capacity_curves")
    allocation_cfg = _ensure_dict(execution_cfg, "allocation_controls")
    regime_cfg = _ensure_dict(execution_cfg, "regime_overlay")
    maker_ladder_cfg = _ensure_dict(execution_cfg, "maker_urgency_ladder")
    confidence_alloc_cfg = _ensure_dict(execution_cfg, "confidence_allocator")
    shorting_cfg = _ensure_dict(execution_cfg, "shorting_controls")
    profitability_cfg = _ensure_dict(execution_cfg, "profitability_gate")
    md_resilience_cfg = _ensure_dict(execution_cfg, "market_data_resilience")
    tca_calibration_cfg = _ensure_dict(execution_cfg, "tca_calibration")
    paper_fill_cfg = _ensure_dict(execution_cfg, "paper_fill_model")

    reliability_cfg["enable_failover"] = bool(state["routing_failover"])
    capacity_cfg["enabled"] = bool(state["capacity_curves"])
    allocation_cfg["enabled"] = bool(state["allocation_controls"])
    regime_cfg["enabled"] = bool(state["regime_overlay"])
    maker_ladder_cfg["enabled"] = bool(state["maker_urgency_ladder"])
    confidence_alloc_cfg["enabled"] = bool(state["confidence_allocator"])
    shorting_cfg["enabled"] = bool(state["shorting_controls"])
    profitability_cfg["enabled"] = bool(state["profitability_gate"])
    md_resilience_cfg["enabled"] = bool(state["market_data_resilience"])
    tca_calibration_cfg["enabled"] = bool(state["tca_calibration_feedback"])
    paper_fill_cfg["reality_stress_mode"] = bool(state["slippage_stress_model"])
    switched["mechanism_switches"] = dict(state)

    return switched, state
