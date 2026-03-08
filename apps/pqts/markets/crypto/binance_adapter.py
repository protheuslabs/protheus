# Binance Market Adapter
import asyncio
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

import aiohttp

logger = logging.getLogger(__name__)


class BinanceAdapter:
    """
    Binance exchange adapter for crypto trading.
    Supports both spot and futures markets.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        router_token=None,
        testnet: bool = True,
        request_timeout_seconds: float = 10.0,
    ):
        self._require_router_token(router_token)
        self._router_token = router_token
        self.api_key = api_key
        self.api_secret = api_secret
        self.testnet = testnet
        self.request_timeout_seconds = float(request_timeout_seconds)
        self.request_timeout = aiohttp.ClientTimeout(total=self.request_timeout_seconds)

        # Base URLs
        if testnet:
            self.base_url = "https://testnet.binance.vision"
            self.ws_url = "wss://testnet.binance.vision/ws"
        else:
            self.base_url = "https://api.binance.com"
            self.ws_url = "wss://stream.binance.com:9443/ws"

        self.session: Optional[aiohttp.ClientSession] = None

        logger.info(f"BinanceAdapter initialized: testnet={testnet}")

    @staticmethod
    def _require_router_token(router_token) -> None:
        from execution.risk_aware_router import _is_valid_router_token

        if not _is_valid_router_token(router_token):
            raise RuntimeError(
                "BinanceAdapter requires a valid _RouterToken issued by RiskAwareRouter."
            )

    def _assert_router_token(self, router_token=None) -> None:
        token = self._router_token if router_token is None else router_token
        self._require_router_token(token)
        if token is not self._router_token:
            raise RuntimeError("RouterToken mismatch for BinanceAdapter order path.")

    async def connect(self):
        """Establish connection"""
        self.session = aiohttp.ClientSession()

        # Test connection
        try:
            await self.get_account_info()
            logger.info("Binance connection successful")
        except Exception as e:
            logger.error(f"Binance connection failed: {e}")
            raise

    async def disconnect(self):
        """Close connection"""
        if self.session:
            await self.session.close()
            self.session = None

    def _generate_signature(self, params: dict) -> str:
        """Generate request signature"""
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        signature = hmac.new(
            self.api_secret.encode("utf-8"), query_string.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return signature

    async def _request(
        self, method: str, endpoint: str, params: dict = None, signed: bool = False
    ) -> dict:
        """Make API request"""
        if not self.session:
            raise RuntimeError("Not connected")

        url = f"{self.base_url}{endpoint}"
        headers = {"X-MBX-APIKEY": self.api_key}

        if signed:
            params = params or {}
            params["timestamp"] = int(datetime.now(timezone.utc).timestamp() * 1000)
            params["signature"] = self._generate_signature(params)

        async with self.session.request(
            method,
            url,
            headers=headers,
            params=params,
            timeout=self.request_timeout,
        ) as response:
            data = await response.json()

            if response.status != 200:
                logger.error(f"Binance API error: {data}")
                raise Exception(f"API error: {data}")

            return data

    async def get_account_info(self) -> dict:
        """Get account information"""
        return await self._request("GET", "/api/v3/account", signed=True)

    async def get_balance(self, asset: str) -> float:
        """Get balance for specific asset"""
        account = await self.get_account_info()
        for balance in account.get("balances", []):
            if balance["asset"] == asset:
                return float(balance["free"])
        return 0.0

    async def get_ticker(self, symbol: str) -> dict:
        """Get 24hr ticker data"""
        return await self._request("GET", "/api/v3/ticker/24hr", {"symbol": symbol})

    async def get_orderbook(self, symbol: str, limit: int = 100) -> dict:
        """Get order book"""
        return await self._request("GET", "/api/v3/depth", {"symbol": symbol, "limit": limit})

    async def get_klines(self, symbol: str, interval: str = "1h", limit: int = 500) -> List[List]:
        """Get candlestick data"""
        params = {"symbol": symbol, "interval": interval, "limit": limit}
        return await self._request("GET", "/api/v3/klines", params)

    async def place_order(
        self,
        symbol: str,
        side: str,
        order_type: str,
        quantity: float,
        price: Optional[float] = None,
        client_order_id: Optional[str] = None,
        router_token=None,
    ) -> dict:
        """Place order"""
        self._assert_router_token(router_token)

        params = {
            "symbol": symbol,
            "side": side.upper(),
            "type": order_type.upper(),
            "quantity": quantity,
        }

        if price and order_type.upper() == "LIMIT":
            params["price"] = price
            params["timeInForce"] = "GTC"
        if client_order_id:
            params["newClientOrderId"] = str(client_order_id)

        return await self._request("POST", "/api/v3/order", params, signed=True)

    async def cancel_order(self, symbol: str, order_id: int, router_token=None) -> dict:
        """Cancel order"""
        self._assert_router_token(router_token)
        params = {"symbol": symbol, "orderId": order_id}
        return await self._request("DELETE", "/api/v3/order", params, signed=True)

    async def get_open_orders(self, symbol: Optional[str] = None) -> List[dict]:
        """Get open orders"""
        params = {}
        if symbol:
            params["symbol"] = symbol
        return await self._request("GET", "/api/v3/openOrders", params, signed=True)

    async def get_exchange_info(self) -> dict:
        """Get exchange information"""
        return await self._request("GET", "/api/v3/exchangeInfo")

    def stream_descriptors(self) -> Dict[str, Dict[str, str | float]]:
        """Canonical market/order/fill stream endpoints for parity monitoring."""
        from execution.stream_contracts import build_stream_registry

        base = str(self.ws_url)
        return build_stream_registry(
            market_url=f"{base}",
            order_url=f"{base}",
            fill_url=f"{base}",
            transport="websocket",
            heartbeat_seconds=15.0,
        )
