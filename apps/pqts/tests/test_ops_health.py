"""Deterministic tests for operations health alerts."""

from __future__ import annotations

from analytics.ops_health import OpsThresholds, evaluate_operational_health


def test_ops_health_emits_critical_alerts_for_drift_and_rejects():
    payload = evaluate_operational_health(
        campaign_stats={"submitted": 100, "filled": 40, "rejected": 60, "reject_rate": 0.60},
        readiness={
            "ready_for_canary": False,
            "p95_realized_slippage_bps": 35.0,
            "slippage_mape_pct": 55.0,
        },
        reliability={
            "binance": {"degraded": 1.0},
            "coinbase": {"degraded": 0.0},
        },
        calibration=[{"status": "alert"}, {"status": "ok"}],
        thresholds=OpsThresholds(
            max_reject_rate=0.40,
            max_p95_slippage_bps=20.0,
            max_mape_pct=35.0,
            max_degraded_venues=0,
            max_calibration_alerts=0,
        ),
    )

    assert payload["summary"]["critical"] >= 3
    keys = {row["key"] for row in payload["alerts"]}
    assert "reject_rate" in keys
    assert "p95_slippage_bps" in keys
    assert "slippage_mape_pct" in keys
    assert "degraded_venues" in keys


def test_ops_health_reports_healthy_when_within_thresholds():
    payload = evaluate_operational_health(
        campaign_stats={"submitted": 100, "filled": 99, "rejected": 1, "reject_rate": 0.01},
        readiness={
            "ready_for_canary": True,
            "p95_realized_slippage_bps": 10.0,
            "slippage_mape_pct": 10.0,
        },
        reliability={
            "binance": {"degraded": 0.0},
            "coinbase": {"degraded": 0.0},
        },
        calibration=[{"status": "ok"}],
        thresholds=OpsThresholds(),
    )

    assert payload["summary"]["critical"] == 0
    assert payload["summary"]["healthy"] is True
