"""Tests for strategy artifact registry."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from research.artifact_registry import StrategyArtifactManifest, StrategyArtifactRegistry


def test_artifact_registry_register_and_lookup(tmp_path):
    registry = StrategyArtifactRegistry(root=str(tmp_path / "registry"))
    manifest = StrategyArtifactManifest(
        run_id="run_abc",
        experiment_id="exp_1",
        strategy_id="exp_1",
        stage="paper",
        created_at="2026-03-01T00:00:00+00:00",
        code_sha="sha123",
        config_hash="cfg123",
        report_id="rep_1",
        report_path="/tmp/report.json",
        report_sha256="hash123",
        metrics={"sharpe": 1.2},
        extras={"decision": "promote_to_paper"},
    )
    path = registry.register(manifest)
    loaded = registry.find_by_run_id("run_abc")
    listed = registry.list_for_strategy("exp_1")

    assert path.exists()
    assert loaded is not None
    assert loaded["report_id"] == "rep_1"
    assert listed
    assert listed[0]["run_id"] == "run_abc"
