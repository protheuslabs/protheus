"""Attribution event logging for launch and conversion tracking."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class AttributionEvent:
    event: str
    source: str
    timestamp: str
    metadata: Dict[str, Any]


def make_event(
    *,
    event: str,
    source: str,
    metadata: Optional[Dict[str, Any]] = None,
    timestamp: Optional[str] = None,
) -> AttributionEvent:
    return AttributionEvent(
        event=str(event),
        source=str(source),
        timestamp=str(timestamp) if timestamp else _utc_now_iso(),
        metadata=dict(metadata or {}),
    )


def log_event(
    *,
    event: str,
    source: str,
    metadata: Optional[Dict[str, Any]] = None,
    log_path: str = "data/analytics/attribution_events.jsonl",
    timestamp: Optional[str] = None,
) -> Path:
    row = make_event(
        event=event,
        source=source,
        metadata=metadata,
        timestamp=timestamp,
    )
    path = Path(log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "event": row.event,
        "source": row.source,
        "timestamp": row.timestamp,
        "metadata": row.metadata,
    }
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\n")
    return path
