"""Dashboard-facing API for research stage gates, A/B metrics, and lineage drilldowns."""

from __future__ import annotations

import json
import logging
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import pandas as pd

from research.database import ResearchDatabase

logger = logging.getLogger(__name__)


def default_stage_gate_config() -> Dict[str, Dict[str, Any]]:
    """Return default stage-gate thresholds aligned with AIResearchAgent defaults."""
    return {
        "live_canary": {
            "source_stage": "paper",
            "min_days": 30,
            "min_avg_sharpe": 1.0,
            "max_avg_drawdown": 0.15,
            "max_slippage_mape": 25.0,
            "max_kill_switch_triggers": 0,
        },
        "live": {
            "source_stage": "live_canary",
            "min_days": 14,
            "min_avg_sharpe": 0.8,
            "max_avg_drawdown": 0.12,
            "max_slippage_mape": 20.0,
            "max_kill_switch_triggers": 0,
        },
    }


def _parse_notes(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            payload = json.loads(value)
            return payload if isinstance(payload, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _normalize_arm(value: Any) -> Optional[str]:
    token = str(value).strip().lower() if value is not None else ""
    if token in {"treatment", "pilot", "agent", "ai_pilot", "challenger"}:
        return "treatment"
    if token in {"control", "autopilot", "baseline", "rules_only"}:
        return "control"
    return None


def _empty_arm_metrics() -> Dict[str, Any]:
    return {
        "samples": 0,
        "strategies": 0,
        "avg_sharpe": 0.0,
        "avg_drawdown": 0.0,
        "net_pnl": 0.0,
        "avg_slippage_mape": 0.0,
        "total_kill_switch_triggers": 0,
        "promotion_events": 0,
        "false_promotions": 0,
        "false_promotion_rate": 0.0,
    }


class ResearchDashboardAPI:
    """Read-only analytics API used by dashboards and monitoring tools."""

    def __init__(
        self,
        db_path: str = "data/research.db",
        stage_gates: Optional[Dict[str, Dict[str, Any]]] = None,
    ):
        self.db = ResearchDatabase(db_path)
        self.stage_gates = (
            deepcopy(stage_gates) if stage_gates is not None else default_stage_gate_config()
        )

    def close(self) -> None:
        self.db.close()

    def _read_sql(self, query: str, params: tuple = ()) -> pd.DataFrame:
        return pd.read_sql_query(query, self.db.conn, params=params)

    def _latest_operator_by_experiment(self) -> Dict[str, str]:
        operators: Dict[str, str] = {}
        artifacts = self.db.get_report_artifacts()
        if artifacts.empty:
            return operators

        for _, row in artifacts.iterrows():
            experiment_id = str(row["experiment_id"])
            if experiment_id in operators:
                continue

            report_path = Path(str(row["report_path"]))
            if not report_path.exists():
                continue

            try:
                payload = json.loads(report_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue

            decision = payload.get("decision", {})
            if not isinstance(decision, dict):
                continue
            arm = _normalize_arm(decision.get("operator"))
            if arm is not None:
                operators[experiment_id] = arm

        return operators

    def _pilot_assignment_by_experiment(self) -> Dict[str, str]:
        assignments = self.db.list_pilot_assignments()
        if assignments.empty:
            return {}
        mapping: Dict[str, str] = {}
        for _, row in assignments.iterrows():
            arm = _normalize_arm(row.get("arm"))
            if arm is None:
                continue
            mapping[str(row.get("experiment_id"))] = arm
        return mapping

    @staticmethod
    def _extract_arm(notes_payload: Dict[str, Any]) -> Optional[str]:
        for key in ("arm", "ab_arm", "pilot_arm", "operator", "decision_operator"):
            arm = _normalize_arm(notes_payload.get(key))
            if arm is not None:
                return arm

        decision = notes_payload.get("decision")
        if isinstance(decision, dict):
            for key in ("arm", "operator"):
                arm = _normalize_arm(decision.get(key))
                if arm is not None:
                    return arm
        return None

    def _arm_for_metric_row(
        self,
        *,
        experiment_id: str,
        notes: Any,
        default_operators: Dict[str, str],
    ) -> Optional[str]:
        notes_payload = _parse_notes(notes)
        arm = self._extract_arm(notes_payload)
        if arm is not None:
            return arm
        return default_operators.get(experiment_id)

    def get_stage_gate_health(
        self,
        *,
        target_stage: str = "live_canary",
        lookback_days: int = 365,
        experiment_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        if target_stage not in self.stage_gates:
            raise ValueError(f"Unknown target stage: {target_stage}")

        gate = self.stage_gates[target_stage]
        source_stage = str(gate["source_stage"])

        if experiment_id:
            experiment_ids = [experiment_id]
        else:
            ids_frame = self._read_sql(
                """
                SELECT DISTINCT experiment_id
                FROM stage_metrics
                WHERE stage = ?
                ORDER BY experiment_id
                """,
                (source_stage,),
            )
            experiment_ids = (
                ids_frame["experiment_id"].astype(str).tolist() if not ids_frame.empty else []
            )

        rows = []
        for strategy_id in experiment_ids:
            summary = self.db.get_stage_summary(
                strategy_id, source_stage, lookback_days=lookback_days
            )
            checks = {
                "days": summary["days"] >= gate["min_days"],
                "sharpe": summary["avg_sharpe"] >= gate["min_avg_sharpe"],
                "drawdown": summary["avg_drawdown"] <= gate["max_avg_drawdown"],
                "slippage_mape": summary["avg_slippage_mape"] <= gate["max_slippage_mape"],
                "kill_switches": summary["total_kill_switch_triggers"]
                <= gate["max_kill_switch_triggers"],
            }
            shortfall = {
                "days_shortfall": max(0, int(gate["min_days"]) - int(summary["days"])),
                "sharpe_shortfall": max(
                    0.0, float(gate["min_avg_sharpe"]) - float(summary["avg_sharpe"])
                ),
                "drawdown_excess": max(
                    0.0, float(summary["avg_drawdown"]) - float(gate["max_avg_drawdown"])
                ),
                "slippage_mape_excess": max(
                    0.0,
                    float(summary["avg_slippage_mape"]) - float(gate["max_slippage_mape"]),
                ),
                "kill_switch_excess": max(
                    0,
                    int(summary["total_kill_switch_triggers"])
                    - int(gate["max_kill_switch_triggers"]),
                ),
            }
            rows.append(
                {
                    "experiment_id": strategy_id,
                    "summary": summary,
                    "checks": checks,
                    "passed": all(checks.values()),
                    "shortfall": shortfall,
                }
            )

        rows.sort(
            key=lambda item: (
                item["passed"],
                item["summary"]["avg_sharpe"],
                item["summary"]["total_pnl"],
            ),
            reverse=True,
        )

        total_candidates = len(rows)
        passed_candidates = sum(1 for row in rows if row["passed"])
        pass_rate = (passed_candidates / total_candidates) if total_candidates else 0.0

        return {
            "target_stage": target_stage,
            "source_stage": source_stage,
            "lookback_days": int(lookback_days),
            "gate_spec": {
                "min_days": int(gate["min_days"]),
                "min_avg_sharpe": float(gate["min_avg_sharpe"]),
                "max_avg_drawdown": float(gate["max_avg_drawdown"]),
                "max_slippage_mape": float(gate["max_slippage_mape"]),
                "max_kill_switch_triggers": int(gate["max_kill_switch_triggers"]),
            },
            "total_candidates": total_candidates,
            "passed_candidates": passed_candidates,
            "pass_rate": pass_rate,
            "strategies": rows,
        }

    def _promotion_outcomes(
        self,
        *,
        lookback_days: int,
        arm_by_experiment: Dict[str, str],
    ) -> Dict[str, Dict[str, Any]]:
        outcomes = {
            "control": _empty_arm_metrics(),
            "treatment": _empty_arm_metrics(),
        }
        frame = self._read_sql("""
            SELECT experiment_id, from_stage, to_stage, reason, timestamp
            FROM promotion_audit
            ORDER BY timestamp ASC
            """)
        if frame.empty:
            return outcomes

        frame = frame.copy()
        frame["timestamp_dt"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame = frame[frame["timestamp_dt"].notna()]

        cutoff = datetime.now(timezone.utc) - timedelta(days=int(lookback_days))
        promotions = frame[
            (frame["timestamp_dt"] >= pd.Timestamp(cutoff))
            & (frame["to_stage"].isin(["live_canary", "live"]))
        ]
        if promotions.empty:
            return outcomes

        for _, row in promotions.iterrows():
            experiment_id = str(row["experiment_id"])
            arm = arm_by_experiment.get(experiment_id)
            if arm not in outcomes:
                continue

            outcomes[arm]["promotion_events"] += 1
            promotion_ts = row["timestamp_dt"]
            horizon = promotion_ts + pd.Timedelta(days=30)
            later = frame[
                (frame["experiment_id"] == experiment_id)
                & (frame["timestamp_dt"] > promotion_ts)
                & (frame["timestamp_dt"] <= horizon)
            ]
            if later.empty:
                continue

            later_stage = later["to_stage"].astype(str).str.lower()
            later_reason = later["reason"].fillna("").astype(str).str.lower()
            demoted_stage = later_stage.isin(["paper", "backtest"]).any()
            demoted_reason = later_reason.str.contains(
                "demote|kill|breach|blocked|rollback|stop",
                regex=True,
            ).any()
            if demoted_stage or demoted_reason:
                outcomes[arm]["false_promotions"] += 1

        for arm in ("control", "treatment"):
            promotions_count = int(outcomes[arm]["promotion_events"])
            false_count = int(outcomes[arm]["false_promotions"])
            outcomes[arm]["false_promotion_rate"] = (
                false_count / promotions_count if promotions_count else 0.0
            )

        return outcomes

    def get_pilot_ab_metrics(
        self,
        *,
        lookback_days: int = 90,
        stage: Optional[str] = None,
    ) -> Dict[str, Any]:
        frame = self._read_sql("""
            SELECT experiment_id, stage, timestamp, pnl, sharpe, drawdown,
                   slippage_mape, kill_switch_triggers, notes
            FROM stage_metrics
            """)

        cutoff = datetime.now(timezone.utc) - timedelta(days=int(lookback_days))
        window_end = datetime.now(timezone.utc)
        arm_metrics = {
            "control": _empty_arm_metrics(),
            "treatment": _empty_arm_metrics(),
        }

        if frame.empty:
            return {
                "lookback_days": int(lookback_days),
                "stage_filter": stage,
                "window_start": cutoff.isoformat(),
                "window_end": window_end.isoformat(),
                "samples_labeled": 0,
                "arms": arm_metrics,
                "differential": {
                    "sharpe": 0.0,
                    "net_pnl": 0.0,
                    "false_promotion_rate": 0.0,
                    "slippage_mape": 0.0,
                    "kill_switch_triggers": 0,
                },
            }

        frame = frame.copy()
        frame["timestamp_dt"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame = frame[frame["timestamp_dt"].notna()]
        frame = frame[frame["timestamp_dt"] >= pd.Timestamp(cutoff)]
        if stage is not None:
            frame = frame[frame["stage"] == stage]

        default_operators = self._latest_operator_by_experiment()
        default_operators.update(self._pilot_assignment_by_experiment())
        frame["arm"] = frame.apply(
            lambda row: self._arm_for_metric_row(
                experiment_id=str(row["experiment_id"]),
                notes=row.get("notes"),
                default_operators=default_operators,
            ),
            axis=1,
        )
        frame = frame[frame["arm"].isin(["control", "treatment"])]

        for arm in ("control", "treatment"):
            subset = frame[frame["arm"] == arm]
            if subset.empty:
                continue
            arm_metrics[arm] = {
                "samples": int(len(subset)),
                "strategies": int(subset["experiment_id"].nunique()),
                "avg_sharpe": float(subset["sharpe"].mean()),
                "avg_drawdown": float(subset["drawdown"].mean()),
                "net_pnl": float(subset["pnl"].sum()),
                "avg_slippage_mape": float(subset["slippage_mape"].mean()),
                "total_kill_switch_triggers": int(subset["kill_switch_triggers"].sum()),
                "promotion_events": 0,
                "false_promotions": 0,
                "false_promotion_rate": 0.0,
            }

        arm_by_experiment = {
            str(exp_id): arm
            for exp_id, arm in frame[["experiment_id", "arm"]].drop_duplicates().values
        }
        promotion_outcomes = self._promotion_outcomes(
            lookback_days=lookback_days,
            arm_by_experiment=arm_by_experiment,
        )
        for arm in ("control", "treatment"):
            arm_metrics[arm]["promotion_events"] = int(promotion_outcomes[arm]["promotion_events"])
            arm_metrics[arm]["false_promotions"] = int(promotion_outcomes[arm]["false_promotions"])
            arm_metrics[arm]["false_promotion_rate"] = float(
                promotion_outcomes[arm]["false_promotion_rate"]
            )

        differential = {
            "sharpe": arm_metrics["treatment"]["avg_sharpe"] - arm_metrics["control"]["avg_sharpe"],
            "net_pnl": arm_metrics["treatment"]["net_pnl"] - arm_metrics["control"]["net_pnl"],
            "false_promotion_rate": arm_metrics["treatment"]["false_promotion_rate"]
            - arm_metrics["control"]["false_promotion_rate"],
            "slippage_mape": arm_metrics["treatment"]["avg_slippage_mape"]
            - arm_metrics["control"]["avg_slippage_mape"],
            "kill_switch_triggers": arm_metrics["treatment"]["total_kill_switch_triggers"]
            - arm_metrics["control"]["total_kill_switch_triggers"],
        }

        return {
            "lookback_days": int(lookback_days),
            "stage_filter": stage,
            "window_start": cutoff.isoformat(),
            "window_end": window_end.isoformat(),
            "samples_labeled": int(len(frame)),
            "arms": arm_metrics,
            "differential": differential,
        }

    def get_lineage_drilldown(self, experiment_id: str) -> Dict[str, Any]:
        artifacts = self.db.get_report_artifacts(experiment_id)
        if artifacts.empty:
            return {
                "experiment_id": experiment_id,
                "found": False,
                "artifact_count": 0,
                "artifacts": [],
                "latest": {},
                "promotion_audit": [],
            }

        records = []
        for _, row in artifacts.iterrows():
            records.append(
                {
                    "report_id": str(row["report_id"]),
                    "created_at": str(row["created_at"]),
                    "report_path": str(row["report_path"]),
                    "report_sha256": str(row["report_sha256"]),
                    "schema_version": str(row["schema_version"]),
                    "decision_action": str(row["decision_action"]),
                    "promoted": bool(row["promoted"]),
                    "summary": (
                        row.get("summary", {}) if isinstance(row.get("summary"), dict) else {}
                    ),
                }
            )

        latest = records[0]
        payload: Dict[str, Any] = {}
        report_path = Path(latest["report_path"])
        if report_path.exists():
            try:
                payload = json.loads(report_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                logger.warning("Failed to read report payload: %s", report_path)

        audit_frame = self._read_sql(
            """
            SELECT from_stage, to_stage, reason, timestamp
            FROM promotion_audit
            WHERE experiment_id = ?
            ORDER BY timestamp DESC
            """,
            (experiment_id,),
        )
        promotion_audit = audit_frame.to_dict(orient="records")

        return {
            "experiment_id": experiment_id,
            "found": True,
            "artifact_count": len(records),
            "latest": latest,
            "lineage": payload.get("lineage", {}),
            "validation": payload.get("validation", {}),
            "execution": payload.get("execution", {}),
            "promotion": payload.get("promotion", {}),
            "decision": payload.get("decision", {}),
            "objective": payload.get("objective", {}),
            "extras": payload.get("extras", {}),
            "artifacts": records,
            "promotion_audit": promotion_audit,
        }

    def get_experiment_governance(self, experiment_id: str) -> Dict[str, Any]:
        """Return immutable run registry and rollback provenance for one experiment."""
        runs = self.db.list_experiment_runs(experiment_id=experiment_id)
        rollbacks = self.db.list_rollback_events(experiment_id=experiment_id)
        return {
            "experiment_id": str(experiment_id),
            "run_count": int(len(runs)),
            "rollback_count": int(len(rollbacks)),
            "latest_run": self.db.latest_experiment_run(experiment_id),
            "runs": runs.to_dict(orient="records"),
            "rollbacks": rollbacks.to_dict(orient="records"),
        }
