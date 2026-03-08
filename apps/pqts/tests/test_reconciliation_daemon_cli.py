"""Tests for scripts/run_reconciliation_daemon.py helpers."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_reconciliation_daemon.py"
SPEC = importlib.util.spec_from_file_location("run_reconciliation_daemon", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parse_aliases_reads_colon_pairs():
    parsed = MODULE._parse_aliases("BTCUSDT:BTC-USD, ETHUSDT:ETH-USD,invalid")
    assert parsed == {"BTCUSDT": "BTC-USD", "ETHUSDT": "ETH-USD"}


def test_parser_accepts_halt_flags():
    parser = MODULE.build_parser()
    args = parser.parse_args(
        [
            "--halt-on-mismatch",
            "--auto-resume",
            "--auto-heal",
            "--resume-consecutive-clean-cycles",
            "4",
            "--resume-cooldown-seconds",
            "30",
            "--auto-heal-retry-attempts",
            "3",
            "--auto-heal-stale-order-seconds",
            "90",
            "--auto-heal-max-cancel-attempts",
            "10",
            "--cycles",
            "2",
            "--risk-profile",
            "professional",
        ]
    )

    assert args.halt_on_mismatch is True
    assert args.auto_resume is True
    assert args.auto_heal is True
    assert args.resume_consecutive_clean_cycles == 4
    assert args.resume_cooldown_seconds == 30.0
    assert args.auto_heal_retry_attempts == 3
    assert args.auto_heal_stale_order_seconds == 90.0
    assert args.auto_heal_max_cancel_attempts == 10
    assert args.cycles == 2
    assert args.risk_profile == "professional"
