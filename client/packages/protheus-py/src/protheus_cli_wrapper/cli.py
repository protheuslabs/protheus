from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional


def _candidate_repo_roots() -> List[Path]:
    roots: List[Path] = []
    env_root = os.environ.get("PROTHEUS_REPO_ROOT")
    if env_root:
        roots.append(Path(env_root).expanduser().resolve())

    cwd = Path.cwd().resolve()
    roots.append(cwd)
    roots.extend(cwd.parents)
    return roots


def _find_repo_root() -> Optional[Path]:
    for root in _candidate_repo_roots():
        manifest = root / "crates" / "ops" / "Cargo.toml"
        if manifest.exists():
            return root
    return None


def _build_commands(repo_root: Optional[Path]) -> List[List[str]]:
    commands: List[List[str]] = []

    env_bin = os.environ.get("PROTHEUS_OPS_BIN", "").strip()
    if env_bin:
        commands.append(shlex.split(env_bin))

    path_bin = shutil.which("protheus-ops")
    if path_bin:
        commands.append([path_bin])

    if repo_root is not None:
        release_bin = repo_root / "target" / "release" / "protheus-ops"
        debug_bin = repo_root / "target" / "debug" / "protheus-ops"
        for local_bin in (release_bin, debug_bin):
            if local_bin.exists():
                commands.append([str(local_bin)])

        cargo_bin = shutil.which("cargo")
        manifest = repo_root / "crates" / "ops" / "Cargo.toml"
        if cargo_bin and manifest.exists():
            commands.append(
                [
                    cargo_bin,
                    "run",
                    "--quiet",
                    "--manifest-path",
                    str(manifest),
                    "--bin",
                    "protheus-ops",
                    "--",
                ]
            )

    return commands


def _run_first_available(args: List[str]) -> int:
    repo_root = _find_repo_root()
    commands = _build_commands(repo_root)
    attempted: List[str] = []

    for base in commands:
        command = base + args
        attempted.append(" ".join(shlex.quote(part) for part in base))
        try:
            result = subprocess.run(command, check=False)
            return int(result.returncode)
        except FileNotFoundError:
            continue

    lines = [
        "protheus-cli-wrapper: could not locate a runnable protheus-ops binary.",
        "Tried:",
    ]
    lines.extend(f"  - {entry}" for entry in attempted if entry)
    lines.append(
        "Set PROTHEUS_OPS_BIN, install protheus-ops on PATH, or run from a repo containing core/layer0/ops/Cargo.toml."
    )
    sys.stderr.write("\n".join(lines) + "\n")
    return 127


def main(argv: Optional[List[str]] = None) -> int:
    args = list(argv) if argv is not None else sys.argv[1:]
    return _run_first_available(args)
