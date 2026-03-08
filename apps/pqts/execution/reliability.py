"""Execution reliability monitoring: latency/rejection SLOs and failover hints."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict, Iterable, Optional

import numpy as np


@dataclass
class VenueReliabilityState:
    """Rolling reliability metrics for one venue."""

    latencies_ms: Deque[float] = field(default_factory=lambda: deque(maxlen=500))
    rejected_flags: Deque[int] = field(default_factory=lambda: deque(maxlen=500))
    failure_flags: Deque[int] = field(default_factory=lambda: deque(maxlen=500))
    last_failover_at: Optional[datetime] = None

    def record(self, *, latency_ms: float, rejected: bool, failed: bool) -> None:
        self.latencies_ms.append(float(max(latency_ms, 0.0)))
        self.rejected_flags.append(1 if rejected else 0)
        self.failure_flags.append(1 if failed else 0)

    def metrics(self) -> Dict[str, float]:
        if not self.latencies_ms:
            return {
                "samples": 0.0,
                "latency_p95_ms": 0.0,
                "rejection_rate": 0.0,
                "failure_rate": 0.0,
            }
        lat = np.array(self.latencies_ms, dtype=float)
        rej = np.array(self.rejected_flags, dtype=float)
        fail = np.array(self.failure_flags, dtype=float)
        return {
            "samples": float(len(lat)),
            "latency_p95_ms": float(np.percentile(lat, 95)),
            "rejection_rate": float(rej.mean()),
            "failure_rate": float(fail.mean()),
        }


class ExecutionReliabilityMonitor:
    """SLO monitor with deterministic failover recommendations."""

    def __init__(
        self,
        latency_slo_ms: float = 250.0,
        rejection_slo: float = 0.001,
        failure_slo: float = 0.01,
        cooldown_seconds: int = 300,
    ):
        self.latency_slo_ms = float(latency_slo_ms)
        self.rejection_slo = float(rejection_slo)
        self.failure_slo = float(failure_slo)
        self.cooldown_seconds = int(cooldown_seconds)
        self._state: Dict[str, VenueReliabilityState] = {}

    def _get(self, venue: str) -> VenueReliabilityState:
        key = str(venue).lower()
        if key not in self._state:
            self._state[key] = VenueReliabilityState()
        return self._state[key]

    def record(self, *, venue: str, latency_ms: float, rejected: bool, failed: bool) -> None:
        self._get(venue).record(latency_ms=latency_ms, rejected=rejected, failed=failed)

    def is_degraded(self, venue: str) -> bool:
        state = self._get(venue)
        metrics = state.metrics()
        if metrics["samples"] < 20:
            return False
        return (
            metrics["latency_p95_ms"] > self.latency_slo_ms
            or metrics["rejection_rate"] > self.rejection_slo
            or metrics["failure_rate"] > self.failure_slo
        )

    def should_failover(self, venue: str) -> bool:
        state = self._get(venue)
        if not self.is_degraded(venue):
            return False
        if state.last_failover_at is None:
            return True
        return datetime.now(timezone.utc) - state.last_failover_at >= timedelta(
            seconds=self.cooldown_seconds
        )

    def choose_failover(self, primary_venue: str, candidates: Iterable[str]) -> Optional[str]:
        if not self.should_failover(primary_venue):
            return None

        best = None
        best_score = float("inf")
        for venue in candidates:
            if str(venue).lower() == str(primary_venue).lower():
                continue
            state = self._get(venue)
            metrics = state.metrics()
            # Lower is better: weighted rejection/failure/latency.
            score = (
                metrics["rejection_rate"] * 10000.0
                + metrics["failure_rate"] * 10000.0
                + metrics["latency_p95_ms"] * 0.01
            )
            if best is None or score < best_score:
                best = venue
                best_score = score

        if best is not None:
            self._get(primary_venue).last_failover_at = datetime.now(timezone.utc)
        return best

    def summary(self) -> Dict[str, Dict[str, float]]:
        payload: Dict[str, Dict[str, float]] = {}
        for venue, state in self._state.items():
            metrics = state.metrics()
            metrics["degraded"] = 1.0 if self.is_degraded(venue) else 0.0
            payload[venue] = metrics
        return payload
