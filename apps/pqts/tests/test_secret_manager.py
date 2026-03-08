"""Tests for secret manager backends and placeholder hydration."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.secret_manager import hydrate_config_secrets


def test_hydrate_config_secrets_env_backend():
    config = {
        "mode": "live_trading",
        "runtime": {"secrets": {"backend": "env"}},
        "markets": {
            "crypto": {
                "exchanges": [{"api_key": "${BINANCE_KEY}", "api_secret": "${BINANCE_SECRET}"}]
            }
        },
    }
    hydrated, metadata = hydrate_config_secrets(
        config,
        env={"BINANCE_KEY": "k_live", "BINANCE_SECRET": "s_live"},
    )

    exchange = hydrated["markets"]["crypto"]["exchanges"][0]
    assert exchange["api_key"] == "k_live"
    assert exchange["api_secret"] == "s_live"
    assert metadata.placeholders_total == 2
    assert metadata.placeholders_resolved == 2
    assert metadata.unresolved_keys == []


def test_hydrate_config_secrets_file_json_backend(tmp_path):
    secret_file = tmp_path / "secrets.json"
    secret_file.write_text(
        json.dumps({"BINANCE_KEY": "file_k", "BINANCE_SECRET": "file_s"}),
        encoding="utf-8",
    )
    config = {
        "mode": "live_trading",
        "runtime": {
            "secrets": {
                "backend": "file_json",
                "file_json_path": str(secret_file),
            }
        },
        "markets": {
            "crypto": {
                "exchanges": [{"api_key": "${BINANCE_KEY}", "api_secret": "${BINANCE_SECRET}"}]
            }
        },
    }
    hydrated, metadata = hydrate_config_secrets(config)

    exchange = hydrated["markets"]["crypto"]["exchanges"][0]
    assert exchange["api_key"] == "file_k"
    assert exchange["api_secret"] == "file_s"
    assert metadata.backend == "file_json"
