"""Optional OpenTelemetry/Prometheus backbone with safe no-op fallback."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class TelemetryBackbone:
    service_name: str = "pqts"
    enabled: bool = False

    def __post_init__(self) -> None:
        self._counter = None
        self._histogram = None
        self._otel = None
        self._prom_registry = None
        if not self.enabled:
            return
        try:
            from prometheus_client import CollectorRegistry, Counter, Histogram  # type: ignore

            self._prom_registry = CollectorRegistry()
            self._counter = Counter(
                "pqts_events_total",
                "Total events emitted by category",
                ["category"],
                registry=self._prom_registry,
            )
            self._histogram = Histogram(
                "pqts_latency_ms",
                "Latency in milliseconds by category",
                ["category"],
                registry=self._prom_registry,
            )
        except Exception:
            self.enabled = False

    def record_event(self, *, category: str, metrics: Dict[str, Any] | None = None) -> None:
        if not self.enabled:
            return
        if self._counter is not None:
            self._counter.labels(str(category)).inc()
        latency_ms = (metrics or {}).get("latency_ms")
        if latency_ms is not None and self._histogram is not None:
            self._histogram.labels(str(category)).observe(float(latency_ms))
