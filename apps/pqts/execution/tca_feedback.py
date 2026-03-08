"""Transaction-cost feedback loop for predicted vs. realized execution quality."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd

try:
    import pyarrow  # noqa: F401

    HAS_PYARROW = True
except ImportError:  # pragma: no cover - environment dependent
    HAS_PYARROW = False


logger = logging.getLogger(__name__)

SLIPPAGE_MAPE_DENOM_FLOOR_BPS = 1.0
MIN_CALIBRATED_ETA = 0.005
MAX_CALIBRATED_ETA = 3.0


def slippage_mape_pct(
    *,
    predicted_slippage_bps: np.ndarray | pd.Series | List[float],
    realized_slippage_bps: np.ndarray | pd.Series | List[float],
    denom_floor_bps: float = SLIPPAGE_MAPE_DENOM_FLOOR_BPS,
) -> float:
    """
    Compute robust slippage MAPE in percent.

    Denominator is floored in bps space so near-zero realized slippage does not
    inflate errors into unusable calibration alerts.
    """
    predicted = np.asarray(predicted_slippage_bps, dtype=float)
    realized = np.asarray(realized_slippage_bps, dtype=float)
    if predicted.size == 0 or realized.size == 0:
        return 0.0

    size = min(predicted.size, realized.size)
    predicted = predicted[:size]
    realized = realized[:size]
    denom = np.maximum(np.abs(realized), max(float(denom_floor_bps), 1e-9))
    return float(np.mean(np.abs(predicted - realized) / denom) * 100.0)


@dataclass(frozen=True)
class ExecutionFill:
    """Canonical fill payload for paper/live execution sources."""

    executed_price: float
    executed_qty: float
    timestamp: datetime
    venue: str
    symbol: str


@dataclass
class TCATradeRecord:
    """Single trade with predicted and realized cost components."""

    trade_id: str
    timestamp: datetime
    symbol: str
    exchange: str
    side: str
    quantity: float
    price: float
    notional: float
    predicted_slippage_bps: float
    predicted_commission_bps: float
    predicted_total_bps: float
    realized_slippage_bps: float
    realized_commission_bps: float
    realized_total_bps: float
    spread_bps: float
    vol_24h: float
    depth_1pct_usd: float
    strategy_id: str = "unknown"
    expected_alpha_bps: float = 0.0
    prediction_profile: str = "unknown"
    expected_gross_alpha_usd: float = 0.0
    realized_commission_cost_usd: float = 0.0
    realized_slippage_cost_usd: float = 0.0
    realized_net_alpha_usd: float = 0.0
    spread_capture_proxy_usd: float = 0.0
    adverse_selection_proxy_usd: float = 0.0
    inventory_carry_proxy_usd: float = 0.0

    @property
    def slippage_error(self) -> float:
        return self.predicted_slippage_bps - self.realized_slippage_bps

    @property
    def realized_net_alpha_bps(self) -> float:
        return float(self.expected_alpha_bps) - float(self.realized_total_bps)


def _ensure_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return pd.to_datetime(value).to_pydatetime()


class TCADatabase:
    """Persist TCA records to CSV/Parquet with deterministic load/save behavior."""

    def __init__(self, db_path: str = "data/tca_records.csv"):
        self.db_path = Path(db_path)
        self.storage_path = self._resolve_storage_path()
        self.records: List[TCATradeRecord] = []
        self._load_existing()

    def _resolve_storage_path(self) -> Path:
        suffix = self.db_path.suffix.lower()

        if suffix in {".csv", ".parquet"}:
            if suffix == ".parquet" and not HAS_PYARROW:
                return self.db_path.with_suffix(".csv")
            return self.db_path

        preferred_suffix = ".parquet" if HAS_PYARROW else ".csv"
        return self.db_path.with_suffix(preferred_suffix)

    def _candidate_paths(self) -> List[Path]:
        candidates = [self.storage_path]
        if self.storage_path.suffix == ".parquet":
            candidates.append(self.storage_path.with_suffix(".csv"))
        elif self.storage_path.suffix == ".csv":
            candidates.append(self.storage_path.with_suffix(".parquet"))
        return candidates

    def _load_existing(self) -> None:
        for path in self._candidate_paths():
            if not path.exists():
                continue

            try:
                if path.suffix == ".parquet":
                    if not HAS_PYARROW:
                        continue
                    frame = pd.read_parquet(path)
                else:
                    frame = pd.read_csv(path, parse_dates=["timestamp"])
            except Exception as exc:  # pragma: no cover - IO safety
                logger.warning("Could not load TCA data from %s: %s", path, exc)
                continue

            self.storage_path = path
            self.records = self._df_to_records(frame)
            logger.info("Loaded %s TCA records from %s", len(self.records), path)
            return

    def _df_to_records(self, frame: pd.DataFrame) -> List[TCATradeRecord]:
        records: List[TCATradeRecord] = []
        for _, row in frame.iterrows():
            payload = row.to_dict()
            payload["timestamp"] = _ensure_datetime(payload["timestamp"])
            strategy_id = payload.get("strategy_id", "unknown")
            if pd.isna(strategy_id) or str(strategy_id).strip() == "":
                strategy_id = "unknown"
            expected_alpha_bps = payload.get("expected_alpha_bps", 0.0)
            if pd.isna(expected_alpha_bps):
                expected_alpha_bps = 0.0
            prediction_profile = payload.get("prediction_profile", "unknown")
            if pd.isna(prediction_profile) or str(prediction_profile).strip() == "":
                prediction_profile = "unknown"
            for key in (
                "expected_gross_alpha_usd",
                "realized_commission_cost_usd",
                "realized_slippage_cost_usd",
                "realized_net_alpha_usd",
                "spread_capture_proxy_usd",
                "adverse_selection_proxy_usd",
                "inventory_carry_proxy_usd",
            ):
                value = payload.get(key, 0.0)
                payload[key] = 0.0 if pd.isna(value) else float(value)
            payload["strategy_id"] = str(strategy_id)
            payload["expected_alpha_bps"] = float(expected_alpha_bps)
            payload["prediction_profile"] = str(prediction_profile)
            records.append(TCATradeRecord(**payload))
        return records

    def _records_to_df(self) -> pd.DataFrame:
        rows = []
        for record in self.records:
            rows.append(
                {
                    "trade_id": record.trade_id,
                    "timestamp": record.timestamp,
                    "symbol": record.symbol,
                    "exchange": record.exchange,
                    "side": record.side,
                    "quantity": record.quantity,
                    "price": record.price,
                    "notional": record.notional,
                    "predicted_slippage_bps": record.predicted_slippage_bps,
                    "predicted_commission_bps": record.predicted_commission_bps,
                    "predicted_total_bps": record.predicted_total_bps,
                    "realized_slippage_bps": record.realized_slippage_bps,
                    "realized_commission_bps": record.realized_commission_bps,
                    "realized_total_bps": record.realized_total_bps,
                    "spread_bps": record.spread_bps,
                    "vol_24h": record.vol_24h,
                    "depth_1pct_usd": record.depth_1pct_usd,
                    "strategy_id": record.strategy_id,
                    "expected_alpha_bps": record.expected_alpha_bps,
                    "prediction_profile": record.prediction_profile,
                    "expected_gross_alpha_usd": record.expected_gross_alpha_usd,
                    "realized_commission_cost_usd": record.realized_commission_cost_usd,
                    "realized_slippage_cost_usd": record.realized_slippage_cost_usd,
                    "realized_net_alpha_usd": record.realized_net_alpha_usd,
                    "spread_capture_proxy_usd": record.spread_capture_proxy_usd,
                    "adverse_selection_proxy_usd": record.adverse_selection_proxy_usd,
                    "inventory_carry_proxy_usd": record.inventory_carry_proxy_usd,
                }
            )
        return pd.DataFrame(rows)

    def add_record(self, record: TCATradeRecord) -> None:
        self.records.append(record)

    def save(self) -> Path:
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        frame = self._records_to_df()

        if self.storage_path.suffix == ".parquet" and HAS_PYARROW:
            frame.to_parquet(self.storage_path, index=False)
        else:
            self.storage_path = self.storage_path.with_suffix(".csv")
            frame.to_csv(self.storage_path, index=False)

        logger.info("Saved %s TCA records to %s", len(self.records), self.storage_path)
        return self.storage_path

    def as_dataframe(self) -> pd.DataFrame:
        return self._records_to_df()

    def get_recent(self, n: int = 100) -> pd.DataFrame:
        frame = self._records_to_df()
        return frame.tail(n)

    def get_by_symbol(self, symbol: str, days: int = 30) -> pd.DataFrame:
        frame = self._records_to_df()
        if frame.empty:
            return frame
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        return frame[(frame["symbol"] == symbol) & (timestamps >= cutoff)]

    def get_by_venue(self, exchange: str, days: int = 30) -> pd.DataFrame:
        frame = self._records_to_df()
        if frame.empty:
            return frame
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        return frame[(frame["exchange"] == exchange) & (timestamps >= cutoff)]

    def get_by_symbol_venue(self, symbol: str, exchange: str, days: int = 30) -> pd.DataFrame:
        frame = self._records_to_df()
        if frame.empty:
            return frame
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        return frame[
            (frame["symbol"] == symbol) & (frame["exchange"] == exchange) & (timestamps >= cutoff)
        ]


class TCACalibrator:
    """Weekly slippage-calibration routines by symbol/venue."""

    def __init__(
        self,
        tca_db: TCADatabase,
        min_samples: int = 50,
        alert_threshold_pct: float = 20.0,
        adaptation_rate: float = 0.75,
        max_step_pct: float = 0.80,
        prediction_profile: str = "",
    ):
        self.tca_db = tca_db
        self.min_samples = min_samples
        self.alert_threshold_pct = alert_threshold_pct
        self.adaptation_rate = float(np.clip(float(adaptation_rate), 0.0, 1.0))
        self.max_step_pct = float(max(float(max_step_pct), 0.0))
        self.prediction_profile = str(prediction_profile or "").strip()

    def _filter_prediction_profile(self, frame: pd.DataFrame) -> pd.DataFrame:
        if frame.empty:
            return frame
        if not self.prediction_profile:
            return frame
        if "prediction_profile" not in frame.columns:
            return frame.iloc[0:0].copy()
        mask = frame["prediction_profile"].astype(str) == self.prediction_profile
        return frame[mask].copy()

    @staticmethod
    def _apply_lookback(frame: pd.DataFrame, *, days: int) -> pd.DataFrame:
        if frame.empty:
            return frame
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        timestamps = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        return frame[timestamps >= cutoff]

    def _calibration_frame(
        self,
        *,
        symbol: str,
        exchange: str,
        days: int,
    ) -> Tuple[pd.DataFrame, str]:
        symbol_frame = self.tca_db.get_by_symbol_venue(symbol, exchange, days=days)
        symbol_frame = self._filter_prediction_profile(symbol_frame)
        if len(symbol_frame) >= self.min_samples:
            return symbol_frame, "symbol_venue"

        venue_frame = self.tca_db.get_by_venue(exchange, days=days)
        venue_frame = self._filter_prediction_profile(venue_frame)
        if len(venue_frame) >= self.min_samples:
            return venue_frame, "venue_fallback"

        global_frame = self._apply_lookback(self.tca_db.as_dataframe(), days=days)
        global_frame = self._filter_prediction_profile(global_frame)
        if len(global_frame) >= self.min_samples:
            return global_frame, "global_fallback"

        return symbol_frame, "insufficient_data"

    def analyze_symbol_venue(self, symbol: str, exchange: str, days: int = 30) -> Dict[str, Any]:
        frame = self.tca_db.get_by_symbol_venue(symbol, exchange, days=days)
        if len(frame) < self.min_samples:
            return {
                "symbol": symbol,
                "exchange": exchange,
                "status": "insufficient_data",
                "n_trades": len(frame),
                "needs": self.min_samples,
                "alerts": [],
            }

        predicted = pd.to_numeric(frame["predicted_slippage_bps"], errors="coerce").fillna(0.0)
        realized = pd.to_numeric(frame["realized_slippage_bps"], errors="coerce").fillna(0.0)
        errors = predicted - realized
        mape = slippage_mape_pct(
            predicted_slippage_bps=predicted,
            realized_slippage_bps=realized,
        )

        alerts: List[str] = []
        analysis: Dict[str, Any] = {
            "symbol": symbol,
            "exchange": exchange,
            "status": "ok",
            "n_trades": len(frame),
            "slippage": {
                "predicted_avg": frame["predicted_slippage_bps"].mean(),
                "realized_avg": frame["realized_slippage_bps"].mean(),
                "mean_error": errors.mean(),
                "mape": mape,
            },
            "alerts": alerts,
        }

        if mape > self.alert_threshold_pct:
            analysis["status"] = "alert"
            alerts.append(f"MAPE {mape:.2f}% exceeds threshold {self.alert_threshold_pct:.2f}%")

        return analysis

    def calibrate_eta(
        self, symbol: str, exchange: str, current_eta: float, days: int = 30
    ) -> Tuple[float, Dict[str, Any]]:
        frame, calibration_scope = self._calibration_frame(
            symbol=symbol,
            exchange=exchange,
            days=days,
        )
        if len(frame) < self.min_samples:
            return current_eta, {
                "symbol": symbol,
                "exchange": exchange,
                "status": "insufficient_data",
                "n_trades": len(frame),
                "eta_before": current_eta,
                "eta_after": current_eta,
                "calibration_scope": calibration_scope,
            }

        predicted_avg = float(
            pd.to_numeric(frame["predicted_slippage_bps"], errors="coerce").mean()
        )
        realized_avg = float(pd.to_numeric(frame["realized_slippage_bps"], errors="coerce").mean())

        baseline = max(abs(predicted_avg), float(SLIPPAGE_MAPE_DENOM_FLOOR_BPS))
        ratio = max(realized_avg, 0.0) / baseline
        current_eta_clamped = float(np.clip(current_eta, MIN_CALIBRATED_ETA, MAX_CALIBRATED_ETA))
        target_eta = float(
            np.clip(current_eta_clamped * ratio, MIN_CALIBRATED_ETA, MAX_CALIBRATED_ETA)
        )
        blended_eta = float(
            current_eta_clamped + self.adaptation_rate * (target_eta - current_eta_clamped)
        )

        if self.max_step_pct > 0.0:
            max_delta = abs(current_eta_clamped) * self.max_step_pct
            lower = max(current_eta_clamped - max_delta, MIN_CALIBRATED_ETA)
            upper = min(current_eta_clamped + max_delta, MAX_CALIBRATED_ETA)
            blended_eta = float(np.clip(blended_eta, lower, upper))

        new_eta = float(np.clip(blended_eta, MIN_CALIBRATED_ETA, MAX_CALIBRATED_ETA))

        predicted = pd.to_numeric(frame["predicted_slippage_bps"], errors="coerce").fillna(0.0)
        realized = pd.to_numeric(frame["realized_slippage_bps"], errors="coerce").fillna(0.0)
        errors = predicted - realized
        mape = slippage_mape_pct(
            predicted_slippage_bps=predicted,
            realized_slippage_bps=realized,
        )
        alerts: List[str] = []
        status = "ok"
        if mape > self.alert_threshold_pct:
            status = "alert"
            alerts.append(f"MAPE {mape:.2f}% exceeds threshold {self.alert_threshold_pct:.2f}%")
        analysis: Dict[str, Any] = {
            "symbol": symbol,
            "exchange": exchange,
            "status": status,
            "n_trades": len(frame),
            "slippage": {
                "predicted_avg": float(predicted.mean()),
                "realized_avg": float(realized.mean()),
                "mean_error": float(errors.mean()),
                "mape": float(mape),
            },
            "alerts": alerts,
        }
        analysis.update(
            {
                "eta_before": current_eta,
                "eta_target": target_eta,
                "eta_after": new_eta,
                "change_pct": ((new_eta - current_eta) / max(current_eta, 1e-9)) * 100.0,
                "ratio_realized_to_predicted": ratio,
                "adaptation_rate": float(self.adaptation_rate),
                "max_step_pct": float(self.max_step_pct),
                "calibration_scope": calibration_scope,
                "calibration_samples": int(len(frame)),
            }
        )

        return new_eta, analysis

    def run_weekly_calibration_by_market(
        self,
        current_eta_by_market: Dict[Tuple[str, str], float],
        days: int = 30,
    ) -> Tuple[Dict[Tuple[str, str], float], List[Dict[str, Any]]]:
        updated = current_eta_by_market.copy()
        analyses: List[Dict[str, Any]] = []

        for (symbol, exchange), eta in sorted(current_eta_by_market.items()):
            new_eta, analysis = self.calibrate_eta(symbol, exchange, eta, days=days)
            updated[(symbol, exchange)] = new_eta
            analyses.append(analysis)

        return updated, analyses


def weekly_calibrate_eta(
    tca_db: TCADatabase,
    current_eta_by_market: Dict[Tuple[str, str], float],
    min_samples: int = 50,
    alert_threshold_pct: float = 20.0,
    adaptation_rate: float = 0.75,
    max_step_pct: float = 0.80,
    days: int = 30,
    prediction_profile: str = "",
) -> Tuple[Dict[Tuple[str, str], float], List[Dict[str, Any]]]:
    """Callable weekly calibration entrypoint for schedulers/jobs."""

    calibrator = TCACalibrator(
        tca_db=tca_db,
        min_samples=min_samples,
        alert_threshold_pct=alert_threshold_pct,
        adaptation_rate=adaptation_rate,
        max_step_pct=max_step_pct,
        prediction_profile=prediction_profile,
    )
    return calibrator.run_weekly_calibration_by_market(
        current_eta_by_market=current_eta_by_market,
        days=days,
    )
