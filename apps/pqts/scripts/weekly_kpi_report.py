#!/usr/bin/env python3
"""Generate weekly operations + alpha KPIs for promotion and tuning."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
import sys

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.revenue_diagnostics import RevenueDiagnostics  # noqa: E402
from analytics.slo_monitor import load_reconciliation_incidents  # noqa: E402
from execution.portfolio_optimizer import optimize_strategy_weights  # noqa: E402


def _load_json(path: str) -> Dict[str, Any]:
    token = str(path or "").strip()
    if not token:
        return {}
    payload = json.loads(Path(token).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return {}
    return payload


def _write_report(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = out_dir / f"weekly_kpi_report_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tca-db", default="data/tca_records.csv")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--lookback-days", type=int, default=7)
    parser.add_argument("--prediction-profile", default="")
    parser.add_argument("--readiness-json", default="")
    parser.add_argument("--ops-health-json", default="")
    parser.add_argument(
        "--reconciliation-incidents", default="data/analytics/reconciliation_incidents.jsonl"
    )
    parser.add_argument("--max-slippage-mape-pct", type=float, default=35.0)
    parser.add_argument("--min-ci95-lower-net-alpha-bps", type=float, default=0.0)
    parser.add_argument("--max-reconciliation-incidents", type=int, default=0)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    diagnostics = RevenueDiagnostics(tca_db_path=str(args.tca_db))
    payload = diagnostics.payload(
        lookback_days=int(args.lookback_days),
        prediction_profile=str(args.prediction_profile or "").strip(),
    )
    summary = payload.get("summary", {}) if isinstance(payload, dict) else {}
    frame = diagnostics._frame(  # noqa: SLF001 - CLI helper intentionally reuses normalized frame.
        lookback_days=int(args.lookback_days),
        prediction_profile=str(args.prediction_profile or "").strip(),
    )

    expected_alpha: Dict[str, float] = {}
    volatility: Dict[str, float] = {}
    corr_input: Dict[str, Dict[str, float]] = {}
    if not frame.empty and "strategy_id" in frame.columns:
        grouped = frame.groupby("strategy_id")
        for strategy, rows in grouped:
            values = pd.to_numeric(rows["realized_net_alpha_bps"], errors="coerce").fillna(0.0)
            expected_alpha[str(strategy)] = float(values.mean())
            volatility[str(strategy)] = float(values.std(ddof=1)) if len(values) > 1 else 0.0
        if grouped.ngroups >= 2:
            pivot = frame.pivot_table(
                index=frame["timestamp"],
                columns="strategy_id",
                values="realized_net_alpha_bps",
                aggfunc="mean",
            ).fillna(0.0)
            corr = pivot.corr()
            for left in corr.columns:
                corr_input[str(left)] = {
                    str(right): float(corr.loc[left, right]) for right in corr.columns
                }

    optimizer = optimize_strategy_weights(
        expected_alpha_bps_by_strategy=expected_alpha,
        volatility_bps_by_strategy=volatility,
        correlation_matrix=corr_input,
        max_weight=0.50,
        min_weight=0.0,
    )

    readiness = _load_json(str(args.readiness_json))
    ops_health = _load_json(str(args.ops_health_json))
    incidents = load_reconciliation_incidents(
        incidents_path=str(args.reconciliation_incidents),
        lookback_hours=int(max(int(args.lookback_days), 1) * 24),
    )
    reconciliation_incident_count = int(len(incidents))
    checks = {
        "slippage_mape_pct": float(summary.get("slippage_mape_pct", 0.0))
        <= float(args.max_slippage_mape_pct),
        "ci95_lower_realized_net_alpha_bps": float(
            summary.get("ci95_lower_realized_net_alpha_bps", 0.0)
        )
        >= float(args.min_ci95_lower_net_alpha_bps),
        "reconciliation_incidents": reconciliation_incident_count
        <= int(args.max_reconciliation_incidents),
    }

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "lookback_days": int(args.lookback_days),
        "prediction_profile": str(args.prediction_profile or ""),
        "revenue": payload,
        "readiness": readiness,
        "ops_health": ops_health,
        "reconciliation_incidents": reconciliation_incident_count,
        "checks": checks,
        "portfolio_optimizer": optimizer.to_dict(),
    }
    report_path = _write_report(Path(args.out_dir), report)
    report["report_path"] = str(report_path)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
