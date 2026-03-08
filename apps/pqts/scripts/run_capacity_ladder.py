#!/usr/bin/env python3
"""Run notional-ladder capacity stress and emit throttle curve report."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from execution.capacity_curves import StrategyCapacityCurveModel


def _csv_float(value: str) -> List[float]:
    return [float(token.strip()) for token in str(value).split(",") if token.strip()]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strategy-id", default="capacity_probe")
    parser.add_argument("--venue", default="binance")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument(
        "--train-notionals",
        default="5000,10000,20000,40000,80000,120000,160000,200000",
    )
    parser.add_argument("--eval-notionals", default="5000,20000,50000,100000,200000,300000")
    parser.add_argument("--base-net-alpha-bps", type=float, default=12.0)
    parser.add_argument("--alpha-decay-per-10k-bps", type=float, default=0.7)
    parser.add_argument("--storage-path", default="data/analytics/capacity_curve_samples.jsonl")
    parser.add_argument("--out-dir", default="data/reports")
    return parser


def _alpha_for_notional(
    *,
    notional_usd: float,
    base_net_alpha_bps: float,
    decay_per_10k_bps: float,
) -> float:
    bucket = float(notional_usd) / 10000.0
    return float(base_net_alpha_bps) - (bucket * float(decay_per_10k_bps))


def main() -> int:
    args = build_parser().parse_args()
    train = _csv_float(args.train_notionals)
    evaluate = _csv_float(args.eval_notionals)
    model = StrategyCapacityCurveModel(enabled=True, storage_path=str(args.storage_path))

    for notional in train:
        model.record(
            strategy_id=str(args.strategy_id),
            venue=str(args.venue),
            symbol=str(args.symbol),
            notional_usd=float(notional),
            net_alpha_bps=_alpha_for_notional(
                notional_usd=float(notional),
                base_net_alpha_bps=float(args.base_net_alpha_bps),
                decay_per_10k_bps=float(args.alpha_decay_per_10k_bps),
            ),
        )

    ladder_rows: List[Dict[str, Any]] = []
    for notional in evaluate:
        decision = model.evaluate_order(
            strategy_id=str(args.strategy_id),
            venue=str(args.venue),
            symbol=str(args.symbol),
            candidate_notional_usd=float(notional),
            predicted_net_alpha_bps=_alpha_for_notional(
                notional_usd=float(notional),
                base_net_alpha_bps=float(args.base_net_alpha_bps),
                decay_per_10k_bps=float(args.alpha_decay_per_10k_bps),
            ),
        )
        ladder_rows.append(
            {
                "candidate_notional_usd": float(notional),
                "approved_notional_usd": float(decision.approved_notional_usd),
                "throttle_ratio": float(decision.throttle_ratio),
                "marginal_net_alpha_bps": float(decision.marginal_net_alpha_bps),
                "blocked": bool(decision.blocked),
                "reason": str(decision.reason),
                "points_used": int(decision.points_used),
            }
        )

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "strategy_id": str(args.strategy_id),
        "venue": str(args.venue),
        "symbol": str(args.symbol),
        "train_points": len(train),
        "evaluation_points": len(evaluate),
        "results": ladder_rows,
    }
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_path = out_dir / f"capacity_ladder_{stamp}.json"
    report_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    payload["report_path"] = str(report_path)
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
