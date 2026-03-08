"""Deterministic strategy contract validation for runtime registration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Sequence

KNOWN_MARKETS = {"crypto", "equities", "forex"}


@dataclass(frozen=True)
class StrategyContractResult:
    strategy: str
    valid: bool
    violations: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "strategy": self.strategy,
            "valid": bool(self.valid),
            "violations": list(self.violations),
        }


def validate_strategy_contract(
    strategy: str,
    config: Mapping[str, Any],
    *,
    known_markets: Sequence[str] = tuple(sorted(KNOWN_MARKETS)),
) -> StrategyContractResult:
    violations: List[str] = []
    name = str(strategy).strip()
    if not name:
        violations.append("strategy_name_empty")

    if "enabled" in config and not isinstance(config.get("enabled"), bool):
        violations.append("enabled_must_be_bool")

    if "markets" in config:
        markets = config.get("markets")
        if isinstance(markets, str):
            markets = [markets]
        if not isinstance(markets, Iterable):
            violations.append("markets_must_be_iterable")
        else:
            parsed = [str(m).strip().lower() for m in markets if str(m).strip()]
            if not parsed:
                violations.append("markets_empty")
            unknown = sorted(set(parsed) - set(str(x) for x in known_markets))
            if unknown:
                violations.append(f"unknown_markets:{','.join(unknown)}")

    if "max_positions" in config:
        try:
            max_positions = int(config.get("max_positions"))
            if max_positions <= 0:
                violations.append("max_positions_must_be_positive")
        except Exception:
            violations.append("max_positions_must_be_int")

    if "risk_budget_pct" in config:
        try:
            token = float(config.get("risk_budget_pct"))
            if token > 1.0:
                token = token / 100.0
            if not (0.0 < token <= 1.0):
                violations.append("risk_budget_pct_out_of_range")
        except Exception:
            violations.append("risk_budget_pct_must_be_numeric")

    return StrategyContractResult(
        strategy=name,
        valid=(len(violations) == 0),
        violations=violations,
    )


def validate_strategy_contracts(
    strategy_configs: Mapping[str, Mapping[str, Any]],
    *,
    known_markets: Sequence[str] = tuple(sorted(KNOWN_MARKETS)),
) -> Dict[str, StrategyContractResult]:
    out: Dict[str, StrategyContractResult] = {}
    for strategy, config in sorted(strategy_configs.items()):
        payload = config if isinstance(config, Mapping) else {}
        out[str(strategy)] = validate_strategy_contract(
            str(strategy),
            payload,
            known_markets=known_markets,
        )
    return out
