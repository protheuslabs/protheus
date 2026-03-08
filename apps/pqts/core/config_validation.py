"""Engine configuration validation with optional strict enforcement."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping


@dataclass(frozen=True)
class ConfigValidationIssue:
    key: str
    message: str
    severity: str = "error"

    def to_dict(self) -> Dict[str, str]:
        return {
            "key": str(self.key),
            "message": str(self.message),
            "severity": str(self.severity),
        }


def validate_engine_config(config: Mapping[str, Any]) -> List[ConfigValidationIssue]:
    issues: List[ConfigValidationIssue] = []

    mode = str(config.get("mode", "")).strip().lower()
    if mode not in {"paper_trading", "live_trading", "live", "paper"}:
        issues.append(
            ConfigValidationIssue(
                key="mode",
                message="mode must be one of paper_trading/live_trading/live/paper",
            )
        )

    markets = config.get("markets")
    if not isinstance(markets, Mapping) or not markets:
        issues.append(
            ConfigValidationIssue(
                key="markets",
                message="markets section must be a non-empty mapping",
            )
        )

    strategies = config.get("strategies")
    if not isinstance(strategies, Mapping) or not strategies:
        issues.append(
            ConfigValidationIssue(
                key="strategies",
                message="strategies section must be a non-empty mapping",
                severity="warning",
            )
        )

    risk = config.get("risk")
    if not isinstance(risk, Mapping):
        issues.append(ConfigValidationIssue(key="risk", message="risk section is required"))
    else:
        capital = risk.get("initial_capital")
        try:
            if float(capital) <= 0.0:
                issues.append(
                    ConfigValidationIssue(
                        key="risk.initial_capital",
                        message="risk.initial_capital must be > 0",
                    )
                )
        except Exception:
            issues.append(
                ConfigValidationIssue(
                    key="risk.initial_capital",
                    message="risk.initial_capital must be numeric",
                )
            )

    runtime = config.get("runtime", {})
    if runtime and not isinstance(runtime, Mapping):
        issues.append(
            ConfigValidationIssue(
                key="runtime",
                message="runtime must be a mapping when provided",
            )
        )
    elif isinstance(runtime, Mapping):
        autopilot = runtime.get("autopilot", {})
        if autopilot and not isinstance(autopilot, Mapping):
            issues.append(
                ConfigValidationIssue(
                    key="runtime.autopilot",
                    message="runtime.autopilot must be a mapping when provided",
                )
            )
        elif isinstance(autopilot, Mapping):
            mode_token = str(autopilot.get("mode", "manual")).strip().lower()
            if mode_token not in {"manual", "auto", "hybrid"}:
                issues.append(
                    ConfigValidationIssue(
                        key="runtime.autopilot.mode",
                        message="runtime.autopilot.mode must be manual/auto/hybrid",
                    )
                )
    return issues
