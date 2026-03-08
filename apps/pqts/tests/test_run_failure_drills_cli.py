"""CLI helper tests for scripts/run_failure_drills.py."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_failure_drills.py"
SPEC = importlib.util.spec_from_file_location("run_failure_drills", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_config_and_out_dir():
    parser = MODULE.build_parser()
    args = parser.parse_args(["--config", "config/paper.yaml", "--out-dir", "tmp/reports"])
    assert args.config == "config/paper.yaml"
    assert args.out_dir == "tmp/reports"


def test_script_help_runs_from_subprocess():
    result = subprocess.run(
        [sys.executable, str(MODULE_PATH), "--help"],
        cwd=str(ROOT),
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
