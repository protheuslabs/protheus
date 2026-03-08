#!/usr/bin/env python3
"""One-command PQTS demo: run paper simulation, emit report, and export handoff blob."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import yaml

from analytics.attribution import log_event
from core.operator_tier import resolve_operator_tier, validate_operator_tier_overrides
from research.handoff_blob import build_handoff_blob

ROOT = Path(__file__).resolve().parent


def _parse_json_from_output(output: str) -> Dict[str, Any]:
    for line in reversed(output.splitlines()):
        payload = line.strip()
        if not payload:
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return {}


def _load_yaml(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def _symbols_for_market(config: Dict[str, Any], market: str) -> List[str]:
    symbols: List[str] = []
    markets = config.get("markets", {})

    if market in {"crypto", "all"}:
        for venue in markets.get("crypto", {}).get("exchanges", []):
            symbols.extend(str(x) for x in venue.get("symbols", []))
    if market in {"equities", "all"}:
        for venue in markets.get("equities", {}).get("brokers", []):
            symbols.extend(str(x) for x in venue.get("symbols", []))
    if market in {"forex", "all"}:
        for venue in markets.get("forex", {}).get("brokers", []):
            symbols.extend(str(x) for x in venue.get("pairs", []))

    out = sorted(set(x for x in symbols if x))
    if not out:
        raise ValueError(f"No symbols configured for market={market!r}")
    return out


def _build_campaign_cmd(args: argparse.Namespace, symbols: List[str]) -> List[str]:
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "run_paper_campaign.py"),
        "--config",
        args.config,
        "--symbols",
        ",".join(symbols),
        "--cycles",
        str(int(args.cycles)),
        "--sleep-seconds",
        str(float(args.sleep_seconds)),
        "--notional-usd",
        str(float(args.notional_usd)),
        "--readiness-every",
        str(int(args.readiness_every)),
        "--lookback-days",
        str(int(args.lookback_days)),
        "--min-days",
        str(int(args.min_days)),
        "--min-fills",
        str(int(args.min_fills)),
        "--max-p95-slippage-bps",
        str(float(args.max_p95_slippage_bps)),
        "--max-mape-pct",
        str(float(args.max_mape_pct)),
        "--out-dir",
        args.out_dir,
    ]
    risk_profile = str(getattr(args, "risk_profile", "") or "").strip()
    if risk_profile:
        cmd.extend(["--risk-profile", risk_profile])
    operator_tier = str(getattr(args, "operator_tier", "") or "").strip()
    if operator_tier:
        cmd.extend(["--operator-tier", operator_tier])
    return cmd


def _write_report(
    *,
    out_dir: Path,
    market: str,
    strategy: str,
    source: str,
    campaign_result: Dict[str, Any],
    handoff_path: Path,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_path = out_dir / f"demo_report_{stamp}.md"

    readiness = campaign_result.get("readiness", {})
    promotion_gate = campaign_result.get("promotion_gate", {})
    ops_summary = (campaign_result.get("ops_health", {}) or {}).get("summary", {})

    lines = [
        "# PQTS Demo Report",
        "",
        f"- Timestamp (UTC): {datetime.now(timezone.utc).isoformat()}",
        f"- Market: `{market}`",
        f"- Strategy Channel Tag: `{strategy}`",
        f"- Attribution Source: `{source}`",
        "",
        "## Simulation Summary",
        "",
        f"- Orders Submitted: {int(campaign_result.get('submitted', 0))}",
        f"- Orders Filled: {int(campaign_result.get('filled', 0))}",
        f"- Orders Rejected: {int(campaign_result.get('rejected', 0))}",
        f"- Reject Rate: {float(campaign_result.get('reject_rate', 0.0)):.4f}",
        f"- Ready for Canary: {bool(readiness.get('ready_for_canary', False))}",
        f"- Promotion Decision: `{promotion_gate.get('decision', 'unknown')}`",
        f"- Ops Critical Alerts: {int(ops_summary.get('critical', 0))}",
        "",
        "## Risk Gates",
        "",
        "- Orders are gated by `RiskAwareRouter.submit_order()` and kill-switch checks.",
        "- Promotion requires readiness + operational health thresholds.",
        "",
        "## Outputs",
        "",
        f"- Handoff Blob: `{handoff_path}`",
        "- Dashboard: `python dashboard/start.py` then open `http://localhost:8050`",
    ]
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--market", choices=["crypto", "equities", "forex", "all"], default="crypto"
    )
    parser.add_argument(
        "--preset",
        choices=["casual", "pro"],
        default="",
        help="Convenience preset for casual or pro launch paths.",
    )
    parser.add_argument(
        "--operator-tier",
        choices=["simple", "pro"],
        default="",
        help="Operator UX tier override (simple or pro).",
    )
    parser.add_argument("--strat", default="ml-ensemble")
    parser.add_argument("--source", default="manual")
    parser.add_argument("--config", default="config/paper.yaml")
    parser.add_argument("--cycles", type=int, default=120)
    parser.add_argument("--sleep-seconds", type=float, default=0.0)
    parser.add_argument("--notional-usd", type=float, default=150.0)
    parser.add_argument("--readiness-every", type=int, default=30)
    parser.add_argument("--lookback-days", type=int, default=60)
    parser.add_argument("--min-days", type=int, default=30)
    parser.add_argument("--min-fills", type=int, default=200)
    parser.add_argument("--max-p95-slippage-bps", type=float, default=20.0)
    parser.add_argument("--max-mape-pct", type=float, default=35.0)
    parser.add_argument(
        "--risk-profile",
        default="",
        help=(
            "Risk tolerance profile override "
            "(conservative, balanced, aggressive, professional, or custom key)."
        ),
    )
    parser.add_argument(
        "--upgrade-url",
        default="https://github.com/jakerslam/pqts",
        help="URL shown for upgrade/next-step funnel tracking.",
    )
    parser.add_argument(
        "--track-upgrade-intent",
        action="store_true",
        help="Log an upgrade intent attribution event.",
    )
    parser.add_argument("--out-dir", default="data/reports")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.preset == "casual":
        args.market = "crypto"
        if args.strat == "ml-ensemble":
            args.strat = "swing-casual"
        if not args.operator_tier:
            args.operator_tier = "simple"
        if not args.risk_profile:
            args.risk_profile = "balanced"
    elif args.preset == "pro":
        args.market = "all"
        if args.strat == "ml-ensemble":
            args.strat = "multi-venue-ensemble"
        if not args.operator_tier:
            args.operator_tier = "pro"
        if not args.risk_profile:
            args.risk_profile = "professional"

    config = _load_yaml(args.config)
    try:
        operator_tier = resolve_operator_tier(config, override=(args.operator_tier or None))
        validate_operator_tier_overrides(
            tier=operator_tier,
            has_market_override=bool(args.market and args.market != "crypto"),
            has_strategy_override=bool(args.strat and args.strat != "ml-ensemble"),
            has_symbol_override=False,
        )
    except ValueError as exc:
        print(f"Invalid operator tier option: {exc}", file=sys.stderr)
        return 2
    symbols = _symbols_for_market(config, args.market)
    cmd = _build_campaign_cmd(args, symbols)

    run = subprocess.run(
        cmd,
        cwd=str(ROOT),
        check=True,
        capture_output=True,
        text=True,
    )
    campaign_result = _parse_json_from_output(run.stdout)
    if not campaign_result:
        raise RuntimeError("Unable to parse campaign result JSON from run_paper_campaign output")

    handoff_blob = build_handoff_blob(
        market=args.market,
        strategy_channel=args.strat,
        campaign_result=campaign_result,
        source=args.source,
    )

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    handoff_path = out_dir / f"handoff_blob_{stamp}.json"
    handoff_path.write_text(json.dumps(handoff_blob, indent=2, sort_keys=True), encoding="utf-8")

    report_path = _write_report(
        out_dir=out_dir,
        market=args.market,
        strategy=args.strat,
        source=args.source,
        campaign_result=campaign_result,
        handoff_path=handoff_path,
    )

    log_event(
        event="demo_run",
        source=args.source,
        metadata={
            "market": args.market,
            "strategy": args.strat,
            "operator_tier": operator_tier.name,
            "report_path": str(report_path),
            "handoff_blob_path": str(handoff_path),
            "submitted": int(campaign_result.get("submitted", 0)),
            "filled": int(campaign_result.get("filled", 0)),
        },
    )

    summary = {
        "report_path": str(report_path),
        "handoff_blob_path": str(handoff_path),
        "dashboard_url": "http://localhost:8050",
        "upgrade_url": str(args.upgrade_url),
        "operator_tier": operator_tier.name,
        "campaign_result": campaign_result,
    }
    if bool(args.track_upgrade_intent):
        log_event(
            event="upgrade_to_protheus",
            source=args.source,
            metadata={
                "upgrade_url": str(args.upgrade_url),
                "preset": str(args.preset or ""),
                "operator_tier": operator_tier.name,
            },
        )
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
