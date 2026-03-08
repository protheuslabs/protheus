"""Versioned data-lake normalization and manifest writing."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

SCHEMA_VERSION = "1.0.0"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_row(row: Dict[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def normalize_trade_row(venue: str, symbol: str, row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "type": "trade",
        "venue": str(venue),
        "symbol": str(symbol),
        "timestamp": str(row.get("timestamp") or _utc_now_iso()),
        "price": float(row.get("price", 0.0)),
        "qty": float(row.get("qty", row.get("quantity", 0.0))),
        "side": str(row.get("side", "unknown")).lower(),
        "trade_id": str(row.get("trade_id", row.get("id", ""))),
    }


def normalize_l2_row(venue: str, symbol: str, row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "type": "l2",
        "venue": str(venue),
        "symbol": str(symbol),
        "timestamp": str(row.get("timestamp") or _utc_now_iso()),
        "bids": list(row.get("bids", [])),
        "asks": list(row.get("asks", [])),
        "depth_levels": int(row.get("depth_levels", 0) or 0),
    }


def normalize_funding_row(venue: str, symbol: str, row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "type": "funding",
        "venue": str(venue),
        "symbol": str(symbol),
        "timestamp": str(row.get("timestamp") or _utc_now_iso()),
        "funding_rate": float(row.get("funding_rate", 0.0)),
        "interval_hours": float(row.get("interval_hours", 8.0)),
    }


@dataclass(frozen=True)
class DataLakeManifest:
    dataset: str
    schema_version: str
    created_at: str
    rows_written: int
    row_hashes: List[str]
    partitions: List[str]
    files: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def write_dataset_rows(
    *,
    root: str,
    dataset: str,
    rows: Iterable[Dict[str, Any]],
    partition_date: str,
) -> DataLakeManifest:
    base = Path(root) / str(dataset) / f"schema_v{SCHEMA_VERSION}" / f"date={partition_date}"
    base.mkdir(parents=True, exist_ok=True)
    rows_list = [dict(row) for row in rows]
    path = base / f"part-{datetime.now(timezone.utc).strftime('%H%M%S%f')}.jsonl"

    row_hashes: List[str] = []
    with path.open("w", encoding="utf-8") as handle:
        for row in rows_list:
            token = _hash_row(row)
            row_hashes.append(token)
            handle.write(json.dumps(row, sort_keys=True) + "\n")

    manifest = DataLakeManifest(
        dataset=str(dataset),
        schema_version=SCHEMA_VERSION,
        created_at=_utc_now_iso(),
        rows_written=len(rows_list),
        row_hashes=row_hashes,
        partitions=[str(partition_date)],
        files=[str(path)],
    )
    manifest_path = Path(root) / str(dataset) / "manifest.jsonl"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(manifest.to_dict(), sort_keys=True) + "\n")
    return manifest
