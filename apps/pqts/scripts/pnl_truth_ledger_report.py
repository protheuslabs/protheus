#!/usr/bin/env python3
"""Generate PnL truth ledger report and strategy disable list from TCA."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.pnl_truth_ledger import (  # noqa: E402
    build_pnl_truth_ledger,
    detect_negative_net_alpha_scopes,
    detect_negative_net_alpha_strategies,
)
from execution.tca_feedback import TCADatabase  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tca-db", default="data/tca_records.csv")
    parser.add_argument("--lookback-days", type=int, default=30)
    parser.add_argument("--min-trades", type=int, default=50)
    parser.add_argument("--disable-threshold-net-alpha-usd", type=float, default=0.0)
    parser.add_argument("--disable-strategy-venues", action="store_true", default=True)
    parser.add_argument("--disable-strategy-symbols", action="store_true", default=True)
    parser.add_argument("--disable-strategy-venue-symbols", action="store_true", default=True)
    parser.add_argument(
        "--disable-list-path",
        default="data/analytics/strategy_disable_list.json",
    )
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--strict", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    tca_db = TCADatabase(str(args.tca_db))
    summary, rows = build_pnl_truth_ledger(
        tca_db,
        lookback_days=int(args.lookback_days),
    )
    disable_decisions = detect_negative_net_alpha_strategies(
        rows,
        min_trades=int(args.min_trades),
        max_net_alpha_usd=float(args.disable_threshold_net_alpha_usd),
    )
    scoped_decisions = detect_negative_net_alpha_scopes(
        rows,
        min_trades=int(args.min_trades),
        max_net_alpha_usd=float(args.disable_threshold_net_alpha_usd),
        include_strategy_venue=bool(args.disable_strategy_venues),
        include_strategy_symbol=bool(args.disable_strategy_symbols),
        include_strategy_venue_symbol=bool(args.disable_strategy_venue_symbols),
    )

    disable_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "lookback_days": int(args.lookback_days),
        "min_trades": int(args.min_trades),
        "threshold_net_alpha_usd": float(args.disable_threshold_net_alpha_usd),
        "disabled_strategies": [row.to_dict() for row in disable_decisions],
        "disabled_strategy_venues": [
            row.to_dict() for row in scoped_decisions.get("strategy_venues", [])
        ],
        "disabled_strategy_symbols": [
            row.to_dict() for row in scoped_decisions.get("strategy_symbols", [])
        ],
        "disabled_strategy_venue_symbols": [
            row.to_dict() for row in scoped_decisions.get("strategy_venue_symbols", [])
        ],
    }
    disable_path = Path(args.disable_list_path)
    disable_path.parent.mkdir(parents=True, exist_ok=True)
    disable_path.write_text(json.dumps(disable_payload, sort_keys=True, indent=2), encoding="utf-8")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_path = out_dir / f"pnl_truth_ledger_{stamp}.json"
    report_payload = {
        "summary": summary,
        "rows": rows,
        "disable_list_path": str(disable_path),
        "disabled_strategies_count": len(disable_decisions),
        "disabled_strategy_venues_count": len(scoped_decisions.get("strategy_venues", [])),
        "disabled_strategy_symbols_count": len(scoped_decisions.get("strategy_symbols", [])),
        "disabled_strategy_venue_symbols_count": len(
            scoped_decisions.get("strategy_venue_symbols", [])
        ),
    }
    report_path.write_text(json.dumps(report_payload, sort_keys=True, indent=2), encoding="utf-8")
    report_payload["report_path"] = str(report_path)
    print(json.dumps(report_payload, sort_keys=True))

    if args.strict and (
        disable_decisions
        or scoped_decisions.get("strategy_venues")
        or scoped_decisions.get("strategy_symbols")
        or scoped_decisions.get("strategy_venue_symbols")
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
