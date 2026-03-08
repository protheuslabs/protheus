# Alpaca Market Adapter
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import aiohttp

logger = logging.getLogger(__name__)


class AlpacaAdapter:
    """
    Alpaca Markets adapter for equity trading.
    Supports both paper and live trading.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        router_token=None,
        paper: bool = True,
        request_timeout_seconds: float = 10.0,
    ):
        self._require_router_token(router_token)
        self._router_token = router_token
        self.api_key = api_key
        self.api_secret = api_secret
        self.paper = paper
        self.request_timeout_seconds = float(request_timeout_seconds)
        self.request_timeout = aiohttp.ClientTimeout(total=self.request_timeout_seconds)

        # Base URLs
        if paper:
            self.base_url = "https://paper-api.alpaca.markets"
            self.data_url = "https://data.alpaca.markets"
            self.order_ws_url = "wss://paper-api.alpaca.markets/stream"
        else:
            self.base_url = "https://api.alpaca.markets"
            self.data_url = "https://data.alpaca.markets"
            self.order_ws_url = "wss://api.alpaca.markets/stream"
        self.market_ws_url = "wss://stream.data.alpaca.markets/v2/iex"

        self.session: Optional[aiohttp.ClientSession] = None

        logger.info(f"AlpacaAdapter initialized: paper={paper}")

    @staticmethod
    def _require_router_token(router_token) -> None:
        from execution.risk_aware_router import _is_valid_router_token

        if not _is_valid_router_token(router_token):
            raise RuntimeError(
                "AlpacaAdapter requires a valid _RouterToken issued by RiskAwareRouter."
            )

    def _assert_router_token(self, router_token=None) -> None:
        token = self._router_token if router_token is None else router_token
        self._require_router_token(token)
        if token is not self._router_token:
            raise RuntimeError("RouterToken mismatch for AlpacaAdapter order path.")

    async def connect(self):
        """Establish connection"""
        self.session = aiohttp.ClientSession()

        # Test connection
        try:
            account = await self.get_account()
            logger.info(f"Alpaca connection successful: {account['status']}")
        except Exception as e:
            logger.error(f"Alpaca connection failed: {e}")
            raise

    async def disconnect(self):
        """Close connection"""
        if self.session:
            await self.session.close()
            self.session = None

    async def _request(
        self,
        method: str,
        endpoint: str,
        base: str = "trading",
        params: dict = None,
        json_data: dict = None,
    ) -> dict:
        """Make API request"""
        if not self.session:
            raise RuntimeError("Not connected")

        url = f"{self.base_url if base == 'trading' else self.data_url}{endpoint}"
        headers = {"APCA-API-KEY-ID": self.api_key, "APCA-API-SECRET-KEY": self.api_secret}

        async with self.session.request(
            method,
            url,
            headers=headers,
            params=params,
            json=json_data,
            timeout=self.request_timeout,
        ) as response:
            data = await response.json()

            if response.status not in [200, 201]:
                logger.error(f"Alpaca API error: {data}")
                raise Exception(f"API error: {data}")

            return data

    async def get_account(self) -> dict:
        """Get account information"""
        return await self._request("GET", "/v2/account")

    async def get_positions(self) -> List[dict]:
        """Get open positions"""
        return await self._request("GET", "/v2/positions")

    async def get_bars(
        self,
        symbol: str,
        timeframe: str = "1Hour",
        start: datetime = None,
        end: datetime = None,
        limit: int = 100,
    ) -> List[dict]:
        """Get historical price bars"""
        params = {"symbols": symbol, "timeframe": timeframe, "limit": limit}

        if start:
            params["start"] = start.isoformat()
        if end:
            params["end"] = end.isoformat()

        response = await self._request("GET", "/v2/stocks/bars", base="data", params=params)
        return response.get(symbol, [])

    async def get_latest_quote(self, symbol: str) -> dict:
        """Get latest quote"""
        response = await self._request("GET", f"/v2/stocks/{symbol}/quotes/latest", base="data")
        return response.get("quote", {})

    async def place_order(
        self,
        symbol: str,
        qty: float,
        side: str,
        order_type: str = "market",
        limit_price: float = None,
        stop_price: float = None,
        client_order_id: Optional[str] = None,
        router_token=None,
    ) -> dict:
        """Place an order"""
        self._assert_router_token(router_token)

        order_data = {
            "symbol": symbol,
            "qty": str(qty),
            "side": side.lower(),
            "type": order_type.lower(),
            "time_in_force": "day",
        }

        if limit_price:
            order_data["limit_price"] = str(limit_price)
        if stop_price:
            order_data["stop_price"] = str(stop_price)
        if client_order_id:
            order_data["client_order_id"] = str(client_order_id)

        return await self._request("POST", "/v2/orders", json_data=order_data)

    async def get_orders(self, status: str = "open") -> List[dict]:
        """Get orders"""
        params = {"status": status}
        return await self._request("GET", "/v2/orders", params=params)

    async def cancel_order(self, order_id: str, router_token=None) -> None:
        """Cancel an order"""
        self._assert_router_token(router_token)
        await self._request("DELETE", f"/v2/orders/{order_id}")

    def stream_descriptors(self) -> Dict[str, Dict[str, str | float]]:
        """Canonical market/order/fill stream endpoints for parity monitoring."""
        from execution.stream_contracts import build_stream_registry

        return build_stream_registry(
            market_url=str(self.market_ws_url),
            order_url=str(self.order_ws_url),
            fill_url=str(self.order_ws_url),
            transport="websocket",
            heartbeat_seconds=15.0,
        )
