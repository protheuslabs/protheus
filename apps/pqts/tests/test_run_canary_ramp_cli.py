"""Tests for canary ramp CLI helpers."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "run_canary_ramp.py"
SPEC = importlib.util.spec_from_file_location("run_canary_ramp", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_parse_steps_parses_fraction_list():
    steps = MODULE._parse_steps("0.01, 0.02,0.05")
    assert steps == [0.01, 0.02, 0.05]


def test_latest_selects_most_recent_file(tmp_path):
    old = tmp_path / "paper_campaign_snapshot_20260101T000000000000Z.json"
    new = tmp_path / "paper_campaign_snapshot_20260102T000000000000Z.json"
    old.write_text("{}", encoding="utf-8")
    new.write_text("{}", encoding="utf-8")

    assert MODULE._latest(tmp_path, "paper_campaign_snapshot_*.json") == new


def test_load_json_reads_object(tmp_path):
    payload = {"ok": True}
    path = tmp_path / "payload.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    assert MODULE._load_json(path) == payload


def test_parser_accepts_risk_profile_flag():
    parser = MODULE.build_parser()
    args = parser.parse_args(["--risk-profile", "aggressive", "--max-tca-drift-mape-pct", "22.5"])
    assert args.risk_profile == "aggressive"
    assert args.max_tca_drift_mape_pct == 22.5
