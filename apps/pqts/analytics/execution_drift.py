"""Execution parity drift analysis from predicted vs realized TCA outcomes."""

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
class DriftThresholds:
    """Thresholds that define alerting boundaries for paper/live drift."""

    min_samples: int = 30
    max_mape_pct: float = 35.0
    min_realized_to_predicted_ratio: float = 0.50
    max_realized_to_predicted_ratio: float = 1.50
    suppress_warmup_alerts: bool = True


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _summarize_group(
    *,
    symbol: str,
    exchange: str,
    frame: pd.DataFrame,
    thresholds: DriftThresholds,
) -> Dict[str, Any]:
    predicted = pd.to_numeric(frame["predicted_slippage_bps"], errors="coerce").fillna(0.0)
    realized = pd.to_numeric(frame["realized_slippage_bps"], errors="coerce").fillna(0.0)

    p = predicted.to_numpy(dtype=float)
    r = realized.to_numpy(dtype=float)
    mape_pct = slippage_mape_pct(
        predicted_slippage_bps=p,
        realized_slippage_bps=r,
        denom_floor_bps=float(SLIPPAGE_MAPE_DENOM_FLOOR_BPS),
    )
    predicted_avg = float(np.mean(p))
    realized_avg = float(np.mean(r))
    ratio = float(realized_avg / max(abs(predicted_avg), float(SLIPPAGE_MAPE_DENOM_FLOOR_BPS)))

    samples = int(len(frame))
    warmup = samples < int(thresholds.min_samples)
    alerts: List[str] = []
    notes: List[str] = []

    if warmup:
        warmup_note = f"insufficient_samples:{samples}<{int(thresholds.min_samples)}"
        if bool(thresholds.suppress_warmup_alerts):
            notes.append(warmup_note)
        else:
            alerts.append(warmup_note)

    if (not warmup) and mape_pct > float(thresholds.max_mape_pct):
        alerts.append(f"mape:{mape_pct:.2f}>{float(thresholds.max_mape_pct):.2f}")
    if (not warmup) and ratio < float(thresholds.min_realized_to_predicted_ratio):
        alerts.append(
            "ratio_low:" f"{ratio:.2f}<{float(thresholds.min_realized_to_predicted_ratio):.2f}"
        )
    if (not warmup) and ratio > float(thresholds.max_realized_to_predicted_ratio):
        alerts.append(
            "ratio:" f"{ratio:.2f}>{float(thresholds.max_realized_to_predicted_ratio):.2f}"
        )

    if alerts:
        status = "alert"
    elif warmup:
        status = "warmup"
    else:
        status = "ok"

    return {
        "symbol": str(symbol),
        "exchange": str(exchange),
        "samples": samples,
        "required_samples": int(thresholds.min_samples),
        "warmup": bool(warmup),
        "predicted_slippage_bps_avg": predicted_avg,
        "realized_slippage_bps_avg": realized_avg,
        "slippage_mape_pct": mape_pct,
        "realized_to_predicted_ratio": ratio,
        "status": status,
        "alerts": alerts,
        "notes": notes,
    }


def analyze_execution_drift(
    *,
    tca_db: TCADatabase,
    lookback_days: int = 30,
    thresholds: DriftThresholds | None = None,
) -> Dict[str, Any]:
    """Analyze symbol/venue drift between predicted and realized execution costs."""
    cfg = thresholds or DriftThresholds()
    frame = tca_db.as_dataframe()
    if frame.empty:
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "lookback_days": int(lookback_days),
            "thresholds": asdict(cfg),
            "summary": {
                "pairs": 0,
                "alerts": 0,
                "healthy": True,
                "samples": 0,
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
                "healthy": True,
                "samples": 0,
            },
            "pairs": [],
        }

    pair_rows: List[Dict[str, Any]] = []
    for (symbol, exchange), group in scoped.groupby(["symbol", "exchange"], sort=True):
        pair_rows.append(
            _summarize_group(
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
    pair_rows.sort(
        key=lambda row: (
            status_rank.get(str(row.get("status", "")).lower(), 3),
            -_safe_float(row.get("slippage_mape_pct", 0.0)),
        )
    )

    alert_count = sum(1 for row in pair_rows if str(row.get("status")) == "alert")
    warmup_count = sum(1 for row in pair_rows if str(row.get("status")) == "warmup")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "lookback_days": int(lookback_days),
        "thresholds": asdict(cfg),
        "summary": {
            "pairs": len(pair_rows),
            "alerts": alert_count,
            "warmup_pairs": warmup_count,
            "healthy": alert_count == 0,
            "samples": int(len(scoped)),
            "mape_p95_pct": float(
                np.percentile([row["slippage_mape_pct"] for row in pair_rows], 95)
            ),
        },
        "pairs": pair_rows,
    }


def write_execution_drift_report(
    *,
    tca_db_path: str,
    out_dir: str = "data/reports",
    lookback_days: int = 30,
    thresholds: DriftThresholds | None = None,
) -> Path:
    """Write execution drift report JSON and return output path."""
    db = TCADatabase(tca_db_path)
    payload = analyze_execution_drift(
        tca_db=db,
        lookback_days=lookback_days,
        thresholds=thresholds,
    )
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = out / f"execution_drift_{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path
