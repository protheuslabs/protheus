# Protheus Quant Trading System
# Quick Start Script

import argparse
import asyncio
import os
import sys

from analytics.dashboard import AnalyticsDashboard
from core.engine import TradingEngine
from core.operator_tier import resolve_operator_tier, validate_operator_tier_overrides
from core.toggle_manager import ToggleValidationError


def _csv_list(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _default_profile_for_tier(engine: TradingEngine, tier_name: str) -> str:
    runtime = engine.config.get("runtime", {})
    presets = runtime.get("operator_mode_presets", {}) if isinstance(runtime, dict) else {}
    if not isinstance(presets, dict):
        presets = {}
    fallback = "casual_core" if str(tier_name) == "simple" else "pro_quant"
    profile = str(presets.get(f"{tier_name}_profile", fallback)).strip()
    profiles = engine.config.get("strategy_profiles", {})
    if not isinstance(profiles, dict):
        return ""
    return profile if profile in profiles else ""


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run PQTS with runtime market/strategy toggles.")
    parser.add_argument(
        "config",
        nargs="?",
        default="config/paper.yaml",
        help="Path to YAML config (default: config/paper.yaml)",
    )
    parser.add_argument(
        "--profile",
        help="Strategy profile name from config.strategy_profiles",
    )
    parser.add_argument(
        "--markets",
        help="Comma-separated active markets (crypto, forex, equities).",
    )
    parser.add_argument(
        "--strategies",
        help="Comma-separated active strategy names.",
    )
    parser.add_argument(
        "--risk-profile",
        help=(
            "Risk tolerance profile override "
            "(conservative, balanced, aggressive, professional, or custom profile key)."
        ),
    )
    parser.add_argument(
        "--show-toggles",
        action="store_true",
        help="Print resolved toggle state and continue startup.",
    )
    parser.add_argument(
        "--operator-tier",
        choices=["simple", "pro"],
        default="",
        help="Operator UX tier override (simple or pro).",
    )
    parser.add_argument(
        "--autopilot-mode",
        choices=["manual", "auto", "hybrid"],
        help="Autopilot strategy selector mode.",
    )
    parser.add_argument(
        "--autopilot-include",
        help="Comma-separated strategy names to force-include after autopilot selection.",
    )
    parser.add_argument(
        "--autopilot-exclude",
        help="Comma-separated strategy names to force-exclude after autopilot selection.",
    )
    parser.add_argument(
        "--autopilot-replace",
        help="Comma-separated strategy names to fully replace autopilot output.",
    )
    return parser


def apply_cli_toggles(engine: TradingEngine, args: argparse.Namespace) -> str:
    has_autopilot_strategy_override = bool(
        args.autopilot_include or args.autopilot_exclude or args.autopilot_replace
    )
    tier = resolve_operator_tier(engine.config, override=(args.operator_tier or None))
    engine.set_operator_tier(tier.name)
    validate_operator_tier_overrides(
        tier=tier,
        has_market_override=bool(args.markets),
        has_strategy_override=bool(args.strategies) or has_autopilot_strategy_override,
        has_symbol_override=False,
    )
    selected_profile = str(args.profile or "").strip()
    if not selected_profile:
        selected_profile = _default_profile_for_tier(engine, tier.name)
    if selected_profile:
        engine.apply_strategy_profile(selected_profile)
    if args.markets:
        engine.set_active_markets(_csv_list(args.markets))
    if args.strategies:
        engine.set_active_strategies(_csv_list(args.strategies))
    if args.autopilot_mode:
        engine.set_autopilot_mode(args.autopilot_mode)
    elif tier.name == "simple":
        engine.set_autopilot_mode("auto")
    if args.autopilot_mode or has_autopilot_strategy_override:
        engine.apply_autopilot_strategy_selection(
            include=_csv_list(args.autopilot_include) if args.autopilot_include else [],
            exclude=_csv_list(args.autopilot_exclude) if args.autopilot_exclude else [],
            replace_with=(
                _csv_list(args.autopilot_replace) if args.autopilot_replace is not None else None
            ),
        )
    if args.risk_profile:
        engine.set_risk_tolerance_profile(args.risk_profile)
    return tier.name


async def main():
    """Main entry point"""
    args = build_arg_parser().parse_args()
    config_path = args.config

    print("=" * 60)
    print("  PROTHEUS QUANT TRADING SYSTEM (PQTS)")
    print("  Paper Trading Mode")
    print("=" * 60)

    if not os.path.exists(config_path):
        print(f"\n❌ Configuration file not found: {config_path}")
        print("\nCreate a config file or use:")
        print("  python main.py config/paper.yaml")
        sys.exit(1)

    # Initialize engine
    engine = TradingEngine(config_path)
    try:
        operator_tier = apply_cli_toggles(engine, args)
    except ToggleValidationError as exc:
        print(f"\n❌ Invalid toggle option: {exc}")
        sys.exit(2)
    except ValueError as exc:
        print(f"\n❌ Invalid operator tier option: {exc}")
        sys.exit(2)

    toggle_state = engine.get_toggle_state()
    active_markets = toggle_state.get("active_markets", [])
    active_strategies = toggle_state.get("active_strategies", [])

    # Initialize dashboard
    dashboard = AnalyticsDashboard(engine.config.get("analytics", {}))

    try:
        print("\n🚀 Starting trading engine...")
        print("   Mode: Paper Trading")
        print(f"   Markets: {', '.join(active_markets) if active_markets else 'none'}")
        print(f"   Strategies: {', '.join(active_strategies) if active_strategies else 'none'}")
        print(f"   Operator Tier: {operator_tier}")
        if args.show_toggles:
            print(f"   Toggle State: {toggle_state}")
        print("\nPress Ctrl+C to stop\n")

        # Start engine
        await engine.start()

    except KeyboardInterrupt:
        print("\n\n🛑 Stopping trading engine...")
        await engine.stop()
        print("✅ Trading engine stopped")

        # Generate final report
        report = dashboard.generate_report()
        print("\n📊 Final Performance Report:")
        dashboard.print_dashboard()


if __name__ == "__main__":
    asyncio.run(main())
