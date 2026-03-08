"""Historical market-data download + quality utilities for research workflows."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional
import hashlib
import json

import pandas as pd
import requests
from requests import HTTPError


_BINANCE_INTERVAL_MS = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "6h": 21_600_000,
    "8h": 28_800_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
}

_COINBASE_GRANULARITY = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3_600,
    "6h": 21_600,
    "1d": 86_400,
}


@dataclass(frozen=True)
class DataQualitySummary:
    rows: int
    duplicates: int
    missing_intervals: int
    completeness: float
    is_monotonic: bool


class HistoricalDataDownloader:
    """Download deterministic OHLCV history from supported public exchange APIs."""

    def __init__(
        self,
        output_dir: str = "data/historical",
        timeout_seconds: float = 20.0,
        request_json: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
    ):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.timeout_seconds = float(timeout_seconds)
        self._session = requests.Session()
        self._request_json_fn = request_json

    @staticmethod
    def _utc(dt: datetime) -> datetime:
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    @staticmethod
    def _to_ms(dt: datetime) -> int:
        return int(HistoricalDataDownloader._utc(dt).timestamp() * 1000)

    @staticmethod
    def _iso(dt: datetime) -> str:
        return HistoricalDataDownloader._utc(dt).isoformat().replace("+00:00", "Z")

    def _request_json(self, url: str, params: Dict[str, Any]) -> Any:
        if self._request_json_fn is not None:
            return self._request_json_fn(url, params)

        response = self._session.get(url, params=params, timeout=self.timeout_seconds)
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _normalize_ohlcv(
        frame: pd.DataFrame,
        *,
        timestamp_col: str,
        timestamp_unit: str,
    ) -> pd.DataFrame:
        if frame.empty:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

        normalized = frame.copy()
        normalized["timestamp"] = pd.to_datetime(
            normalized[timestamp_col], unit=timestamp_unit, utc=True
        )
        for col in ["open", "high", "low", "close", "volume"]:
            normalized[col] = pd.to_numeric(normalized[col], errors="coerce")

        normalized = normalized[["timestamp", "open", "high", "low", "close", "volume"]]
        normalized = normalized.dropna().drop_duplicates(subset=["timestamp"])
        normalized = normalized.sort_values("timestamp").set_index("timestamp")
        return normalized

    def download_binance_ohlcv(
        self,
        *,
        symbol: str,
        interval: str,
        start: datetime,
        end: datetime,
        limit: int = 1000,
    ) -> pd.DataFrame:
        if interval not in _BINANCE_INTERVAL_MS:
            raise ValueError(f"Unsupported Binance interval: {interval}")

        start_ms = self._to_ms(start)
        end_ms = self._to_ms(end)
        interval_ms = _BINANCE_INTERVAL_MS[interval]

        rows: List[List[Any]] = []
        cursor = start_ms
        urls = [
            "https://api.binance.com/api/v3/klines",
            "https://api.binance.us/api/v3/klines",
            "https://data-api.binance.vision/api/v3/klines",
        ]

        while cursor <= end_ms:
            params = {
                "symbol": symbol,
                "interval": interval,
                "startTime": cursor,
                "endTime": end_ms,
                "limit": int(limit),
            }
            payload = None
            last_exc: Optional[Exception] = None
            for url in urls:
                try:
                    payload = self._request_json(url, params)
                    break
                except HTTPError as exc:
                    last_exc = exc
                    continue

            if not payload:
                if payload is None and last_exc is not None:
                    raise last_exc
                break

            rows.extend(payload)
            last_open = int(payload[-1][0])
            next_cursor = last_open + interval_ms
            if next_cursor <= cursor:
                break
            cursor = next_cursor

            if len(payload) < int(limit):
                break

        frame = pd.DataFrame(
            [
                {
                    "open_time": row[0],
                    "open": row[1],
                    "high": row[2],
                    "low": row[3],
                    "close": row[4],
                    "volume": row[5],
                }
                for row in rows
            ]
        )
        return self._normalize_ohlcv(frame, timestamp_col="open_time", timestamp_unit="ms")

    def download_coinbase_ohlcv(
        self,
        *,
        product_id: str,
        interval: str,
        start: datetime,
        end: datetime,
    ) -> pd.DataFrame:
        if interval not in _COINBASE_GRANULARITY:
            raise ValueError(f"Unsupported Coinbase interval: {interval}")

        granularity = _COINBASE_GRANULARITY[interval]
        chunk = granularity * 300
        start_utc = self._utc(start)
        end_utc = self._utc(end)

        rows: List[List[Any]] = []
        cursor = start_utc
        url = f"https://api.exchange.coinbase.com/products/{product_id}/candles"

        while cursor < end_utc:
            chunk_end = min(cursor + timedelta(seconds=chunk), end_utc)
            payload = self._request_json(
                url,
                {
                    "start": self._iso(cursor),
                    "end": self._iso(chunk_end),
                    "granularity": granularity,
                },
            )
            if payload:
                rows.extend(payload)
            cursor = chunk_end

        frame = pd.DataFrame(
            [
                {
                    "time": row[0],
                    "low": row[1],
                    "high": row[2],
                    "open": row[3],
                    "close": row[4],
                    "volume": row[5],
                }
                for row in rows
            ]
        )
        return self._normalize_ohlcv(frame, timestamp_col="time", timestamp_unit="s")

    def quality_summary(self, frame: pd.DataFrame, *, interval: str) -> DataQualitySummary:
        if interval in _BINANCE_INTERVAL_MS:
            delta_ms = _BINANCE_INTERVAL_MS[interval]
        elif interval in _COINBASE_GRANULARITY:
            delta_ms = _COINBASE_GRANULARITY[interval] * 1000
        else:
            raise ValueError(f"Unsupported interval for quality summary: {interval}")

        if frame.empty:
            return DataQualitySummary(
                rows=0,
                duplicates=0,
                missing_intervals=0,
                completeness=0.0,
                is_monotonic=True,
            )

        idx = pd.DatetimeIndex(frame.index)
        duplicates = int(idx.duplicated().sum())
        is_monotonic = bool(idx.is_monotonic_increasing)

        diffs = idx.to_series().diff().dropna().dt.total_seconds() * 1000.0
        missing = 0
        for diff in diffs:
            if diff > delta_ms:
                missing += int(round(diff / delta_ms)) - 1

        observed = len(idx)
        expected = observed + missing
        completeness = float(observed / expected) if expected > 0 else 0.0

        return DataQualitySummary(
            rows=observed,
            duplicates=duplicates,
            missing_intervals=max(missing, 0),
            completeness=completeness,
            is_monotonic=is_monotonic,
        )

    @staticmethod
    def _slug_symbol(symbol: str) -> str:
        return symbol.replace("/", "-").replace("_", "-")

    def save_dataset(
        self,
        frame: pd.DataFrame,
        *,
        venue: str,
        symbol: str,
        interval: str,
        start: datetime,
        end: datetime,
        fmt: str = "csv",
    ) -> Path:
        venue_slug = str(venue).lower()
        symbol_slug = self._slug_symbol(symbol)
        span = f"{self._utc(start).strftime('%Y%m%d')}_{self._utc(end).strftime('%Y%m%d')}"
        target_dir = self.output_dir / venue_slug / symbol_slug / interval
        target_dir.mkdir(parents=True, exist_ok=True)

        if fmt not in {"csv", "parquet"}:
            raise ValueError("fmt must be 'csv' or 'parquet'")

        path = target_dir / f"{span}.{fmt}"
        if fmt == "parquet":
            frame.to_parquet(path)
        else:
            frame.to_csv(path)

        manifest = {
            "venue": venue_slug,
            "symbol": symbol,
            "interval": interval,
            "rows": int(len(frame)),
            "start": self._iso(start),
            "end": self._iso(end),
            "path": str(path),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        manifest_path = target_dir / f"{span}.manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

        return path


def load_research_frames(data_paths: Dict[str, Path]) -> Dict[str, pd.DataFrame]:
    """Load OHLCV files into AIResearchAgent-compatible frames by symbol."""
    result: Dict[str, pd.DataFrame] = {}
    for symbol, path in sorted(data_paths.items()):
        file_path = Path(path)
        if file_path.suffix == ".parquet":
            frame = pd.read_parquet(file_path)
        else:
            frame = pd.read_csv(file_path, parse_dates=["timestamp"], index_col="timestamp")

        if not isinstance(frame.index, pd.DatetimeIndex):
            frame.index = pd.to_datetime(frame.index, utc=True)
        frame = frame.sort_index()
        result[symbol] = frame[["open", "high", "low", "close", "volume"]]
    return result


def interval_for_coinbase(interval: str) -> int:
    if interval not in _COINBASE_GRANULARITY:
        raise ValueError(f"Unsupported coinbase interval: {interval}")
    return _COINBASE_GRANULARITY[interval]


def supported_binance_intervals() -> Iterable[str]:
    return tuple(sorted(_BINANCE_INTERVAL_MS.keys(), key=lambda token: _BINANCE_INTERVAL_MS[token]))


def supported_coinbase_intervals() -> Iterable[str]:
    return tuple(sorted(_COINBASE_GRANULARITY.keys(), key=lambda token: _COINBASE_GRANULARITY[token]))
