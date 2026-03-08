#!/usr/bin/env python3
"""Replay execution events from JSON and emit queue-aware fill diagnostics."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from execution.event_replay import ReplayEvent, replay_sync  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-json", required=True, help="Path to replay events JSON file.")
    return parser


def _load_events(path: str) -> List[ReplayEvent]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = payload if isinstance(payload, list) else payload.get("events", [])
    out: List[ReplayEvent] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out.append(
            ReplayEvent(
                order_id=str(row["order_id"]),
                symbol=str(row["symbol"]),
                venue=str(row["venue"]),
                side=str(row["side"]),
                requested_qty=float(row["requested_qty"]),
                reference_price=float(row["reference_price"]),
                order_book=dict(row.get("order_book", {})),
                queue_ahead_qty=float(row.get("queue_ahead_qty", 0.0)),
                timestamp=str(row.get("timestamp", "")) or None,
            )
        )
    return out


def main() -> int:
    args = build_parser().parse_args()
    events = _load_events(args.events_json)
    result = replay_sync(events)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
