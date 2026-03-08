"""CLI helper tests for scripts/nightly_live_sandbox_gate.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "nightly_live_sandbox_gate.py"
SPEC = importlib.util.spec_from_file_location("nightly_live_sandbox_gate", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_gate_thresholds():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--cert-report",
            "data/reports/cert.json",
            "--reconciliation-incidents",
            "data/analytics/reconciliation_incidents.jsonl",
            "--max-reject-rate",
            "0.1",
            "--max-timeout-rate",
            "0.05",
            "--max-reconciliation-mismatches",
            "2",
        ]
    )
    assert args.cert_report == "data/reports/cert.json"
    assert args.max_reject_rate == 0.1
    assert args.max_timeout_rate == 0.05
    assert args.max_reconciliation_mismatches == 2
