"""Capacity-curve tracking and marginal-alpha throttling for execution."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np


@dataclass(frozen=True)
class CapacitySample:
    timestamp: str
    strategy_id: str
    venue: str
    symbol: str
    notional_usd: float
    net_alpha_bps: float


@dataclass(frozen=True)
class CapacityDecision:
    approved_notional_usd: float
    throttle_ratio: float
    marginal_net_alpha_bps: float
    reason: str
    blocked: bool
    points_used: int


class StrategyCapacityCurveModel:
    """Deterministic capacity model keyed by strategy/venue/symbol."""

    def __init__(
        self,
        *,
        enabled: bool = False,
        storage_path: str = "data/analytics/capacity_curve_samples.jsonl",
        min_points: int = 8,
        max_points_per_key: int = 300,
        throttle_buffer: float = 0.95,
    ):
        self.enabled = bool(enabled)
        self.storage_path = Path(storage_path)
        self.min_points = max(int(min_points), 2)
        self.max_points_per_key = max(int(max_points_per_key), self.min_points)
        self.throttle_buffer = float(max(min(throttle_buffer, 1.0), 0.1))
        self._samples: Dict[Tuple[str, str, str], List[CapacitySample]] = {}
        self._load()

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _key(strategy_id: str, venue: str, symbol: str) -> Tuple[str, str, str]:
        return (
            str(strategy_id or "unknown").strip() or "unknown",
            str(venue or "unknown").strip() or "unknown",
            str(symbol or "unknown").strip() or "unknown",
        )

    def _load(self) -> None:
        if not self.storage_path.exists():
            return
        with self.storage_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                payload = line.strip()
                if not payload:
                    continue
                try:
                    row = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue
                sample = CapacitySample(
                    timestamp=str(row.get("timestamp", self._utc_now_iso())),
                    strategy_id=str(row.get("strategy_id", "unknown")),
                    venue=str(row.get("venue", "unknown")),
                    symbol=str(row.get("symbol", "unknown")),
                    notional_usd=float(row.get("notional_usd", 0.0)),
                    net_alpha_bps=float(row.get("net_alpha_bps", 0.0)),
                )
                key = self._key(sample.strategy_id, sample.venue, sample.symbol)
                self._samples.setdefault(key, []).append(sample)
        for key, rows in self._samples.items():
            self._samples[key] = rows[-self.max_points_per_key :]

    def _append(self, sample: CapacitySample) -> None:
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        with self.storage_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(sample), sort_keys=True) + "\n")

    def record(
        self,
        *,
        strategy_id: str,
        venue: str,
        symbol: str,
        notional_usd: float,
        net_alpha_bps: float,
        timestamp: Optional[datetime] = None,
    ) -> None:
        if not self.enabled:
            return
        sample = CapacitySample(
            timestamp=(timestamp or datetime.now(timezone.utc)).isoformat(),
            strategy_id=str(strategy_id or "unknown"),
            venue=str(venue or "unknown"),
            symbol=str(symbol or "unknown"),
            notional_usd=float(max(notional_usd, 0.0)),
            net_alpha_bps=float(net_alpha_bps),
        )
        key = self._key(sample.strategy_id, sample.venue, sample.symbol)
        rows = self._samples.setdefault(key, [])
        rows.append(sample)
        self._samples[key] = rows[-self.max_points_per_key :]
        self._append(sample)

    def sample_count(self, *, strategy_id: str, venue: str, symbol: str) -> int:
        key = self._key(strategy_id, venue, symbol)
        return len(self._samples.get(key, []))

    def _fit_curve(
        self,
        *,
        strategy_id: str,
        venue: str,
        symbol: str,
    ) -> Tuple[float, float, int]:
        key = self._key(strategy_id, venue, symbol)
        rows = self._samples.get(key, [])
        if not rows:
            return 0.0, 0.0, 0

        notionals = np.array([float(r.notional_usd) for r in rows], dtype=float)
        net_alpha = np.array([float(r.net_alpha_bps) for r in rows], dtype=float)
        points = int(len(rows))
        if points < 2 or float(np.std(notionals)) <= 1e-12:
            intercept = float(np.mean(net_alpha))
            return 0.0, intercept, points

        slope, intercept = np.polyfit(notionals, net_alpha, deg=1)
        return float(slope), float(intercept), points

    def evaluate_order(
        self,
        *,
        strategy_id: str,
        venue: str,
        symbol: str,
        candidate_notional_usd: float,
        predicted_net_alpha_bps: float,
    ) -> CapacityDecision:
        candidate = float(max(candidate_notional_usd, 0.0))
        if not self.enabled:
            return CapacityDecision(
                approved_notional_usd=candidate,
                throttle_ratio=1.0,
                marginal_net_alpha_bps=float(predicted_net_alpha_bps),
                reason="capacity_curves_disabled",
                blocked=False,
                points_used=0,
            )
        if candidate <= 0:
            return CapacityDecision(
                approved_notional_usd=0.0,
                throttle_ratio=0.0,
                marginal_net_alpha_bps=0.0,
                reason="invalid_notional",
                blocked=True,
                points_used=0,
            )

        slope, intercept, points = self._fit_curve(
            strategy_id=strategy_id,
            venue=venue,
            symbol=symbol,
        )

        if points < self.min_points:
            marginal = float(predicted_net_alpha_bps)
            if marginal <= 0:
                return CapacityDecision(
                    approved_notional_usd=0.0,
                    throttle_ratio=0.0,
                    marginal_net_alpha_bps=marginal,
                    reason="predicted_marginal_alpha_non_positive",
                    blocked=True,
                    points_used=points,
                )
            return CapacityDecision(
                approved_notional_usd=candidate,
                throttle_ratio=1.0,
                marginal_net_alpha_bps=marginal,
                reason="insufficient_curve_points",
                blocked=False,
                points_used=points,
            )

        marginal = float(intercept + slope * candidate)
        if slope < 0 and intercept > 0:
            zero_cross = float(intercept / abs(slope))
        else:
            zero_cross = float("inf")

        if marginal <= 0:
            if np.isfinite(zero_cross):
                approved = max(zero_cross * self.throttle_buffer, 0.0)
                if approved > 0:
                    return CapacityDecision(
                        approved_notional_usd=approved,
                        throttle_ratio=float(min(approved / candidate, 1.0)),
                        marginal_net_alpha_bps=marginal,
                        reason="negative_marginal_alpha_throttled_to_zero_cross",
                        blocked=False,
                        points_used=points,
                    )
            return CapacityDecision(
                approved_notional_usd=0.0,
                throttle_ratio=0.0,
                marginal_net_alpha_bps=marginal,
                reason="negative_marginal_alpha_blocked",
                blocked=True,
                points_used=points,
            )

        if np.isfinite(zero_cross):
            cap = float(zero_cross * self.throttle_buffer)
            if cap < candidate:
                return CapacityDecision(
                    approved_notional_usd=max(cap, 0.0),
                    throttle_ratio=float(max(cap, 0.0) / candidate),
                    marginal_net_alpha_bps=marginal,
                    reason="capacity_zero_cross_throttle",
                    blocked=False,
                    points_used=points,
                )

        return CapacityDecision(
            approved_notional_usd=candidate,
            throttle_ratio=1.0,
            marginal_net_alpha_bps=marginal,
            reason="capacity_ok",
            blocked=False,
            points_used=points,
        )
