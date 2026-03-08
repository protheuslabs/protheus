"""Tests for one-command demo helper functions."""

from __future__ import annotations

import importlib.util
import sys
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
MODULE_PATH = ROOT / "demo.py"
SPEC = importlib.util.spec_from_file_location("pqts_demo", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def _args() -> Namespace:
    return Namespace(
        config="config/paper.yaml",
        market="crypto",
        strat="ml-ensemble",
        source="unit_test",
        cycles=50,
        sleep_seconds=0.0,
        notional_usd=150.0,
        readiness_every=10,
        lookback_days=60,
        min_days=30,
        min_fills=200,
        max_p95_slippage_bps=20.0,
        max_mape_pct=35.0,
        risk_profile="conservative",
        out_dir="data/reports",
    )


def test_parse_json_from_output_reads_last_object():
    payload = MODULE._parse_json_from_output('noise\n{"a":1}\n{"b":2}\n')
    assert payload == {"b": 2}


def test_symbols_for_market_extracts_configured_symbols():
    config = {
        "markets": {
            "crypto": {"exchanges": [{"symbols": ["BTCUSDT", "ETHUSDT"]}]},
            "equities": {"brokers": [{"symbols": ["AAPL"]}]},
            "forex": {"brokers": [{"pairs": ["EUR_USD"]}]},
        }
    }
    assert MODULE._symbols_for_market(config, "crypto") == ["BTCUSDT", "ETHUSDT"]
    assert MODULE._symbols_for_market(config, "equities") == ["AAPL"]
    assert MODULE._symbols_for_market(config, "forex") == ["EUR_USD"]


def test_build_campaign_cmd_contains_expected_flags():
    cmd = MODULE._build_campaign_cmd(_args(), ["BTCUSDT", "ETHUSDT"])
    joined = " ".join(cmd)
    assert "run_paper_campaign.py" in joined
    assert "--symbols BTCUSDT,ETHUSDT" in joined
    assert "--cycles 50" in joined
    assert "--notional-usd 150.0" in joined
    assert "--risk-profile conservative" in joined
