#!/usr/bin/env python3
"""Generate execution drift report from TCA predicted vs realized slippage."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.execution_drift import DriftThresholds, write_execution_drift_report  # noqa: E402


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tca-db", default="data/tca_records.csv")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--lookback-days", type=int, default=30)
    parser.add_argument("--min-samples", type=int, default=30)
    parser.add_argument("--max-mape-pct", type=float, default=35.0)
    parser.add_argument("--min-ratio", type=float, default=0.5)
    parser.add_argument("--max-ratio", type=float, default=1.5)
    parser.add_argument(
        "--emit-warmup-alerts",
        action="store_true",
        help="Treat insufficient-sample warmup windows as hard alerts.",
    )
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    thresholds = DriftThresholds(
        min_samples=int(args.min_samples),
        max_mape_pct=float(args.max_mape_pct),
        min_realized_to_predicted_ratio=float(args.min_ratio),
        max_realized_to_predicted_ratio=float(args.max_ratio),
        suppress_warmup_alerts=not bool(args.emit_warmup_alerts),
    )
    report_path = write_execution_drift_report(
        tca_db_path=args.tca_db,
        out_dir=args.out_dir,
        lookback_days=int(args.lookback_days),
        thresholds=thresholds,
    )
    print(json.dumps({"report_path": str(report_path)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
