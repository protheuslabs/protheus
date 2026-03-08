"""Deterministic tests for adapter idempotency key propagation and cancel token gates."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

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


def test_binance_place_order_propagates_client_order_id(monkeypatch):
    adapter = BinanceAdapter("k", "s", router_token=_router_token())
    captured: Dict[str, Any] = {}

    async def fake_request(method: str, endpoint: str, params=None, signed: bool = False):
        captured["params"] = dict(params or {})
        captured["signed"] = bool(signed)
        return {"ok": True}

    monkeypatch.setattr(adapter, "_request", fake_request)
    result = asyncio.run(
        adapter.place_order(
            "BTCUSDT",
            "buy",
            "limit",
            0.01,
            price=50000.0,
            client_order_id="cid-binance-1",
        )
    )

    assert result["ok"] is True
    assert captured["params"]["newClientOrderId"] == "cid-binance-1"


def test_coinbase_place_order_propagates_client_order_id(monkeypatch):
    adapter = CoinbaseAdapter("k", "s", "p", router_token=_router_token())
    captured: Dict[str, Any] = {}

    async def fake_request(method: str, path: str, params=None, json_data=None):
        captured["json_data"] = dict(json_data or {})
        return {"ok": True}

    monkeypatch.setattr(adapter, "_request", fake_request)
    result = asyncio.run(
        adapter.place_order(
            "BTC-USD",
            "buy",
            order_type="limit",
            size=0.01,
            price=50000.0,
            client_order_id="cid-coinbase-1",
        )
    )

    assert result["ok"] is True
    assert captured["json_data"]["client_oid"] == "cid-coinbase-1"


def test_alpaca_place_order_propagates_client_order_id(monkeypatch):
    adapter = AlpacaAdapter("k", "s", router_token=_router_token())
    captured: Dict[str, Any] = {}

    async def fake_request(
        method: str, endpoint: str, base: str = "trading", params=None, json_data=None
    ):
        captured["json_data"] = dict(json_data or {})
        return {"ok": True}

    monkeypatch.setattr(adapter, "_request", fake_request)
    result = asyncio.run(
        adapter.place_order(
            "AAPL",
            1.0,
            "buy",
            order_type="limit",
            limit_price=190.0,
            client_order_id="cid-alpaca-1",
        )
    )

    assert result["ok"] is True
    assert captured["json_data"]["client_order_id"] == "cid-alpaca-1"


def test_oanda_place_order_propagates_client_order_id(monkeypatch):
    adapter = OandaAdapter("k", "acct", router_token=_router_token())
    captured: Dict[str, Any] = {}

    async def fake_request(method: str, endpoint: str, params=None, json_data=None):
        captured["json_data"] = dict(json_data or {})
        return {"ok": True}

    monkeypatch.setattr(adapter, "_request", fake_request)
    result = asyncio.run(
        adapter.place_order(
            "EUR_USD",
            1000.0,
            order_type="MARKET",
            client_order_id="cid-oanda-1",
        )
    )

    assert result["ok"] is True
    assert captured["json_data"]["order"]["clientExtensions"]["id"] == "cid-oanda-1"


def test_adapter_cancel_paths_require_valid_router_token(monkeypatch):
    token = _router_token()
    binance = BinanceAdapter("k", "s", router_token=token)
    coinbase = CoinbaseAdapter("k", "s", "p", router_token=token)
    alpaca = AlpacaAdapter("k", "s", router_token=token)
    oanda = OandaAdapter("k", "acct", router_token=token)

    async def fake_request(*_args, **_kwargs):
        return {"ok": True}

    for adapter in (binance, coinbase, alpaca, oanda):
        monkeypatch.setattr(adapter, "_request", fake_request)

    with pytest.raises(RuntimeError):
        asyncio.run(binance.cancel_order("BTCUSDT", 123, router_token=object()))
    with pytest.raises(RuntimeError):
        asyncio.run(coinbase.cancel_order("oid", router_token=object()))
    with pytest.raises(RuntimeError):
        asyncio.run(alpaca.cancel_order("oid", router_token=object()))
    with pytest.raises(RuntimeError):
        asyncio.run(oanda.close_trade("tid", router_token=object()))

    assert asyncio.run(binance.cancel_order("BTCUSDT", 123))["ok"] is True
    assert asyncio.run(coinbase.cancel_order("oid"))["ok"] is True
    assert asyncio.run(alpaca.cancel_order("oid")) is None
    assert asyncio.run(oanda.close_trade("tid"))["ok"] is True
