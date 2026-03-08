"""Market-data resilience controls: gap replay + stale-feed failover."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value: Any, *, fallback: datetime) -> datetime:
    token = str(value or "").strip()
    if not token:
        return fallback
    dt = datetime.fromisoformat(token.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


@dataclass(frozen=True)
class MarketDataResiliencePolicy:
    enabled: bool = True
    stale_after_seconds: float = 5.0
    replay_window_seconds: float = 120.0
    backup_venues_by_venue: Dict[str, List[str]] = field(default_factory=dict)
    backup_venues_by_market: Dict[str, List[str]] = field(default_factory=dict)


@dataclass(frozen=True)
class QuoteResolution:
    mode: str
    source_venue: str
    stale: bool
    gap: bool
    replay_age_seconds: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class MarketDataResilienceManager:
    """Resolve quote gaps and stale feeds using deterministic fallback ordering."""

    def __init__(self, policy: MarketDataResiliencePolicy | None = None):
        self.policy = policy or MarketDataResiliencePolicy()
        self._last_good: Dict[Tuple[str, str], Dict[str, Any]] = {}
        self._metrics = {
            "live_quotes": 0,
            "stale_quotes": 0,
            "gap_quotes": 0,
            "failover_quotes": 0,
            "replay_quotes": 0,
        }

    def _is_stale(self, quote: Mapping[str, Any], *, now: datetime) -> bool:
        ts = _parse_ts(quote.get("timestamp"), fallback=now)
        age = (now - ts).total_seconds()
        return age > float(self.policy.stale_after_seconds)

    def _is_usable(self, quote: Optional[Mapping[str, Any]], *, now: datetime) -> bool:
        if quote is None:
            return False
        try:
            price = float(quote.get("price", 0.0) or 0.0)
        except (TypeError, ValueError):
            return False
        if price <= 0:
            return False
        return not self._is_stale(quote, now=now)

    @staticmethod
    def _copy_quote(quote: Mapping[str, Any]) -> Dict[str, Any]:
        out = dict(quote)
        if "order_book" in quote and isinstance(quote.get("order_book"), Mapping):
            out["order_book"] = dict(quote["order_book"])
        return out

    def _record_live(self, *, venue: str, symbol: str, quote: Mapping[str, Any]) -> None:
        self._last_good[(str(venue), str(symbol))] = self._copy_quote(quote)

    def _candidate_backups(self, *, venue: str, market: str) -> List[str]:
        candidates: List[str] = []
        for key in (
            str(venue),
            str(venue).lower(),
        ):
            for backup in self.policy.backup_venues_by_venue.get(key, []):
                if backup not in candidates:
                    candidates.append(str(backup))
        for key in (
            str(market),
            str(market).lower(),
        ):
            for backup in self.policy.backup_venues_by_market.get(key, []):
                if backup not in candidates:
                    candidates.append(str(backup))
        return [name for name in candidates if name != str(venue)]

    def resolve(
        self,
        *,
        venue: str,
        symbol: str,
        market: str,
        live_quote: Optional[Dict[str, Any]],
        raw_quotes: Mapping[Tuple[str, str], Optional[Dict[str, Any]]],
        now: Optional[datetime] = None,
    ) -> Tuple[Optional[Dict[str, Any]], QuoteResolution]:
        now_dt = now or _utc_now()
        if not bool(self.policy.enabled):
            if live_quote is None:
                return None, QuoteResolution(
                    mode="disabled_no_quote",
                    source_venue=str(venue),
                    stale=False,
                    gap=True,
                    replay_age_seconds=0.0,
                )
            self._record_live(venue=venue, symbol=symbol, quote=live_quote)
            return self._copy_quote(live_quote), QuoteResolution(
                mode="disabled_live",
                source_venue=str(venue),
                stale=False,
                gap=False,
                replay_age_seconds=0.0,
            )

        stale = bool(live_quote is not None and self._is_stale(live_quote, now=now_dt))
        gap = live_quote is None
        if live_quote is not None:
            self._metrics["live_quotes"] = int(self._metrics["live_quotes"]) + 1
            if stale:
                self._metrics["stale_quotes"] = int(self._metrics["stale_quotes"]) + 1
        else:
            self._metrics["gap_quotes"] = int(self._metrics["gap_quotes"]) + 1

        if self._is_usable(live_quote, now=now_dt):
            self._record_live(venue=venue, symbol=symbol, quote=live_quote or {})
            return self._copy_quote(live_quote or {}), QuoteResolution(
                mode="live",
                source_venue=str(venue),
                stale=False,
                gap=False,
                replay_age_seconds=0.0,
            )

        for backup in self._candidate_backups(venue=venue, market=market):
            backup_quote = raw_quotes.get((str(backup), str(symbol)))
            if not self._is_usable(backup_quote, now=now_dt):
                continue
            quote = self._copy_quote(backup_quote or {})
            quote["source_venue"] = str(backup)
            quote["failover_from_venue"] = str(venue)
            self._record_live(venue=venue, symbol=symbol, quote=quote)
            self._metrics["failover_quotes"] = int(self._metrics["failover_quotes"]) + 1
            return quote, QuoteResolution(
                mode="failover",
                source_venue=str(backup),
                stale=stale,
                gap=gap,
                replay_age_seconds=0.0,
            )

        replay = self._last_good.get((str(venue), str(symbol)))
        if replay is not None:
            replay_ts = _parse_ts(replay.get("timestamp"), fallback=now_dt)
            replay_age = max((now_dt - replay_ts).total_seconds(), 0.0)
            if replay_age <= float(self.policy.replay_window_seconds):
                quote = self._copy_quote(replay)
                quote["replayed"] = True
                self._metrics["replay_quotes"] = int(self._metrics["replay_quotes"]) + 1
                return quote, QuoteResolution(
                    mode="replay",
                    source_venue=str(venue),
                    stale=stale,
                    gap=gap,
                    replay_age_seconds=float(replay_age),
                )

        return None, QuoteResolution(
            mode="unresolved",
            source_venue=str(venue),
            stale=stale,
            gap=gap,
            replay_age_seconds=0.0,
        )

    def snapshot_metrics(self) -> Dict[str, Any]:
        return {
            "policy": asdict(self.policy),
            "metrics": {key: int(value) for key, value in self._metrics.items()},
        }
