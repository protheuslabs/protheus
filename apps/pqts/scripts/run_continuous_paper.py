#!/usr/bin/env python3
"""Run continuous paper trading slices with periodic calibration re-evaluation."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
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


def _load_report(payload: Dict[str, Any]) -> Dict[str, Any]:
    report_path = str(payload.get("report_path", "")).strip()
    if not report_path:
        return {}
    path = Path(report_path)
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _build_campaign_cmd(args: argparse.Namespace) -> List[str]:
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
        "--max-degraded-venues",
        str(int(args.max_degraded_venues)),
        "--max-calibration-alerts",
        str(int(args.max_calibration_alerts)),
        "--promotion-min-days",
        str(int(args.promotion_min_days)),
        "--promotion-max-days",
        str(int(args.promotion_max_days)),
        "--out-dir",
        args.out_dir,
        "--tca-db-path",
        args.tca_db,
    ]
    symbols = str(args.campaign_symbols).strip()
    if symbols:
        cmd.extend(["--symbols", symbols])
    risk_profile = str(args.risk_profile).strip()
    if risk_profile:
        cmd.extend(["--risk-profile", risk_profile])
    for switch in list(getattr(args, "switches", []) or []):
        cmd.extend(["--switch", str(switch)])
    return cmd


def _build_readiness_cmd(args: argparse.Namespace) -> List[str]:
    return [
        sys.executable,
        str(ROOT / "scripts" / "paper_readiness_report.py"),
        "--tca-db",
        args.tca_db,
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
        "--out-dir",
        args.out_dir,
    ]


def _build_drift_cmd(args: argparse.Namespace) -> List[str]:
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
        "--min-ratio",
        str(float(args.min_ratio)),
        "--max-ratio",
        str(float(args.max_ratio)),
    ]


def _build_calibration_cmd(args: argparse.Namespace) -> List[str]:
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
        "--min-ratio",
        str(float(args.min_ratio)),
        "--max-ratio",
        str(float(args.max_ratio)),
    ]


def _checkpoint_decision(
    *,
    readiness: Dict[str, Any],
    drift_report: Dict[str, Any],
    calibration_report: Dict[str, Any],
) -> Dict[str, Any]:
    readiness_ready = bool(readiness.get("ready_for_canary", False))
    drift_summary = dict(drift_report.get("summary", {}))
    calibration_summary = dict(calibration_report.get("summary", {}))
    drift_alerts = int(drift_summary.get("alerts", 0))
    calibration_alerts = int(calibration_summary.get("alerts", 0))
    warmup_pairs = int(drift_summary.get("warmup_pairs", 0))

    if readiness_ready and drift_alerts == 0 and calibration_alerts == 0:
        action = "eligible_for_canary_review"
    elif warmup_pairs > 0 and not readiness_ready:
        action = "remain_in_paper_warmup"
    else:
        action = "remain_in_paper_calibrate"

    return {
        "action": action,
        "ready_for_canary": readiness_ready,
        "drift_alerts": drift_alerts,
        "calibration_alerts": calibration_alerts,
        "warmup_pairs": warmup_pairs,
    }


def _write_checkpoint(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = out_dir / f"continuous_paper_checkpoint_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _write_summary(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = out_dir / f"continuous_paper_summary_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--tca-db", default="data/tca_records.csv")
    parser.add_argument("--risk-profile", default="")
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
    parser.add_argument("--min-ratio", type=float, default=0.5)
    parser.add_argument("--max-ratio", type=float, default=1.5)
    parser.add_argument("--max-degraded-venues", type=int, default=0)
    parser.add_argument("--max-calibration-alerts", type=int, default=0)
    parser.add_argument("--promotion-min-days", type=int, default=30)
    parser.add_argument("--promotion-max-days", type=int, default=90)
    parser.add_argument("--continuous", action="store_true")
    parser.add_argument("--max-slices", type=int, default=0)
    parser.add_argument("--runtime-hours", type=float, default=0.0)
    parser.add_argument("--slice-interval-seconds", type=float, default=0.0)
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
    started = datetime.now(timezone.utc)
    checkpoints: List[Dict[str, Any]] = []

    while True:
        elapsed_hours = (datetime.now(timezone.utc) - started).total_seconds() / 3600.0
        if not bool(args.continuous) and len(checkpoints) >= 1:
            break
        if int(args.max_slices) > 0 and len(checkpoints) >= int(args.max_slices):
            break
        if float(args.runtime_hours) > 0.0 and elapsed_hours >= float(args.runtime_hours):
            break

        campaign_run = _run(_build_campaign_cmd(args))
        campaign_payload = _parse_json_from_output(campaign_run.stdout)

        readiness_run = _run(_build_readiness_cmd(args))
        readiness_payload = _parse_json_from_output(readiness_run.stdout)

        drift_run = _run(_build_drift_cmd(args))
        drift_payload = _parse_json_from_output(drift_run.stdout)
        drift_report = _load_report(drift_payload)

        calibration_run = _run(_build_calibration_cmd(args))
        calibration_payload = _parse_json_from_output(calibration_run.stdout)
        calibration_report = _load_report(calibration_payload)

        decision = _checkpoint_decision(
            readiness=readiness_payload,
            drift_report=drift_report,
            calibration_report=calibration_report,
        )
        checkpoint = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "slice": len(checkpoints) + 1,
            "campaign": campaign_payload,
            "readiness": readiness_payload,
            "execution_drift": drift_report,
            "calibration_diagnostics": calibration_report,
            "decision": decision,
        }
        checkpoint_path = _write_checkpoint(out_dir, checkpoint)
        checkpoint["checkpoint_path"] = str(checkpoint_path)
        checkpoints.append(checkpoint)
        print(
            json.dumps(
                {
                    "slice": int(checkpoint["slice"]),
                    "decision": str(decision.get("action", "unknown")),
                    "checkpoint_path": str(checkpoint_path),
                },
                sort_keys=True,
            )
        )

        if float(args.slice_interval_seconds) > 0.0:
            time.sleep(float(args.slice_interval_seconds))

    summary = {
        "started_at": started.isoformat(),
        "ended_at": datetime.now(timezone.utc).isoformat(),
        "continuous": bool(args.continuous),
        "slices_run": len(checkpoints),
        "latest_checkpoint": str(checkpoints[-1]["checkpoint_path"]) if checkpoints else "",
        "checkpoints": checkpoints,
    }
    summary_path = _write_summary(out_dir, summary)
    summary["report_path"] = str(summary_path)
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
