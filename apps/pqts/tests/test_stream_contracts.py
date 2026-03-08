"""Tests for adapter stream descriptor contracts."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.risk_aware_router import RiskAwareRouter
from markets.crypto.binance_adapter import BinanceAdapter
from markets.crypto.coinbase_adapter import CoinbaseAdapter
from markets.equities.alpaca_adapter import AlpacaAdapter
from markets.forex.oanda_adapter import OandaAdapter
from risk.kill_switches import RiskLimits


def _router_token():
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.15,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
    )
    return router._create_token()


def _assert_stream_payload(payload: dict) -> None:
    assert set(payload.keys()) == {"market", "order", "fill"}
    for key in ("market", "order", "fill"):
        row = payload[key]
        assert row["channel"] == key
        assert isinstance(row["url"], str) and len(row["url"]) > 5
        assert float(row["heartbeat_seconds"]) > 0.0
        assert row["transport"] in {"websocket", "http_stream"}


def test_crypto_adapter_stream_descriptors_are_defined():
    token = _router_token()
    binance = BinanceAdapter("k", "s", router_token=token)
    coinbase = CoinbaseAdapter("k", "s", "p", router_token=token)

    _assert_stream_payload(binance.stream_descriptors())
    _assert_stream_payload(coinbase.stream_descriptors())
    assert binance.stream_descriptors()["market"]["transport"] == "websocket"
    assert coinbase.stream_descriptors()["market"]["transport"] == "websocket"


def test_equities_and_forex_adapter_stream_descriptors_are_defined():
    token = _router_token()
    alpaca = AlpacaAdapter("k", "s", router_token=token)
    oanda = OandaAdapter("k", "acct", router_token=token)

    _assert_stream_payload(alpaca.stream_descriptors())
    _assert_stream_payload(oanda.stream_descriptors())
    assert alpaca.stream_descriptors()["market"]["transport"] == "websocket"
    assert oanda.stream_descriptors()["market"]["transport"] == "http_stream"


def test_router_stream_registry_reports_stub_availability():
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.15,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
    )
    router.configure_market_adapters(
        {
            "crypto": {
                "enabled": True,
                "exchanges": [{"name": "binance", "symbols": ["BTCUSDT"]}],
            },
            "equities": {
                "enabled": False,
                "brokers": [],
            },
            "forex": {
                "enabled": False,
                "brokers": [],
            },
        }
    )

    registry = router.get_stream_registry()
    assert "binance" in registry
    assert registry["binance"]["available"] is False
    assert "adapter_unavailable" in registry["binance"]["reason"]
