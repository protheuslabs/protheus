"""Tests for control-plane usage metering and pricing recommendations."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.control_plane import (
    ControlPlaneMeter,
    pricing_tier_recommendation,
    resolve_usage_entitlement,
)


def test_control_plane_usage_summary_and_arr_estimate(tmp_path):
    meter = ControlPlaneMeter(log_path=str(tmp_path / "usage.jsonl"))
    now = datetime.now(timezone.utc).isoformat()

    meter.emit(
        tenant_id="tenant_a",
        event_type="backtest_run",
        units=1000.0,
        revenue_hint_usd=999.0,
        timestamp=now,
    )
    meter.emit(
        tenant_id="tenant_b",
        event_type="risk_report",
        units=100.0,
        revenue_hint_usd=599.0,
        timestamp=now,
    )

    summary = meter.usage_summary(window_days=30)

    assert summary["summary"]["tenant_count"] == 2
    assert summary["summary"]["events"] == 2
    assert summary["summary"]["mrr_estimate_usd"] == 1598.0
    assert summary["summary"]["arr_estimate_usd"] == 19176.0


def test_pricing_tier_recommendation_thresholds():
    assert pricing_tier_recommendation(total_units=1000.0, monthly_events=200)["tier"] == "starter"
    assert pricing_tier_recommendation(total_units=50000.0, monthly_events=1000)["tier"] == "pro"
    assert (
        pricing_tier_recommendation(total_units=200000.0, monthly_events=50000)["tier"]
        == "enterprise"
    )


def test_control_plane_entitlements_block_disallowed_event_type(tmp_path):
    meter = ControlPlaneMeter(log_path=str(tmp_path / "usage.jsonl"))
    entitlement = resolve_usage_entitlement("starter")
    now = datetime.now(timezone.utc).isoformat()

    with pytest.raises(RuntimeError):
        meter.emit(
            tenant_id="tenant_a",
            event_type="live_order",
            units=1.0,
            entitlement=entitlement,
            timestamp=now,
        )


def test_control_plane_billing_hook_populates_revenue_when_missing(tmp_path):
    meter = ControlPlaneMeter(log_path=str(tmp_path / "usage.jsonl"))
    now = datetime.now(timezone.utc).isoformat()

    event = meter.emit(
        tenant_id="tenant_x",
        event_type="backtest_run",
        units=20.0,
        revenue_hint_usd=0.0,
        timestamp=now,
        billing_hook=lambda row: 0.5 * float(row.units),
    )

    assert event.revenue_hint_usd == 10.0
    assert event.metadata["billed_amount_usd"] == 10.0


def test_control_plane_audit_usage_report_builds_hash_chain(tmp_path):
    meter = ControlPlaneMeter(log_path=str(tmp_path / "usage.jsonl"))
    now = datetime.now(timezone.utc).isoformat()
    meter.emit(tenant_id="tenant_a", event_type="backtest_run", units=10.0, timestamp=now)
    meter.emit(tenant_id="tenant_a", event_type="backtest_run", units=15.0, timestamp=now)
    meter.emit(tenant_id="tenant_b", event_type="risk_report", units=4.0, timestamp=now)

    report = meter.audit_usage_report(window_days=30)

    assert report["summary"]["events"] == 3
    assert report["summary"]["tenants"] == 2
    assert report["summary"]["chain_head"].startswith("sha256:")
    assert len(report["rows"]) >= 2
    assert report["rows"][0]["row_hash"].startswith("sha256:")
