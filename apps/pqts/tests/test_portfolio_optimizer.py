"""Tests for correlation-aware portfolio optimizer."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.portfolio_optimizer import optimize_strategy_weights


def test_optimize_strategy_weights_prefers_higher_alpha_lower_corr():
    result = optimize_strategy_weights(
        expected_alpha_bps_by_strategy={"a": 8.0, "b": 6.0, "c": 2.0},
        volatility_bps_by_strategy={"a": 2.0, "b": 3.0, "c": 4.0},
        correlation_matrix={
            "a": {"a": 1.0, "b": 0.2, "c": 0.1},
            "b": {"a": 0.2, "b": 1.0, "c": 0.6},
            "c": {"a": 0.1, "b": 0.6, "c": 1.0},
        },
        max_weight=0.6,
    )
    assert abs(sum(result.weights.values()) - 1.0) < 1e-9
    assert result.weights["a"] >= result.weights["c"]
    assert result.expected_portfolio_alpha_bps > 0.0
