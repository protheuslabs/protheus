"""Calibration diagnostics for predicted-vs-realized execution slippage."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from execution.tca_feedback import SLIPPAGE_MAPE_DENOM_FLOOR_BPS, TCADatabase, slippage_mape_pct


@dataclass(frozen=True)
class CalibrationDiagnosticsThresholds:
    """Thresholds for calibration diagnostics and alerting."""

    min_samples: int = 30
    max_mape_pct: float = 35.0
    min_realized_to_predicted_ratio: float = 0.50
    max_realized_to_predicted_ratio: float = 1.50


def _summarize_pair(
    *,
    symbol: str,
    exchange: str,
    frame: pd.DataFrame,
    thresholds: CalibrationDiagnosticsThresholds,
) -> Dict[str, Any]:
    predicted = pd.to_numeric(frame["predicted_slippage_bps"], errors="coerce").fillna(0.0)
    realized = pd.to_numeric(frame["realized_slippage_bps"], errors="coerce").fillna(0.0)
    timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")

    p = predicted.to_numpy(dtype=float)
    r = realized.to_numpy(dtype=float)
    predicted_avg = float(np.mean(p))
    realized_avg = float(np.mean(r))
    mape_pct = slippage_mape_pct(
        predicted_slippage_bps=p,
        realized_slippage_bps=r,
        denom_floor_bps=float(SLIPPAGE_MAPE_DENOM_FLOOR_BPS),
    )
    ratio = float(realized_avg / max(abs(predicted_avg), float(SLIPPAGE_MAPE_DENOM_FLOOR_BPS)))
    bias_bps = float(realized_avg - predicted_avg)
    samples = int(len(frame))
    trading_days = int(pd.Series(timestamps.dt.date).nunique())
    warmup = samples < int(thresholds.min_samples)

    reasons: List[str] = []
    if warmup:
        reasons.append(f"warmup_insufficient_samples:{samples}<{int(thresholds.min_samples)}")
        status = "warmup"
    else:
        if mape_pct > float(thresholds.max_mape_pct):
            reasons.append(f"mape:{mape_pct:.2f}>{float(thresholds.max_mape_pct):.2f}")
        if ratio < float(thresholds.min_realized_to_predicted_ratio):
            reasons.append(
                "ratio_low:" f"{ratio:.2f}<{float(thresholds.min_realized_to_predicted_ratio):.2f}"
            )
        if ratio > float(thresholds.max_realized_to_predicted_ratio):
            reasons.append(
                "ratio_high:" f"{ratio:.2f}>{float(thresholds.max_realized_to_predicted_ratio):.2f}"
            )
        status = "alert" if reasons else "ok"

    eta_multiplier = float(np.clip(ratio, 0.25, 4.0))
    if eta_multiplier > 1.01:
        eta_direction = "increase_eta"
    elif eta_multiplier < 0.99:
        eta_direction = "decrease_eta"
    else:
        eta_direction = "hold_eta"

    return {
        "symbol": str(symbol),
        "exchange": str(exchange),
        "samples": samples,
        "trading_days": trading_days,
        "required_samples": int(thresholds.min_samples),
        "predicted_slippage_bps_avg": predicted_avg,
        "realized_slippage_bps_avg": realized_avg,
        "slippage_mape_pct": mape_pct,
        "realized_to_predicted_ratio": ratio,
        "bias_bps": bias_bps,
        "recommended_eta_multiplier": eta_multiplier,
        "eta_direction": eta_direction,
        "status": status,
        "reasons": reasons,
    }


def analyze_calibration_diagnostics(
    *,
    tca_db: TCADatabase,
    lookback_days: int = 30,
    thresholds: CalibrationDiagnosticsThresholds | None = None,
) -> Dict[str, Any]:
    """Summarize calibration health by symbol/venue over a lookback window."""
    cfg = thresholds or CalibrationDiagnosticsThresholds()
    frame = tca_db.as_dataframe()
    if frame.empty:
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "lookback_days": int(lookback_days),
            "thresholds": asdict(cfg),
            "summary": {
                "pairs": 0,
                "alerts": 0,
                "warmup_pairs": 0,
                "healthy": True,
                "samples": 0,
                "mape_p95_pct": 0.0,
                "ratio_p95": 0.0,
            },
            "pairs": [],
        }

    timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
    cutoff = datetime.now(timezone.utc) - timedelta(days=int(lookback_days))
    scoped = frame[timestamps >= pd.Timestamp(cutoff)].copy()
    if scoped.empty:
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "lookback_days": int(lookback_days),
            "thresholds": asdict(cfg),
            "summary": {
                "pairs": 0,
                "alerts": 0,
                "warmup_pairs": 0,
                "healthy": True,
                "samples": 0,
                "mape_p95_pct": 0.0,
                "ratio_p95": 0.0,
            },
            "pairs": [],
        }

    rows: List[Dict[str, Any]] = []
    for (symbol, exchange), group in scoped.groupby(["symbol", "exchange"], sort=True):
        rows.append(
            _summarize_pair(
                symbol=str(symbol),
                exchange=str(exchange),
                frame=group,
                thresholds=cfg,
            )
        )

    status_rank = {
        "alert": 0,
        "warmup": 1,
        "ok": 2,
    }
    rows.sort(
        key=lambda row: (
            status_rank.get(str(row.get("status", "")).lower(), 3),
            -float(row.get("slippage_mape_pct", 0.0)),
        )
    )

    alert_count = sum(1 for row in rows if str(row.get("status")) == "alert")
    warmup_count = sum(1 for row in rows if str(row.get("status")) == "warmup")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "lookback_days": int(lookback_days),
        "thresholds": asdict(cfg),
        "summary": {
            "pairs": len(rows),
            "alerts": alert_count,
            "warmup_pairs": warmup_count,
            "healthy": alert_count == 0,
            "samples": int(len(scoped)),
            "mape_p95_pct": float(np.percentile([row["slippage_mape_pct"] for row in rows], 95)),
            "ratio_p95": float(
                np.percentile([row["realized_to_predicted_ratio"] for row in rows], 95)
            ),
        },
        "pairs": rows,
    }


def write_calibration_diagnostics_report(
    *,
    tca_db_path: str,
    out_dir: str = "data/reports",
    lookback_days: int = 30,
    thresholds: CalibrationDiagnosticsThresholds | None = None,
) -> Path:
    """Persist calibration diagnostics report and return output path."""
    db = TCADatabase(tca_db_path)
    payload = analyze_calibration_diagnostics(
        tca_db=db,
        lookback_days=lookback_days,
        thresholds=thresholds,
    )
    root = Path(out_dir)
    root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = root / f"calibration_diagnostics_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path
