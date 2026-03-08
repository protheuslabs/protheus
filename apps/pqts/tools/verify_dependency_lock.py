#!/usr/bin/env python3
"""Verify that requirements.lock is fully pinned and hash-protected."""

from __future__ import annotations

from pathlib import Path
import re
import sys
from typing import Iterable


ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "requirements.lock"
IN_PATH = ROOT / "requirements.in"


REQ_LINE = re.compile(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\?$")
HASH_LINE = re.compile(r"^\s*--hash=sha256:[a-f0-9]{64}\s*\\?$")


def _required_top_level(path: Path) -> set[str]:
    required: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "==" not in line:
            continue
        name = line.split("==", 1)[0].strip().lower()
        if name:
            required.add(name)
    return required


def _iter_lock_blocks(lines: Iterable[str]) -> list[tuple[str, int]]:
    """
    Return list of (package_name, hash_count).

    Each requirement block starts with `name==version` and contains one or more
    `--hash=sha256:...` lines.
    """
    blocks: list[tuple[str, int]] = []
    current_name = ""
    current_hashes = 0

    def flush() -> None:
        nonlocal current_name, current_hashes
        if current_name:
            blocks.append((current_name, current_hashes))
        current_name = ""
        current_hashes = 0

    for raw in lines:
        line = raw.rstrip()
        match = REQ_LINE.match(line)
        if match:
            flush()
            current_name = match.group(1).lower()
            current_hashes = 0
            continue
        if HASH_LINE.match(line):
            current_hashes += 1
            continue
        if line.startswith("# via") or line.startswith("    # via"):
            continue
        if not line.strip():
            flush()
    flush()
    return blocks


def main() -> int:
    if not LOCK_PATH.exists():
        print(f"ERROR: missing lock file: {LOCK_PATH}", file=sys.stderr)
        return 2
    if not IN_PATH.exists():
        print(f"ERROR: missing input file: {IN_PATH}", file=sys.stderr)
        return 2

    lock_lines = LOCK_PATH.read_text(encoding="utf-8").splitlines()
    line_count = len(lock_lines)
    if line_count < 200:
        print(
            f"ERROR: requirements.lock looks too small ({line_count} lines); expected a full lock.",
            file=sys.stderr,
        )
        return 1

    required_top_level = _required_top_level(IN_PATH)
    blocks = _iter_lock_blocks(lock_lines)
    if not blocks:
        print("ERROR: no pinned requirement blocks found in requirements.lock.", file=sys.stderr)
        return 1

    lock_names = {name for name, _ in blocks}
    missing = sorted(required_top_level.difference(lock_names))
    if missing:
        print(
            f"ERROR: top-level requirements missing from lock: {missing}",
            file=sys.stderr,
        )
        return 1

    no_hash = sorted(name for name, hashes in blocks if hashes == 0 and name != "setuptools")
    if no_hash:
        print(
            f"ERROR: lock entries missing hashes: {no_hash[:20]}{'...' if len(no_hash) > 20 else ''}",
            file=sys.stderr,
        )
        return 1

    print(
        "PASS: dependency lock verification succeeded "
        f"(lines={line_count}, blocks={len(blocks)}, top_level={len(required_top_level)})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
