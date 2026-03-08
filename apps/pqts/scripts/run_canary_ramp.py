#!/usr/bin/env python3
"""Evaluate canary capital ramp and persist allocation step with rollback policy."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import yaml

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from execution.canary_ramp import (  # noqa: E402
    CanaryRampController,
    CanaryRampMetrics,
    CanaryRampPolicy,
)
from risk.risk_tolerance import (  # noqa: E402
    resolve_risk_tolerance_profile,
    risk_profile_payload,
    scale_canary_steps_for_profile,
)


def _load_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object JSON at {path}")
    return payload


def _load_yaml(path: Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = yaml.safe_load(handle) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object YAML at {path}")
    return payload


def _latest(path: Path, pattern: str) -> Path:
    rows = sorted(path.glob(pattern))
    if not rows:
        raise FileNotFoundError(f"No files found in {path} for pattern {pattern}")
    return rows[-1]


def _latest_optional(path: Path, pattern: str) -> Path | None:
    rows = sorted(path.glob(pattern))
    if not rows:
        return None
    return rows[-1]


def _parse_dt(value: str) -> datetime:
    token = str(value).replace("Z", "+00:00")
    dt = datetime.fromisoformat(token)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument(
        "--risk-profile",
        default="",
        help=(
            "Risk tolerance profile override "
            "(conservative, balanced, aggressive, professional, or custom key)."
        ),
    )
    parser.add_argument("--reports-dir", default="data/reports")
    parser.add_argument("--campaign-snapshot", default="")
    parser.add_argument("--slo-health", default="")
    parser.add_argument("--execution-drift", default="")
    parser.add_argument("--state-path", default="data/analytics/canary_ramp_state.json")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--steps", default="0.01,0.02,0.05,0.10")
    parser.add_argument("--min-days-per-step", type=int, default=14)
    parser.add_argument("--max-reject-rate", type=float, default=0.05)
    parser.add_argument("--max-slippage-mape-pct", type=float, default=25.0)
    parser.add_argument("--max-tca-drift-mape-pct", type=float, default=35.0)
    parser.add_argument("--max-critical-alerts", type=int, default=0)
    parser.add_argument("--max-reconciliation-incidents", type=int, default=0)
    return parser


def _parse_steps(value: str) -> list[float]:
    steps = [float(token.strip()) for token in value.split(",") if token.strip()]
    if not steps:
        raise ValueError("--steps must include at least one numeric allocation fraction")
    return steps


def main() -> int:
    args = build_parser().parse_args()
    config = _load_yaml(Path(args.config))
    risk_profile = resolve_risk_tolerance_profile(
        config,
        override_profile=(args.risk_profile or None),
    )
    reports_dir = Path(args.reports_dir)
    campaign_path = (
        Path(args.campaign_snapshot)
        if args.campaign_snapshot
        else _latest(reports_dir, "paper_campaign_snapshot_*.json")
    )
    slo_path = (
        Path(args.slo_health) if args.slo_health else _latest(reports_dir, "slo_health_*.json")
    )
    drift_path = (
        Path(args.execution_drift)
        if args.execution_drift
        else _latest_optional(reports_dir, "execution_drift_*.json")
    )

    campaign = _load_json(campaign_path)
    slo = _load_json(slo_path)
    drift = _load_json(drift_path) if drift_path is not None else {"summary": {"healthy": False}}

    policy = CanaryRampPolicy(
        steps=scale_canary_steps_for_profile(_parse_steps(args.steps), profile=risk_profile),
        min_days_per_step=int(args.min_days_per_step),
        max_reject_rate=float(args.max_reject_rate),
        max_slippage_mape_pct=float(args.max_slippage_mape_pct),
        max_tca_drift_mape_pct=float(args.max_tca_drift_mape_pct),
        max_critical_alerts=int(args.max_critical_alerts),
        max_reconciliation_incidents=int(args.max_reconciliation_incidents),
    )
    controller = CanaryRampController(state_path=str(args.state_path), policy=policy)

    state = controller.load_state()
    now = datetime.now(timezone.utc)
    transition_at = _parse_dt(state.last_transition_at)
    days_in_step = max((now - transition_at).days, 0)

    readiness = campaign.get("readiness", {}) if isinstance(campaign.get("readiness"), dict) else {}
    stats = campaign.get("stats", {}) if isinstance(campaign.get("stats"), dict) else {}
    ops_health = (
        campaign.get("ops_health", {}) if isinstance(campaign.get("ops_health"), dict) else {}
    )
    ops_summary = (
        ops_health.get("summary", {}) if isinstance(ops_health.get("summary"), dict) else {}
    )

    slo_health = slo.get("slo_health", {}) if isinstance(slo.get("slo_health"), dict) else {}
    slo_metrics = (
        slo_health.get("metrics", {}) if isinstance(slo_health.get("metrics"), dict) else {}
    )
    slo_summary = (
        slo_health.get("summary", {}) if isinstance(slo_health.get("summary"), dict) else {}
    )
    reconciliation_incidents = int(slo_metrics.get("reconciliation_incidents", 0))
    drift_summary = drift.get("summary", {}) if isinstance(drift.get("summary"), dict) else {}
    tca_drift_mape_pct = float(drift_summary.get("mape_p95_pct", 0.0))
    tca_drift_healthy = bool(drift_summary.get("healthy", False))
    slo_healthy = bool(slo_summary.get("healthy", False))

    metrics = CanaryRampMetrics(
        days_in_step=days_in_step,
        reject_rate=float(stats.get("reject_rate", 0.0)),
        slippage_mape_pct=float(readiness.get("slippage_mape_pct", 0.0)),
        tca_drift_mape_pct=tca_drift_mape_pct,
        critical_alerts=int(ops_summary.get("critical", 0)),
        reconciliation_incidents=reconciliation_incidents,
        slo_healthy=bool(slo_healthy and tca_drift_healthy),
        kill_switch_triggered=bool(stats.get("kill_switch_active", False)),
    )
    decision = controller.evaluate_and_persist(metrics=metrics)

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "risk_profile": risk_profile_payload(risk_profile),
        "campaign_snapshot": str(campaign_path),
        "slo_health": str(slo_path),
        "execution_drift": str(drift_path) if drift_path is not None else "",
        "drift_summary": drift_summary,
        "decision": decision,
    }

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_path = out_dir / f"canary_ramp_{stamp}.json"
    report_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    payload["report_path"] = str(report_path)

    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
