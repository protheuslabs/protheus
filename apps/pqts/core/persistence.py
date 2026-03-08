"""Persistence abstraction: sqlite default, optional postgres support."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class PersistenceRecord:
    timestamp: str
    category: str
    payload: Dict[str, Any]


class EventPersistenceStore:
    """Unified event persistence for sqlite and optional postgres DSN."""

    def __init__(self, dsn: str = "sqlite:///data/analytics/events.db"):
        self.dsn = str(dsn)
        self._sqlite_conn: Optional[sqlite3.Connection] = None
        self._pg_conn = None
        self._mode = "sqlite"
        self._connect()

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _connect(self) -> None:
        if self.dsn.startswith("postgres://") or self.dsn.startswith("postgresql://"):
            try:
                import psycopg  # type: ignore
            except Exception as exc:  # pragma: no cover
                raise RuntimeError("Postgres DSN provided but psycopg is not installed.") from exc
            self._mode = "postgres"
            self._pg_conn = psycopg.connect(self.dsn)
            with self._pg_conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS events (
                        id SERIAL PRIMARY KEY,
                        timestamp TEXT NOT NULL,
                        category TEXT NOT NULL,
                        payload JSONB NOT NULL
                    )
                    """)
            self._pg_conn.commit()
            return

        if self.dsn.startswith("sqlite:///"):
            path = self.dsn[len("sqlite:///") :]
        else:
            path = self.dsn
        db_path = Path(path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._sqlite_conn = sqlite3.connect(str(db_path))
        self._sqlite_conn.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                category TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """)
        self._sqlite_conn.commit()

    def append(
        self, *, category: str, payload: Dict[str, Any], timestamp: Optional[str] = None
    ) -> None:
        ts = str(timestamp or self._utc_now())
        cat = str(category)
        body = dict(payload or {})
        if self._mode == "postgres":  # pragma: no cover
            with self._pg_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO events (timestamp, category, payload) VALUES (%s, %s, %s)",
                    (ts, cat, json.dumps(body)),
                )
            self._pg_conn.commit()
            return

        assert self._sqlite_conn is not None
        self._sqlite_conn.execute(
            "INSERT INTO events (timestamp, category, payload) VALUES (?, ?, ?)",
            (ts, cat, json.dumps(body, sort_keys=True)),
        )
        self._sqlite_conn.commit()

    def read(self, *, category: Optional[str] = None, limit: int = 1000) -> List[PersistenceRecord]:
        limit = max(int(limit), 1)
        rows: List[PersistenceRecord] = []
        if self._mode == "postgres":  # pragma: no cover
            query = "SELECT timestamp, category, payload FROM events"
            params: list[Any] = []
            if category:
                query += " WHERE category = %s"
                params.append(str(category))
            query += " ORDER BY id DESC LIMIT %s"
            params.append(limit)
            with self._pg_conn.cursor() as cur:
                cur.execute(query, params)
                out = cur.fetchall()
            for ts, cat, payload in out:
                body = payload if isinstance(payload, dict) else json.loads(str(payload))
                rows.append(PersistenceRecord(timestamp=str(ts), category=str(cat), payload=body))
            return rows

        assert self._sqlite_conn is not None
        query = "SELECT timestamp, category, payload FROM events"
        params: list[Any] = []
        if category:
            query += " WHERE category = ?"
            params.append(str(category))
        query += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        cur = self._sqlite_conn.execute(query, params)
        for ts, cat, payload in cur.fetchall():
            body = json.loads(str(payload))
            rows.append(PersistenceRecord(timestamp=str(ts), category=str(cat), payload=body))
        return rows
