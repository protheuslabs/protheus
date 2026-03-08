#!/usr/bin/env python3
"""Render monthly stage-metric attribution from research DB."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.monthly_attribution import summarize_monthly_attribution  # noqa: E402
from research.database import ResearchDatabase  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-path", default="data/research.db")
    parser.add_argument("--stage", default="paper")
    parser.add_argument("--lookback-days", type=int, default=90)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    db = ResearchDatabase(str(args.db_path))
    frame = db.list_stage_metrics(stage=str(args.stage), lookback_days=int(args.lookback_days))
    rows = summarize_monthly_attribution(frame.to_dict(orient="records"))
    payload = {
        "db_path": str(args.db_path),
        "stage": str(args.stage),
        "lookback_days": int(args.lookback_days),
        "rows": rows,
    }
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
