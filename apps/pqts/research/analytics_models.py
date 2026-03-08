"""Canonical research/analytics report models for strategy runs."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List


@dataclass(frozen=True)
class DataLineage:
    """Data + code provenance for a strategy report."""

    dataset_id: str
    symbols: List[str]
    start: str
    end: str
    bars: int
    timezone: str
    source: str
    code_sha: str
    config_hash: str


@dataclass(frozen=True)
class ValidationSnapshot:
    """Deterministic validation outputs from backtest/CV/walk-forward."""

    sharpe: float
    total_return: float
    max_drawdown: float
    win_rate: float
    total_trades: int
    turnover_annualized: float
    cost_drag_bps: float
    capacity_ratio: float
    cv_sharpe: float
    cv_sharpe_std: float
    cv_drawdown: float
    deflated_sharpe: float
    pbo_estimate: float
    walk_forward_sharpe: float
    walk_forward_drawdown: float
    walk_forward_consistency: float
    validator_passed: bool
    validator_reasons: List[str]


@dataclass(frozen=True)
class ExecutionAnalyticsSnapshot:
    """Execution/TCA snapshot attached to research reports."""

    tca_samples: int
    slippage_mape: float
    predicted_slippage_bps: float
    realized_slippage_bps: float
    fill_ratio: float
    regime_tca: Dict[str, Dict[str, float]] = field(default_factory=dict)


@dataclass(frozen=True)
class PromotionSnapshot:
    """Promotion state and gate outcomes."""

    current_stage: str
    target_stage: str
    promoted: bool
    gate_checks: Dict[str, bool]
    reason: str
    timestamp: str


@dataclass(frozen=True)
class DecisionAttribution:
    """Pilot/autopilot attribution for one strategy decision."""

    action: str
    rationale: str
    supporting_card_ids: List[str]
    counterevidence_card_ids: List[str]
    confidence: float
    operator: str


@dataclass(frozen=True)
class StrategyAnalyticsReport:
    """Single canonical report object for a strategy run."""

    schema_version: str
    report_id: str
    created_at: str
    experiment_id: str
    strategy_type: str
    lineage: DataLineage
    validation: ValidationSnapshot
    execution: ExecutionAnalyticsSnapshot
    promotion: PromotionSnapshot
    decision: DecisionAttribution
    objective: Dict[str, Any]
    extras: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
