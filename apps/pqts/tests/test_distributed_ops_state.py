"""Tests for distributed ops state fallback behavior."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.distributed_ops_state import DistributedOpsState, DistributedStateConfig


def test_distributed_ops_state_local_put_get():
    state = DistributedOpsState(
        DistributedStateConfig(redis_url="", namespace="unit", ttl_seconds=60)
    )
    state.put("incident", {"seen": True})

    row = state.get("incident")
    assert row is not None
    assert row["seen"] is True
    assert state.seen_recently("incident") is True


def test_distributed_ops_state_expiry():
    state = DistributedOpsState(
        DistributedStateConfig(redis_url="", namespace="unit", ttl_seconds=0)
    )
    state.put("incident", {"seen": True})
    assert state.get("incident") is None
