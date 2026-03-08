"""CLI helper tests for scripts/security_compliance_report.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "security_compliance_report.py"
SPEC = importlib.util.spec_from_file_location("security_compliance_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_artifacts_and_signing_env():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--config",
            "config/live_canary.yaml",
            "--artifacts",
            "dist/a.tar.gz,dist/b.tar.gz",
            "--signing-key-env",
            "PQTS_SIGN_KEY",
        ]
    )
    assert args.config == "config/live_canary.yaml"
    assert args.artifacts == "dist/a.tar.gz,dist/b.tar.gz"
    assert args.signing_key_env == "PQTS_SIGN_KEY"
