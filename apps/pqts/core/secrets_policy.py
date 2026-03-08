"""Live-trading secret policy enforcement."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence

from core.compliance_security import validate_secret_rotation

_LIVE_MODES = {"live", "live_trading"}
_SECRET_KEY_TOKENS = (
    "api_key",
    "api_secret",
    "secret",
    "token",
    "passphrase",
    "private_key",
    "account_id",
)
_PLACEHOLDER_RE = re.compile(r"^\$\{([A-Z0-9_]+)\}$")
_BLOCKED_LITERALS = {
    "",
    "none",
    "null",
    "changeme",
    "replace_me",
    "your_api_key",
    "your_api_secret",
    "your_token",
    "demo",
    "test",
}


@dataclass(frozen=True)
class SecretPolicyIssue:
    key: str
    message: str

    def to_dict(self) -> Dict[str, str]:
        return {
            "key": str(self.key),
            "message": str(self.message),
        }


def _is_live_mode(config: Mapping[str, Any]) -> bool:
    mode = str(config.get("mode", "")).strip().lower()
    return mode in _LIVE_MODES


def _is_secret_key(token: str) -> bool:
    key = str(token).strip().lower()
    return any(fragment in key for fragment in _SECRET_KEY_TOKENS)


def _iter_mapping(
    payload: Any,
    *,
    parent: str = "",
) -> Iterable[tuple[str, str, Any]]:
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            key_token = str(key)
            child = f"{parent}.{key_token}" if parent else key_token
            yield child, key_token, value
            yield from _iter_mapping(value, parent=child)
    elif isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray)):
        for idx, item in enumerate(payload):
            child = f"{parent}[{idx}]"
            yield from _iter_mapping(item, parent=child)


def validate_live_secrets(
    config: Mapping[str, Any],
    *,
    env: Optional[Mapping[str, str]] = None,
) -> List[SecretPolicyIssue]:
    """Validate live-trading credentials are present and not placeholder literals."""
    if not _is_live_mode(config):
        return []

    environment: Mapping[str, str]
    if env is None:
        environment = os.environ
    elif isinstance(env, MutableMapping):
        environment = dict(env)
    else:
        environment = env

    issues: List[SecretPolicyIssue] = []
    discovered_secret_fields = 0

    for path, key, value in _iter_mapping(config):
        if not _is_secret_key(key):
            continue
        discovered_secret_fields += 1
        token = str(value or "").strip()
        lower = token.lower()
        if lower in _BLOCKED_LITERALS:
            issues.append(
                SecretPolicyIssue(
                    key=path,
                    message="live secret is missing or uses blocked placeholder literal",
                )
            )
            continue
        match = _PLACEHOLDER_RE.match(token)
        if match is None:
            continue
        env_key = match.group(1)
        env_value = str(environment.get(env_key, "")).strip()
        if not env_value:
            issues.append(
                SecretPolicyIssue(
                    key=path,
                    message=f"required env var '{env_key}' is not set for live mode",
                )
            )

    if discovered_secret_fields == 0:
        issues.append(
            SecretPolicyIssue(
                key="markets",
                message="live mode requires credential fields (api_key/api_secret/token/etc.)",
            )
        )
    runtime = config.get("runtime", {})
    secrets_cfg = runtime.get("secrets", {}) if isinstance(runtime, Mapping) else {}
    enforce_rotation = bool(
        secrets_cfg.get("enforce_rotation", False) if isinstance(secrets_cfg, Mapping) else False
    )
    if enforce_rotation:
        rotation_issues = validate_secret_rotation(config, max_age_days=90)
        for issue in rotation_issues:
            issues.append(
                SecretPolicyIssue(
                    key=str(issue.key),
                    message=str(issue.message),
                )
            )
    return issues


def enforce_live_secrets(
    config: Mapping[str, Any],
    *,
    env: Optional[Mapping[str, str]] = None,
) -> None:
    issues = validate_live_secrets(config, env=env)
    if not issues:
        return
    messages = "; ".join(f"{issue.key}: {issue.message}" for issue in issues)
    raise RuntimeError(f"Live secret policy failed: {messages}")
