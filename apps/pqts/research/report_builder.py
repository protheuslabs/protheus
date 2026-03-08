"""Unified report builder for research/analytics artifacts."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from research.analytics_models import (
    DataLineage,
    DecisionAttribution,
    ExecutionAnalyticsSnapshot,
    PromotionSnapshot,
    StrategyAnalyticsReport,
    ValidationSnapshot,
)
from research.database import ResearchDatabase


def _stable_hash(payload: Dict[str, Any]) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class ResearchAnalyticsReportBuilder:
    """Build and persist canonical strategy analytics reports."""

    def __init__(
        self,
        output_dir: str = "data/research_reports",
        schema_version: str = "1.0.0",
        db: Optional[ResearchDatabase] = None,
    ):
        self.output_dir = Path(output_dir)
        self.schema_version = schema_version
        self.db = db
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def build_from_result_row(
        self,
        *,
        result_row: Dict[str, Any],
        data_lineage: Dict[str, Any],
        objective_assessment: Dict[str, Any],
        promotion_stage: str,
        promoted: bool,
        promotion_reason: str,
        promotion_gate_checks: Optional[Dict[str, bool]] = None,
        decision: Optional[Dict[str, Any]] = None,
        tca_snapshot: Optional[Dict[str, Any]] = None,
        extras: Optional[Dict[str, Any]] = None,
    ) -> StrategyAnalyticsReport:
        variant = result_row["variant"]
        metrics = result_row.get("metrics", {})
        cv = result_row.get("cv", {})
        wf = result_row.get("walk_forward", {}).get("aggregate", {})

        lineage = DataLineage(
            dataset_id=str(data_lineage.get("dataset_id", "unknown")),
            symbols=list(data_lineage.get("symbols", [])),
            start=str(data_lineage.get("start", "")),
            end=str(data_lineage.get("end", "")),
            bars=int(data_lineage.get("bars", 0)),
            timezone=str(data_lineage.get("timezone", "UTC")),
            source=str(data_lineage.get("source", "historical_backtest")),
            code_sha=str(data_lineage.get("code_sha", "unknown")),
            config_hash=str(data_lineage.get("config_hash", "")),
        )

        validation = ValidationSnapshot(
            sharpe=float(metrics.get("sharpe", 0.0)),
            total_return=float(metrics.get("total_return", 0.0)),
            max_drawdown=float(metrics.get("max_drawdown", 0.0)),
            win_rate=float(metrics.get("win_rate", 0.0)),
            total_trades=int(metrics.get("total_trades", 0)),
            turnover_annualized=float(metrics.get("turnover_annualized", 0.0)),
            cost_drag_bps=float(metrics.get("cost_drag_bps", 0.0)),
            capacity_ratio=float(metrics.get("capacity_ratio", 0.0)),
            cv_sharpe=float(cv.get("cv_sharpe", 0.0)),
            cv_sharpe_std=float(cv.get("cv_sharpe_std", 0.0)),
            cv_drawdown=float(cv.get("cv_drawdown", 0.0)),
            deflated_sharpe=float(result_row.get("deflated_sharpe", 0.0)),
            pbo_estimate=float(result_row.get("pbo_estimate", 1.0)),
            walk_forward_sharpe=float(wf.get("avg_sharpe", result_row.get("walk_forward_sharpe", 0.0))),
            walk_forward_drawdown=float(
                abs(wf.get("avg_drawdown", result_row.get("walk_forward_drawdown", 0.0)))
            ),
            walk_forward_consistency=float(
                wf.get("consistency_score", result_row.get("walk_forward_consistency", 0.0))
            ),
            validator_passed=bool(result_row.get("validator_passed", False)),
            validator_reasons=list(result_row.get("validator_reasons", [])),
        )

        execution = ExecutionAnalyticsSnapshot(
            tca_samples=int((tca_snapshot or {}).get("tca_samples", 0)),
            slippage_mape=float((tca_snapshot or {}).get("slippage_mape", 0.0)),
            predicted_slippage_bps=float((tca_snapshot or {}).get("predicted_slippage_bps", 0.0)),
            realized_slippage_bps=float((tca_snapshot or {}).get("realized_slippage_bps", 0.0)),
            fill_ratio=float((tca_snapshot or {}).get("fill_ratio", 0.0)),
            regime_tca=dict((tca_snapshot or {}).get("regime_tca", {})),
        )

        promotion = PromotionSnapshot(
            current_stage=str(promotion_stage),
            target_stage="paper",
            promoted=bool(promoted),
            gate_checks=dict(promotion_gate_checks or {}),
            reason=promotion_reason,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

        decision_payload = decision or {}
        decision_obj = DecisionAttribution(
            action=str(decision_payload.get("action", "hold")),
            rationale=str(decision_payload.get("rationale", "no_rationale_supplied")),
            supporting_card_ids=list(decision_payload.get("supporting_card_ids", [])),
            counterevidence_card_ids=list(decision_payload.get("counterevidence_card_ids", [])),
            confidence=float(np.clip(float(decision_payload.get("confidence", 0.5)), 0.0, 1.0)),
            operator=str(decision_payload.get("operator", "autopilot")),
        )

        report_seed = {
            "experiment_id": variant.strategy_id,
            "schema_version": self.schema_version,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        report_id = f"rep_{_stable_hash(report_seed)[:16]}"
        report = StrategyAnalyticsReport(
            schema_version=self.schema_version,
            report_id=report_id,
            created_at=report_seed["created_at"],
            experiment_id=variant.strategy_id,
            strategy_type=variant.strategy_type,
            lineage=lineage,
            validation=validation,
            execution=execution,
            promotion=promotion,
            decision=decision_obj,
            objective=objective_assessment,
            extras=dict(extras or {}),
        )
        return report

    def save_report(self, report: StrategyAnalyticsReport) -> Tuple[Path, str]:
        payload = report.to_dict()
        report_json = json.dumps(payload, indent=2, sort_keys=True)
        report_hash = hashlib.sha256(report_json.encode("utf-8")).hexdigest()

        folder = self.output_dir / report.experiment_id
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{report.report_id}.json"
        path.write_text(report_json + "\n", encoding="utf-8")

        if self.db is not None:
            summary = {
                "strategy_type": report.strategy_type,
                "sharpe": report.validation.sharpe,
                "deflated_sharpe": report.validation.deflated_sharpe,
                "action": report.decision.action,
                "promoted": report.promotion.promoted,
            }
            self.db.log_report_artifact(
                report_id=report.report_id,
                experiment_id=report.experiment_id,
                report_path=str(path),
                report_sha256=report_hash,
                schema_version=report.schema_version,
                decision_action=report.decision.action,
                promoted=report.promotion.promoted,
                summary=summary,
            )

        return path, report_hash

    def build_and_save_from_result_row(self, **kwargs) -> Tuple[StrategyAnalyticsReport, Path, str]:
        report = self.build_from_result_row(**kwargs)
        path, report_hash = self.save_report(report)
        return report, path, report_hash

    @staticmethod
    def summarize_tca_by_regime(
        *,
        tca_records: List[Dict[str, Any]],
        regime_by_timestamp: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Produce execution analytics summary and optional regime-conditioned attribution.

        `tca_records` should include:
        - predicted_slippage_bps
        - realized_slippage_bps
        - filled_qty / requested_qty (optional)
        - timestamp (ISO string)
        """
        if not tca_records:
            return {
                "tca_samples": 0,
                "slippage_mape": 0.0,
                "predicted_slippage_bps": 0.0,
                "realized_slippage_bps": 0.0,
                "fill_ratio": 0.0,
                "regime_tca": {},
            }

        predicted = np.array(
            [float(rec.get("predicted_slippage_bps", 0.0)) for rec in tca_records], dtype=float
        )
        realized = np.array(
            [float(rec.get("realized_slippage_bps", 0.0)) for rec in tca_records], dtype=float
        )
        denom = np.where(np.abs(realized) > 1e-9, np.abs(realized), 1.0)
        mape = float(np.mean(np.abs(predicted - realized) / denom) * 100.0)

        fill_ratios = []
        for rec in tca_records:
            requested = float(rec.get("requested_qty", 0.0))
            filled = float(rec.get("filled_qty", requested))
            if requested > 0:
                fill_ratios.append(filled / requested)
        fill_ratio = float(np.mean(fill_ratios)) if fill_ratios else 0.0

        regime_tca: Dict[str, Dict[str, float]] = {}
        if regime_by_timestamp:
            grouped: Dict[str, List[Tuple[float, float]]] = {}
            for rec in tca_records:
                ts = str(rec.get("timestamp", ""))
                regime = regime_by_timestamp.get(ts)
                if not regime:
                    continue
                grouped.setdefault(regime, []).append(
                    (
                        float(rec.get("predicted_slippage_bps", 0.0)),
                        float(rec.get("realized_slippage_bps", 0.0)),
                    )
                )

            for regime, rows in grouped.items():
                p = np.array([x[0] for x in rows], dtype=float)
                r = np.array([x[1] for x in rows], dtype=float)
                d = np.where(np.abs(r) > 1e-9, np.abs(r), 1.0)
                regime_tca[regime] = {
                    "samples": float(len(rows)),
                    "predicted_slippage_bps": float(np.mean(p)),
                    "realized_slippage_bps": float(np.mean(r)),
                    "slippage_mape": float(np.mean(np.abs(p - r) / d) * 100.0),
                }

        return {
            "tca_samples": int(len(tca_records)),
            "slippage_mape": mape,
            "predicted_slippage_bps": float(np.mean(predicted)),
            "realized_slippage_bps": float(np.mean(realized)),
            "fill_ratio": fill_ratio,
            "regime_tca": regime_tca,
        }
