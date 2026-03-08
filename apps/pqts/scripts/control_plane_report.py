#!/usr/bin/env python3
"""Generate B2B control-plane usage + pricing recommendation report."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.control_plane import (  # noqa: E402
    ControlPlaneMeter,
    pricing_tier_recommendation,
    resolve_usage_entitlement,
)


def _write_report(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"control_plane_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--usage-log", default="data/analytics/control_plane_usage.jsonl")
    parser.add_argument("--window-days", type=int, default=30)
    parser.add_argument("--tenant-plan", default="pro")
    parser.add_argument("--out-dir", default="data/reports")
    return parser


def main() -> int:
    args = build_parser().parse_args()

    meter = ControlPlaneMeter(log_path=str(args.usage_log))
    summary = meter.usage_summary(window_days=int(args.window_days))
    audit = meter.audit_usage_report(window_days=int(args.window_days))
    entitlement = resolve_usage_entitlement(args.tenant_plan)
    top = summary.get("tenants", [])
    top_row = top[0] if top else {"total_units": 0.0, "events": 0}
    recommendation = pricing_tier_recommendation(
        total_units=float(top_row.get("total_units", 0.0)),
        monthly_events=int(top_row.get("events", 0)),
    )

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "usage_log": str(args.usage_log),
        "summary": summary,
        "audit_report": audit,
        "entitlement_policy": {
            "plan": entitlement.plan,
            "max_events_per_day": entitlement.max_events_per_day,
            "max_units_per_day": entitlement.max_units_per_day,
            "allowed_event_types": entitlement.allowed_event_types,
        },
        "pricing_recommendation": recommendation,
    }
    report_path = _write_report(Path(args.out_dir), payload)
    payload["report_path"] = str(report_path)

    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
