"""Policy-driven canary capital ramp with deterministic rollback rules."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


@dataclass(frozen=True)
class CanaryRampPolicy:
    steps: List[float]
    min_days_per_step: int = 14
    max_reject_rate: float = 0.05
    max_slippage_mape_pct: float = 25.0
    max_tca_drift_mape_pct: float = 35.0
    max_critical_alerts: int = 0
    max_reconciliation_incidents: int = 0
    require_slo_healthy: bool = True

    @staticmethod
    def default() -> "CanaryRampPolicy":
        return CanaryRampPolicy(steps=[0.01, 0.02, 0.05, 0.10])


@dataclass
class CanaryRampState:
    step_index: int
    allocation_pct: float
    status: str
    last_transition_at: str
    reason: str


@dataclass(frozen=True)
class CanaryRampMetrics:
    days_in_step: int
    reject_rate: float
    slippage_mape_pct: float
    tca_drift_mape_pct: float
    critical_alerts: int
    reconciliation_incidents: int
    slo_healthy: bool
    kill_switch_triggered: bool


class CanaryRampController:
    """Evaluate, persist, and advance/rollback canary allocation policy."""

    def __init__(
        self,
        *,
        state_path: str = "data/analytics/canary_ramp_state.json",
        policy: CanaryRampPolicy | None = None,
    ):
        self.state_path = Path(state_path)
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.policy = policy or CanaryRampPolicy.default()
        if not self.policy.steps:
            raise ValueError("CanaryRampPolicy.steps must not be empty")

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def load_state(self) -> CanaryRampState:
        if not self.state_path.exists():
            return CanaryRampState(
                step_index=0,
                allocation_pct=float(self.policy.steps[0]),
                status="active",
                last_transition_at=self._utc_now_iso(),
                reason="initialized",
            )

        payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        return CanaryRampState(
            step_index=int(payload.get("step_index", 0)),
            allocation_pct=float(payload.get("allocation_pct", float(self.policy.steps[0]))),
            status=str(payload.get("status", "active")),
            last_transition_at=str(payload.get("last_transition_at", self._utc_now_iso())),
            reason=str(payload.get("reason", "loaded")),
        )

    def save_state(self, state: CanaryRampState) -> None:
        self.state_path.write_text(
            json.dumps(asdict(state), indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def evaluate(self, *, state: CanaryRampState, metrics: CanaryRampMetrics) -> Dict[str, Any]:
        policy = self.policy
        checks = {
            "reject_rate": float(metrics.reject_rate) <= float(policy.max_reject_rate),
            "slippage_mape_pct": float(metrics.slippage_mape_pct)
            <= float(policy.max_slippage_mape_pct),
            "tca_drift_mape_pct": float(metrics.tca_drift_mape_pct)
            <= float(policy.max_tca_drift_mape_pct),
            "critical_alerts": int(metrics.critical_alerts) <= int(policy.max_critical_alerts),
            "reconciliation_incidents": int(metrics.reconciliation_incidents)
            <= int(policy.max_reconciliation_incidents),
            "kill_switch": not bool(metrics.kill_switch_triggered),
            "slo_healthy": bool(metrics.slo_healthy) if bool(policy.require_slo_healthy) else True,
        }

        action = "hold"
        next_step = int(state.step_index)
        status = str(state.status)
        reason = "within_policy"

        severe_breach = not checks["kill_switch"] or not checks["critical_alerts"]
        moderate_breach = (
            (not checks["reject_rate"])
            or (not checks["slippage_mape_pct"])
            or (not checks["tca_drift_mape_pct"])
            or (not checks["reconciliation_incidents"])
            or (not checks["slo_healthy"])
        )

        if severe_breach:
            action = "halt"
            next_step = 0
            status = "halted"
            reason = "severe_risk_breach"
        elif moderate_breach:
            action = "rollback"
            next_step = max(int(state.step_index) - 1, 0)
            status = "active"
            reason = "policy_breach"
        elif int(metrics.days_in_step) >= int(policy.min_days_per_step):
            if int(state.step_index) < len(policy.steps) - 1:
                action = "advance"
                next_step = int(state.step_index) + 1
                status = "active"
                reason = "stability_window_passed"
            else:
                action = "hold"
                reason = "max_step_reached"

        allocation_pct = float(policy.steps[next_step])
        return {
            "action": action,
            "next_state": CanaryRampState(
                step_index=next_step,
                allocation_pct=allocation_pct,
                status=status,
                last_transition_at=self._utc_now_iso(),
                reason=reason,
            ),
            "checks": checks,
            "metrics": asdict(metrics),
            "policy": asdict(policy),
        }

    def evaluate_and_persist(self, *, metrics: CanaryRampMetrics) -> Dict[str, Any]:
        current = self.load_state()
        decision = self.evaluate(state=current, metrics=metrics)
        next_state: CanaryRampState = decision["next_state"]

        if decision["action"] == "hold":
            # Preserve previous transition timestamp while holding allocation.
            next_state = CanaryRampState(
                step_index=current.step_index,
                allocation_pct=current.allocation_pct,
                status=next_state.status,
                last_transition_at=current.last_transition_at,
                reason=next_state.reason,
            )

        self.save_state(next_state)
        return {
            "action": decision["action"],
            "state": asdict(next_state),
            "checks": decision["checks"],
            "metrics": decision["metrics"],
            "policy": decision["policy"],
            "state_path": str(self.state_path),
        }
