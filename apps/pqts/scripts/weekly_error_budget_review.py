#!/usr/bin/env python3
"""Build a weekly error-budget review from recent SLO health reports."""

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

from analytics.slo_monitor import load_slo_reports, weekly_error_budget_review


def _write_report(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"error_budget_review_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports-dir", default="data/reports")
    parser.add_argument("--pattern", default="slo_health_*.json")
    parser.add_argument("--window-days", type=int, default=7)
    parser.add_argument("--out-dir", default="data/reports")
    return parser


def main() -> int:
    args = build_parser().parse_args()

    reports = load_slo_reports(
        report_dir=str(args.reports_dir),
        pattern=str(args.pattern),
        window_days=int(args.window_days),
    )
    review = weekly_error_budget_review(
        slo_reports=reports,
        window_days=int(args.window_days),
    )

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "reports_dir": str(args.reports_dir),
        "report_pattern": str(args.pattern),
        "reports_loaded": len(reports),
        "review": review,
    }
    report_path = _write_report(Path(args.out_dir), payload)
    payload["report_path"] = str(report_path)

    print(report_path)
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
