"""Deterministic websocket-ingestion orchestrator for market/order/fill streams."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

import aiohttp
from aiohttp import WSMsgType

from execution.live_ops_controls import WebSocketConnectionManager
from execution.risk_aware_router import RiskAwareRouter
from research.data_lake_pipeline import (
    normalize_funding_row,
    normalize_l2_row,
    normalize_trade_row,
    write_dataset_rows,
)


@dataclass(frozen=True)
class StreamIngestionEvent:
    event_id: str
    timestamp: str
    venue: str
    channel: str
    url: str
    payload: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class StreamIngestionStore:
    """Append-only JSONL event sink for websocket-ingestion payloads."""

    def __init__(
        self,
        events_path: str = "data/analytics/ws_ingestion_events.jsonl",
        data_lake_root: str = "",
    ):
        self.events_path = Path(events_path)
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        self.data_lake_root = str(data_lake_root or "").strip()

    def append_many(self, events: List[StreamIngestionEvent]) -> None:
        if not events:
            return
        with self.events_path.open("a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event.to_dict(), sort_keys=True) + "\n")
        self._write_data_lake(events)

    def _write_data_lake(self, events: List[StreamIngestionEvent]) -> None:
        if not self.data_lake_root:
            return
        trade_rows: List[Dict[str, Any]] = []
        l2_rows: List[Dict[str, Any]] = []
        funding_rows: List[Dict[str, Any]] = []
        for event in events:
            payload = dict(event.payload or {})
            symbol = str(
                payload.get("symbol")
                or payload.get("product_id")
                or payload.get("instrument")
                or "unknown"
            )
            if event.channel in {"fill", "order"}:
                trade_rows.append(
                    normalize_trade_row(
                        venue=event.venue,
                        symbol=symbol,
                        row={
                            "timestamp": payload.get("timestamp", event.timestamp),
                            "price": payload.get("price", payload.get("executed_price", 0.0)),
                            "qty": payload.get(
                                "qty", payload.get("size", payload.get("quantity", 0.0))
                            ),
                            "side": payload.get("side", "unknown"),
                            "trade_id": payload.get(
                                "trade_id", payload.get("order_id", event.event_id)
                            ),
                        },
                    )
                )
            if event.channel == "market":
                l2_rows.append(
                    normalize_l2_row(
                        venue=event.venue,
                        symbol=symbol,
                        row={
                            "timestamp": payload.get("timestamp", event.timestamp),
                            "bids": payload.get("bids", []),
                            "asks": payload.get("asks", []),
                            "depth_levels": payload.get("depth_levels", 0),
                        },
                    )
                )
                if "funding_rate" in payload:
                    funding_rows.append(
                        normalize_funding_row(
                            venue=event.venue,
                            symbol=symbol,
                            row={
                                "timestamp": payload.get("timestamp", event.timestamp),
                                "funding_rate": payload.get("funding_rate", 0.0),
                                "interval_hours": payload.get("interval_hours", 8.0),
                            },
                        )
                    )

        partition_date = (
            events[0].timestamp[:10] if events else datetime.now(timezone.utc).strftime("%Y-%m-%d")
        )
        try:
            if trade_rows:
                write_dataset_rows(
                    root=self.data_lake_root,
                    dataset="stream_trades",
                    rows=trade_rows,
                    partition_date=partition_date,
                )
            if l2_rows:
                write_dataset_rows(
                    root=self.data_lake_root,
                    dataset="stream_l2",
                    rows=l2_rows,
                    partition_date=partition_date,
                )
            if funding_rows:
                write_dataset_rows(
                    root=self.data_lake_root,
                    dataset="stream_funding",
                    rows=funding_rows,
                    partition_date=partition_date,
                )
        except Exception:
            # Ingestion durability takes precedence over lake side-effects.
            return


Fetcher = Callable[[str, str, Dict[str, Any]], Awaitable[List[Dict[str, Any]]]]


class LiveVenueStreamFetcher:
    """Venue-aware stream fetcher for websocket and HTTP-stream transports."""

    def __init__(
        self,
        *,
        router: RiskAwareRouter,
        max_messages: int = 10,
        recv_timeout_seconds: float = 2.0,
        connect_timeout_seconds: float = 10.0,
    ):
        self.router = router
        self.max_messages = max(int(max_messages), 1)
        self.recv_timeout_seconds = float(max(recv_timeout_seconds, 0.1))
        self.connect_timeout_seconds = float(max(connect_timeout_seconds, 0.1))
        self._session: Optional[aiohttp.ClientSession] = None
        self._binance_user_stream: Dict[str, str] = {}

    async def close(self) -> None:
        if self._session is None:
            return
        await self._session.close()
        self._session = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            timeout = aiohttp.ClientTimeout(total=None, sock_connect=self.connect_timeout_seconds)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    def _venue_adapter(self, venue: str) -> Any:
        client = self.router.market_venues.get(str(venue))
        return client.adapter if client is not None else None

    def _symbols(self, venue: str) -> List[str]:
        client = self.router.market_venues.get(str(venue))
        if client is None:
            return []
        return [str(symbol) for symbol in list(client.symbols)]

    @staticmethod
    def _normalize_ws_message(msg: Any) -> List[Dict[str, Any]]:
        if isinstance(msg, dict):
            return [msg]
        if isinstance(msg, list):
            return [row for row in msg if isinstance(row, dict)]
        return [{"raw": msg}]

    @staticmethod
    def _binance_symbol(symbol: str) -> str:
        token = str(symbol).replace("-", "").replace("/", "").replace("_", "")
        return token.lower()

    async def _binance_listen_key(self, venue: str) -> str:
        if venue in self._binance_user_stream:
            return self._binance_user_stream[venue]

        adapter = self._venue_adapter(venue)
        if adapter is None or not hasattr(adapter, "_request"):
            return ""

        payload = await adapter._request("POST", "/api/v3/userDataStream", signed=False)
        listen_key = str((payload or {}).get("listenKey", "")).strip()
        if listen_key:
            self._binance_user_stream[venue] = listen_key
        return listen_key

    async def _resolve_ws_url(self, venue: str, channel: str, url: str) -> str:
        if str(venue).lower() != "binance":
            return url
        if channel not in {"order", "fill"}:
            return url

        listen_key = await self._binance_listen_key(venue)
        if not listen_key:
            return url
        base = str(url).rstrip("/")
        if base.endswith("/ws"):
            return f"{base}/{listen_key}"
        return base

    def _build_subscriptions(self, venue: str, channel: str) -> List[Dict[str, Any]]:
        venue_token = str(venue).lower()
        symbols = self._symbols(venue)

        if venue_token == "binance":
            if channel == "market":
                streams = [f"{self._binance_symbol(symbol)}@bookTicker" for symbol in symbols]
                if not streams:
                    streams = ["!bookTicker"]
                return [{"method": "SUBSCRIBE", "params": streams, "id": 1}]
            return []

        if venue_token == "coinbase":
            if channel == "market":
                products = [str(symbol) for symbol in symbols if str(symbol)]
                return [
                    {
                        "type": "subscribe",
                        "channels": [{"name": "ticker", "product_ids": products}],
                    }
                ]
            adapter = self._venue_adapter(venue)
            if adapter is None:
                return []

            api_key = str(getattr(adapter, "api_key", "")).strip()
            passphrase = str(getattr(adapter, "passphrase", "")).strip()
            api_secret = str(getattr(adapter, "api_secret", "")).strip()
            if not api_key or not passphrase or not api_secret:
                return []

            timestamp = f"{datetime.now(timezone.utc).timestamp():.6f}"
            signature = ""
            if hasattr(adapter, "_generate_signature"):
                try:
                    signature = str(
                        adapter._generate_signature(timestamp, "GET", "/users/self/verify", "")
                    ).strip()
                except Exception:
                    signature = ""
            if not signature:
                payload = f"{timestamp}GET/users/self/verify"
                signature = hmac.new(
                    api_secret.encode("utf-8"),
                    payload.encode("utf-8"),
                    hashlib.sha256,
                ).hexdigest()

            products = [str(symbol) for symbol in symbols if str(symbol)]
            user_channel: Dict[str, Any] = {"name": "user"}
            if products:
                user_channel["product_ids"] = products
            return [
                {
                    "type": "subscribe",
                    "key": api_key,
                    "passphrase": passphrase,
                    "timestamp": timestamp,
                    "signature": signature,
                    "channels": [user_channel],
                }
            ]

        if venue_token == "alpaca":
            adapter = self._venue_adapter(venue)
            if adapter is None:
                return []

            api_key = str(getattr(adapter, "api_key", "")).strip()
            api_secret = str(getattr(adapter, "api_secret", "")).strip()
            if not api_key or not api_secret:
                return []

            rows: List[Dict[str, Any]] = [
                {"action": "auth", "key": api_key, "secret": api_secret},
            ]
            if channel == "market":
                if symbols:
                    rows.append({"action": "subscribe", "quotes": symbols, "trades": symbols})
            else:
                rows.append({"action": "listen", "data": {"streams": ["trade_updates"]}})
            return rows

        return []

    async def _fetch_websocket(
        self, venue: str, channel: str, descriptor: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        url = str(descriptor.get("url", "")).strip()
        if not url:
            return []

        session = await self._get_session()
        ws_url = await self._resolve_ws_url(venue, channel, url)
        heartbeat = float(descriptor.get("heartbeat_seconds", 15.0))
        subscriptions = self._build_subscriptions(venue, channel)

        rows: List[Dict[str, Any]] = []
        async with session.ws_connect(
            ws_url,
            heartbeat=heartbeat,
            receive_timeout=self.recv_timeout_seconds,
        ) as ws:
            for payload in subscriptions:
                await ws.send_json(payload)

            for _ in range(self.max_messages):
                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=self.recv_timeout_seconds)
                except asyncio.TimeoutError:
                    break

                if msg.type == WSMsgType.TEXT:
                    text = str(msg.data or "").strip()
                    if not text:
                        continue
                    try:
                        decoded = json.loads(text)
                    except json.JSONDecodeError:
                        decoded = {"raw": text}
                    rows.extend(self._normalize_ws_message(decoded))
                elif msg.type == WSMsgType.BINARY:
                    raw = bytes(msg.data or b"")
                    if not raw:
                        continue
                    try:
                        decoded = json.loads(raw.decode("utf-8"))
                    except Exception:
                        decoded = {"raw_bytes": raw.hex()}
                    rows.extend(self._normalize_ws_message(decoded))
                elif msg.type in {
                    WSMsgType.CLOSE,
                    WSMsgType.CLOSED,
                    WSMsgType.CLOSING,
                    WSMsgType.ERROR,
                }:
                    break

        return rows

    async def _fetch_http_stream(
        self, venue: str, channel: str, descriptor: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        url = str(descriptor.get("url", "")).strip()
        if not url:
            return []

        adapter = self._venue_adapter(venue)
        headers: Dict[str, str] = {}
        params: Dict[str, Any] = {}
        if str(venue).lower() == "oanda" and adapter is not None:
            api_key = str(getattr(adapter, "api_key", "")).strip()
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            if channel == "market":
                symbols = self._symbols(venue)
                if symbols:
                    params["instruments"] = ",".join(symbols)

        session = await self._get_session()
        rows: List[Dict[str, Any]] = []
        async with session.get(url, headers=headers, params=params) as resp:
            if resp.status >= 400:
                body = await resp.text()
                raise RuntimeError(f"Stream request failed ({resp.status}): {body[:200]}")

            while len(rows) < self.max_messages:
                try:
                    line = await asyncio.wait_for(
                        resp.content.readline(), timeout=self.recv_timeout_seconds
                    )
                except asyncio.TimeoutError:
                    break
                if not line:
                    break
                token = line.decode("utf-8", errors="ignore").strip()
                if not token:
                    continue
                try:
                    payload = json.loads(token)
                except json.JSONDecodeError:
                    payload = {"raw": token}
                rows.extend(self._normalize_ws_message(payload))
        return rows

    async def __call__(
        self, venue: str, channel: str, descriptor: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        transport = str(descriptor.get("transport", "websocket")).strip().lower()
        if transport == "websocket":
            return await self._fetch_websocket(venue, channel, descriptor)
        if transport in {"http_stream", "httpstream"}:
            return await self._fetch_http_stream(venue, channel, descriptor)
        return []


class WebSocketIngestionService:
    """
    Ingest stream payloads for market/order/fill channels.

    This service focuses on deterministic persistence + socket health behavior;
    transport adapters can be swapped behind the async fetcher callback.
    """

    def __init__(
        self,
        *,
        router: RiskAwareRouter,
        store: Optional[StreamIngestionStore] = None,
        ws_manager: Optional[WebSocketConnectionManager] = None,
        fetcher: Optional[Fetcher] = None,
    ):
        self.router = router
        self.store = store or StreamIngestionStore()
        self.ws_manager = ws_manager or WebSocketConnectionManager()
        self.fetcher = fetcher or self._default_fetcher

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _event_id(*parts: object) -> str:
        payload = "|".join(str(part) for part in parts)
        token = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]
        return f"ws_{token}"

    @staticmethod
    async def _default_fetcher(
        _venue: str,
        _channel: str,
        _descriptor: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        # Default to no-op in deterministic test/paper environments.
        return []

    def _socket_key(self, venue: str, channel: str) -> str:
        return f"{venue}:{channel}"

    def _ensure_registered(self, socket_key: str, url: str) -> None:
        try:
            self.ws_manager.get(socket_key)
        except KeyError:
            self.ws_manager.register(socket_key, str(url))

    async def collect_once(self) -> Dict[str, Any]:
        registry = self.router.get_stream_registry()
        now = self._utc_now_iso()
        events: List[StreamIngestionEvent] = []
        counts = {"market": 0, "order": 0, "fill": 0}
        connected = 0
        disconnected = 0

        for venue, payload in sorted(registry.items()):
            if not isinstance(payload, dict) or not bool(payload.get("available", False)):
                continue
            streams = payload.get("streams", {})
            if not isinstance(streams, dict):
                continue

            for channel in ("market", "order", "fill"):
                descriptor = streams.get(channel, {})
                if not isinstance(descriptor, dict):
                    continue
                url = str(descriptor.get("url", "")).strip()
                if not url:
                    continue

                socket_key = self._socket_key(venue, channel)
                self._ensure_registered(socket_key, url)

                if not self.ws_manager.can_reconnect(socket_key):
                    disconnected += 1
                    continue

                try:
                    rows = await self.fetcher(
                        venue,
                        channel,
                        {
                            "url": url,
                            "transport": str(descriptor.get("transport", "websocket")),
                            "heartbeat_seconds": float(descriptor.get("heartbeat_seconds", 15.0)),
                        },
                    )
                    self.ws_manager.mark_connected(socket_key)
                    connected += 1
                except Exception:
                    self.ws_manager.mark_disconnected(socket_key)
                    disconnected += 1
                    continue

                for idx, row in enumerate(rows):
                    payload_row = row if isinstance(row, dict) else {"raw": row}
                    events.append(
                        StreamIngestionEvent(
                            event_id=self._event_id(now, venue, channel, idx, payload_row),
                            timestamp=now,
                            venue=str(venue),
                            channel=channel,
                            url=url,
                            payload=payload_row,
                        )
                    )
                    counts[channel] += 1

        self.store.append_many(events)
        return {
            "timestamp": now,
            "events_path": str(self.store.events_path),
            "events_written": len(events),
            "market_events": int(counts["market"]),
            "order_events": int(counts["order"]),
            "fill_events": int(counts["fill"]),
            "connected_streams": int(connected),
            "disconnected_streams": int(disconnected),
        }

    async def run_loop(self, *, cycles: int, sleep_seconds: float = 1.0) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for _ in range(max(int(cycles), 0)):
            out.append(await self.collect_once())
            if float(sleep_seconds) > 0:
                await asyncio.sleep(float(sleep_seconds))
        return out
