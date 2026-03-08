"""Unified market and strategy toggle control."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Mapping, MutableMapping, Optional, Set

MARKET_ALIASES = {
    "crypto": "crypto",
    "cryptocurrency": "crypto",
    "forex": "forex",
    "fx": "forex",
    "equities": "equities",
    "equity": "equities",
    "stock": "equities",
    "stocks": "equities",
    "market": "equities",
}


@dataclass(frozen=True)
class StrategyTarget:
    """Resolved strategy-to-market target mapping."""

    strategy: str
    markets: List[str]


class ToggleValidationError(ValueError):
    """Raised for unknown market/strategy toggles."""


class MarketStrategyToggleManager:
    """State manager for market and strategy enable/disable controls."""

    def __init__(self, config: Mapping[str, object]):
        self._config = config
        self._markets: MutableMapping[str, Dict[str, object]] = {}
        self._strategies: MutableMapping[str, Dict[str, object]] = {}
        self._load_markets(config.get("markets", {}))
        self._load_strategies(config.get("strategies", {}))

    def _load_markets(self, markets_config: object) -> None:
        if not isinstance(markets_config, Mapping):
            return
        for market_name, market_cfg in markets_config.items():
            normalized = self.resolve_market(market_name)
            cfg = dict(market_cfg) if isinstance(market_cfg, Mapping) else {}
            cfg.setdefault("enabled", False)
            self._markets[normalized] = cfg

    def _load_strategies(self, strategies_config: object) -> None:
        if not isinstance(strategies_config, Mapping):
            return
        for strategy_name, strategy_cfg in strategies_config.items():
            cfg = dict(strategy_cfg) if isinstance(strategy_cfg, Mapping) else {}
            cfg.setdefault("enabled", False)
            self._strategies[strategy_name] = cfg

    def resolve_market(self, market: str) -> str:
        normalized = str(market).strip().lower()
        if normalized in MARKET_ALIASES:
            return MARKET_ALIASES[normalized]
        raise ToggleValidationError(f"Unknown market toggle: {market}")

    def list_markets(self) -> List[str]:
        return sorted(self._markets.keys())

    def list_strategies(self) -> List[str]:
        return sorted(self._strategies.keys())

    def get_market_config(self, market: str) -> Dict[str, object]:
        normalized = self.resolve_market(market)
        if normalized not in self._markets:
            raise ToggleValidationError(f"Market '{market}' is not configured")
        return dict(self._markets[normalized])

    def get_strategy_config(self, strategy: str) -> Dict[str, object]:
        if strategy not in self._strategies:
            raise ToggleValidationError(f"Strategy '{strategy}' is not configured")
        return dict(self._strategies[strategy])

    def is_market_enabled(self, market: str) -> bool:
        return bool(self.get_market_config(market).get("enabled", False))

    def is_strategy_enabled(self, strategy: str) -> bool:
        return bool(self.get_strategy_config(strategy).get("enabled", False))

    def set_market_enabled(self, market: str, enabled: bool) -> None:
        normalized = self.resolve_market(market)
        if normalized not in self._markets:
            raise ToggleValidationError(f"Market '{market}' is not configured")
        self._markets[normalized]["enabled"] = bool(enabled)

    def set_strategy_enabled(self, strategy: str, enabled: bool) -> None:
        if strategy not in self._strategies:
            raise ToggleValidationError(f"Strategy '{strategy}' is not configured")
        self._strategies[strategy]["enabled"] = bool(enabled)

    def get_active_markets(self) -> List[str]:
        return sorted(
            market for market, cfg in self._markets.items() if bool(cfg.get("enabled", False))
        )

    def _resolve_strategy_markets(self, strategy_cfg: Mapping[str, object]) -> Set[str]:
        target_markets = strategy_cfg.get("markets")
        if target_markets is None:
            return set(self.list_markets())

        if isinstance(target_markets, str):
            target_markets = [target_markets]
        if not isinstance(target_markets, Iterable):
            return set()

        resolved: Set[str] = set()
        for market in target_markets:
            try:
                resolved.add(self.resolve_market(str(market)))
            except ToggleValidationError:
                continue
        return resolved

    def get_strategy_targets(self) -> List[StrategyTarget]:
        targets: List[StrategyTarget] = []
        for strategy, cfg in self._strategies.items():
            targets.append(
                StrategyTarget(
                    strategy=strategy,
                    markets=sorted(self._resolve_strategy_markets(cfg)),
                )
            )
        return sorted(targets, key=lambda x: x.strategy)

    def get_active_strategies(self) -> List[str]:
        active_markets = set(self.get_active_markets())
        active: List[str] = []
        for strategy, cfg in self._strategies.items():
            if not bool(cfg.get("enabled", False)):
                continue
            strategy_markets = self._resolve_strategy_markets(cfg)
            if strategy_markets and strategy_markets.intersection(active_markets):
                active.append(strategy)
        return sorted(active)

    def set_active_markets(self, markets: Iterable[str]) -> None:
        selected = {self.resolve_market(m) for m in markets}
        for market in self._markets:
            self._markets[market]["enabled"] = market in selected

    def set_active_strategies(self, strategies: Iterable[str]) -> None:
        selected = set(strategies)
        unknown = sorted(selected.difference(self._strategies.keys()))
        if unknown:
            raise ToggleValidationError(f"Unknown strategies: {unknown}")

        for strategy in self._strategies:
            self._strategies[strategy]["enabled"] = strategy in selected

    def apply_strategy_profile(self, profile_name: str) -> None:
        profiles = self._config.get("strategy_profiles", {})
        if not isinstance(profiles, Mapping) or profile_name not in profiles:
            raise ToggleValidationError(f"Unknown strategy profile '{profile_name}'")

        profile = profiles[profile_name]
        if not isinstance(profile, Mapping):
            raise ToggleValidationError(f"Strategy profile '{profile_name}' is invalid")

        profile_markets = profile.get("markets")
        if profile_markets is not None:
            if isinstance(profile_markets, str):
                profile_markets = [profile_markets]
            self.set_active_markets(profile_markets)

        profile_strategies = profile.get("strategies")
        if profile_strategies is not None:
            if isinstance(profile_strategies, str):
                profile_strategies = [profile_strategies]
            self.set_active_strategies(profile_strategies)

    def snapshot(self) -> Dict[str, object]:
        active_markets = self.get_active_markets()
        active_strategies = self.get_active_strategies()
        return {
            "active_markets": active_markets,
            "inactive_markets": sorted(set(self.list_markets()) - set(active_markets)),
            "active_strategies": active_strategies,
            "inactive_strategies": sorted(set(self.list_strategies()) - set(active_strategies)),
            "strategy_targets": [
                {"strategy": target.strategy, "markets": target.markets}
                for target in self.get_strategy_targets()
            ],
        }
