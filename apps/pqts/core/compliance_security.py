"""Security/compliance hardening helpers for release signing and audit exports."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence

_PLACEHOLDER_RE = re.compile(r"^\$\{([A-Z0-9_]+)\}$")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: str) -> datetime:
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


@dataclass(frozen=True)
class SecretRotationIssue:
    key: str
    message: str
    age_days: int

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _iter_secret_placeholders(payload: Any, *, parent: str = "") -> Iterable[tuple[str, str]]:
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            token = str(key)
            path = f"{parent}.{token}" if parent else token
            if isinstance(value, str):
                match = _PLACEHOLDER_RE.match(value.strip())
                if match is not None:
                    env_key = str(match.group(1))
                    lowered = token.lower()
                    if any(
                        fragment in lowered
                        for fragment in (
                            "api_key",
                            "api_secret",
                            "secret",
                            "token",
                            "passphrase",
                            "private_key",
                            "account_id",
                        )
                    ):
                        yield path, env_key
            yield from _iter_secret_placeholders(value, parent=path)
    elif isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray)):
        for idx, row in enumerate(payload):
            yield from _iter_secret_placeholders(row, parent=f"{parent}[{idx}]")


def validate_secret_rotation(
    config: Mapping[str, Any],
    *,
    max_age_days: int = 90,
    now: datetime | None = None,
) -> List[SecretRotationIssue]:
    runtime = config.get("runtime", {})
    secrets_cfg = runtime.get("secrets", {}) if isinstance(runtime, Mapping) else {}
    if not isinstance(secrets_cfg, Mapping):
        secrets_cfg = {}
    rotation_meta = secrets_cfg.get("rotation_metadata", {})
    if not isinstance(rotation_meta, Mapping):
        rotation_meta = {}

    issues: List[SecretRotationIssue] = []
    now_dt = now or _utc_now()
    max_age = max(int(max_age_days), 1)
    checked = set()
    for path, env_key in _iter_secret_placeholders(config):
        if env_key in checked:
            continue
        checked.add(env_key)
        rotated_at = str(rotation_meta.get(env_key, "")).strip()
        if not rotated_at:
            issues.append(
                SecretRotationIssue(
                    key=path,
                    message=f"rotation metadata missing for secret env '{env_key}'",
                    age_days=max_age + 1,
                )
            )
            continue
        try:
            dt = _parse_dt(rotated_at)
        except Exception:
            issues.append(
                SecretRotationIssue(
                    key=path,
                    message=f"invalid rotation timestamp for secret env '{env_key}'",
                    age_days=max_age + 1,
                )
            )
            continue
        age_days = max(int((now_dt - dt).total_seconds() // 86400), 0)
        if age_days > max_age:
            issues.append(
                SecretRotationIssue(
                    key=path,
                    message=f"secret env '{env_key}' exceeded max rotation age ({age_days}>{max_age})",
                    age_days=age_days,
                )
            )
    return issues


def _sha256_bytes(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def build_signed_release_manifest(
    *,
    artifacts: Sequence[str],
    output_path: str,
    signing_key: str,
    generated_at: str | None = None,
) -> Dict[str, Any]:
    rows: List[Dict[str, Any]] = []
    for artifact in sorted(str(path) for path in artifacts):
        file_path = Path(artifact)
        if not file_path.exists():
            raise FileNotFoundError(f"Artifact not found: {artifact}")
        data = file_path.read_bytes()
        rows.append(
            {
                "path": str(file_path),
                "size_bytes": int(len(data)),
                "sha256": _sha256_bytes(data),
            }
        )
    payload = {
        "generated_at": generated_at or _utc_now().isoformat(),
        "artifacts": rows,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(
        str(signing_key).encode("utf-8"),
        canonical,
        hashlib.sha256,
    ).hexdigest()
    manifest = {**payload, "signature": f"hmac-sha256:{signature}"}
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return manifest


def verify_signed_release_manifest(*, manifest_path: str, signing_key: str) -> bool:
    payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return False
    signature = str(payload.get("signature", "")).strip()
    if not signature.startswith("hmac-sha256:"):
        return False
    stripped = dict(payload)
    stripped.pop("signature", None)
    canonical = json.dumps(stripped, sort_keys=True, separators=(",", ":")).encode("utf-8")
    expected = hmac.new(
        str(signing_key).encode("utf-8"),
        canonical,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, f"hmac-sha256:{expected}")


def export_immutable_audit_from_files(
    *,
    files: Sequence[str],
    output_path: str,
    generated_at: str | None = None,
) -> Dict[str, Any]:
    records: List[Dict[str, Any]] = []
    for path in sorted(str(item) for item in files):
        file_path = Path(path)
        if not file_path.exists():
            continue
        blob = file_path.read_bytes()
        records.append(
            {
                "path": str(file_path),
                "size_bytes": int(len(blob)),
                "sha256": _sha256_bytes(blob),
            }
        )

    chain: List[Dict[str, Any]] = []
    prev_hash = ""
    for idx, row in enumerate(records):
        encoded = json.dumps(row, sort_keys=True, separators=(",", ":")).encode("utf-8")
        row_hash = _sha256_bytes(f"{prev_hash}|".encode("utf-8") + encoded)
        chain.append(
            {
                "index": int(idx),
                "generated_at": generated_at or _utc_now().isoformat(),
                "record": row,
                "prev_hash": prev_hash,
                "row_hash": row_hash,
            }
        )
        prev_hash = row_hash

    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        for row in chain:
            handle.write(json.dumps(row, sort_keys=True) + "\n")

    return {
        "output_path": str(out_path),
        "records": chain,
        "chain_head": prev_hash,
    }
