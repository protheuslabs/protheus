"""Exchange adapter certification harness for sandbox/live-readiness checks."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Dict, Protocol


@dataclass(frozen=True)
class CertificationThresholds:
    max_auth_latency_ms: float = 5000.0
    max_submit_latency_ms: float = 5000.0
    max_cancel_latency_ms: float = 5000.0
    max_reconnect_latency_ms: float = 10000.0
    max_reject_rate: float = 0.05
    max_timeout_rate: float = 0.02
    max_error_rate: float = 0.01


@dataclass(frozen=True)
class ProbeCheckResult:
    ok: bool
    status: str = "ok"  # ok | rejected | timeout | error
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": bool(self.ok),
            "status": str(self.status),
            "detail": str(self.detail),
        }


@dataclass(frozen=True)
class CertificationResult:
    venue: str
    passed: bool
    checks: Dict[str, bool]
    latencies_ms: Dict[str, float]
    failures: list[str]
    samples_per_check: int
    attempts: int
    rejected_attempts: int
    timeout_attempts: int
    error_attempts: int
    reject_rate: float
    timeout_rate: float
    error_rate: float
    check_attempts: Dict[str, int]
    check_failures: Dict[str, int]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "venue": self.venue,
            "passed": bool(self.passed),
            "checks": dict(self.checks),
            "latencies_ms": dict(self.latencies_ms),
            "failures": list(self.failures),
            "samples_per_check": int(self.samples_per_check),
            "attempts": int(self.attempts),
            "rejected_attempts": int(self.rejected_attempts),
            "timeout_attempts": int(self.timeout_attempts),
            "error_attempts": int(self.error_attempts),
            "reject_rate": float(self.reject_rate),
            "timeout_rate": float(self.timeout_rate),
            "error_rate": float(self.error_rate),
            "check_attempts": dict(self.check_attempts),
            "check_failures": dict(self.check_failures),
        }


class AdapterCertificationProbe(Protocol):
    async def auth_check(self) -> bool | ProbeCheckResult: ...

    async def submit_order_check(self) -> bool | ProbeCheckResult: ...

    async def cancel_order_check(self) -> bool | ProbeCheckResult: ...

    async def partial_fill_check(self) -> bool | ProbeCheckResult: ...

    async def reconnect_check(self) -> bool | ProbeCheckResult: ...


def _normalize_probe_result(result: bool | ProbeCheckResult) -> ProbeCheckResult:
    if isinstance(result, ProbeCheckResult):
        return result
    return ProbeCheckResult(ok=bool(result), status=("ok" if bool(result) else "rejected"))


def _status_from_exception(exc: Exception) -> str:
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    return "error"


async def run_adapter_certification(
    *,
    venue: str,
    probe: AdapterCertificationProbe,
    thresholds: CertificationThresholds | None = None,
    samples_per_check: int = 1,
) -> CertificationResult:
    cfg = thresholds or CertificationThresholds()
    samples = max(int(samples_per_check), 1)

    check_fns = {
        "auth": probe.auth_check,
        "submit_order": probe.submit_order_check,
        "cancel_order": probe.cancel_order_check,
        "partial_fill": probe.partial_fill_check,
        "reconnect": probe.reconnect_check,
    }

    checks: Dict[str, bool] = {}
    latencies_ms: Dict[str, float] = {}
    check_attempts: Dict[str, int] = {name: 0 for name in check_fns}
    check_failures: Dict[str, int] = {name: 0 for name in check_fns}
    rejected_attempts = 0
    timeout_attempts = 0
    error_attempts = 0

    for name, fn in check_fns.items():
        all_ok = True
        elapsed_samples: list[float] = []
        for _ in range(samples):
            check_attempts[name] += 1
            start = time.perf_counter()
            try:
                normalized = _normalize_probe_result(await fn())
                elapsed_ms = (time.perf_counter() - start) * 1000.0
                elapsed_samples.append(float(elapsed_ms))
                if not normalized.ok:
                    all_ok = False
                    check_failures[name] += 1
                    if str(normalized.status) == "timeout":
                        timeout_attempts += 1
                    elif str(normalized.status) == "error":
                        error_attempts += 1
                    else:
                        rejected_attempts += 1
            except Exception as exc:
                elapsed_ms = (time.perf_counter() - start) * 1000.0
                elapsed_samples.append(float(elapsed_ms))
                all_ok = False
                check_failures[name] += 1
                status = _status_from_exception(exc)
                if status == "timeout":
                    timeout_attempts += 1
                else:
                    error_attempts += 1
            # continue sampling to estimate rates reliably

        checks[name] = all_ok
        latencies_ms[name] = float(sum(elapsed_samples) / max(len(elapsed_samples), 1))

    attempts = int(sum(check_attempts.values()))
    reject_rate = float(rejected_attempts / max(attempts, 1))
    timeout_rate = float(timeout_attempts / max(attempts, 1))
    error_rate = float(error_attempts / max(attempts, 1))

    failures: list[str] = []
    if not checks["auth"]:
        failures.append("auth_check_failed")
    if not checks["submit_order"]:
        failures.append("submit_order_check_failed")
    if not checks["cancel_order"]:
        failures.append("cancel_order_check_failed")
    if not checks["partial_fill"]:
        failures.append("partial_fill_check_failed")
    if not checks["reconnect"]:
        failures.append("reconnect_check_failed")

    if latencies_ms["auth"] > cfg.max_auth_latency_ms:
        failures.append("auth_latency_exceeded")
    if latencies_ms["submit_order"] > cfg.max_submit_latency_ms:
        failures.append("submit_latency_exceeded")
    if latencies_ms["cancel_order"] > cfg.max_cancel_latency_ms:
        failures.append("cancel_latency_exceeded")
    if latencies_ms["reconnect"] > cfg.max_reconnect_latency_ms:
        failures.append("reconnect_latency_exceeded")
    if reject_rate > float(cfg.max_reject_rate):
        failures.append("reject_rate_exceeded")
    if timeout_rate > float(cfg.max_timeout_rate):
        failures.append("timeout_rate_exceeded")
    if error_rate > float(cfg.max_error_rate):
        failures.append("error_rate_exceeded")

    return CertificationResult(
        venue=str(venue),
        passed=(len(failures) == 0),
        checks=checks,
        latencies_ms=latencies_ms,
        failures=failures,
        samples_per_check=samples,
        attempts=attempts,
        rejected_attempts=int(rejected_attempts),
        timeout_attempts=int(timeout_attempts),
        error_attempts=int(error_attempts),
        reject_rate=reject_rate,
        timeout_rate=timeout_rate,
        error_rate=error_rate,
        check_attempts=check_attempts,
        check_failures=check_failures,
    )


def summarize_certification(results: list[CertificationResult]) -> Dict[str, Any]:
    passed = [row for row in results if row.passed]
    failed = [row for row in results if not row.passed]
    total_attempts = int(sum(row.attempts for row in results))
    total_rejected = int(sum(row.rejected_attempts for row in results))
    total_timeouts = int(sum(row.timeout_attempts for row in results))
    total_errors = int(sum(row.error_attempts for row in results))
    return {
        "venues_total": len(results),
        "venues_passed": len(passed),
        "venues_failed": len(failed),
        "all_passed": len(failed) == 0,
        "totals": {
            "attempts": total_attempts,
            "rejected_attempts": total_rejected,
            "timeout_attempts": total_timeouts,
            "error_attempts": total_errors,
            "reject_rate": float(total_rejected / max(total_attempts, 1)),
            "timeout_rate": float(total_timeouts / max(total_attempts, 1)),
            "error_rate": float(total_errors / max(total_attempts, 1)),
        },
        "results": [row.to_dict() for row in results],
    }
