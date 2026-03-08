#!/usr/bin/env python3
"""Validate live-trading secret coverage for a config file."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

import yaml

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.secret_manager import hydrate_config_secrets  # noqa: E402
from core.secrets_policy import validate_live_secrets  # noqa: E402


def _load_yaml(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument("--strict", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    config = _load_yaml(str(args.config))
    hydrated, metadata = hydrate_config_secrets(config)
    issues = validate_live_secrets(hydrated)
    payload = {
        "config": str(args.config),
        "secret_resolution": metadata.to_dict(),
        "issues": [issue.to_dict() for issue in issues],
        "ok": len(issues) == 0,
    }
    print(json.dumps(payload, sort_keys=True))
    if args.strict and issues:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
