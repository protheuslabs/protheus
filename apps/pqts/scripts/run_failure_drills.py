#!/usr/bin/env python3
"""Run deterministic operator drills: shutdown/recovery/incident handling."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import yaml

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from analytics.incident_automation import IncidentAutomation
from analytics.ops_observability import OpsEventStore
from core.engine import MarketType, Order, OrderSide, OrderType, Position, TradingEngine


def _load_yaml(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def _write_yaml(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument("--out-dir", default="data/reports")
    return parser


def _drill_shutdown_and_recovery(config_path: Path, out_dir: Path) -> Dict[str, Any]:
    state_path = out_dir / "drill_state" / "engine_state.json"
    config = _load_yaml(str(config_path))
    runtime = config.setdefault("runtime", {})
    runtime["state_path"] = str(state_path)
    drill_config = out_dir / "drill_engine.yaml"
    _write_yaml(drill_config, config)

    engine = TradingEngine(str(drill_config))
    engine.orders["ord_pending"] = Order(
        id="ord_pending",
        symbol="BTCUSDT",
        side=OrderSide.BUY,
        order_type=OrderType.LIMIT,
        quantity=1.0,
        price=100.0,
        status="pending",
    )
    engine.positions["BTCUSDT"] = Position(
        symbol="BTCUSDT",
        quantity=1.5,
        avg_entry_price=100.0,
        market=MarketType.CRYPTO,
    )

    asyncio.run(engine.stop())
    restarted = TradingEngine(str(drill_config))

    closed_order = restarted.orders.get("ord_pending")
    recovered_positions = len(restarted.positions)
    return {
        "state_path": str(state_path),
        "state_exists": state_path.exists(),
        "pending_order_cancelled": bool(
            closed_order is not None and closed_order.status == "cancelled"
        ),
        "positions_flattened": recovered_positions == 0,
    }


def _drill_incident_flow(out_dir: Path) -> Dict[str, Any]:
    ops_path = out_dir / "drill_ops_events.jsonl"
    incident_path = out_dir / "drill_incidents.jsonl"
    store = OpsEventStore(path=str(ops_path))
    store.emit(
        category="execution",
        severity="critical",
        message="drill_kill_switch_trip",
        metrics={"reject_rate": 0.5, "slippage_mape_pct": 60.0},
    )
    automation = IncidentAutomation(incident_log_path=str(incident_path))
    payload = automation.run_from_store(store=store, since_minutes=120)
    return {
        "ops_events_path": str(ops_path),
        "incident_log_path": str(incident_path),
        "incidents_created": int(payload.get("incidents_created", 0)),
    }


def main() -> int:
    args = build_parser().parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    shutdown = _drill_shutdown_and_recovery(Path(args.config), out_dir)
    incidents = _drill_incident_flow(out_dir)
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "shutdown_recovery": shutdown,
        "incident_flow": incidents,
        "all_passed": bool(
            shutdown.get("state_exists")
            and shutdown.get("pending_order_cancelled")
            and shutdown.get("positions_flattened")
            and incidents.get("incidents_created", 0) > 0
        ),
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_path = out_dir / f"failure_drills_{stamp}.json"
    report_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    payload["report_path"] = str(report_path)
    print(json.dumps(payload, sort_keys=True))
    return 0 if payload["all_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
