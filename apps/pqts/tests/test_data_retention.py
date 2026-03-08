"""Tests for data retention enforcement."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.data_retention import DataRetentionPolicy, enforce_data_retention


def _touch_with_mtime(path: Path, *, dt: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")
    ts = dt.timestamp()
    os.utime(path, (ts, ts))


def test_enforce_data_retention_removes_old_files(tmp_path):
    now = datetime(2026, 3, 4, tzinfo=timezone.utc)
    old_file = tmp_path / "data" / "old.csv"
    new_file = tmp_path / "data" / "new.csv"
    _touch_with_mtime(old_file, dt=now - timedelta(days=90))
    _touch_with_mtime(new_file, dt=now - timedelta(days=5))

    result = enforce_data_retention(
        root_path=str(tmp_path / "data"),
        policy=DataRetentionPolicy(max_age_days=30, max_total_files=10),
        now=now,
    )

    assert result.removed == 1
    assert old_file.exists() is False
    assert new_file.exists() is True


def test_enforce_data_retention_removes_oldest_when_over_file_cap(tmp_path):
    now = datetime(2026, 3, 4, tzinfo=timezone.utc)
    base = tmp_path / "data"
    files = [base / f"f{i}.csv" for i in range(5)]
    for idx, path in enumerate(files):
        _touch_with_mtime(path, dt=now - timedelta(days=idx))

    result = enforce_data_retention(
        root_path=str(base),
        policy=DataRetentionPolicy(max_age_days=365, max_total_files=2),
        now=now,
    )

    assert result.removed == 3
    assert result.kept == 2
