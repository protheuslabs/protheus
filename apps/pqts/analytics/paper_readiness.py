"""Paper-trading readiness checks based on realized fill quality and track record."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import numpy as np
import pandas as pd

from execution.tca_feedback import TCADatabase, slippage_mape_pct


@dataclass(frozen=True)
class PaperReadinessResult:
    lookback_days: int
    trading_days: int
    min_days_required: int
    fills: int
    min_fills_required: int
    avg_realized_slippage_bps: float
    p95_realized_slippage_bps: float
    avg_predicted_slippage_bps: float
    slippage_mape_pct: float
    max_p95_slippage_bps: float
    max_mape_pct: float
    passed_track_record: bool
    passed_slippage: bool
    ready_for_canary: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "lookback_days": int(self.lookback_days),
            "trading_days": int(self.trading_days),
            "min_days_required": int(self.min_days_required),
            "fills": int(self.fills),
            "min_fills_required": int(self.min_fills_required),
            "avg_realized_slippage_bps": float(self.avg_realized_slippage_bps),
            "p95_realized_slippage_bps": float(self.p95_realized_slippage_bps),
            "avg_predicted_slippage_bps": float(self.avg_predicted_slippage_bps),
            "slippage_mape_pct": float(self.slippage_mape_pct),
            "max_p95_slippage_bps": float(self.max_p95_slippage_bps),
            "max_mape_pct": float(self.max_mape_pct),
            "passed_track_record": bool(self.passed_track_record),
            "passed_slippage": bool(self.passed_slippage),
            "ready_for_canary": bool(self.ready_for_canary),
        }


class PaperTrackRecordEvaluator:
    """Evaluate if paper fills are sufficient to justify live-canary promotion."""

    def __init__(self, tca_db: TCADatabase):
        self.tca_db = tca_db

    def evaluate(
        self,
        *,
        lookback_days: int = 60,
        min_days_required: int = 30,
        min_fills_required: int = 200,
        max_p95_slippage_bps: float = 20.0,
        max_mape_pct: float = 35.0,
        prediction_profile: str = "",
    ) -> PaperReadinessResult:
        frame = self.tca_db.as_dataframe()
        profile_token = str(prediction_profile or "").strip()
        if profile_token:
            if "prediction_profile" not in frame.columns:
                frame = frame.iloc[0:0].copy()
            else:
                frame = frame[frame["prediction_profile"].astype(str) == profile_token].copy()
        if frame.empty:
            return PaperReadinessResult(
                lookback_days=lookback_days,
                trading_days=0,
                min_days_required=min_days_required,
                fills=0,
                min_fills_required=min_fills_required,
                avg_realized_slippage_bps=0.0,
                p95_realized_slippage_bps=0.0,
                avg_predicted_slippage_bps=0.0,
                slippage_mape_pct=0.0,
                max_p95_slippage_bps=max_p95_slippage_bps,
                max_mape_pct=max_mape_pct,
                passed_track_record=False,
                passed_slippage=False,
                ready_for_canary=False,
            )

        timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        cutoff = datetime.now(timezone.utc) - timedelta(days=int(lookback_days))
        frame = frame[timestamps >= pd.Timestamp(cutoff)].copy()
        if frame.empty:
            return PaperReadinessResult(
                lookback_days=lookback_days,
                trading_days=0,
                min_days_required=min_days_required,
                fills=0,
                min_fills_required=min_fills_required,
                avg_realized_slippage_bps=0.0,
                p95_realized_slippage_bps=0.0,
                avg_predicted_slippage_bps=0.0,
                slippage_mape_pct=0.0,
                max_p95_slippage_bps=max_p95_slippage_bps,
                max_mape_pct=max_mape_pct,
                passed_track_record=False,
                passed_slippage=False,
                ready_for_canary=False,
            )

        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
        frame["trade_day"] = frame["timestamp"].dt.date

        realized = pd.to_numeric(frame["realized_slippage_bps"], errors="coerce").fillna(0.0)
        predicted = pd.to_numeric(frame["predicted_slippage_bps"], errors="coerce").fillna(0.0)

        mape = slippage_mape_pct(
            predicted_slippage_bps=predicted.to_numpy(dtype=float),
            realized_slippage_bps=realized.to_numpy(dtype=float),
        )

        trading_days = int(frame["trade_day"].nunique())
        fills = int(len(frame))
        p95_realized = float(np.percentile(realized.to_numpy(dtype=float), 95))
        avg_realized = float(realized.mean())
        avg_predicted = float(predicted.mean())

        passed_track_record = trading_days >= int(min_days_required) and fills >= int(
            min_fills_required
        )
        passed_slippage = p95_realized <= float(max_p95_slippage_bps) and mape <= float(
            max_mape_pct
        )

        return PaperReadinessResult(
            lookback_days=lookback_days,
            trading_days=trading_days,
            min_days_required=min_days_required,
            fills=fills,
            min_fills_required=min_fills_required,
            avg_realized_slippage_bps=avg_realized,
            p95_realized_slippage_bps=p95_realized,
            avg_predicted_slippage_bps=avg_predicted,
            slippage_mape_pct=mape,
            max_p95_slippage_bps=max_p95_slippage_bps,
            max_mape_pct=max_mape_pct,
            passed_track_record=passed_track_record,
            passed_slippage=passed_slippage,
            ready_for_canary=(passed_track_record and passed_slippage),
        )
