"""CLI helper tests for scripts/run_exchange_certification.py."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_exchange_certification.py"
SPEC = importlib.util.spec_from_file_location("run_exchange_certification", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parser_accepts_fail_checks_and_thresholds():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--venues",
            "binance,coinbase",
            "--fail-checks",
            "auth,reconnect",
            "--timeout-checks",
            "submit_order",
            "--samples-per-check",
            "3",
            "--max-auth-latency-ms",
            "1000",
            "--max-reject-rate",
            "0.1",
            "--output",
            "data/reports/cert.json",
        ]
    )
    assert args.venues == "binance,coinbase"
    assert args.fail_checks == "auth,reconnect"
    assert args.timeout_checks == "submit_order"
    assert args.samples_per_check == 3
    assert args.max_auth_latency_ms == 1000
    assert args.max_reject_rate == 0.1
    assert args.output == "data/reports/cert.json"
