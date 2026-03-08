"""Tests for canary capital ramp advancement and rollback behavior."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.canary_ramp import (
    CanaryRampController,
    CanaryRampMetrics,
    CanaryRampPolicy,
    CanaryRampState,
)


def test_canary_ramp_advances_after_stable_window(tmp_path):
    controller = CanaryRampController(
        state_path=str(tmp_path / "canary_state.json"),
        policy=CanaryRampPolicy(
            steps=[0.01, 0.02, 0.05],
            min_days_per_step=14,
            max_reject_rate=0.10,
            max_slippage_mape_pct=30.0,
            max_critical_alerts=0,
            max_reconciliation_incidents=0,
        ),
    )
    state = CanaryRampState(
        step_index=0,
        allocation_pct=0.01,
        status="active",
        last_transition_at="2026-01-01T00:00:00+00:00",
        reason="seed",
    )
    controller.save_state(state)

    result = controller.evaluate_and_persist(
        metrics=CanaryRampMetrics(
            days_in_step=14,
            reject_rate=0.01,
            slippage_mape_pct=10.0,
            tca_drift_mape_pct=8.0,
            critical_alerts=0,
            reconciliation_incidents=0,
            slo_healthy=True,
            kill_switch_triggered=False,
        )
    )

    assert result["action"] == "advance"
    assert result["state"]["allocation_pct"] == 0.02
    assert result["state"]["step_index"] == 1


def test_canary_ramp_rolls_back_on_policy_breach(tmp_path):
    controller = CanaryRampController(
        state_path=str(tmp_path / "canary_state.json"),
        policy=CanaryRampPolicy(
            steps=[0.01, 0.02, 0.05],
            min_days_per_step=14,
            max_reject_rate=0.05,
            max_slippage_mape_pct=20.0,
            max_critical_alerts=0,
            max_reconciliation_incidents=0,
        ),
    )
    state = CanaryRampState(
        step_index=2,
        allocation_pct=0.05,
        status="active",
        last_transition_at="2026-01-01T00:00:00+00:00",
        reason="seed",
    )
    controller.save_state(state)

    result = controller.evaluate_and_persist(
        metrics=CanaryRampMetrics(
            days_in_step=7,
            reject_rate=0.12,
            slippage_mape_pct=30.0,
            tca_drift_mape_pct=45.0,
            critical_alerts=0,
            reconciliation_incidents=1,
            slo_healthy=False,
            kill_switch_triggered=False,
        )
    )

    assert result["action"] == "rollback"
    assert result["state"]["step_index"] == 1
    assert result["state"]["allocation_pct"] == 0.02


def test_canary_ramp_holds_when_slo_or_tca_drift_not_green(tmp_path):
    controller = CanaryRampController(
        state_path=str(tmp_path / "canary_state.json"),
        policy=CanaryRampPolicy(
            steps=[0.01, 0.02, 0.05],
            min_days_per_step=14,
            max_reject_rate=0.10,
            max_slippage_mape_pct=30.0,
            max_tca_drift_mape_pct=20.0,
            max_critical_alerts=0,
            max_reconciliation_incidents=0,
            require_slo_healthy=True,
        ),
    )
    state = CanaryRampState(
        step_index=0,
        allocation_pct=0.01,
        status="active",
        last_transition_at="2026-01-01T00:00:00+00:00",
        reason="seed",
    )
    controller.save_state(state)

    result = controller.evaluate_and_persist(
        metrics=CanaryRampMetrics(
            days_in_step=20,
            reject_rate=0.01,
            slippage_mape_pct=10.0,
            tca_drift_mape_pct=25.0,
            critical_alerts=0,
            reconciliation_incidents=0,
            slo_healthy=False,
            kill_switch_triggered=False,
        )
    )

    assert result["action"] in {"rollback", "hold"}
    assert result["checks"]["slo_healthy"] is False
    assert result["checks"]["tca_drift_mape_pct"] is False
