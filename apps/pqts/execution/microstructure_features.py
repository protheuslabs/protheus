"""Deterministic microstructure feature extraction for research and execution telemetry."""

from __future__ import annotations

from typing import Any, Dict, Iterable, Tuple


def _safe_level(level: Any) -> Tuple[float, float]:
    if not isinstance(level, (list, tuple)) or len(level) < 2:
        return 0.0, 0.0
    try:
        price = float(level[0])
        size = float(level[1])
    except (TypeError, ValueError):
        return 0.0, 0.0
    return max(price, 0.0), max(size, 0.0)


def _sum_notional(levels: Iterable[Any], *, max_levels: int = 5) -> float:
    total = 0.0
    count = 0
    for level in levels:
        if count >= max(int(max_levels), 1):
            break
        price, size = _safe_level(level)
        total += price * size
        count += 1
    return float(total)


def extract_microstructure_features(
    *,
    order_book: Dict[str, Any] | None,
    reference_price: float,
    side: str,
    requested_qty: float,
    queue_ahead_qty: float = 0.0,
    max_levels: int = 5,
) -> Dict[str, float]:
    """
    Build side-aware queue/depth features for attribution and strategy research.
    """
    book = order_book if isinstance(order_book, dict) else {}
    bids = list(book.get("bids", []) or [])
    asks = list(book.get("asks", []) or [])
    best_bid, bid_size = _safe_level(bids[0] if bids else None)
    best_ask, ask_size = _safe_level(asks[0] if asks else None)
    mid = float(reference_price)
    if mid <= 0.0 and best_bid > 0.0 and best_ask > 0.0:
        mid = (best_bid + best_ask) / 2.0
    mid = max(mid, 1e-9)

    spread_bps = 0.0
    if best_bid > 0.0 and best_ask > 0.0:
        spread_bps = ((best_ask - best_bid) / mid) * 10000.0

    bid_depth_usd = _sum_notional(bids, max_levels=max_levels)
    ask_depth_usd = _sum_notional(asks, max_levels=max_levels)
    total_depth = max(bid_depth_usd + ask_depth_usd, 1e-9)
    imbalance = (bid_depth_usd - ask_depth_usd) / total_depth

    side_token = str(side).lower()
    side_depth_usd = bid_depth_usd if side_token == "sell" else ask_depth_usd
    queue_notional = max(float(queue_ahead_qty), 0.0) * mid
    requested_notional = max(float(requested_qty), 0.0) * mid
    queue_turnover = requested_notional / max(queue_notional, 1e-9)
    depth_participation = requested_notional / max(side_depth_usd, 1e-9)

    # Deterministic proxy for impact risk from order-book participation.
    impact_proxy_bps = spread_bps * max(min(depth_participation, 5.0), 0.0)

    return {
        "mid_price": float(mid),
        "spread_bps": float(spread_bps),
        "top_bid_qty": float(bid_size),
        "top_ask_qty": float(ask_size),
        "bid_depth_usd": float(bid_depth_usd),
        "ask_depth_usd": float(ask_depth_usd),
        "depth_imbalance": float(imbalance),
        "side_depth_usd": float(side_depth_usd),
        "requested_notional_usd": float(requested_notional),
        "queue_notional_usd": float(queue_notional),
        "queue_turnover": float(queue_turnover),
        "depth_participation": float(depth_participation),
        "impact_proxy_bps": float(impact_proxy_bps),
    }
