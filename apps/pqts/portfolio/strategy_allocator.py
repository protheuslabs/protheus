"""Cost/capacity-aware strategy capital allocator."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional

import numpy as np


@dataclass(frozen=True)
class StrategyBudgetInput:
    strategy_id: str
    expected_return: float
    annual_vol: float
    annual_turnover: float
    cost_per_turnover: float
    capacity_ratio: float
    horizon: str = "intraday"
    market: str = "global"
    short_exposure_ratio: float = 0.0
    borrow_bps: float = 0.0
    risk_budget_pct: float = 1.0
    drawdown_pct: float = 0.0


@dataclass(frozen=True)
class StrategyUtilityConfig:
    """Risk-utility parameters for capital allocation."""

    risk_aversion: float = 4.0
    turnover_penalty: float = 1.0
    capacity_penalty: float = 1.0


class StrategyCapitalAllocator:
    """Allocate capital weights across strategies using utility-aware controls."""

    def __init__(
        self,
        max_weight: float = 0.35,
        min_weight: float = 0.0,
        capacity_haircut: float = 0.05,
        utility_config: Optional[StrategyUtilityConfig] = None,
    ):
        self.max_weight = float(max_weight)
        self.min_weight = float(min_weight)
        self.capacity_haircut = float(capacity_haircut)
        self.utility_config = utility_config or StrategyUtilityConfig()

    def net_edge(self, item: StrategyBudgetInput) -> float:
        cost_drag = float(item.annual_turnover) * float(item.cost_per_turnover)
        capacity_drag = max(float(item.capacity_ratio) - 1.0, 0.0) * self.capacity_haircut
        return float(item.expected_return) - cost_drag - capacity_drag

    def utility_score(
        self,
        item: StrategyBudgetInput,
        *,
        utility: Optional[StrategyUtilityConfig] = None,
    ) -> float:
        """
        Compute strategy utility as net edge minus risk/cost penalties.

        U = net_edge - lambda*vol^2 - turnover_penalty*cost_drag - capacity_penalty*over_capacity
        """
        cfg = utility or self.utility_config
        net_edge = self.net_edge(item)
        variance_penalty = float(cfg.risk_aversion) * float(item.annual_vol) ** 2
        turnover_penalty = float(cfg.turnover_penalty) * (
            float(item.annual_turnover) * float(item.cost_per_turnover)
        )
        over_capacity = max(float(item.capacity_ratio) - 1.0, 0.0)
        capacity_penalty = float(cfg.capacity_penalty) * over_capacity
        return net_edge - variance_penalty - turnover_penalty - capacity_penalty

    @staticmethod
    def _normalize(weights: np.ndarray) -> np.ndarray:
        positive = np.maximum(weights, 0.0)
        total = float(positive.sum())
        if total <= 1e-12:
            return np.full(len(weights), 1.0 / max(len(weights), 1), dtype=float)
        return positive / total

    def _clip(self, weights: np.ndarray) -> np.ndarray:
        clipped = np.clip(weights, self.min_weight, self.max_weight)
        total = float(clipped.sum())
        if total <= 1e-12:
            return np.full(len(weights), 1.0 / max(len(weights), 1), dtype=float)
        return clipped / total

    def allocate_utility(
        self,
        inputs: Iterable[StrategyBudgetInput],
        *,
        utility: Optional[StrategyUtilityConfig] = None,
    ) -> Dict[str, float]:
        """
        Utility-based allocation maximizing risk-adjusted expected net alpha.

        Base score = utility / vol; then normalized + box-constrained.
        """
        rows: List[StrategyBudgetInput] = list(inputs)
        if not rows:
            return {}

        cfg = utility or self.utility_config
        utilities = np.array(
            [self.utility_score(row, utility=cfg) for row in rows],
            dtype=float,
        )
        vols = np.array([max(float(row.annual_vol), 1e-6) for row in rows], dtype=float)
        utility_per_risk = utilities / vols
        shifted = utility_per_risk - float(np.min(utility_per_risk))
        if float(np.sum(shifted)) <= 1e-12:
            shifted = np.ones_like(utility_per_risk)
        base = self._normalize(shifted)
        clipped = self._clip(base)
        return {row.strategy_id: float(weight) for row, weight in zip(rows, clipped)}

    def allocate(self, inputs: Iterable[StrategyBudgetInput]) -> Dict[str, float]:
        """Backward-compatible alias: now delegates to utility-based allocation."""
        return self.allocate_utility(inputs, utility=self.utility_config)

    @staticmethod
    def _normalize_budget_map(raw: Dict[str, float]) -> Dict[str, float]:
        positive = {str(k): max(float(v), 0.0) for k, v in raw.items()}
        total = float(sum(positive.values()))
        if total <= 1e-12:
            n = max(len(positive), 1)
            return {key: 1.0 / n for key in positive} if positive else {"intraday": 1.0}
        return {key: value / total for key, value in positive.items()}

    def allocate_multi_horizon(
        self,
        inputs: Iterable[StrategyBudgetInput],
        *,
        sleeve_budgets: Optional[Dict[str, float]] = None,
        utility: Optional[StrategyUtilityConfig] = None,
    ) -> Dict[str, float]:
        """
        Allocate by horizon sleeves, then allocate within each sleeve by utility.

        Example horizons: intraday, swing, hold.
        """
        rows: List[StrategyBudgetInput] = list(inputs)
        if not rows:
            return {}

        rows_by_horizon: Dict[str, List[StrategyBudgetInput]] = {}
        for row in rows:
            horizon = str(row.horizon or "intraday").strip().lower() or "intraday"
            rows_by_horizon.setdefault(horizon, []).append(row)

        if sleeve_budgets:
            raw_budgets = {
                horizon: float(sleeve_budgets.get(horizon, 0.0))
                for horizon in rows_by_horizon.keys()
            }
            missing = [h for h, value in raw_budgets.items() if value <= 0.0]
            if missing:
                remainder = max(1.0 - sum(max(v, 0.0) for v in raw_budgets.values()), 0.0)
                fill = remainder / max(len(missing), 1)
                for horizon in missing:
                    raw_budgets[horizon] = fill
            budgets = self._normalize_budget_map(raw_budgets)
        else:
            equal = 1.0 / max(len(rows_by_horizon), 1)
            budgets = {horizon: equal for horizon in rows_by_horizon}

        final_weights: Dict[str, float] = {}
        for horizon, bucket in rows_by_horizon.items():
            local = self.allocate_utility(bucket, utility=utility)
            sleeve_weight = float(budgets.get(horizon, 0.0))
            for strategy_id, weight in local.items():
                final_weights[strategy_id] = float(weight) * sleeve_weight

        total = float(sum(final_weights.values()))
        if total <= 1e-12:
            return self.allocate_utility(rows, utility=utility)
        return {sid: float(weight / total) for sid, weight in final_weights.items()}

    @staticmethod
    def _pairwise_correlation(
        correlation_matrix: Optional[Dict[tuple[str, str], float]],
        a: str,
        b: str,
    ) -> float:
        if not correlation_matrix:
            return 0.0
        if (a, b) in correlation_matrix:
            return float(correlation_matrix[(a, b)])
        if (b, a) in correlation_matrix:
            return float(correlation_matrix[(b, a)])
        return 0.0

    def allocate_constrained(
        self,
        inputs: Iterable[StrategyBudgetInput],
        *,
        correlation_matrix: Optional[Dict[tuple[str, str], float]] = None,
        max_pair_correlation: float = 0.85,
        market_caps: Optional[Dict[str, float]] = None,
        max_total_short_exposure: Optional[float] = None,
        max_weighted_borrow_bps: Optional[float] = None,
        utility: Optional[StrategyUtilityConfig] = None,
    ) -> Dict[str, float]:
        """
        Constrained allocation:
        1) utility allocation baseline
        2) pairwise correlation cap throttling
        3) per-market capital caps
        4) total short exposure budget
        5) weighted borrow-cost budget
        """
        rows: List[StrategyBudgetInput] = list(inputs)
        if not rows:
            return {}

        weights = dict(self.allocate_utility(rows, utility=utility))
        row_by_id = {row.strategy_id: row for row in rows}

        # Pairwise correlation throttling.
        ids = sorted(weights.keys())
        for i, left in enumerate(ids):
            for right in ids[i + 1 :]:
                corr = self._pairwise_correlation(correlation_matrix, left, right)
                if abs(corr) <= float(max_pair_correlation):
                    continue
                # Throttle the lower-scored leg of highly correlated pair.
                if weights[left] <= weights[right]:
                    target = left
                else:
                    target = right
                throttle = float(max_pair_correlation) / max(abs(corr), 1e-9)
                weights[target] *= max(min(throttle, 1.0), 0.0)

        # Market caps.
        if market_caps:
            caps = {str(k): max(float(v), 0.0) for k, v in market_caps.items()}
            market_weight: Dict[str, float] = {}
            for strategy_id, weight in weights.items():
                market = str(row_by_id[strategy_id].market or "global").strip().lower()
                market_weight[market] = market_weight.get(market, 0.0) + float(weight)
            for market, used in market_weight.items():
                cap = caps.get(market)
                if cap is None or used <= cap + 1e-12:
                    continue
                scale = cap / max(used, 1e-12)
                for strategy_id in list(weights.keys()):
                    row_market = str(row_by_id[strategy_id].market or "global").strip().lower()
                    if row_market == market:
                        weights[strategy_id] *= max(min(scale, 1.0), 0.0)

        # Short exposure budget.
        if max_total_short_exposure is not None:
            short_used = 0.0
            for strategy_id, weight in weights.items():
                row = row_by_id[strategy_id]
                short_used += float(weight) * max(float(row.short_exposure_ratio), 0.0)
            budget = max(float(max_total_short_exposure), 0.0)
            if short_used > budget + 1e-12 and short_used > 0:
                scale = budget / short_used
                for strategy_id in list(weights.keys()):
                    row = row_by_id[strategy_id]
                    if float(row.short_exposure_ratio) > 0.0:
                        weights[strategy_id] *= max(min(scale, 1.0), 0.0)

        # Weighted borrow-cost budget.
        if max_weighted_borrow_bps is not None:
            borrow_used = 0.0
            total = sum(weights.values())
            if total > 0:
                for strategy_id, weight in weights.items():
                    row = row_by_id[strategy_id]
                    borrow_used += (float(weight) / total) * max(float(row.borrow_bps), 0.0)
            budget_bps = max(float(max_weighted_borrow_bps), 0.0)
            if borrow_used > budget_bps + 1e-12 and borrow_used > 0:
                scale = budget_bps / borrow_used
                for strategy_id in list(weights.keys()):
                    row = row_by_id[strategy_id]
                    if float(row.borrow_bps) > 0.0:
                        weights[strategy_id] *= max(min(scale, 1.0), 0.0)

        vec = np.array([max(float(weights[row.strategy_id]), 0.0) for row in rows], dtype=float)
        vec = self._clip(self._normalize(vec))
        return {row.strategy_id: float(weight) for row, weight in zip(rows, vec)}

    def allocate_enterprise(
        self,
        inputs: Iterable[StrategyBudgetInput],
        *,
        correlation_matrix: Optional[Dict[tuple[str, str], float]] = None,
        max_pair_correlation: float = 0.85,
        market_caps: Optional[Dict[str, float]] = None,
        max_total_short_exposure: Optional[float] = None,
        max_weighted_borrow_bps: Optional[float] = None,
        max_drawdown_pct: float = 0.25,
        utility: Optional[StrategyUtilityConfig] = None,
    ) -> Dict[str, float]:
        """
        Enterprise allocator:
        - constrained optimizer baseline (corr/market/short/borrow limits)
        - per-strategy risk-budget caps
        - drawdown throttling for stressed strategies
        """
        rows: List[StrategyBudgetInput] = list(inputs)
        if not rows:
            return {}

        base = self.allocate_constrained(
            rows,
            correlation_matrix=correlation_matrix,
            max_pair_correlation=max_pair_correlation,
            market_caps=market_caps,
            max_total_short_exposure=max_total_short_exposure,
            max_weighted_borrow_bps=max_weighted_borrow_bps,
            utility=utility,
        )

        adjusted: Dict[str, float] = {}
        for row in rows:
            strategy_id = str(row.strategy_id)
            weight = float(base.get(strategy_id, 0.0))
            budget_cap = max(float(row.risk_budget_pct), 0.0)
            weight = min(weight, budget_cap)

            drawdown = max(float(row.drawdown_pct), 0.0)
            cap = max(float(max_drawdown_pct), 1e-9)
            if drawdown > cap:
                weight *= cap / drawdown

            adjusted[strategy_id] = max(weight, 0.0)

        vec = np.array([adjusted[str(row.strategy_id)] for row in rows], dtype=float)
        vec = self._clip(self._normalize(vec))
        return {row.strategy_id: float(weight) for row, weight in zip(rows, vec)}
