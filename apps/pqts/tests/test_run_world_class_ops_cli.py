"""CLI helper tests for scripts/run_world_class_ops.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_world_class_ops.py"
SPEC = importlib.util.spec_from_file_location("run_world_class_ops", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_quick_and_config():
    parser = MODULE.build_parser()
    args = parser.parse_args(["--config", "config/paper.yaml", "--quick"])
    assert args.config == "config/paper.yaml"
    assert args.quick is True
