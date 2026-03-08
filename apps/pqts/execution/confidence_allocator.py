"""Confidence-weighted capital allocation from realized TCA outcomes."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import numpy as np
import pandas as pd

from execution.tca_feedback import TCADatabase


@dataclass(frozen=True)
class ConfidenceAllocatorDecision:
    multiplier: float
    mean_net_alpha_bps: float
    std_net_alpha_bps: float
    stderr_net_alpha_bps: float
    ci_lower_bps: float
    samples: int
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ConfidenceWeightedAllocator:
    """Scale order notional by lower-confidence bound of realized net alpha."""

    def __init__(
        self,
        *,
        enabled: bool = False,
        lookback_days: int = 30,
        min_samples: int = 40,
        min_multiplier: float = 0.25,
        max_multiplier: float = 1.50,
        neutral_multiplier: float = 1.0,
        z_score: float = 1.96,
        target_lower_bps: float = 2.0,
        response_slope: float = 0.5,
        hard_floor_on_negative_lower: bool = True,
    ):
        self.enabled = bool(enabled)
        self.lookback_days = max(int(lookback_days), 1)
        self.min_samples = max(int(min_samples), 1)
        self.min_multiplier = float(max(min_multiplier, 0.0))
        self.max_multiplier = float(max(max_multiplier, self.min_multiplier))
        self.neutral_multiplier = float(
            np.clip(float(neutral_multiplier), self.min_multiplier, self.max_multiplier)
        )
        self.z_score = float(max(z_score, 0.0))
        self.target_lower_bps = float(max(target_lower_bps, 1e-6))
        self.response_slope = float(max(response_slope, 0.0))
        self.hard_floor_on_negative_lower = bool(hard_floor_on_negative_lower)

    @staticmethod
    def _profile_filter(frame: pd.DataFrame, prediction_profile: str) -> pd.DataFrame:
        token = str(prediction_profile or "").strip()
        if frame.empty or not token:
            return frame
        if "prediction_profile" not in frame.columns:
            return frame.iloc[0:0].copy()
        return frame[frame["prediction_profile"].astype(str) == token].copy()

    def _strategy_frame(
        self,
        *,
        strategy_id: str,
        tca_db: TCADatabase,
        prediction_profile: str = "",
    ) -> pd.DataFrame:
        frame = tca_db.as_dataframe()
        if frame.empty:
            return frame
        frame = self._profile_filter(frame, prediction_profile)
        if frame.empty:
            return frame
        frame = frame.copy()
        if "strategy_id" not in frame.columns:
            frame["strategy_id"] = "unknown"
        frame["strategy_id"] = frame["strategy_id"].fillna("unknown").astype(str)
        frame = frame[frame["strategy_id"] == str(strategy_id or "unknown")]
        if frame.empty:
            return frame

        cutoff = datetime.now(timezone.utc) - timedelta(days=self.lookback_days)
        timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame = frame[timestamps >= cutoff].copy()
        if frame.empty:
            return frame

        if "realized_total_bps" not in frame.columns:
            frame["realized_total_bps"] = 0.0
        if "expected_alpha_bps" not in frame.columns:
            frame["expected_alpha_bps"] = 0.0
        frame["realized_total_bps"] = pd.to_numeric(
            frame["realized_total_bps"], errors="coerce"
        ).fillna(0.0)
        frame["expected_alpha_bps"] = pd.to_numeric(
            frame["expected_alpha_bps"], errors="coerce"
        ).fillna(0.0)
        frame["realized_net_alpha_bps"] = frame["expected_alpha_bps"] - frame["realized_total_bps"]
        return frame

    def evaluate(
        self,
        *,
        strategy_id: str,
        tca_db: TCADatabase,
        prediction_profile: str = "",
    ) -> ConfidenceAllocatorDecision:
        if not self.enabled:
            return ConfidenceAllocatorDecision(
                multiplier=float(self.neutral_multiplier),
                mean_net_alpha_bps=0.0,
                std_net_alpha_bps=0.0,
                stderr_net_alpha_bps=0.0,
                ci_lower_bps=0.0,
                samples=0,
                reason="confidence_allocator_disabled",
            )

        frame = self._strategy_frame(
            strategy_id=strategy_id,
            tca_db=tca_db,
            prediction_profile=prediction_profile,
        )
        if frame.empty:
            return ConfidenceAllocatorDecision(
                multiplier=float(self.neutral_multiplier),
                mean_net_alpha_bps=0.0,
                std_net_alpha_bps=0.0,
                stderr_net_alpha_bps=0.0,
                ci_lower_bps=0.0,
                samples=0,
                reason="no_strategy_tca_samples",
            )

        net_alpha = pd.to_numeric(frame["realized_net_alpha_bps"], errors="coerce").fillna(0.0)
        samples = int(len(net_alpha))
        if samples < self.min_samples:
            return ConfidenceAllocatorDecision(
                multiplier=float(self.neutral_multiplier),
                mean_net_alpha_bps=float(net_alpha.mean()),
                std_net_alpha_bps=float(net_alpha.std(ddof=1)) if samples > 1 else 0.0,
                stderr_net_alpha_bps=0.0,
                ci_lower_bps=0.0,
                samples=samples,
                reason="insufficient_samples",
            )

        mean = float(net_alpha.mean())
        std = float(net_alpha.std(ddof=1)) if samples > 1 else 0.0
        stderr = float(std / np.sqrt(samples)) if samples > 1 else 0.0
        ci_lower = float(mean - (self.z_score * stderr))

        if self.hard_floor_on_negative_lower and ci_lower <= 0.0:
            multiplier = float(self.min_multiplier)
            reason = "negative_lower_bound_floor"
        else:
            score = ci_lower / self.target_lower_bps
            raw = 1.0 + (self.response_slope * score)
            multiplier = float(np.clip(raw, self.min_multiplier, self.max_multiplier))
            reason = "confidence_scaled"

        return ConfidenceAllocatorDecision(
            multiplier=multiplier,
            mean_net_alpha_bps=mean,
            std_net_alpha_bps=std,
            stderr_net_alpha_bps=stderr,
            ci_lower_bps=ci_lower,
            samples=samples,
            reason=reason,
        )
