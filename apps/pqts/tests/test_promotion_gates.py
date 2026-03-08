"""Deterministic tests for 30-90 day promotion gate logic."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.promotion_gates import PromotionGateThresholds, evaluate_promotion_gate


def test_promotion_gate_promotes_when_all_conditions_pass():
    result = evaluate_promotion_gate(
        readiness={
            "trading_days": 45,
            "fills": 500,
            "ready_for_canary": True,
        },
        campaign_stats={"reject_rate": 0.05},
        ops_summary={"critical": 0},
        research_validation={
            "purged_cv_sharpe": 1.2,
            "walk_forward_sharpe": 1.1,
            "deflated_sharpe": 0.9,
            "purged_cv_passed": True,
            "walk_forward_passed": True,
            "deflated_sharpe_passed": True,
        },
        thresholds=PromotionGateThresholds(
            min_days=30,
            max_days=90,
            min_fills=200,
            max_reject_rate=0.40,
            max_critical_alerts=0,
        ),
    )
    assert result["decision"] == "promote_to_live_canary"
    assert all(result["checks"].values())


def test_promotion_gate_rejects_after_window_if_not_ready():
    result = evaluate_promotion_gate(
        readiness={
            "trading_days": 120,
            "fills": 1000,
            "ready_for_canary": False,
        },
        campaign_stats={"reject_rate": 0.02},
        ops_summary={"critical": 0},
        research_validation={
            "purged_cv_sharpe": 2.0,
            "walk_forward_sharpe": 1.8,
            "deflated_sharpe": 1.2,
            "purged_cv_passed": True,
            "walk_forward_passed": True,
            "deflated_sharpe_passed": True,
        },
        thresholds=PromotionGateThresholds(),
    )
    assert result["decision"] == "reject_or_research"
    assert result["checks"]["max_days_window"] is False


def test_promotion_gate_stays_in_paper_on_critical_alerts():
    result = evaluate_promotion_gate(
        readiness={
            "trading_days": 40,
            "fills": 400,
            "ready_for_canary": True,
        },
        campaign_stats={"reject_rate": 0.10},
        ops_summary={"critical": 1},
        research_validation={
            "purged_cv_sharpe": 1.5,
            "walk_forward_sharpe": 1.2,
            "deflated_sharpe": 0.9,
            "purged_cv_passed": True,
            "walk_forward_passed": True,
            "deflated_sharpe_passed": True,
        },
        thresholds=PromotionGateThresholds(max_critical_alerts=0),
    )
    assert result["decision"] == "remain_in_paper"
    assert result["checks"]["critical_alerts"] is False


def test_promotion_gate_blocks_negative_net_pnl_after_costs():
    result = evaluate_promotion_gate(
        readiness={
            "trading_days": 40,
            "fills": 400,
            "ready_for_canary": True,
            "slippage_mape_pct": 12.0,
        },
        campaign_stats={"reject_rate": 0.03},
        ops_summary={"critical": 0},
        research_validation={
            "purged_cv_sharpe": 1.5,
            "walk_forward_sharpe": 1.2,
            "deflated_sharpe": 0.9,
            "purged_cv_passed": True,
            "walk_forward_passed": True,
            "deflated_sharpe_passed": True,
        },
        revenue_summary={"estimated_realized_pnl_usd": -50.0},
        thresholds=PromotionGateThresholds(
            min_net_pnl_after_costs_usd=0.0,
            max_slippage_mape_pct=20.0,
        ),
    )
    assert result["decision"] == "remain_in_paper"
    assert result["checks"]["net_pnl_after_costs"] is False


def test_promotion_gate_blocks_excess_slippage_mape():
    result = evaluate_promotion_gate(
        readiness={
            "trading_days": 45,
            "fills": 500,
            "ready_for_canary": True,
            "slippage_mape_pct": 48.0,
        },
        campaign_stats={"reject_rate": 0.03},
        ops_summary={"critical": 0},
        research_validation={
            "purged_cv_sharpe": 1.5,
            "walk_forward_sharpe": 1.2,
            "deflated_sharpe": 0.9,
            "purged_cv_passed": True,
            "walk_forward_passed": True,
            "deflated_sharpe_passed": True,
        },
        revenue_summary={"estimated_realized_pnl_usd": 500.0},
        thresholds=PromotionGateThresholds(
            min_net_pnl_after_costs_usd=0.0,
            max_slippage_mape_pct=35.0,
        ),
    )
    assert result["decision"] == "remain_in_paper"
    assert result["checks"]["slippage_mape_pct"] is False


def test_promotion_gate_blocks_when_deflated_sharpe_fails():
    result = evaluate_promotion_gate(
        readiness={
            "trading_days": 45,
            "fills": 500,
            "ready_for_canary": True,
            "slippage_mape_pct": 10.0,
        },
        campaign_stats={"reject_rate": 0.02},
        ops_summary={"critical": 0},
        research_validation={
            "purged_cv_sharpe": 1.5,
            "walk_forward_sharpe": 1.2,
            "deflated_sharpe": 0.4,
            "purged_cv_passed": True,
            "walk_forward_passed": True,
            "deflated_sharpe_passed": False,
        },
        revenue_summary={"estimated_realized_pnl_usd": 250.0},
    )
    assert result["decision"] == "remain_in_paper"
    assert result["checks"]["deflated_sharpe_passed"] is False


def test_promotion_gate_blocks_when_net_alpha_confidence_is_negative():
    result = evaluate_promotion_gate(
        readiness={
            "trading_days": 45,
            "fills": 500,
            "ready_for_canary": True,
            "slippage_mape_pct": 10.0,
        },
        campaign_stats={"reject_rate": 0.02},
        ops_summary={"critical": 0},
        research_validation={
            "purged_cv_sharpe": 1.3,
            "walk_forward_sharpe": 1.1,
            "deflated_sharpe": 0.9,
            "purged_cv_passed": True,
            "walk_forward_passed": True,
            "deflated_sharpe_passed": True,
            "parameter_stability_score": 0.8,
            "regime_robustness_score": 0.8,
        },
        revenue_summary={
            "estimated_realized_pnl_usd": 300.0,
            "avg_realized_net_alpha_bps": 1.0,
            "ci95_lower_realized_net_alpha_bps": -2.0,
        },
    )
    assert result["decision"] == "remain_in_paper"
    assert result["checks"]["net_alpha_confidence_passed"] is False
