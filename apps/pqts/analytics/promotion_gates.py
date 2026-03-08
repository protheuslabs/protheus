"""Promotion-gate evaluation for 30-90 day paper campaigns."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict


@dataclass(frozen=True)
class PromotionGateThresholds:
    """Thresholds for paper-to-canary promotion decisions."""

    min_days: int = 30
    max_days: int = 90
    min_fills: int = 200
    max_reject_rate: float = 0.40
    max_critical_alerts: int = 0
    min_net_pnl_after_costs_usd: float = 0.0
    max_slippage_mape_pct: float = 35.0
    max_kill_switch_triggers: int = 0
    min_purged_cv_sharpe: float = 1.0
    min_walk_forward_sharpe: float = 1.0
    min_deflated_sharpe: float = 0.8
    min_parameter_stability_score: float = 0.55
    min_regime_robustness_score: float = 0.55
    min_realized_net_alpha_bps: float = 0.0
    min_ci95_lower_realized_net_alpha_bps: float = 0.0
    require_purged_cv_passed: bool = True
    require_walk_forward_passed: bool = True
    require_deflated_sharpe_passed: bool = True
    require_parameter_stability_passed: bool = True
    require_regime_robustness_passed: bool = True
    require_net_alpha_confidence_passed: bool = True


def evaluate_promotion_gate(
    *,
    readiness: Dict[str, Any],
    campaign_stats: Dict[str, Any],
    ops_summary: Dict[str, Any],
    research_validation: Dict[str, Any] | None = None,
    revenue_summary: Dict[str, Any] | None = None,
    thresholds: PromotionGateThresholds | None = None,
) -> Dict[str, Any]:
    """Evaluate deterministic promotion decision from campaign/readiness/ops data."""
    gate = thresholds or PromotionGateThresholds()

    trading_days = int(readiness.get("trading_days", 0))
    fills = int(readiness.get("fills", 0))
    ready_for_canary = bool(readiness.get("ready_for_canary", False))
    reject_rate = float(campaign_stats.get("reject_rate", 0.0))
    critical_alerts = int(ops_summary.get("critical", 0))
    net_pnl_after_costs = float(
        (revenue_summary or {}).get("estimated_realized_pnl_usd", readiness.get("total_pnl", 0.0))
    )
    slippage_mape_pct = float(readiness.get("slippage_mape_pct", 0.0))
    kill_switch_triggers = int(readiness.get("kill_switch_triggers", 0))
    validation = dict(research_validation or {})

    purged_cv_sharpe = float(validation.get("purged_cv_sharpe", 0.0))
    walk_forward_sharpe = float(validation.get("walk_forward_sharpe", 0.0))
    deflated_sharpe = float(validation.get("deflated_sharpe", 0.0))
    parameter_stability_score = float(
        validation.get(
            "parameter_stability_score",
            validation.get("walk_forward_consistency", 1.0),
        )
    )
    regime_robustness_score = float(
        validation.get(
            "regime_robustness_score",
            validation.get("walk_forward_consistency", 1.0),
        )
    )
    avg_realized_net_alpha_bps = float(
        (revenue_summary or {}).get("avg_realized_net_alpha_bps", 0.0)
    )
    ci95_lower_realized_net_alpha_bps = float(
        (revenue_summary or {}).get("ci95_lower_realized_net_alpha_bps", avg_realized_net_alpha_bps)
    )
    purged_cv_passed = bool(
        validation.get("purged_cv_passed", purged_cv_sharpe >= float(gate.min_purged_cv_sharpe))
    )
    walk_forward_passed = bool(
        validation.get(
            "walk_forward_passed",
            walk_forward_sharpe >= float(gate.min_walk_forward_sharpe),
        )
    )
    deflated_sharpe_passed = bool(
        validation.get(
            "deflated_sharpe_passed",
            deflated_sharpe >= float(gate.min_deflated_sharpe),
        )
    )
    parameter_stability_passed = bool(
        validation.get(
            "parameter_stability_passed",
            parameter_stability_score >= float(gate.min_parameter_stability_score),
        )
    )
    regime_robustness_passed = bool(
        validation.get(
            "regime_robustness_passed",
            regime_robustness_score >= float(gate.min_regime_robustness_score),
        )
    )
    paper_track_record_passed = bool(readiness.get("ready_for_canary", False))
    net_alpha_confidence_passed = bool(
        (avg_realized_net_alpha_bps >= float(gate.min_realized_net_alpha_bps))
        and (ci95_lower_realized_net_alpha_bps >= float(gate.min_ci95_lower_realized_net_alpha_bps))
    )

    checks = {
        "min_days": trading_days >= int(gate.min_days),
        "max_days_window": trading_days <= int(gate.max_days),
        "min_fills": fills >= int(gate.min_fills),
        "paper_track_record": paper_track_record_passed and ready_for_canary,
        "reject_rate": reject_rate <= float(gate.max_reject_rate),
        "critical_alerts": critical_alerts <= int(gate.max_critical_alerts),
        "net_pnl_after_costs": net_pnl_after_costs >= float(gate.min_net_pnl_after_costs_usd),
        "slippage_mape_pct": slippage_mape_pct <= float(gate.max_slippage_mape_pct),
        "kill_switch_triggers": kill_switch_triggers <= int(gate.max_kill_switch_triggers),
        "purged_cv_sharpe": purged_cv_sharpe >= float(gate.min_purged_cv_sharpe),
        "walk_forward_sharpe": walk_forward_sharpe >= float(gate.min_walk_forward_sharpe),
        "deflated_sharpe": deflated_sharpe >= float(gate.min_deflated_sharpe),
        "parameter_stability_score": parameter_stability_score
        >= float(gate.min_parameter_stability_score),
        "regime_robustness_score": regime_robustness_score
        >= float(gate.min_regime_robustness_score),
        "realized_net_alpha_bps": avg_realized_net_alpha_bps
        >= float(gate.min_realized_net_alpha_bps),
        "realized_net_alpha_ci95_lower_bps": ci95_lower_realized_net_alpha_bps
        >= float(gate.min_ci95_lower_realized_net_alpha_bps),
        "purged_cv_passed": purged_cv_passed if bool(gate.require_purged_cv_passed) else True,
        "walk_forward_passed": (
            walk_forward_passed if bool(gate.require_walk_forward_passed) else True
        ),
        "deflated_sharpe_passed": (
            deflated_sharpe_passed if bool(gate.require_deflated_sharpe_passed) else True
        ),
        "parameter_stability_passed": (
            parameter_stability_passed if bool(gate.require_parameter_stability_passed) else True
        ),
        "regime_robustness_passed": (
            regime_robustness_passed if bool(gate.require_regime_robustness_passed) else True
        ),
        "net_alpha_confidence_passed": (
            net_alpha_confidence_passed if bool(gate.require_net_alpha_confidence_passed) else True
        ),
    }

    if checks["paper_track_record"] and all(
        checks[k]
        for k in (
            "min_days",
            "max_days_window",
            "min_fills",
            "reject_rate",
            "critical_alerts",
            "net_pnl_after_costs",
            "slippage_mape_pct",
            "kill_switch_triggers",
            "purged_cv_sharpe",
            "walk_forward_sharpe",
            "deflated_sharpe",
            "parameter_stability_score",
            "regime_robustness_score",
            "realized_net_alpha_bps",
            "realized_net_alpha_ci95_lower_bps",
            "purged_cv_passed",
            "walk_forward_passed",
            "deflated_sharpe_passed",
            "parameter_stability_passed",
            "regime_robustness_passed",
            "net_alpha_confidence_passed",
        )
    ):
        decision = "promote_to_live_canary"
    elif trading_days > int(gate.max_days) and not checks["paper_track_record"]:
        decision = "reject_or_research"
    else:
        decision = "remain_in_paper"

    return {
        "decision": decision,
        "checks": checks,
        "metrics": {
            "trading_days": trading_days,
            "fills": fills,
            "reject_rate": reject_rate,
            "critical_alerts": critical_alerts,
            "net_pnl_after_costs_usd": net_pnl_after_costs,
            "slippage_mape_pct": slippage_mape_pct,
            "kill_switch_triggers": kill_switch_triggers,
            "purged_cv_sharpe": purged_cv_sharpe,
            "walk_forward_sharpe": walk_forward_sharpe,
            "deflated_sharpe": deflated_sharpe,
            "parameter_stability_score": parameter_stability_score,
            "regime_robustness_score": regime_robustness_score,
            "purged_cv_passed": purged_cv_passed,
            "walk_forward_passed": walk_forward_passed,
            "deflated_sharpe_passed": deflated_sharpe_passed,
            "avg_realized_net_alpha_bps": avg_realized_net_alpha_bps,
            "ci95_lower_realized_net_alpha_bps": ci95_lower_realized_net_alpha_bps,
            "parameter_stability_passed": parameter_stability_passed,
            "regime_robustness_passed": regime_robustness_passed,
            "net_alpha_confidence_passed": net_alpha_confidence_passed,
        },
        "thresholds": asdict(gate),
    }
