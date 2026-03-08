"""Tests for telemetry backbone safe behavior."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.telemetry_backbone import TelemetryBackbone


def test_telemetry_backbone_noop_when_disabled():
    backbone = TelemetryBackbone(service_name="pqts-test", enabled=False)
    backbone.record_event(category="execution", metrics={"latency_ms": 12.0})
    assert backbone.enabled is False


def test_telemetry_backbone_record_event_is_safe_when_enabled():
    backbone = TelemetryBackbone(service_name="pqts-test", enabled=True)
    backbone.record_event(category="autopilot", metrics={"latency_ms": 5.5})
    # Environments without prometheus-client may auto-disable.
    assert isinstance(backbone.enabled, bool)
