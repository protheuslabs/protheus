"""Tests for exchange certification harness."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from execution.exchange_certification import (
    CertificationThresholds,
    ProbeCheckResult,
    run_adapter_certification,
    summarize_certification,
)


class _ProbePass:
    async def auth_check(self) -> bool:
        return True

    async def submit_order_check(self) -> bool:
        return True

    async def cancel_order_check(self) -> bool:
        return True

    async def partial_fill_check(self) -> bool:
        return True

    async def reconnect_check(self) -> bool:
        return True


class _ProbeFail:
    async def auth_check(self) -> bool:
        return True

    async def submit_order_check(self) -> bool:
        return False

    async def cancel_order_check(self) -> bool:
        return True

    async def partial_fill_check(self) -> bool:
        return True

    async def reconnect_check(self) -> bool:
        return True


class _ProbeTimeout:
    async def auth_check(self) -> ProbeCheckResult:
        return ProbeCheckResult(ok=False, status="timeout")

    async def submit_order_check(self) -> bool:
        return True

    async def cancel_order_check(self) -> bool:
        return True

    async def partial_fill_check(self) -> bool:
        return True

    async def reconnect_check(self) -> bool:
        return True


def test_run_adapter_certification_passes_when_all_checks_pass():
    result = asyncio.run(
        run_adapter_certification(
            venue="binance",
            probe=_ProbePass(),
            thresholds=CertificationThresholds(
                max_auth_latency_ms=5000,
                max_submit_latency_ms=5000,
                max_cancel_latency_ms=5000,
                max_reconnect_latency_ms=5000,
                max_reject_rate=0.5,
                max_timeout_rate=0.5,
                max_error_rate=0.5,
            ),
            samples_per_check=2,
        )
    )

    assert result.passed is True
    assert all(result.checks.values())


def test_run_adapter_certification_fails_on_submit_check():
    result = asyncio.run(
        run_adapter_certification(
            venue="coinbase",
            probe=_ProbeFail(),
            thresholds=CertificationThresholds(max_reject_rate=0.0),
            samples_per_check=3,
        )
    )

    assert result.passed is False
    assert "submit_order_check_failed" in result.failures


def test_summarize_certification_outputs_rollup():
    passed = asyncio.run(run_adapter_certification(venue="a", probe=_ProbePass()))
    failed = asyncio.run(run_adapter_certification(venue="b", probe=_ProbeFail()))
    summary = summarize_certification([passed, failed])

    assert summary["venues_total"] == 2
    assert summary["venues_passed"] == 1
    assert summary["venues_failed"] == 1
    assert summary["all_passed"] is False
    assert "totals" in summary


def test_run_adapter_certification_fails_on_timeout_rate():
    result = asyncio.run(
        run_adapter_certification(
            venue="oanda",
            probe=_ProbeTimeout(),
            thresholds=CertificationThresholds(max_timeout_rate=0.0),
            samples_per_check=1,
        )
    )
    assert result.passed is False
    assert "timeout_rate_exceeded" in result.failures
