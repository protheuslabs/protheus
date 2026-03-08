"""Correlation-aware strategy weight optimizer for allocation planning."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Mapping

import numpy as np


@dataclass(frozen=True)
class PortfolioOptimizationResult:
    weights: Dict[str, float]
    scores: Dict[str, float]
    correlation_penalty: float
    expected_portfolio_alpha_bps: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def optimize_strategy_weights(
    *,
    expected_alpha_bps_by_strategy: Mapping[str, float],
    volatility_bps_by_strategy: Mapping[str, float] | None = None,
    correlation_matrix: Mapping[str, Mapping[str, float]] | None = None,
    max_weight: float = 0.50,
    min_weight: float = 0.0,
    shrinkage: float = 0.15,
) -> PortfolioOptimizationResult:
    """
    Compute deterministic long-only strategy weights with covariance regularization.
    """
    strategies = [str(k) for k in expected_alpha_bps_by_strategy.keys() if str(k)]
    if not strategies:
        return PortfolioOptimizationResult(
            weights={},
            scores={},
            correlation_penalty=0.0,
            expected_portfolio_alpha_bps=0.0,
        )

    alpha = np.array(
        [float(expected_alpha_bps_by_strategy.get(strategy, 0.0)) for strategy in strategies],
        dtype=float,
    )
    vol = np.array(
        [
            float((volatility_bps_by_strategy or {}).get(strategy, max(abs(alpha[i]), 1.0)))
            for i, strategy in enumerate(strategies)
        ],
        dtype=float,
    )
    vol = np.maximum(vol, 1.0)
    corr = np.eye(len(strategies), dtype=float)
    matrix = correlation_matrix or {}
    for i, left in enumerate(strategies):
        for j, right in enumerate(strategies):
            if i == j:
                continue
            row = matrix.get(left, {})
            value = row.get(right, 0.0) if isinstance(row, Mapping) else 0.0
            corr[i, j] = float(np.clip(float(value), -0.99, 0.99))
    corr = (corr + corr.T) / 2.0
    np.fill_diagonal(corr, 1.0)

    cov = np.outer(vol, vol) * corr
    if float(shrinkage) > 0.0:
        diag = np.diag(np.diag(cov))
        cov = (1.0 - float(shrinkage)) * cov + float(shrinkage) * diag

    try:
        inv_cov = np.linalg.pinv(cov)
    except np.linalg.LinAlgError:
        inv_cov = np.eye(len(strategies), dtype=float)
    raw_scores = inv_cov @ alpha
    raw_scores = np.maximum(raw_scores, 0.0)
    if float(raw_scores.sum()) <= 1e-12:
        raw_scores = np.ones_like(raw_scores)

    weights = raw_scores / float(raw_scores.sum())
    weights = np.clip(weights, float(min_weight), float(max_weight))
    if float(weights.sum()) <= 1e-12:
        weights = np.ones_like(weights) / float(len(weights))
    else:
        weights = weights / float(weights.sum())

    scores = {strategy: float(raw_scores[idx]) for idx, strategy in enumerate(strategies)}
    weights_map = {strategy: float(weights[idx]) for idx, strategy in enumerate(strategies)}
    expected_alpha = float(np.dot(weights, alpha))
    corr_penalty = float(
        np.sum((weights[:, None] * weights[None, :]) * np.abs(corr - np.eye(len(corr))))
    )

    return PortfolioOptimizationResult(
        weights=weights_map,
        scores=scores,
        correlation_penalty=corr_penalty,
        expected_portfolio_alpha_bps=expected_alpha,
    )
