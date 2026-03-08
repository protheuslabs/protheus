"""Secret provider abstraction for runtime config hydration."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, MutableMapping, Optional

_PLACEHOLDER_RE = re.compile(r"\$\{([A-Z0-9_]+)\}")


@dataclass(frozen=True)
class SecretResolutionMetadata:
    backend: str
    placeholders_total: int
    placeholders_resolved: int
    unresolved_keys: list[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "backend": str(self.backend),
            "placeholders_total": int(self.placeholders_total),
            "placeholders_resolved": int(self.placeholders_resolved),
            "unresolved_keys": list(self.unresolved_keys),
        }


def _runtime_secret_cfg(config: Mapping[str, Any]) -> Mapping[str, Any]:
    runtime = config.get("runtime", {})
    if not isinstance(runtime, Mapping):
        return {}
    raw = runtime.get("secrets", {})
    if not isinstance(raw, Mapping):
        return {}
    return raw


def _load_file_json_secret_map(path: str) -> Dict[str, str]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return {}
    out: Dict[str, str] = {}
    for key, value in payload.items():
        out[str(key)] = str(value)
    return out


def _load_aws_secret_map(*, secret_id: str, region_name: str) -> Dict[str, str]:
    try:
        import boto3  # type: ignore
    except Exception as exc:  # pragma: no cover - optional dependency
        raise RuntimeError("AWS secret backend requires boto3.") from exc

    client = boto3.client("secretsmanager", region_name=region_name)
    response = client.get_secret_value(SecretId=secret_id)
    secret_string = str(response.get("SecretString", "")).strip()
    if not secret_string:
        return {}
    parsed = json.loads(secret_string)
    if isinstance(parsed, dict):
        return {str(k): str(v) for k, v in parsed.items()}
    return {}


def load_secret_map(
    config: Mapping[str, Any],
    *,
    env: Optional[Mapping[str, str]] = None,
) -> Dict[str, str]:
    """Load secret key/value map from configured backend."""
    env_map: Mapping[str, str]
    if env is None:
        env_map = os.environ
    elif isinstance(env, MutableMapping):
        env_map = dict(env)
    else:
        env_map = env

    cfg = _runtime_secret_cfg(config)
    backend = str(cfg.get("backend", "env")).strip().lower()

    if backend == "env":
        return {str(k): str(v) for k, v in env_map.items()}

    if backend == "file_json":
        path = str(cfg.get("file_json_path", "")).strip()
        if not path:
            raise RuntimeError("runtime.secrets.file_json_path is required for file_json backend.")
        return _load_file_json_secret_map(path)

    if backend == "aws_sm":
        secret_id = str(cfg.get("aws_secret_id", "")).strip()
        if not secret_id:
            raise RuntimeError("runtime.secrets.aws_secret_id is required for aws_sm backend.")
        region = str(
            cfg.get("aws_region")
            or env_map.get("AWS_REGION")
            or env_map.get("AWS_DEFAULT_REGION")
            or ""
        ).strip()
        if not region:
            raise RuntimeError("AWS region is required for aws_sm backend.")
        return _load_aws_secret_map(secret_id=secret_id, region_name=region)

    raise RuntimeError(f"Unsupported secret backend '{backend}'.")


def _hydrate_value(value: Any, *, secret_map: Mapping[str, str], counters: Dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {
            key: _hydrate_value(val, secret_map=secret_map, counters=counters)
            for key, val in value.items()
        }
    if isinstance(value, list):
        return [_hydrate_value(item, secret_map=secret_map, counters=counters) for item in value]
    if not isinstance(value, str):
        return value

    matches = _PLACEHOLDER_RE.findall(value)
    if not matches:
        return value
    counters["total"] += len(matches)
    hydrated = value
    for key in matches:
        replacement = secret_map.get(key)
        if replacement is None:
            counters["unresolved"].add(key)
            continue
        counters["resolved"] += 1
        hydrated = hydrated.replace(f"${{{key}}}", str(replacement))
    return hydrated


def hydrate_config_secrets(
    config: Mapping[str, Any],
    *,
    env: Optional[Mapping[str, str]] = None,
) -> tuple[Dict[str, Any], SecretResolutionMetadata]:
    """Replace `${VAR}` placeholders using configured secret backend."""
    cfg = _runtime_secret_cfg(config)
    backend = str(cfg.get("backend", "env")).strip().lower()
    secret_map = load_secret_map(config, env=env)
    counters: Dict[str, Any] = {
        "total": 0,
        "resolved": 0,
        "unresolved": set(),
    }
    hydrated = _hydrate_value(dict(config), secret_map=secret_map, counters=counters)
    metadata = SecretResolutionMetadata(
        backend=backend,
        placeholders_total=int(counters["total"]),
        placeholders_resolved=int(counters["resolved"]),
        unresolved_keys=sorted(str(key) for key in counters["unresolved"]),
    )
    return hydrated, metadata
