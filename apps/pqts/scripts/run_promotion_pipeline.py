#!/usr/bin/env python3
"""Run sustained paper campaign slices and gate promotion into canary ramps."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent.parent


def _parse_json_from_output(output: str) -> Dict[str, Any]:
    for line in reversed(output.splitlines()):
        token = line.strip()
        if not token:
            continue
        try:
            payload = json.loads(token)
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            continue
    return {}


def _run(cmd: List[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(ROOT), check=True, capture_output=True, text=True)


def _build_research_validation_cmd(
    *,
    report: str,
    reports_dir: str,
    out_dir: str,
    min_purged_cv_sharpe: float,
    min_walk_forward_sharpe: float,
    min_deflated_sharpe: float,
    min_parameter_stability_score: float,
    min_regime_robustness_score: float,
) -> List[str]:
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "build_research_validation_payload.py"),
        "--reports-dir",
        reports_dir,
        "--out-dir",
        out_dir,
        "--min-purged-cv-sharpe",
        str(float(min_purged_cv_sharpe)),
        "--min-walk-forward-sharpe",
        str(float(min_walk_forward_sharpe)),
        "--min-deflated-sharpe",
        str(float(min_deflated_sharpe)),
        "--min-parameter-stability-score",
        str(float(min_parameter_stability_score)),
        "--min-regime-robustness-score",
        str(float(min_regime_robustness_score)),
    ]
    if str(report).strip():
        cmd.extend(["--report", report])
    return cmd


def _build_campaign_cmd(
    *,
    args: argparse.Namespace,
    research_validation_path: str,
) -> List[str]:
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "run_paper_campaign.py"),
        "--config",
        args.config,
        "--cycles",
        str(int(args.campaign_cycles)),
        "--sleep-seconds",
        str(float(args.campaign_sleep_seconds)),
        "--notional-usd",
        str(float(args.campaign_notional_usd)),
        "--readiness-every",
        str(int(args.campaign_readiness_every)),
        "--out-dir",
        args.out_dir,
        "--lookback-days",
        str(int(args.lookback_days)),
        "--min-days",
        str(int(args.min_days)),
        "--min-fills",
        str(int(args.min_fills)),
        "--max-p95-slippage-bps",
        str(float(args.max_p95_slippage_bps)),
        "--max-mape-pct",
        str(float(args.max_mape_pct)),
        "--calibration-min-samples",
        str(int(args.calibration_min_samples)),
        "--calibration-adaptation-rate",
        str(float(args.calibration_adaptation_rate)),
        "--calibration-max-step-pct",
        str(float(args.calibration_max_step_pct)),
        "--max-calibration-alerts",
        str(int(args.max_calibration_alerts)),
        "--promotion-min-days",
        str(int(args.promotion_min_days)),
        "--promotion-max-days",
        str(int(args.promotion_max_days)),
        "--promotion-min-purged-cv-sharpe",
        str(float(args.promotion_min_purged_cv_sharpe)),
        "--promotion-min-walk-forward-sharpe",
        str(float(args.promotion_min_walk_forward_sharpe)),
        "--promotion-min-deflated-sharpe",
        str(float(args.promotion_min_deflated_sharpe)),
        "--promotion-min-parameter-stability-score",
        str(float(args.promotion_min_parameter_stability_score)),
        "--promotion-min-regime-robustness-score",
        str(float(args.promotion_min_regime_robustness_score)),
        "--promotion-min-realized-net-alpha-bps",
        str(float(args.promotion_min_realized_net_alpha_bps)),
        "--promotion-min-ci95-lower-realized-net-alpha-bps",
        str(float(args.promotion_min_ci95_lower_realized_net_alpha_bps)),
    ]
    symbols = str(args.campaign_symbols or "").strip()
    if symbols:
        cmd.extend(["--symbols", symbols])
    if str(args.risk_profile or "").strip():
        cmd.extend(["--risk-profile", str(args.risk_profile)])
    for switch in list(getattr(args, "switches", []) or []):
        cmd.extend(["--switch", str(switch)])
    if str(research_validation_path).strip():
        cmd.extend(["--research-validation", research_validation_path])
    return cmd


def _build_execution_drift_cmd(*, args: argparse.Namespace) -> List[str]:
    return [
        sys.executable,
        str(ROOT / "scripts" / "execution_drift_report.py"),
        "--tca-db",
        args.tca_db,
        "--out-dir",
        args.out_dir,
        "--lookback-days",
        str(int(args.lookback_days)),
        "--min-samples",
        str(int(args.min_fills)),
        "--max-mape-pct",
        str(float(args.max_mape_pct)),
    ]


def _build_calibration_diagnostics_cmd(*, args: argparse.Namespace) -> List[str]:
    return [
        sys.executable,
        str(ROOT / "scripts" / "calibration_diagnostics_report.py"),
        "--tca-db",
        args.tca_db,
        "--out-dir",
        args.out_dir,
        "--lookback-days",
        str(int(args.lookback_days)),
        "--min-samples",
        str(int(args.min_fills)),
        "--max-mape-pct",
        str(float(args.max_mape_pct)),
    ]


def _build_canary_cmd(*, args: argparse.Namespace) -> List[str]:
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "run_canary_ramp.py"),
        "--config",
        args.config,
        "--reports-dir",
        args.out_dir,
        "--out-dir",
        args.out_dir,
        "--state-path",
        args.canary_state_path,
        "--min-days-per-step",
        str(int(args.canary_min_days_per_step)),
        "--max-slippage-mape-pct",
        str(float(args.canary_max_slippage_mape_pct)),
        "--max-tca-drift-mape-pct",
        str(float(args.canary_max_tca_drift_mape_pct)),
    ]
    if str(args.risk_profile or "").strip():
        cmd.extend(["--risk-profile", str(args.risk_profile)])
    return cmd


def _write_report(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"promotion_pipeline_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument("--risk-profile", default="")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--tca-db", default="data/tca_records.csv")
    parser.add_argument("--research-validation", default="")
    parser.add_argument("--research-report", default="")
    parser.add_argument("--research-reports-dir", default="data/research_reports")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--campaign-symbols", default="BTCUSDT,ETHUSDT,BTC-USD,ETH-USD")
    parser.add_argument("--campaign-cycles", type=int, default=1440)
    parser.add_argument("--campaign-sleep-seconds", type=float, default=60.0)
    parser.add_argument("--campaign-notional-usd", type=float, default=150.0)
    parser.add_argument("--campaign-readiness-every", type=int, default=60)
    parser.add_argument("--lookback-days", type=int, default=60)
    parser.add_argument("--min-days", type=int, default=30)
    parser.add_argument("--min-fills", type=int, default=200)
    parser.add_argument("--max-p95-slippage-bps", type=float, default=20.0)
    parser.add_argument("--max-mape-pct", type=float, default=35.0)
    parser.add_argument("--calibration-min-samples", type=int, default=10)
    parser.add_argument("--calibration-adaptation-rate", type=float, default=0.75)
    parser.add_argument("--calibration-max-step-pct", type=float, default=0.80)
    parser.add_argument("--max-calibration-alerts", type=int, default=0)
    parser.add_argument("--promotion-min-days", type=int, default=30)
    parser.add_argument("--promotion-max-days", type=int, default=90)
    parser.add_argument("--promotion-min-purged-cv-sharpe", type=float, default=1.0)
    parser.add_argument("--promotion-min-walk-forward-sharpe", type=float, default=1.0)
    parser.add_argument("--promotion-min-deflated-sharpe", type=float, default=0.8)
    parser.add_argument("--promotion-min-parameter-stability-score", type=float, default=0.55)
    parser.add_argument("--promotion-min-regime-robustness-score", type=float, default=0.55)
    parser.add_argument("--promotion-min-realized-net-alpha-bps", type=float, default=0.0)
    parser.add_argument(
        "--promotion-min-ci95-lower-realized-net-alpha-bps", type=float, default=0.0
    )
    parser.add_argument("--canary-state-path", default="data/analytics/canary_ramp_state.json")
    parser.add_argument("--canary-min-days-per-step", type=int, default=14)
    parser.add_argument("--canary-max-slippage-mape-pct", type=float, default=25.0)
    parser.add_argument("--canary-max-tca-drift-mape-pct", type=float, default=35.0)
    parser.add_argument("--require-promotion", action="store_true")
    parser.add_argument("--halt-on-canary-breach", action="store_true")
    parser.add_argument(
        "--switch",
        dest="switches",
        action="append",
        default=[],
        help="Mechanism switch override, e.g. --switch slippage_stress_model=off",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    out_dir = Path(args.out_dir)

    epochs: List[Dict[str, Any]] = []
    promotions = 0
    canary_breaches = 0
    research_validation_path = str(args.research_validation or "").strip()

    for index in range(int(args.epochs)):
        if not research_validation_path:
            cmd = _build_research_validation_cmd(
                report=str(args.research_report or ""),
                reports_dir=str(args.research_reports_dir),
                out_dir=str(args.out_dir),
                min_purged_cv_sharpe=float(args.promotion_min_purged_cv_sharpe),
                min_walk_forward_sharpe=float(args.promotion_min_walk_forward_sharpe),
                min_deflated_sharpe=float(args.promotion_min_deflated_sharpe),
                min_parameter_stability_score=float(args.promotion_min_parameter_stability_score),
                min_regime_robustness_score=float(args.promotion_min_regime_robustness_score),
            )
            build_run = _run(cmd)
            build_payload = _parse_json_from_output(build_run.stdout)
            research_validation_path = str(build_payload.get("payload_path", "")).strip()

        campaign_run = _run(
            _build_campaign_cmd(args=args, research_validation_path=research_validation_path)
        )
        campaign_payload = _parse_json_from_output(campaign_run.stdout)

        drift_run = _run(_build_execution_drift_cmd(args=args))
        drift_payload = _parse_json_from_output(drift_run.stdout)
        calibration_run = _run(_build_calibration_diagnostics_cmd(args=args))
        calibration_payload = _parse_json_from_output(calibration_run.stdout)

        promotion_gate = (
            campaign_payload.get("promotion_gate", {})
            if isinstance(campaign_payload.get("promotion_gate"), dict)
            else {}
        )
        decision = str(promotion_gate.get("decision", "remain_in_paper"))

        epoch_row: Dict[str, Any] = {
            "epoch": index + 1,
            "research_validation_path": research_validation_path,
            "campaign": campaign_payload,
            "execution_drift": drift_payload,
            "calibration_diagnostics": calibration_payload,
            "promotion_decision": decision,
            "canary": {},
        }

        if decision == "promote_to_live_canary":
            promotions += 1
            canary_run = _run(_build_canary_cmd(args=args))
            canary_payload = _parse_json_from_output(canary_run.stdout)
            epoch_row["canary"] = canary_payload
            canary_action = str(canary_payload.get("decision", {}).get("action", "")).lower()
            if canary_action in {"halt", "rollback"}:
                canary_breaches += 1
                if bool(args.halt_on_canary_breach):
                    epochs.append(epoch_row)
                    break

        epochs.append(epoch_row)

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "epochs_requested": int(args.epochs),
        "epochs_run": len(epochs),
        "promotions": promotions,
        "canary_breaches": canary_breaches,
        "require_promotion": bool(args.require_promotion),
        "halt_on_canary_breach": bool(args.halt_on_canary_breach),
        "epochs": epochs,
    }
    report_path = _write_report(out_dir, payload)
    payload["report_path"] = str(report_path)
    print(json.dumps(payload, sort_keys=True))

    if bool(args.require_promotion) and promotions == 0:
        return 2
    if bool(args.halt_on_canary_breach) and canary_breaches > 0:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
