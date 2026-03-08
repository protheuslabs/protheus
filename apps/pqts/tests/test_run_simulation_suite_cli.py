"""CLI helper tests for scripts/run_simulation_suite.py."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
MODULE_PATH = ROOT / "scripts" / "run_simulation_suite.py"
SPEC = importlib.util.spec_from_file_location("run_simulation_suite", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parse_csv_trims_and_filters_empty_tokens():
    assert MODULE._parse_csv("crypto, forex , ,equities") == ["crypto", "forex", "equities"]


def test_parser_accepts_expected_flags():
    parser = MODULE.build_arg_parser()
    args = parser.parse_args(
        [
            "--markets",
            "crypto,forex",
            "--strategies",
            "market_making,funding_arbitrage",
            "--cycles-per-scenario",
            "40",
            "--symbols-per-market",
            "1",
            "--risk-profile",
            "conservative",
            "--switch",
            "market_data_resilience=off",
        ]
    )

    assert args.markets == "crypto,forex"
    assert args.strategies == "market_making,funding_arbitrage"
    assert args.cycles_per_scenario == 40
    assert args.symbols_per_market == 1
    assert args.risk_profile == "conservative"
    assert args.switches == ["market_data_resilience=off"]
