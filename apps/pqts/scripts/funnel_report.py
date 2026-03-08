#!/usr/bin/env python3
"""Summarize demo funnel metrics from attribution events."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.funnel import load_attribution_events, summarize_funnel  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-log", default="data/analytics/attribution_events.jsonl")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    events = load_attribution_events(str(args.events_log))
    summary = summarize_funnel(events)
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
