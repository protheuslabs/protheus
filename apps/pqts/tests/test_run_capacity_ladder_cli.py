"""CLI helper tests for scripts/run_capacity_ladder.py."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_capacity_ladder.py"
SPEC = importlib.util.spec_from_file_location("run_capacity_ladder", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_notional_ladders():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--train-notionals",
            "1000,2000,3000",
            "--eval-notionals",
            "1000,5000",
            "--strategy-id",
            "probe",
        ]
    )
    assert args.train_notionals == "1000,2000,3000"
    assert args.eval_notionals == "1000,5000"
    assert args.strategy_id == "probe"


def test_script_help_runs_from_subprocess():
    result = subprocess.run(
        [sys.executable, str(MODULE_PATH), "--help"],
        cwd=str(ROOT),
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
