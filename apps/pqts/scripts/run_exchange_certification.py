#!/usr/bin/env python3
"""Run deterministic exchange certification checks (auth/order/cancel/fill/reconnect)."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from execution.exchange_certification import (  # noqa: E402
    CertificationThresholds,
    ProbeCheckResult,
    run_adapter_certification,
    summarize_certification,
)


class _SyntheticProbe:
    """Synthetic probe for CI/smoke certification runs without exchange credentials."""

    def __init__(self, failures: set[str], timeouts: set[str]):
        self.failures = set(failures)
        self.timeouts = set(timeouts)

    async def auth_check(self) -> bool | ProbeCheckResult:
        if "auth" in self.timeouts:
            return ProbeCheckResult(ok=False, status="timeout", detail="synthetic_timeout")
        return "auth" not in self.failures

    async def submit_order_check(self) -> bool | ProbeCheckResult:
        if "submit_order" in self.timeouts:
            return ProbeCheckResult(ok=False, status="timeout", detail="synthetic_timeout")
        return "submit_order" not in self.failures

    async def cancel_order_check(self) -> bool | ProbeCheckResult:
        if "cancel_order" in self.timeouts:
            return ProbeCheckResult(ok=False, status="timeout", detail="synthetic_timeout")
        return "cancel_order" not in self.failures

    async def partial_fill_check(self) -> bool | ProbeCheckResult:
        if "partial_fill" in self.timeouts:
            return ProbeCheckResult(ok=False, status="timeout", detail="synthetic_timeout")
        return "partial_fill" not in self.failures

    async def reconnect_check(self) -> bool | ProbeCheckResult:
        if "reconnect" in self.timeouts:
            return ProbeCheckResult(ok=False, status="timeout", detail="synthetic_timeout")
        return "reconnect" not in self.failures


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venues", default="binance,coinbase,alpaca,oanda")
    parser.add_argument(
        "--fail-checks",
        default="",
        help="Comma-separated checks to force fail (auth,submit_order,cancel_order,partial_fill,reconnect).",
    )
    parser.add_argument(
        "--timeout-checks",
        default="",
        help="Comma-separated checks to force timeout classification.",
    )
    parser.add_argument("--samples-per-check", type=int, default=5)
    parser.add_argument("--max-auth-latency-ms", type=float, default=5000.0)
    parser.add_argument("--max-submit-latency-ms", type=float, default=5000.0)
    parser.add_argument("--max-cancel-latency-ms", type=float, default=5000.0)
    parser.add_argument("--max-reconnect-latency-ms", type=float, default=10000.0)
    parser.add_argument("--max-reject-rate", type=float, default=0.05)
    parser.add_argument("--max-timeout-rate", type=float, default=0.02)
    parser.add_argument("--max-error-rate", type=float, default=0.01)
    parser.add_argument("--output", default="")
    return parser


def _csv(value: str) -> list[str]:
    return [item.strip() for item in str(value).split(",") if item.strip()]


async def _run(args: argparse.Namespace) -> dict:
    venues = _csv(args.venues)
    fail_checks = set(_csv(args.fail_checks))
    timeout_checks = set(_csv(args.timeout_checks))
    thresholds = CertificationThresholds(
        max_auth_latency_ms=float(args.max_auth_latency_ms),
        max_submit_latency_ms=float(args.max_submit_latency_ms),
        max_cancel_latency_ms=float(args.max_cancel_latency_ms),
        max_reconnect_latency_ms=float(args.max_reconnect_latency_ms),
        max_reject_rate=float(args.max_reject_rate),
        max_timeout_rate=float(args.max_timeout_rate),
        max_error_rate=float(args.max_error_rate),
    )
    results = []
    for venue in venues:
        probe = _SyntheticProbe(failures=fail_checks, timeouts=timeout_checks)
        outcome = await run_adapter_certification(
            venue=venue,
            probe=probe,
            thresholds=thresholds,
            samples_per_check=max(int(args.samples_per_check), 1),
        )
        results.append(outcome)
    return summarize_certification(results)


def main() -> int:
    args = build_parser().parse_args()
    payload = asyncio.run(_run(args))
    output = str(args.output).strip()
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, sort_keys=True, indent=2), encoding="utf-8")
        payload["output_path"] = str(path)
    print(json.dumps(payload, sort_keys=True))
    return 0 if bool(payload.get("all_passed", False)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
