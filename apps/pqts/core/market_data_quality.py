"""Market-data ingestion quality metrics and gating utilities."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional


@dataclass(frozen=True)
class DataQualityReport:
    expected_symbols: int
    observed_symbols: int
    completeness: float
    max_timestamp_drift_ms: float
    feature_parity: float
    passed: bool


class MarketDataQualityMonitor:
    """Compute deterministic quality metrics for ingest and feature parity."""

    def __init__(
        self,
        min_completeness: float = 0.995,
        max_drift_ms: float = 10.0,
        min_feature_parity: float = 0.99,
    ):
        self.min_completeness = float(min_completeness)
        self.max_drift_ms = float(max_drift_ms)
        self.min_feature_parity = float(min_feature_parity)

    @staticmethod
    def _drift_ms(ts: datetime, now: datetime) -> float:
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return abs((now - ts).total_seconds() * 1000.0)

    def assess(
        self,
        *,
        expected_symbols: int,
        observed_symbols: int,
        timestamps: Iterable[datetime],
        backtest_features: Optional[Dict[str, float]] = None,
        live_features: Optional[Dict[str, float]] = None,
        now: Optional[datetime] = None,
    ) -> DataQualityReport:
        now_dt = now or datetime.now(timezone.utc)
        expected = max(int(expected_symbols), 1)
        observed = max(int(observed_symbols), 0)
        completeness = float(observed / expected)

        drifts = [self._drift_ms(ts, now_dt) for ts in timestamps]
        max_drift = float(max(drifts)) if drifts else math.inf

        parity = self.feature_parity(backtest_features or {}, live_features or {})

        passed = (
            completeness >= self.min_completeness
            and max_drift <= self.max_drift_ms
            and parity >= self.min_feature_parity
        )
        return DataQualityReport(
            expected_symbols=expected,
            observed_symbols=observed,
            completeness=completeness,
            max_timestamp_drift_ms=max_drift,
            feature_parity=parity,
            passed=passed,
        )

    @staticmethod
    def feature_parity(
        backtest_features: Dict[str, float], live_features: Dict[str, float]
    ) -> float:
        if not backtest_features:
            return 1.0 if not live_features else 0.0
        keys = sorted(backtest_features.keys())
        matched = 0
        for key in keys:
            if key not in live_features:
                continue
            ref = float(backtest_features[key])
            cur = float(live_features[key])
            scale = max(abs(ref), 1.0)
            if abs(ref - cur) / scale <= 1e-6:
                matched += 1
        return float(matched / max(len(keys), 1))
