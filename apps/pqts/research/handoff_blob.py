"""Strategy handoff blob generation for Protheus agent pilots."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def select_governed_lane(
    *,
    readiness: Dict[str, Any],
    promotion_gate: Dict[str, Any],
    ops_health: Dict[str, Any],
) -> str:
    decision = str(promotion_gate.get("decision", "")).lower()
    ready = bool(readiness.get("ready_for_canary", False))
    critical_alerts = int((ops_health.get("summary", {}) or {}).get("critical", 0))

    if critical_alerts > 0:
        return "research"
    if decision == "promote_to_live_canary" and ready:
        return "live_canary"
    if ready:
        return "paper"
    return "research"


def build_handoff_blob(
    *,
    market: str,
    strategy_channel: str,
    campaign_result: Dict[str, Any],
    source: str = "pqts_demo",
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    readiness = dict(campaign_result.get("readiness", {}) or {})
    promotion_gate = dict(campaign_result.get("promotion_gate", {}) or {})
    ops_health = dict(campaign_result.get("ops_health", {}) or {})
    lane = select_governed_lane(
        readiness=readiness,
        promotion_gate=promotion_gate,
        ops_health=ops_health,
    )

    return {
        "schema_version": "1.0",
        "created_at": str(created_at) if created_at else _utc_now_iso(),
        "source": str(source),
        "market": str(market),
        "strategy_channel": str(strategy_channel),
        "governed_lane": lane,
        "pilot_context": {
            "mode": "agent_pilot",
            "objective": "promote only strategies that pass risk and readiness gates",
            "constraints": {
                "only_router_submit_order": True,
                "kill_switch_hard_gates": True,
                "paper_before_live": True,
            },
        },
        "evidence": {
            "submitted": int(campaign_result.get("submitted", 0)),
            "filled": int(campaign_result.get("filled", 0)),
            "rejected": int(campaign_result.get("rejected", 0)),
            "reject_rate": float(campaign_result.get("reject_rate", 0.0)),
            "readiness": readiness,
            "promotion_gate": promotion_gate,
            "ops_health": ops_health,
            "reliability": dict(campaign_result.get("reliability", {}) or {}),
        },
    }
