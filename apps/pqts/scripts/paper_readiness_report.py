#!/usr/bin/env python3
"""Generate paper-trading readiness report from realized TCA fills."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.paper_readiness import PaperTrackRecordEvaluator
from execution.tca_feedback import TCADatabase


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tca-db", default="data/tca_records.csv")
    parser.add_argument("--lookback-days", type=int, default=60)
    parser.add_argument("--min-days", type=int, default=30)
    parser.add_argument("--min-fills", type=int, default=200)
    parser.add_argument("--max-p95-slippage-bps", type=float, default=20.0)
    parser.add_argument("--max-mape-pct", type=float, default=35.0)
    parser.add_argument("--out-dir", default="data/reports")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db = TCADatabase(args.tca_db)
    evaluator = PaperTrackRecordEvaluator(db)
    result = evaluator.evaluate(
        lookback_days=args.lookback_days,
        min_days_required=args.min_days,
        min_fills_required=args.min_fills,
        max_p95_slippage_bps=args.max_p95_slippage_bps,
        max_mape_pct=args.max_mape_pct,
    ).to_dict()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = out_dir / f"paper_readiness_{stamp}.json"
    md_path = out_dir / f"paper_readiness_{stamp}.md"

    json_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")

    lines = [
        "# Paper Readiness Report",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        "",
        f"- Ready for canary: **{result['ready_for_canary']}**",
        f"- Trading days: {result['trading_days']} (required {result['min_days_required']})",
        f"- Fills: {result['fills']} (required {result['min_fills_required']})",
        f"- p95 realized slippage (bps): {result['p95_realized_slippage_bps']:.3f} (max {result['max_p95_slippage_bps']:.3f})",
        f"- Slippage MAPE (%): {result['slippage_mape_pct']:.3f} (max {result['max_mape_pct']:.3f})",
        "",
        "## Raw JSON",
        "",
        "```json",
        json.dumps(result, indent=2, sort_keys=True),
        "```",
    ]
    md_path.write_text("\n".join(lines), encoding="utf-8")

    print(json_path)
    print(md_path)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
