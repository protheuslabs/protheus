#!/usr/bin/env python3
"""Run paper-campaign mechanism ablations with isolated TCA ledgers."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import yaml

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.mechanism_switches import (  # noqa: E402
    apply_mechanism_switches,
    list_switches,
    parse_switch_overrides,
)


def _parse_json_from_output(output: str) -> Dict[str, Any]:
    for line in reversed(output.splitlines()):
        token = line.strip()
        if not token:
            continue
        try:
            payload = json.loads(token)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return {}


def _run(cmd: List[str]) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env.setdefault("PYTHONHASHSEED", "0")
    return subprocess.run(
        cmd,
        cwd=str(ROOT),
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )


def _serialize_switches(state: Dict[str, bool]) -> List[str]:
    rows: List[str] = []
    for key in list_switches():
        value = "on" if bool(state.get(key, False)) else "off"
        rows.append(f"{key}={value}")
    return rows


def _build_campaign_cmd(
    *,
    args: argparse.Namespace,
    tca_db_path: str,
    switch_state: Dict[str, bool],
    research_validation_path: str,
    expected_alpha_bps: float | None,
) -> List[str]:
    cmd: List[str] = [
        sys.executable,
        str(ROOT / "scripts" / "run_paper_campaign.py"),
        "--config",
        str(args.config),
        "--cycles",
        str(int(args.cycles)),
        "--sleep-seconds",
        str(float(args.sleep_seconds)),
        "--notional-usd",
        str(float(args.notional_usd)),
        "--readiness-every",
        str(int(args.readiness_every)),
        "--out-dir",
        str(args.out_dir),
        "--lookback-days",
        str(int(args.lookback_days)),
        "--min-days",
        str(int(args.min_days)),
        "--min-fills",
        str(int(args.min_fills)),
        "--paper-base-slippage-bps",
        str(float(args.paper_base_slippage_bps)),
        "--paper-min-slippage-bps",
        str(float(args.paper_min_slippage_bps)),
        "--paper-stress-multiplier",
        str(float(args.paper_stress_multiplier)),
        "--paper-stress-fill-ratio-multiplier",
        str(float(args.paper_stress_fill_ratio_multiplier)),
        "--tca-db-path",
        str(tca_db_path),
    ]
    if str(args.symbols or "").strip():
        cmd.extend(["--symbols", str(args.symbols)])
    if str(args.risk_profile or "").strip():
        cmd.extend(["--risk-profile", str(args.risk_profile)])
    for switch in _serialize_switches(switch_state):
        cmd.extend(["--switch", switch])
    if expected_alpha_bps is not None:
        cmd.extend(["--campaign-expected-alpha-bps", str(float(expected_alpha_bps))])
    elif str(research_validation_path).strip():
        cmd.extend(["--research-validation", str(research_validation_path)])
    return cmd


def _summarize_case(
    *,
    case_id: str,
    mechanism: str,
    switch_state: Dict[str, bool],
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    revenue_summary = (
        payload.get("revenue", {}).get("summary", {})
        if isinstance(payload.get("revenue"), dict)
        else {}
    )
    pnl_usd = float(revenue_summary.get("estimated_realized_pnl_usd", 0.0) or 0.0)
    notional_usd = float(revenue_summary.get("notional_usd", 0.0) or 0.0)
    roi_pct_notional = (pnl_usd / max(notional_usd, 1e-9)) * 100.0
    return {
        "case_id": str(case_id),
        "mechanism": str(mechanism),
        "switch_state": {key: bool(switch_state.get(key, False)) for key in list_switches()},
        "campaign_expected_alpha_bps": float(
            payload.get("campaign_expected_alpha_bps", 0.0) or 0.0
        ),
        "campaign_expected_alpha_source": str(payload.get("campaign_expected_alpha_source", "")),
        "submitted": int(payload.get("submitted", 0) or 0),
        "filled": int(payload.get("filled", 0) or 0),
        "rejected": int(payload.get("rejected", 0) or 0),
        "reject_rate": float(payload.get("reject_rate", 0.0) or 0.0),
        "trades": int(revenue_summary.get("trades", 0) or 0),
        "avg_realized_cost_bps": float(revenue_summary.get("avg_realized_cost_bps", 0.0) or 0.0),
        "avg_realized_net_alpha_bps": float(
            revenue_summary.get("avg_realized_net_alpha_bps", 0.0) or 0.0
        ),
        "estimated_realized_pnl_usd": float(pnl_usd),
        "notional_usd": float(notional_usd),
        "roi_pct_on_notional": float(roi_pct_notional),
    }


def _write_report(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = out_dir / f"mechanism_ablation_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def _build_research_validation(args: argparse.Namespace) -> str:
    if str(args.research_validation or "").strip():
        return str(args.research_validation).strip()

    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "build_research_validation_payload.py"),
        "--reports-dir",
        str(args.reports_dir),
        "--out-dir",
        str(args.out_dir),
        "--min-purged-cv-sharpe",
        str(float(args.min_purged_cv_sharpe)),
        "--min-walk-forward-sharpe",
        str(float(args.min_walk_forward_sharpe)),
        "--min-deflated-sharpe",
        str(float(args.min_deflated_sharpe)),
        "--min-parameter-stability-score",
        str(float(args.min_parameter_stability_score)),
        "--min-regime-robustness-score",
        str(float(args.min_regime_robustness_score)),
    ]
    if str(args.report or "").strip():
        cmd.extend(["--report", str(args.report)])
    payload = _parse_json_from_output(_run(cmd).stdout)
    return str(payload.get("payload_path", "")).strip()


def _parse_mechanisms(raw: str) -> List[str]:
    known = set(list_switches())
    out: List[str] = []
    for row in str(raw or "").split(","):
        token = row.strip().lower().replace("-", "_")
        if not token:
            continue
        if token not in known:
            raise ValueError(
                f"Unknown mechanism '{token}'. Valid values: {', '.join(list_switches())}"
            )
        out.append(token)
    return out or list(list_switches())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--tca-dir", default="data/tca/ablation")
    parser.add_argument("--reports-dir", default="data/research_reports")
    parser.add_argument("--report", default="")
    parser.add_argument("--research-validation", default="")
    parser.add_argument("--risk-profile", default="")
    parser.add_argument("--symbols", default="BTCUSDT,ETHUSDT,BTC-USD,ETH-USD")
    parser.add_argument("--mechanisms", default=",".join(list_switches()))
    parser.add_argument("--cycles", type=int, default=300)
    parser.add_argument("--sleep-seconds", type=float, default=0.0)
    parser.add_argument("--notional-usd", type=float, default=200.0)
    parser.add_argument("--readiness-every", type=int, default=100)
    parser.add_argument("--lookback-days", type=int, default=60)
    parser.add_argument("--min-days", type=int, default=1)
    parser.add_argument("--min-fills", type=int, default=1)
    parser.add_argument("--paper-base-slippage-bps", type=float, default=3.0)
    parser.add_argument("--paper-min-slippage-bps", type=float, default=0.5)
    parser.add_argument("--paper-stress-multiplier", type=float, default=1.25)
    parser.add_argument("--paper-stress-fill-ratio-multiplier", type=float, default=0.90)
    parser.add_argument("--min-purged-cv-sharpe", type=float, default=1.0)
    parser.add_argument("--min-walk-forward-sharpe", type=float, default=1.0)
    parser.add_argument("--min-deflated-sharpe", type=float, default=0.8)
    parser.add_argument("--min-parameter-stability-score", type=float, default=0.55)
    parser.add_argument("--min-regime-robustness-score", type=float, default=0.55)
    parser.add_argument("--include-agent-off", action="store_true")
    parser.add_argument(
        "--switch",
        dest="switches",
        action="append",
        default=[],
        help="Baseline mechanism switch override, e.g. --switch allocation_controls=on",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    out_dir = Path(args.out_dir)
    tca_dir = Path(args.tca_dir)
    tca_dir.mkdir(parents=True, exist_ok=True)

    base_config = yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) or {}
    base_overrides = parse_switch_overrides(args.switches)
    _, baseline_switches = apply_mechanism_switches(base_config, overrides=base_overrides)
    mechanisms = _parse_mechanisms(args.mechanisms)
    research_validation_path = _build_research_validation(args)

    cases: List[Dict[str, Any]] = []
    run_rows: List[Dict[str, Any]] = []

    baseline_case = {"case_id": "baseline", "mechanism": "baseline", "switches": baseline_switches}
    cases.append(baseline_case)
    if bool(args.include_agent_off):
        cases.append(
            {
                "case_id": "agent_off_baseline",
                "mechanism": "agent_off",
                "switches": baseline_switches,
                "expected_alpha_bps": 0.0,
            }
        )

    for mechanism in mechanisms:
        state = dict(baseline_switches)
        state[mechanism] = not bool(state.get(mechanism, False))
        cases.append(
            {
                "case_id": f"ablate_{mechanism}",
                "mechanism": mechanism,
                "switches": state,
            }
        )

    for index, case in enumerate(cases):
        case_id = str(case["case_id"])
        tca_path = tca_dir / f"{case_id}.csv"
        if tca_path.exists():
            tca_path.unlink()
        cmd = _build_campaign_cmd(
            args=args,
            tca_db_path=str(tca_path),
            switch_state=dict(case["switches"]),
            research_validation_path=research_validation_path,
            expected_alpha_bps=case.get("expected_alpha_bps"),
        )
        output = _run(cmd)
        payload = _parse_json_from_output(output.stdout)
        run_rows.append(
            _summarize_case(
                case_id=case_id,
                mechanism=str(case.get("mechanism", "")),
                switch_state=dict(case["switches"]),
                payload=payload,
            )
        )

    baseline_row = next((row for row in run_rows if row["case_id"] == "baseline"), None)
    baseline_roi = float(baseline_row["roi_pct_on_notional"]) if baseline_row else 0.0
    for row in run_rows:
        row["roi_delta_vs_baseline_pct_points"] = float(row["roi_pct_on_notional"]) - baseline_roi

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "config": str(args.config),
        "research_validation_path": str(research_validation_path),
        "baseline_switches": {
            key: bool(baseline_switches.get(key, False)) for key in list_switches()
        },
        "mechanisms_tested": mechanisms,
        "cases_run": len(run_rows),
        "rows": run_rows,
    }
    report_path = _write_report(out_dir, payload)
    payload["report_path"] = str(report_path)
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
