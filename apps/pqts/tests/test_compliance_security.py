"""Tests for compliance security helpers (rotation, release signing, audit exports)."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.compliance_security import (  # noqa: E402
    build_signed_release_manifest,
    export_immutable_audit_from_files,
    validate_secret_rotation,
    verify_signed_release_manifest,
)


def test_validate_secret_rotation_flags_missing_and_stale_entries():
    config = {
        "mode": "live_trading",
        "runtime": {
            "secrets": {
                "rotation_metadata": {
                    "BINANCE_API_KEY": "2020-01-01T00:00:00+00:00",
                }
            }
        },
        "markets": {
            "crypto": {
                "exchanges": [
                    {
                        "api_key": "${BINANCE_API_KEY}",
                        "api_secret": "${BINANCE_API_SECRET}",
                    }
                ]
            }
        },
    }
    issues = validate_secret_rotation(
        config,
        max_age_days=90,
        now=datetime(2026, 3, 4, tzinfo=timezone.utc),
    )
    messages = [row.message for row in issues]
    assert any("exceeded max rotation age" in msg for msg in messages)
    assert any("rotation metadata missing" in msg for msg in messages)


def test_release_manifest_sign_and_verify(tmp_path):
    artifact = tmp_path / "build.tar.gz"
    artifact.write_text("artifact-content", encoding="utf-8")
    manifest_path = tmp_path / "release_manifest.json"

    manifest = build_signed_release_manifest(
        artifacts=[str(artifact)],
        output_path=str(manifest_path),
        signing_key="unit-test-key",
    )

    assert manifest_path.exists()
    assert manifest["signature"].startswith("hmac-sha256:")
    assert verify_signed_release_manifest(
        manifest_path=str(manifest_path),
        signing_key="unit-test-key",
    )
    assert not verify_signed_release_manifest(
        manifest_path=str(manifest_path),
        signing_key="wrong-key",
    )


def test_export_immutable_audit_from_files_builds_hash_chain(tmp_path):
    one = tmp_path / "a.log"
    two = tmp_path / "b.log"
    one.write_text("row-a", encoding="utf-8")
    two.write_text("row-b", encoding="utf-8")
    out_path = tmp_path / "audit_export.jsonl"

    payload = export_immutable_audit_from_files(
        files=[str(one), str(two)],
        output_path=str(out_path),
    )

    assert out_path.exists()
    rows = [json.loads(line) for line in out_path.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 2
    assert rows[0]["prev_hash"] == ""
    assert rows[1]["prev_hash"] == rows[0]["row_hash"]
    assert payload["chain_head"] == rows[-1]["row_hash"]
