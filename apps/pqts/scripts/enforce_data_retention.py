#!/usr/bin/env python3
"""Enforce deterministic data retention policy for local data stores."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.data_retention import DataRetentionPolicy, enforce_data_retention  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="data")
    parser.add_argument("--max-age-days", type=int, default=365)
    parser.add_argument("--max-total-files", type=int, default=10000)
    parser.add_argument("--suffixes", default=".csv,.parquet,.jsonl")
    return parser


def _csv(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in str(value).split(",") if item.strip())


def main() -> int:
    args = build_parser().parse_args()
    result = enforce_data_retention(
        root_path=str(args.root),
        policy=DataRetentionPolicy(
            max_age_days=int(args.max_age_days),
            max_total_files=int(args.max_total_files),
            include_suffixes=_csv(args.suffixes),
        ),
    )
    payload = result.to_dict()
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
