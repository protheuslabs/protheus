#!/usr/bin/env python3
"""Export a Protheus handoff blob from a campaign result JSON payload."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from research.handoff_blob import build_handoff_blob


def _load_payload(path: str) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Campaign result must be a JSON object")
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign-result", required=True, help="Path to campaign result JSON")
    parser.add_argument("--market", required=True, help="Market label for handoff")
    parser.add_argument("--strategy", required=True, help="Strategy channel for handoff")
    parser.add_argument("--source", default="manual_export")
    parser.add_argument("--out", default="")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    campaign_result = _load_payload(args.campaign_result)
    blob = build_handoff_blob(
        market=args.market,
        strategy_channel=args.strategy,
        campaign_result=campaign_result,
        source=args.source,
    )
    if args.out:
        out_path = Path(args.out)
    else:
        out_path = Path("data/reports") / "handoff_blob.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(blob, indent=2, sort_keys=True), encoding="utf-8")
    print(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
