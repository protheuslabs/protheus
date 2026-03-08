#!/usr/bin/env python3
"""Gate nightly sandbox certification and reconciliation thresholds."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List


def _load_json(path: str) -> Dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    token = str(value).strip()
    if token.endswith("Z"):
        token = token[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(token)
    except ValueError:
        return None


def _count_recent_reconciliation_incidents(path: str, *, lookback_hours: int) -> int:
    incident_path = Path(path)
    if not incident_path.exists():
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max(int(lookback_hours), 0))
    count = 0
    for line in incident_path.read_text(encoding="utf-8").splitlines():
        token = line.strip()
        if not token:
            continue
        try:
            payload = json.loads(token)
        except json.JSONDecodeError:
            continue
        ts = _parse_ts(payload.get("timestamp"))
        if ts is None:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts >= cutoff:
            count += 1
    return count


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cert-report", required=True)
    parser.add_argument(
        "--reconciliation-incidents",
        default="data/analytics/reconciliation_incidents.jsonl",
    )
    parser.add_argument("--reconciliation-lookback-hours", type=int, default=24)
    parser.add_argument("--max-reject-rate", type=float, default=0.05)
    parser.add_argument("--max-timeout-rate", type=float, default=0.02)
    parser.add_argument("--max-reconciliation-mismatches", type=int, default=0)
    parser.add_argument("--output", default="")
    return parser


def _evaluate(args: argparse.Namespace) -> Dict[str, Any]:
    cert = _load_json(str(args.cert_report))
    totals = cert.get("totals", {}) if isinstance(cert, dict) else {}
    reject_rate = float(totals.get("reject_rate", 0.0))
    timeout_rate = float(totals.get("timeout_rate", 0.0))
    mismatch_count = _count_recent_reconciliation_incidents(
        str(args.reconciliation_incidents),
        lookback_hours=int(args.reconciliation_lookback_hours),
    )

    failures: List[str] = []
    if not bool(cert.get("all_passed", False)):
        failures.append("certification_failed")
    if reject_rate > float(args.max_reject_rate):
        failures.append("reject_rate_exceeded")
    if timeout_rate > float(args.max_timeout_rate):
        failures.append("timeout_rate_exceeded")
    if mismatch_count > int(args.max_reconciliation_mismatches):
        failures.append("reconciliation_mismatch_exceeded")

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cert_report": str(args.cert_report),
        "cert_all_passed": bool(cert.get("all_passed", False)),
        "reject_rate": reject_rate,
        "timeout_rate": timeout_rate,
        "reconciliation_incidents_path": str(args.reconciliation_incidents),
        "reconciliation_incidents_lookback_hours": int(args.reconciliation_lookback_hours),
        "reconciliation_incidents_count": int(mismatch_count),
        "thresholds": {
            "max_reject_rate": float(args.max_reject_rate),
            "max_timeout_rate": float(args.max_timeout_rate),
            "max_reconciliation_mismatches": int(args.max_reconciliation_mismatches),
        },
        "failures": failures,
        "passed": len(failures) == 0,
    }
    return payload


def main() -> int:
    args = build_parser().parse_args()
    payload = _evaluate(args)
    output = str(args.output).strip()
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, sort_keys=True, indent=2), encoding="utf-8")
        payload["output_path"] = str(path)
    print(json.dumps(payload, sort_keys=True))
    return 0 if payload["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
