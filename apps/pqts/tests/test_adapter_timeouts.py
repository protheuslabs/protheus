"""Deterministic contract tests for exchange adapter request timeouts."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.risk_aware_router import RiskAwareRouter
from markets.crypto.binance_adapter import BinanceAdapter
from markets.crypto.coinbase_adapter import CoinbaseAdapter
from markets.equities.alpaca_adapter import AlpacaAdapter
from markets.forex.oanda_adapter import OandaAdapter
from risk.kill_switches import RiskLimits


class _FakeResponse:
    def __init__(self, status: int = 200, payload: dict | None = None):
        self.status = status
        self._payload = payload or {"ok": True}

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def json(self):
        return self._payload


class _CaptureSession:
    def __init__(self):
        self.calls: list[tuple[tuple, dict]] = []

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return _FakeResponse()


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


def _assert_timeout(call_kwargs: dict, expected_seconds: float) -> None:
    timeout = call_kwargs.get("timeout")
    assert isinstance(timeout, aiohttp.ClientTimeout)
    assert float(timeout.total) == expected_seconds


def test_binance_requests_use_configured_timeout():
    adapter = BinanceAdapter("k", "s", router_token=_router_token(), request_timeout_seconds=7.5)
    adapter.session = _CaptureSession()

    asyncio.run(adapter.place_order("BTCUSDT", "buy", "market", 0.01))
    assert adapter.session.calls
    _assert_timeout(adapter.session.calls[-1][1], 7.5)


def test_coinbase_requests_use_configured_timeout():
    adapter = CoinbaseAdapter(
        "k",
        "s",
        "p",
        router_token=_router_token(),
        request_timeout_seconds=6.0,
    )
    adapter.session = _CaptureSession()

    asyncio.run(adapter.place_order("BTC-USD", "buy", order_type="market", funds=100.0))
    assert adapter.session.calls
    _assert_timeout(adapter.session.calls[-1][1], 6.0)


def test_alpaca_requests_use_configured_timeout():
    adapter = AlpacaAdapter("k", "s", router_token=_router_token(), request_timeout_seconds=5.0)
    adapter.session = _CaptureSession()

    asyncio.run(adapter.place_order("AAPL", 1.0, "buy"))
    assert adapter.session.calls
    _assert_timeout(adapter.session.calls[-1][1], 5.0)


def test_oanda_requests_use_configured_timeout():
    adapter = OandaAdapter("k", "acct", router_token=_router_token(), request_timeout_seconds=9.0)
    adapter.session = _CaptureSession()

    asyncio.run(adapter.place_order("EUR_USD", 1000.0))
    assert adapter.session.calls
    _assert_timeout(adapter.session.calls[-1][1], 9.0)
