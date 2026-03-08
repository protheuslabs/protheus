#!/usr/bin/env python3
"""Execute the 10-step world-class ops checklist and emit a consolidated report."""

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


def _run_step(name: str, command: List[str], *, allow_fail: bool = False) -> Dict[str, Any]:
    started = datetime.now(timezone.utc)
    env = dict(os.environ)
    existing_pythonpath = str(env.get("PYTHONPATH", "")).strip()
    root_str = str(ROOT)
    env["PYTHONPATH"] = (
        root_str
        if not existing_pythonpath
        else f"{root_str}{os.pathsep}{existing_pythonpath}"
    )
    completed = subprocess.run(
        command,
        cwd=str(ROOT),
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    ended = datetime.now(timezone.utc)
    payload = _parse_json_from_output(completed.stdout)
    return {
        "name": str(name),
        "command": command,
        "rc": int(completed.returncode),
        "ok": bool(completed.returncode == 0 or allow_fail),
        "allow_fail": bool(allow_fail),
        "started_at": started.isoformat(),
        "ended_at": ended.isoformat(),
        "duration_seconds": float((ended - started).total_seconds()),
        "stdout_tail": completed.stdout.splitlines()[-20:],
        "stderr_tail": completed.stderr.splitlines()[-20:],
        "payload": payload,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--quick", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    campaign_cycles = 20 if args.quick else 720
    ws_cycles = 3 if args.quick else 120
    shadow_cycles = 2 if args.quick else 30

    steps: List[Dict[str, Any]] = []
    python = sys.executable
    live_secret_file = out_dir / "live_secret_smoke.json"
    live_secret_file.write_text(
        json.dumps(
            {
                "BINANCE_LIVE_API_KEY": "smoke_binance_key",
                "BINANCE_LIVE_API_SECRET": "smoke_binance_secret",
                "COINBASE_LIVE_API_KEY": "smoke_coinbase_key",
                "COINBASE_LIVE_API_SECRET": "smoke_coinbase_secret",
                "COINBASE_LIVE_PASSPHRASE": "smoke_coinbase_passphrase",
            }
        ),
        encoding="utf-8",
    )
    live_cfg_src = ROOT / "config" / "live_canary.yaml"
    live_cfg_payload = yaml.safe_load(live_cfg_src.read_text(encoding="utf-8")) or {}
    runtime = live_cfg_payload.setdefault("runtime", {})
    runtime["secrets"] = {
        "backend": "file_json",
        "file_json_path": str(live_secret_file),
    }
    live_cfg_resolved = out_dir / "live_canary_smoke.yaml"
    live_cfg_resolved.write_text(yaml.safe_dump(live_cfg_payload), encoding="utf-8")

    steps.append(
        _run_step(
            "1_paper_campaign",
            [
                python,
                "scripts/daily_paper_ops.py",
                "--config",
                str(args.config),
                "--campaign-cycles",
                str(campaign_cycles),
                "--campaign-sleep-seconds",
                "0.0",
                "--campaign-readiness-every",
                "5",
                "--lookback-days",
                "7",
                "--min-days",
                "1",
                "--min-fills",
                "1",
                "--out-dir",
                str(out_dir),
            ],
        )
    )
    steps.append(
        _run_step(
            "2_ws_ingestion_data_lake",
            [
                python,
                "scripts/run_ws_ingestion.py",
                "--config",
                str(args.config),
                "--cycles",
                str(ws_cycles),
                "--sleep-seconds",
                "0.0",
                "--events-path",
                "data/analytics/ws_ingestion_events.jsonl",
                "--data-lake-root",
                "data/lake",
                "--out-dir",
                str(out_dir),
                "--no-live-fetcher",
            ],
        )
    )
    steps.append(
        _run_step(
            "3_incident_automation",
            [
                python,
                "scripts/run_incident_automation.py",
                "--ops-events",
                "data/analytics/ops_events.jsonl",
                "--incident-log",
                "data/analytics/incidents.jsonl",
                "--since-minutes",
                "120",
            ],
        )
    )
    steps.append(
        _run_step(
            "4_monthly_attribution",
            [
                python,
                "scripts/monthly_attribution_report.py",
                "--db-path",
                "data/research.db",
                "--stage",
                "paper",
                "--lookback-days",
                "90",
            ],
            allow_fail=True,
        )
    )
    steps.append(
        _run_step(
            "5_exchange_certification",
            [
                python,
                "scripts/run_exchange_certification.py",
                "--venues",
                "binance,coinbase,alpaca,oanda",
            ],
        )
    )
    steps.append(
        _run_step(
            "6_live_secret_validation",
            [
                python,
                "scripts/validate_live_secrets.py",
                "--config",
                str(live_cfg_resolved),
                "--strict",
            ],
        )
    )
    steps.append(
        _run_step(
            "7_shadow_stream_worker",
            [
                python,
                "scripts/run_shadow_stream_worker.py",
                "--config",
                str(args.config),
                "--cycles",
                str(shadow_cycles),
                "--sleep-seconds",
                "0.0",
                "--out-dir",
                str(out_dir),
            ],
        )
    )
    steps.append(
        _run_step(
            "7_slo_health",
            [
                python,
                "scripts/slo_health_report.py",
                "--stream-health",
                "data/analytics/stream_health.json",
                "--out-dir",
                str(out_dir),
            ],
        )
    )
    steps.append(
        _run_step(
            "7_canary_ramp",
            [
                python,
                "scripts/run_canary_ramp.py",
                "--config",
                str(args.config),
                "--reports-dir",
                str(out_dir),
                "--out-dir",
                str(out_dir),
                "--min-days-per-step",
                "1",
            ],
        )
    )
    steps.append(
        _run_step(
            "8_capacity_ladder",
            [
                python,
                "scripts/run_capacity_ladder.py",
                "--storage-path",
                "data/analytics/capacity_curve_samples.jsonl",
                "--out-dir",
                str(out_dir),
            ],
        )
    )
    steps.append(
        _run_step(
            "9_failure_drills",
            [
                python,
                "scripts/run_failure_drills.py",
                "--config",
                str(args.config),
                "--out-dir",
                str(out_dir),
            ],
        )
    )
    steps.append(
        _run_step(
            "10_entitlement_tests",
            [
                python,
                "-m",
                "pytest",
                "-q",
                "tests/test_multi_tenant.py",
            ],
        )
    )

    overall_ok = all(bool(step.get("ok", False)) for step in steps)
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "quick_mode": bool(args.quick),
        "config": str(args.config),
        "overall_ok": bool(overall_ok),
        "step_count": len(steps),
        "steps": steps,
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_path = out_dir / f"world_class_ops_{stamp}.json"
    report_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    payload["report_path"] = str(report_path)
    print(json.dumps(payload, sort_keys=True))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
