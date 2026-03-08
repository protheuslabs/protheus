"""Data retention and readiness helpers for historical/live data stores."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


@dataclass(frozen=True)
class DataRetentionPolicy:
    max_age_days: int = 365
    max_total_files: int = 10000
    include_suffixes: tuple[str, ...] = (".csv", ".parquet", ".jsonl")


@dataclass(frozen=True)
class RetentionEnforcementResult:
    scanned: int
    removed: int
    kept: int
    bytes_removed: int
    removed_files: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "scanned": int(self.scanned),
            "removed": int(self.removed),
            "kept": int(self.kept),
            "bytes_removed": int(self.bytes_removed),
            "removed_files": list(self.removed_files),
        }


def _collect_files(root: Path, suffixes: Iterable[str]) -> List[Path]:
    allowed = {str(token).lower() for token in suffixes}
    out: List[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if allowed and path.suffix.lower() not in allowed:
            continue
        out.append(path)
    return out


def enforce_data_retention(
    *,
    root_path: str,
    policy: Optional[DataRetentionPolicy] = None,
    now: Optional[datetime] = None,
) -> RetentionEnforcementResult:
    cfg = policy or DataRetentionPolicy()
    root = Path(root_path)
    if not root.exists():
        return RetentionEnforcementResult(
            scanned=0,
            removed=0,
            kept=0,
            bytes_removed=0,
            removed_files=[],
        )

    utc_now = now or datetime.now(timezone.utc)
    cutoff = utc_now - timedelta(days=max(int(cfg.max_age_days), 0))
    files = _collect_files(root, cfg.include_suffixes)

    removed_files: List[str] = []
    bytes_removed = 0

    def _remove(path: Path) -> None:
        nonlocal bytes_removed
        try:
            size = path.stat().st_size
        except Exception:
            size = 0
        try:
            path.unlink()
        except FileNotFoundError:
            return
        removed_files.append(str(path))
        bytes_removed += int(size)

    # Age-based removal first.
    candidates: List[Path] = []
    for path in files:
        modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        if modified_at < cutoff:
            _remove(path)
        else:
            candidates.append(path)

    # Count-based removal next (oldest first).
    max_files = max(int(cfg.max_total_files), 0)
    if len(candidates) > max_files:
        ordered = sorted(candidates, key=lambda p: p.stat().st_mtime)
        for path in ordered[: len(candidates) - max_files]:
            _remove(path)

    kept = max(len(files) - len(removed_files), 0)
    return RetentionEnforcementResult(
        scanned=len(files),
        removed=len(removed_files),
        kept=kept,
        bytes_removed=int(bytes_removed),
        removed_files=removed_files,
    )
