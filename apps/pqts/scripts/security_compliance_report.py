#!/usr/bin/env python3
"""Generate security/compliance report with optional release signing and audit export."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import yaml

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.compliance_security import (  # noqa: E402
    build_signed_release_manifest,
    export_immutable_audit_from_files,
    validate_secret_rotation,
)
from core.secrets_policy import validate_live_secrets  # noqa: E402


def _load_yaml(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = yaml.safe_load(handle) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object YAML at {path}")
    return payload


def _csv_list(value: str) -> List[str]:
    return [token.strip() for token in str(value or "").split(",") if token.strip()]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config/live_canary.yaml")
    parser.add_argument(
        "--artifacts",
        default="",
        help="Comma-separated artifact paths for release signing.",
    )
    parser.add_argument(
        "--audit-files",
        default=(
            "data/analytics/order_ledger.jsonl,"
            "data/analytics/reconciliation_incidents.jsonl,"
            "data/analytics/control_plane_usage.jsonl"
        ),
    )
    parser.add_argument("--signing-key-env", default="PQTS_RELEASE_SIGNING_KEY")
    parser.add_argument("--rotation-max-age-days", type=int, default=90)
    parser.add_argument("--out-dir", default="data/reports")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    config = _load_yaml(str(args.config))

    secret_issues = [issue.to_dict() for issue in validate_live_secrets(config)]
    rotation_issues = [
        issue.to_dict()
        for issue in validate_secret_rotation(config, max_age_days=int(args.rotation_max_age_days))
    ]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    manifest_path = out_dir / f"release_manifest_{stamp}.json"
    audit_path = out_dir / f"immutable_audit_export_{stamp}.jsonl"

    signing_key = str(os.environ.get(str(args.signing_key_env), "")).strip()
    artifacts = _csv_list(args.artifacts)
    manifest_payload: Dict[str, Any] = {
        "skipped": True,
        "reason": "missing_signing_key_or_artifacts",
    }
    if signing_key and artifacts:
        manifest_payload = build_signed_release_manifest(
            artifacts=artifacts,
            output_path=str(manifest_path),
            signing_key=signing_key,
        )
        manifest_payload["skipped"] = False
        manifest_payload["path"] = str(manifest_path)

    audit_payload = export_immutable_audit_from_files(
        files=_csv_list(args.audit_files),
        output_path=str(audit_path),
    )

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "config": str(args.config),
        "secret_issues": secret_issues,
        "rotation_issues": rotation_issues,
        "release_manifest": manifest_payload,
        "immutable_audit_export": audit_payload,
    }
    report_path = out_dir / f"security_compliance_{stamp}.json"
    report_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    payload["report_path"] = str(report_path)
    print(json.dumps(payload, sort_keys=True))
    return 0 if not secret_issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
