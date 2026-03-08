# Coinbase Pro Adapter
import asyncio
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

import aiohttp

logger = logging.getLogger(__name__)


class CoinbaseAdapter:
    """
    Coinbase Pro / Advanced Trade adapter for crypto trading.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        passphrase: str,
        router_token=None,
        sandbox: bool = True,
        request_timeout_seconds: float = 10.0,
    ):
        self._require_router_token(router_token)
        self._router_token = router_token
        self.api_key = api_key
        self.api_secret = api_secret
        self.passphrase = passphrase
        self.sandbox = sandbox
        self.request_timeout_seconds = float(request_timeout_seconds)
        self.request_timeout = aiohttp.ClientTimeout(total=self.request_timeout_seconds)

        # Base URL
        if sandbox:
            self.base_url = "https://api-public.sandbox.exchange.coinbase.com"
            self.ws_url = "wss://ws-feed-public.sandbox.exchange.coinbase.com"
        else:
            self.base_url = "https://api.exchange.coinbase.com"
            self.ws_url = "wss://ws-feed.exchange.coinbase.com"

        self.session: Optional[aiohttp.ClientSession] = None

        logger.info(f"CoinbaseAdapter initialized: sandbox={sandbox}")

    @staticmethod
    def _require_router_token(router_token) -> None:
        from execution.risk_aware_router import _is_valid_router_token

        if not _is_valid_router_token(router_token):
            raise RuntimeError(
                "CoinbaseAdapter requires a valid _RouterToken issued by RiskAwareRouter."
            )

    def _assert_router_token(self, router_token=None) -> None:
        token = self._router_token if router_token is None else router_token
        self._require_router_token(token)
        if token is not self._router_token:
            raise RuntimeError("RouterToken mismatch for CoinbaseAdapter order path.")

    async def connect(self):
        """Establish connection"""
        self.session = aiohttp.ClientSession()

        try:
            accounts = await self.get_accounts()
            logger.info(f"Coinbase connection successful: {len(accounts)} accounts")
        except Exception as e:
            logger.error(f"Coinbase connection failed: {e}")
            raise

    async def disconnect(self):
        """Close connection"""
        if self.session:
            await self.session.close()
            self.session = None

    def _generate_signature(self, timestamp: str, method: str, path: str, body: str = "") -> tuple:
        """Generate request signature"""
        message = timestamp + method.upper() + path + body
        signature = hmac.new(
            self.api_secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        return signature

    async def _request(
        self, method: str, path: str, params: dict = None, json_data: dict = None
    ) -> dict:
        """Make API request"""
        if not self.session:
            raise RuntimeError("Not connected")

        url = f"{self.base_url}{path}"
        timestamp = str(datetime.now(timezone.utc).timestamp())
        body = json.dumps(json_data) if json_data else ""

        signature = self._generate_signature(timestamp, method, path, body)

        headers = {
            "CB-ACCESS-KEY": self.api_key,
            "CB-ACCESS-SIGN": signature,
            "CB-ACCESS-TIMESTAMP": timestamp,
            "CB-ACCESS-PASSPHRASE": self.passphrase,
            "Content-Type": "application/json",
        }

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
                logger.error(f"Coinbase API error: {data}")
                raise Exception(f"API error: {data}")

            return data

    async def get_accounts(self) -> List[dict]:
        """Get accounts"""
        return await self._request("GET", "/accounts")

    async def get_account(self, account_id: str) -> dict:
        """Get specific account"""
        return await self._request("GET", f"/accounts/{account_id}")

    async def get_products(self) -> List[dict]:
        """Get available trading pairs"""
        return await self._request("GET", "/products")

    async def get_product_ticker(self, product_id: str) -> dict:
        """Get product ticker"""
        return await self._request("GET", f"/products/{product_id}/ticker")

    async def get_candles(
        self, product_id: str, granularity: int = 3600, start: datetime = None, end: datetime = None
    ) -> List[list]:
        """Get historical candles"""
        params = {"granularity": granularity}

        if start:
            params["start"] = start.isoformat()
        if end:
            params["end"] = end.isoformat()

        return await self._request("GET", f"/products/{product_id}/candles", params=params)

    async def place_order(
        self,
        product_id: str,
        side: str,
        order_type: str = "limit",
        size: float = None,
        price: float = None,
        funds: float = None,
        client_order_id: Optional[str] = None,
        router_token=None,
    ) -> dict:
        """Place an order"""
        self._assert_router_token(router_token)

        order_data = {"product_id": product_id, "side": side.lower(), "type": order_type.lower()}

        if order_type.lower() == "market":
            if side.lower() == "buy" and funds:
                order_data["funds"] = str(funds)
            elif size:
                order_data["size"] = str(size)
        else:
            order_data["size"] = str(size)
            order_data["price"] = str(price)
        if client_order_id:
            order_data["client_oid"] = str(client_order_id)

        return await self._request("POST", "/orders", json_data=order_data)

    async def get_orders(self, status: str = "open") -> List[dict]:
        """Get orders"""
        params = {"status": status}
        return await self._request("GET", "/orders", params=params)

    async def cancel_order(self, order_id: str, router_token=None) -> dict:
        """Cancel an order"""
        self._assert_router_token(router_token)
        return await self._request("DELETE", f"/orders/{order_id}")

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
