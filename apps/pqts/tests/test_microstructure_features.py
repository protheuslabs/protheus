"""Tests for deterministic microstructure feature extraction."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.microstructure_features import extract_microstructure_features


def test_extract_microstructure_features_returns_side_aware_metrics():
    features = extract_microstructure_features(
        order_book={
            "bids": [(99.0, 10.0), (98.0, 20.0)],
            "asks": [(101.0, 8.0), (102.0, 16.0)],
        },
        reference_price=100.0,
        side="buy",
        requested_qty=5.0,
        queue_ahead_qty=2.0,
    )
    assert features["spread_bps"] > 0.0
    assert features["ask_depth_usd"] > 0.0
    assert features["queue_turnover"] > 0.0
    assert features["impact_proxy_bps"] >= 0.0
