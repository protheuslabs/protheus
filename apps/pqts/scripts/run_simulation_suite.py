#!/usr/bin/env python3
"""Run deterministic simulation suites and emit telemetry/leaderboard artifacts."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import List

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.mechanism_switches import parse_switch_overrides  # noqa: E402
from execution.simulation_suite import SimulationSuiteRunner  # noqa: E402


def _parse_csv(value: str) -> List[str]:
    return [token.strip() for token in str(value).split(",") if token.strip()]


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument(
        "--risk-profile",
        default="",
        help=(
            "Risk tolerance profile override "
            "(conservative, balanced, aggressive, professional, or custom key)."
        ),
    )
    parser.add_argument("--markets", default="crypto,equities,forex")
    parser.add_argument("--strategies", default="market_making,funding_arbitrage,cross_exchange")
    parser.add_argument("--cycles-per-scenario", type=int, default=120)
    parser.add_argument("--notional-usd", type=float, default=150.0)
    parser.add_argument("--symbols-per-market", type=int, default=2)
    parser.add_argument("--readiness-every", type=int, default=30)
    parser.add_argument("--sleep-seconds", type=float, default=0.0)
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--telemetry-log", default="data/analytics/simulation_events.jsonl")
    parser.add_argument("--tca-dir", default="data/tca/simulation")

    parser.add_argument("--lookback-days", type=int, default=60)
    parser.add_argument("--min-days", type=int, default=30)
    parser.add_argument("--min-fills", type=int, default=200)
    parser.add_argument("--max-p95-slippage-bps", type=float, default=20.0)
    parser.add_argument("--max-mape-pct", type=float, default=35.0)
    parser.add_argument("--max-reject-rate", type=float, default=0.40)
    parser.add_argument("--max-degraded-venues", type=int, default=0)
    parser.add_argument("--max-calibration-alerts", type=int, default=0)
    parser.add_argument("--promotion-min-days", type=int, default=30)
    parser.add_argument("--promotion-max-days", type=int, default=90)

    parser.add_argument("--paper-base-slippage-bps", type=float, default=3.0)
    parser.add_argument("--paper-min-slippage-bps", type=float, default=0.5)
    parser.add_argument("--paper-stress-multiplier", type=float, default=1.25)
    parser.add_argument("--paper-stress-fill-ratio-multiplier", type=float, default=0.90)
    parser.add_argument(
        "--switch",
        dest="switches",
        action="append",
        default=[],
        help="Mechanism switch override, e.g. --switch market_data_resilience=off",
    )
    return parser


async def _run(args: argparse.Namespace) -> dict:
    switch_overrides = parse_switch_overrides(args.switches)
    runner = SimulationSuiteRunner(
        config_path=args.config,
        out_dir=args.out_dir,
        telemetry_log_path=args.telemetry_log,
        tca_dir=args.tca_dir,
        lookback_days=args.lookback_days,
        min_days=args.min_days,
        min_fills=args.min_fills,
        max_p95_slippage_bps=args.max_p95_slippage_bps,
        max_mape_pct=args.max_mape_pct,
        max_reject_rate=args.max_reject_rate,
        max_degraded_venues=args.max_degraded_venues,
        max_calibration_alerts=args.max_calibration_alerts,
        promotion_min_days=args.promotion_min_days,
        promotion_max_days=args.promotion_max_days,
        paper_base_slippage_bps=args.paper_base_slippage_bps,
        paper_min_slippage_bps=args.paper_min_slippage_bps,
        paper_stress_multiplier=args.paper_stress_multiplier,
        paper_stress_fill_ratio_multiplier=args.paper_stress_fill_ratio_multiplier,
        risk_profile=(args.risk_profile or None),
        switch_overrides=switch_overrides,
    )
    payload = await runner.run_suite(
        markets=_parse_csv(args.markets),
        strategies=_parse_csv(args.strategies),
        cycles_per_scenario=args.cycles_per_scenario,
        notional_usd=args.notional_usd,
        symbols_per_market=args.symbols_per_market,
        readiness_every=args.readiness_every,
        sleep_seconds=args.sleep_seconds,
    )
    return payload


def main() -> int:
    args = build_arg_parser().parse_args()
    payload = asyncio.run(_run(args))
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
