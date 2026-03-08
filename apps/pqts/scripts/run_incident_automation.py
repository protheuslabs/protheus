#!/usr/bin/env python3
"""Generate incidents from recent ops events using deterministic thresholds."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.incident_automation import IncidentAutomation, IncidentThresholds  # noqa: E402
from analytics.ops_observability import OpsEventStore  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ops-events", default="data/analytics/ops_events.jsonl")
    parser.add_argument("--incident-log", default="data/analytics/incidents.jsonl")
    parser.add_argument("--since-minutes", type=int, default=60)
    parser.add_argument("--max-reject-rate", type=float, default=0.25)
    parser.add_argument("--max-slippage-mape-pct", type=float, default=35.0)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    store = OpsEventStore(path=str(args.ops_events))
    automation = IncidentAutomation(incident_log_path=str(args.incident_log))
    payload = automation.run_from_store(
        store=store,
        since_minutes=int(args.since_minutes),
        thresholds=IncidentThresholds(
            max_reject_rate=float(args.max_reject_rate),
            max_slippage_mape_pct=float(args.max_slippage_mape_pct),
        ),
    )
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
