#!/usr/bin/env python3
"""Run automated strategy tournament + promotion evaluation from data lake partitions."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List

import yaml

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from research.data_lake import DataLakeQualityGate  # noqa: E402
from research.tournament import (  # noqa: E402
    LakeSymbolSource,
    StrategyTournamentRunner,
    TournamentConfig,
)


def _parse_datetime(value: str) -> datetime:
    token = str(value).strip()
    if token.endswith("Z"):
        token = token[:-1] + "+00:00"
    dt = datetime.fromisoformat(token)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_sources(value: str) -> List[LakeSymbolSource]:
    out: List[LakeSymbolSource] = []
    for token in value.split(","):
        row = token.strip()
        if not row or ":" not in row:
            continue
        venue, symbol = row.split(":", 1)
        venue = venue.strip()
        symbol = symbol.strip()
        if venue and symbol:
            out.append(LakeSymbolSource(venue=venue, symbol=symbol))
    return out


def _parse_csv(value: str) -> List[str]:
    return [token.strip() for token in value.split(",") if token.strip()]


def _load_agent_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-config", default="research/agent_config.yaml")
    parser.add_argument("--lake-root", default="data/lake")
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument(
        "--sources",
        default="binance:BTCUSDT,binance:ETHUSDT",
        help="Comma-separated venue:symbol list",
    )
    parser.add_argument("--strategy-types", default="market_making,funding_arbitrage")
    parser.add_argument("--start", required=True, help="ISO-8601 start timestamp")
    parser.add_argument("--end", required=True, help="ISO-8601 end timestamp")
    parser.add_argument("--interval-seconds", type=int, default=3600)
    parser.add_argument("--min-completeness", type=float, default=0.995)
    parser.add_argument("--max-missing-intervals", type=int, default=0)
    parser.add_argument("--require-monotonic", action="store_true")
    parser.add_argument("--no-auto-promote-canary", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    sources = _parse_sources(args.sources)
    if not sources:
        raise ValueError("At least one valid --sources entry is required (venue:symbol).")

    runner = StrategyTournamentRunner(
        agent_config=_load_agent_config(args.agent_config),
        lake_root=args.lake_root,
        out_dir=args.out_dir,
        config=TournamentConfig(
            interval_seconds=int(args.interval_seconds),
            quality_gate=DataLakeQualityGate(
                min_completeness=float(args.min_completeness),
                max_missing_intervals=int(args.max_missing_intervals),
                require_monotonic=bool(args.require_monotonic),
            ),
            auto_promote_canary=not bool(args.no_auto_promote_canary),
        ),
    )

    payload = runner.run_once(
        strategy_types=_parse_csv(args.strategy_types),
        sources=sources,
        start=_parse_datetime(args.start),
        end=_parse_datetime(args.end),
    )
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
