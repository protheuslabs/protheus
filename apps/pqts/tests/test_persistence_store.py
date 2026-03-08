"""Tests for event persistence store abstraction."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.persistence import EventPersistenceStore


def test_event_persistence_store_sqlite_append_and_read(tmp_path):
    db_path = tmp_path / "events.db"
    store = EventPersistenceStore(f"sqlite:///{db_path}")
    store.append(category="autopilot", payload={"event": "select"})
    store.append(category="execution", payload={"event": "fill"})

    rows = store.read(limit=10)
    assert len(rows) == 2
    assert rows[0].category == "execution"
    assert rows[1].category == "autopilot"

    execution_only = store.read(category="execution", limit=5)
    assert len(execution_only) == 1
    assert execution_only[0].payload["event"] == "fill"
