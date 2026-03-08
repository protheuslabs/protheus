"""Distributed ops state with in-memory fallback and optional Redis backend."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class DistributedStateConfig:
    redis_url: str = ""
    namespace: str = "pqts"
    ttl_seconds: int = 300


class DistributedOpsState:
    """Shared idempotency/rate-limit state; local dict when Redis unavailable."""

    def __init__(self, config: DistributedStateConfig | None = None):
        self.config = config or DistributedStateConfig()
        self._redis = None
        self._local: Dict[str, tuple[float, str]] = {}
        if self.config.redis_url:
            try:
                import redis  # type: ignore

                self._redis = redis.Redis.from_url(self.config.redis_url, decode_responses=True)
                self._redis.ping()
            except Exception:
                self._redis = None

    def _key(self, key: str) -> str:
        return f"{self.config.namespace}:{str(key)}"

    def put(self, key: str, payload: Dict[str, Any]) -> None:
        namespaced = self._key(key)
        body = json.dumps(dict(payload or {}), sort_keys=True)
        if self._redis is not None:  # pragma: no cover
            self._redis.set(namespaced, body, ex=int(self.config.ttl_seconds))
            return
        expiry = time.time() + float(self.config.ttl_seconds)
        self._local[namespaced] = (expiry, body)

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        namespaced = self._key(key)
        if self._redis is not None:  # pragma: no cover
            raw = self._redis.get(namespaced)
            if raw is None:
                return None
            return json.loads(raw)

        now = time.time()
        row = self._local.get(namespaced)
        if row is None:
            return None
        expiry, body = row
        if now >= float(expiry):
            self._local.pop(namespaced, None)
            return None
        return json.loads(body)

    def seen_recently(self, key: str) -> bool:
        return self.get(key) is not None
