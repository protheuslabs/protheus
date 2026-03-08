"""Deterministic tests for Protheus handoff blob generation."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from research.handoff_blob import build_handoff_blob, select_governed_lane


def test_select_governed_lane_blocks_on_critical_alerts():
    lane = select_governed_lane(
        readiness={"ready_for_canary": True},
        promotion_gate={"decision": "promote_to_live_canary"},
        ops_health={"summary": {"critical": 1}},
    )
    assert lane == "research"


def test_select_governed_lane_promotes_canary_when_ready():
    lane = select_governed_lane(
        readiness={"ready_for_canary": True},
        promotion_gate={"decision": "promote_to_live_canary"},
        ops_health={"summary": {"critical": 0}},
    )
    assert lane == "live_canary"


def test_build_handoff_blob_contains_expected_keys():
    blob = build_handoff_blob(
        market="crypto",
        strategy_channel="ml-ensemble",
        source="unit_test",
        campaign_result={
            "submitted": 120,
            "filled": 110,
            "rejected": 10,
            "reject_rate": 0.0833,
            "readiness": {"ready_for_canary": True},
            "promotion_gate": {"decision": "promote_to_live_canary"},
            "ops_health": {"summary": {"critical": 0}},
            "reliability": {"degraded_venues": []},
        },
        created_at="2026-03-04T00:00:00+00:00",
    )

    assert blob["schema_version"] == "1.0"
    assert blob["market"] == "crypto"
    assert blob["strategy_channel"] == "ml-ensemble"
    assert blob["governed_lane"] == "live_canary"
    assert blob["evidence"]["submitted"] == 120
