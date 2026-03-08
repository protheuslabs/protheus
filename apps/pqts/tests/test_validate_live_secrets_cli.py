"""CLI helper tests for scripts/validate_live_secrets.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "validate_live_secrets.py"
SPEC = importlib.util.spec_from_file_location("validate_live_secrets", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_config_and_strict():
    parser = MODULE.build_parser()
    args = parser.parse_args(["--config", "config/live_canary.yaml", "--strict"])
    assert args.config == "config/live_canary.yaml"
    assert args.strict is True
