"""Partitioned market-data lake with deterministic replay and hard quality gates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Generator, Iterable, List, Optional

import pandas as pd

try:
    import pyarrow  # noqa: F401

    HAS_PYARROW = True
except Exception:  # pragma: no cover
    HAS_PYARROW = False


@dataclass(frozen=True)
class DataLakeQualitySummary:
    rows: int
    duplicates: int
    missing_intervals: int
    completeness: float
    monotonic: bool


@dataclass(frozen=True)
class DataLakeQualityGate:
    min_completeness: float = 0.995
    max_missing_intervals: int = 0
    require_monotonic: bool = True


class MarketDataLake:
    """Partitioned OHLCV lakehouse: venue/symbol/date with deterministic replay order."""

    def __init__(self, root_dir: str = "data/lake"):
        self.root = Path(root_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _utc(ts: datetime) -> datetime:
        if ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)

    @staticmethod
    def _normalize_index(frame: pd.DataFrame) -> pd.DataFrame:
        if frame.empty:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

        out = frame.copy()
        if "timestamp" in out.columns:
            out["timestamp"] = pd.to_datetime(out["timestamp"], utc=True, errors="coerce")
            out = out.dropna(subset=["timestamp"]).set_index("timestamp")
        else:
            out.index = pd.to_datetime(out.index, utc=True, errors="coerce")
            out = out[~out.index.isna()]

        for col in ("open", "high", "low", "close", "volume"):
            if col not in out.columns:
                out[col] = 0.0
            out[col] = pd.to_numeric(out[col], errors="coerce")

        out = out[["open", "high", "low", "close", "volume"]]
        out = out.dropna().sort_index()
        out = out[~out.index.duplicated(keep="first")]
        return out

    @staticmethod
    def _slug(value: str) -> str:
        return str(value).strip().replace("/", "-").replace("_", "-")

    def _partition_dir(self, *, channel: str, venue: str, symbol: str, date_token: str) -> Path:
        return (
            self.root
            / f"channel={self._slug(channel)}"
            / f"venue={self._slug(venue)}"
            / f"symbol={self._slug(symbol)}"
            / f"date={date_token}"
        )

    @staticmethod
    def _part_file_name(index: pd.DatetimeIndex) -> str:
        if len(index) == 0:
            digest = "empty"
        else:
            payload = f"{index[0].isoformat()}|{index[-1].isoformat()}|{len(index)}"
            digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
        suffix = "parquet" if HAS_PYARROW else "csv"
        return f"part-{digest}.{suffix}"

    @staticmethod
    def _write_frame(path: Path, frame: pd.DataFrame) -> None:
        if path.suffix == ".parquet" and HAS_PYARROW:
            frame.to_parquet(path)
        else:
            frame.to_csv(path, index_label="timestamp")

    @staticmethod
    def _read_frame(path: Path) -> pd.DataFrame:
        if path.suffix == ".parquet" and HAS_PYARROW:
            frame = pd.read_parquet(path)
        else:
            frame = pd.read_csv(path, parse_dates=["timestamp"])
            frame = frame.set_index("timestamp")

        frame.index = pd.to_datetime(frame.index, utc=True, errors="coerce")
        frame = frame[~frame.index.isna()]
        return frame.sort_index()

    def write_ohlcv(
        self,
        frame: pd.DataFrame,
        *,
        venue: str,
        symbol: str,
        channel: str = "ohlcv",
    ) -> List[Path]:
        normalized = self._normalize_index(frame)
        if normalized.empty:
            return []

        written: List[Path] = []
        by_date = normalized.groupby(normalized.index.strftime("%Y-%m-%d"))
        for date_token, chunk in by_date:
            part_dir = self._partition_dir(
                channel=channel,
                venue=venue,
                symbol=symbol,
                date_token=str(date_token),
            )
            part_dir.mkdir(parents=True, exist_ok=True)
            part_path = part_dir / self._part_file_name(chunk.index)
            self._write_frame(part_path, chunk)
            written.append(part_path)

            manifest = {
                "channel": str(channel),
                "venue": str(venue),
                "symbol": str(symbol),
                "date": str(date_token),
                "rows": int(len(chunk)),
                "path": str(part_path),
            }
            (part_dir / "manifest.json").write_text(
                json.dumps(manifest, indent=2, sort_keys=True),
                encoding="utf-8",
            )

        return sorted(written)

    def _iter_partition_files(
        self,
        *,
        venue: str,
        symbol: str,
        start: datetime,
        end: datetime,
        channel: str = "ohlcv",
    ) -> Iterable[Path]:
        start_utc = self._utc(start)
        end_utc = self._utc(end)
        if end_utc < start_utc:
            return []

        base = (
            self.root
            / f"channel={self._slug(channel)}"
            / f"venue={self._slug(venue)}"
            / f"symbol={self._slug(symbol)}"
        )
        if not base.exists():
            return []

        day = start_utc.date()
        final = end_utc.date()
        out: List[Path] = []
        while day <= final:
            date_token = day.strftime("%Y-%m-%d")
            part_dir = base / f"date={date_token}"
            if part_dir.exists():
                out.extend(sorted(part_dir.glob("part-*")))
            day = (
                datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=1)
            ).date()
        return out

    def load_ohlcv_range(
        self,
        *,
        venue: str,
        symbol: str,
        start: datetime,
        end: datetime,
        channel: str = "ohlcv",
    ) -> pd.DataFrame:
        parts = list(
            self._iter_partition_files(
                venue=venue,
                symbol=symbol,
                start=start,
                end=end,
                channel=channel,
            )
        )
        if not parts:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

        frames = [self._read_frame(path) for path in parts]
        merged = pd.concat(frames, axis=0).sort_index()
        merged = merged[~merged.index.duplicated(keep="first")]

        start_utc = self._utc(start)
        end_utc = self._utc(end)
        return merged[(merged.index >= start_utc) & (merged.index <= end_utc)]

    def replay_ohlcv(
        self,
        *,
        venue: str,
        symbol: str,
        start: datetime,
        end: datetime,
        channel: str = "ohlcv",
    ) -> Generator[Dict[str, Any], None, None]:
        frame = self.load_ohlcv_range(
            venue=venue,
            symbol=symbol,
            start=start,
            end=end,
            channel=channel,
        )
        seq = 0
        for ts, row in frame.iterrows():
            yield {
                "sequence": seq,
                "timestamp": pd.Timestamp(ts).to_pydatetime().isoformat(),
                "venue": str(venue),
                "symbol": str(symbol),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            }
            seq += 1

    @staticmethod
    def quality_summary(frame: pd.DataFrame, *, interval_seconds: int) -> DataLakeQualitySummary:
        normalized = MarketDataLake._normalize_index(frame)
        if normalized.empty:
            return DataLakeQualitySummary(
                rows=0,
                duplicates=0,
                missing_intervals=0,
                completeness=0.0,
                monotonic=True,
            )

        idx = pd.DatetimeIndex(normalized.index)
        duplicates = int(idx.duplicated().sum())
        monotonic = bool(idx.is_monotonic_increasing)

        step_ms = max(int(interval_seconds), 1) * 1000
        diffs = idx.to_series().diff().dropna().dt.total_seconds() * 1000.0
        missing = 0
        for diff in diffs:
            if diff > step_ms:
                missing += max(int(round(diff / step_ms)) - 1, 0)

        observed = len(idx)
        expected = observed + missing
        completeness = float(observed / expected) if expected > 0 else 0.0
        return DataLakeQualitySummary(
            rows=int(observed),
            duplicates=int(duplicates),
            missing_intervals=int(missing),
            completeness=float(completeness),
            monotonic=monotonic,
        )

    @staticmethod
    def enforce_quality_gate(
        *,
        summary: DataLakeQualitySummary,
        gate: Optional[DataLakeQualityGate] = None,
    ) -> Dict[str, Any]:
        cfg = gate or DataLakeQualityGate()
        checks = {
            "completeness": float(summary.completeness) >= float(cfg.min_completeness),
            "missing_intervals": int(summary.missing_intervals) <= int(cfg.max_missing_intervals),
            "monotonic": (not bool(cfg.require_monotonic)) or bool(summary.monotonic),
        }
        passed = all(checks.values())
        payload = {
            "passed": passed,
            "checks": checks,
            "summary": asdict(summary),
            "gate": asdict(cfg),
        }
        if not passed:
            raise RuntimeError(f"Data quality gate failed: {payload}")
        return payload
