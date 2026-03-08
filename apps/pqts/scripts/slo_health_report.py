#!/usr/bin/env python3
"""Evaluate SLO health from stream/reconciliation telemetry and route alerts."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.slo_monitor import (
    AlertRoutingConfig,
    SLOThresholds,
    evaluate_service_level_objectives,
    load_reconciliation_incidents,
    route_slo_alerts,
)


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object JSON at {path}")
    return payload


def _write_report(out_dir: Path, payload: Dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"slo_health_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stream-health", default="data/analytics/stream_health.json")
    parser.add_argument(
        "--reconciliation-incidents",
        default="data/analytics/reconciliation_incidents.jsonl",
    )
    parser.add_argument("--lookback-hours", type=float, default=24.0)
    parser.add_argument("--out-dir", default="data/reports")
    parser.add_argument("--alerts-path", default="data/alerts/slo_alerts.jsonl")
    parser.add_argument("--min-stream-uptime-ratio", type=float, default=0.995)
    parser.add_argument("--max-latency-p95-ms", type=float, default=250.0)
    parser.add_argument("--max-rejection-rate", type=float, default=0.01)
    parser.add_argument("--max-failure-rate", type=float, default=0.01)
    parser.add_argument("--max-reconciliation-incidents", type=int, default=0)
    return parser


def main() -> int:
    args = build_parser().parse_args()

    stream_health = _load_json(Path(args.stream_health))
    incidents = load_reconciliation_incidents(
        incidents_path=str(args.reconciliation_incidents),
        lookback_hours=float(args.lookback_hours),
    )

    slo_health = evaluate_service_level_objectives(
        stream_health=stream_health,
        reconciliation_incidents=incidents,
        thresholds=SLOThresholds(
            min_stream_uptime_ratio=float(args.min_stream_uptime_ratio),
            max_latency_p95_ms=float(args.max_latency_p95_ms),
            max_rejection_rate=float(args.max_rejection_rate),
            max_failure_rate=float(args.max_failure_rate),
            max_reconciliation_incidents=int(args.max_reconciliation_incidents),
        ),
    )
    routing = route_slo_alerts(
        slo_payload=slo_health,
        config=AlertRoutingConfig(alerts_path=str(args.alerts_path)),
    )

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stream_health_path": str(args.stream_health),
        "reconciliation_incidents_path": str(args.reconciliation_incidents),
        "incidents_considered": len(incidents),
        "slo_health": slo_health,
        "alert_routing": routing,
    }
    report_path = _write_report(Path(args.out_dir), payload)
    payload["report_path"] = str(report_path)

    print(report_path)
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
