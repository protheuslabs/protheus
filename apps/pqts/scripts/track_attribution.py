#!/usr/bin/env python3
"""Record launch/conversion attribution events to local analytics logs."""

from __future__ import annotations

import argparse
import json

from analytics.attribution import log_event


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--metadata", default="{}", help="JSON object string")
    parser.add_argument("--log-path", default="data/analytics/attribution_events.jsonl")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    metadata = json.loads(args.metadata)
    if not isinstance(metadata, dict):
        raise ValueError("--metadata must decode to a JSON object")
    path = log_event(
        event=args.event,
        source=args.source,
        metadata=metadata,
        log_path=args.log_path,
    )
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
