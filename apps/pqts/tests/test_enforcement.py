"""Hard-gate enforcement tests for production order routing and risk controls."""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parent.parent
TESTS_DIR = ROOT / "tests"
SCRIPTS_DIR = ROOT / "scripts"
ROUTER_FILE = ROOT / "execution" / "risk_aware_router.py"
ROUTER_REL = ROUTER_FILE.relative_to(ROOT)

ADAPTER_FILES = {
    (ROOT / "markets" / "crypto" / "binance_adapter.py").relative_to(ROOT),
    (ROOT / "markets" / "crypto" / "coinbase_adapter.py").relative_to(ROOT),
    (ROOT / "markets" / "equities" / "alpaca_adapter.py").relative_to(ROOT),
    (ROOT / "markets" / "forex" / "oanda_adapter.py").relative_to(ROOT),
}

ADAPTER_MODULES = {
    "markets.crypto.binance_adapter",
    "markets.crypto.coinbase_adapter",
    "markets.equities.alpaca_adapter",
    "markets.forex.oanda_adapter",
}

ORDER_ENTRY_NAMES = {"submit_order", "place_order", "create_order", "send_order", "_submit_order"}

sys.path.insert(0, str(ROOT))

from execution.risk_aware_router import RiskAwareRouter, _RouterToken
from markets.crypto.binance_adapter import BinanceAdapter
from markets.crypto.coinbase_adapter import CoinbaseAdapter
from markets.equities.alpaca_adapter import AlpacaAdapter
from markets.forex.oanda_adapter import OandaAdapter
from risk.kill_switches import KillSwitchMonitor, RiskLimits


def _is_under(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _iter_repo_python_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        files.append(path)
    return files


def _parse_tree(path: Path) -> ast.AST:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _adapter_import_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name in ADAPTER_MODULES:
                return alias.name
        return None

    if not isinstance(node, ast.ImportFrom):
        return None

    module = node.module or ""
    if module in ADAPTER_MODULES:
        return module

    for alias in node.names:
        candidate = f"{module}.{alias.name}" if module else alias.name
        if candidate in ADAPTER_MODULES:
            return candidate
    return None


def _build_router() -> RiskAwareRouter:
    router = RiskAwareRouter(
        risk_config=RiskLimits(
            max_daily_loss_pct=0.02,
            max_drawdown_pct=0.15,
            max_gross_leverage=2.0,
        ),
        broker_config={"enabled": True},
    )
    router.set_capital(100000.0, source="test")
    return router


class TestSingleOrderPath:
    def test_submit_order_exists_only_in_risk_aware_router(self):
        violations: list[str] = []

        for path in _iter_repo_python_files():
            if _is_under(path, TESTS_DIR):
                continue
            tree = _parse_tree(path)
            rel = path.relative_to(ROOT)

            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "submit_order":
                    if rel != ROUTER_REL:
                        violations.append(f"{rel}:{node.lineno}")

        assert not violations, (
            "VIOLATION: submit_order() exists outside execution/risk_aware_router.py: "
            f"{violations}"
        )

    def test_no_order_entry_methods_outside_router_and_adapters(self):
        violations: list[str] = []

        for path in _iter_repo_python_files():
            if _is_under(path, TESTS_DIR):
                continue

            rel = path.relative_to(ROOT)
            tree = _parse_tree(path)

            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if node.name not in ORDER_ENTRY_NAMES:
                    continue

                allowed = False
                if node.name == "submit_order":
                    allowed = rel == ROUTER_REL
                elif node.name == "place_order":
                    allowed = rel in ADAPTER_FILES

                if not allowed:
                    violations.append(f"{rel}:{node.lineno}:{node.name}")

        assert not violations, (
            "VIOLATION: order entry method found outside RiskAwareRouter.submit_order "
            f"or token-gated adapters: {violations}"
        )

    def test_no_adapter_imports_outside_router(self):
        allowed_files = {ROUTER_REL, *ADAPTER_FILES}
        violations: list[str] = []

        for path in _iter_repo_python_files():
            if _is_under(path, TESTS_DIR):
                continue

            rel = path.relative_to(ROOT)
            if rel in allowed_files:
                continue

            tree = _parse_tree(path)
            for node in ast.walk(tree):
                adapter_import = _adapter_import_name(node)
                if adapter_import:
                    violations.append(f"{rel}:{adapter_import}")

        assert not violations, (
            "VIOLATION: adapter modules imported outside RiskAwareRouter: "
            f"{violations}"
        )

    def test_place_order_calls_outside_router_are_blocked(self):
        allowed_files = {ROUTER_REL, *ADAPTER_FILES}
        violations: list[str] = []

        for path in _iter_repo_python_files():
            if _is_under(path, TESTS_DIR):
                continue

            rel = path.relative_to(ROOT)
            if rel in allowed_files:
                continue

            tree = _parse_tree(path)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    if node.func.attr == "place_order":
                        violations.append(f"{rel}:{node.lineno}")

        assert not violations, (
            "VIOLATION: .place_order() call found outside RiskAwareRouter/order adapters: "
            f"{violations}"
        )

    def test_no_sys_path_mutation_in_library_modules(self):
        violations: list[str] = []

        for path in _iter_repo_python_files():
            if _is_under(path, TESTS_DIR) or _is_under(path, SCRIPTS_DIR):
                continue
            if path.relative_to(ROOT) == Path("main.py"):
                continue

            rel = path.relative_to(ROOT)
            tree = _parse_tree(path)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if not isinstance(func, ast.Attribute):
                    continue
                if func.attr != "insert":
                    continue
                path_obj = func.value
                if (
                    isinstance(path_obj, ast.Attribute)
                    and path_obj.attr == "path"
                    and isinstance(path_obj.value, ast.Name)
                    and path_obj.value.id == "sys"
                ):
                    violations.append(f"{rel}:{node.lineno}")

        assert not violations, f"VIOLATION: sys.path.insert found in library modules: {violations}"


class TestRouterTokenProtection:
    def test_router_token_direct_construction_is_blocked(self):
        with pytest.raises(RuntimeError):
            _RouterToken()

    def test_router_factory_creates_private_token(self):
        router = _build_router()
        token = router._create_token()
        assert type(token) is _RouterToken
        assert token.router_id == id(router)

    def test_adapter_constructors_require_router_token(self):
        with pytest.raises(RuntimeError):
            BinanceAdapter("k", "s", router_token=None)
        with pytest.raises(RuntimeError):
            CoinbaseAdapter("k", "s", "p", router_token=None)
        with pytest.raises(RuntimeError):
            AlpacaAdapter("k", "s", router_token=None)
        with pytest.raises(RuntimeError):
            OandaAdapter("k", "acct", router_token=None)

        with pytest.raises(RuntimeError):
            BinanceAdapter("k", "s", router_token=object())
        with pytest.raises(RuntimeError):
            CoinbaseAdapter("k", "s", "p", router_token=object())
        with pytest.raises(RuntimeError):
            AlpacaAdapter("k", "s", router_token=object())
        with pytest.raises(RuntimeError):
            OandaAdapter("k", "acct", router_token=object())

    def test_forged_router_token_is_rejected(self):
        forged = object.__new__(_RouterToken)
        object.__setattr__(forged, "router_id", 12345)
        object.__setattr__(forged, "created_at", "forged")
        object.__setattr__(forged, "_proof", object())

        with pytest.raises(RuntimeError):
            BinanceAdapter("k", "s", router_token=forged)
        with pytest.raises(RuntimeError):
            CoinbaseAdapter("k", "s", "p", router_token=forged)
        with pytest.raises(RuntimeError):
            AlpacaAdapter("k", "s", router_token=forged)
        with pytest.raises(RuntimeError):
            OandaAdapter("k", "acct", router_token=forged)

    def test_adapter_place_order_requires_valid_token(self, monkeypatch):
        router = _build_router()
        token = router._create_token()

        async def fake_request(*_args, **_kwargs):
            return {"ok": True}

        binance = BinanceAdapter("k", "s", router_token=token)
        coinbase = CoinbaseAdapter("k", "s", "p", router_token=token)
        alpaca = AlpacaAdapter("k", "s", router_token=token)
        oanda = OandaAdapter("k", "acct", router_token=token)

        for adapter in (binance, coinbase, alpaca, oanda):
            monkeypatch.setattr(adapter, "_request", fake_request)

        with pytest.raises(RuntimeError):
            asyncio.run(
                binance.place_order("BTCUSDT", "buy", "market", 0.01, router_token=object())
            )
        with pytest.raises(RuntimeError):
            asyncio.run(
                coinbase.place_order("BTC-USD", "buy", order_type="market", funds=100, router_token=object())
            )
        with pytest.raises(RuntimeError):
            asyncio.run(
                alpaca.place_order("AAPL", 1, "buy", router_token=object())
            )
        with pytest.raises(RuntimeError):
            asyncio.run(
                oanda.place_order("EUR_USD", 1000, router_token=object())
            )

        assert asyncio.run(binance.place_order("BTCUSDT", "buy", "market", 0.01))["ok"]
        assert asyncio.run(
            coinbase.place_order("BTC-USD", "buy", order_type="market", funds=100)
        )["ok"]
        assert asyncio.run(alpaca.place_order("AAPL", 1, "buy"))["ok"]
        assert asyncio.run(oanda.place_order("EUR_USD", 1000))["ok"]


class TestCapitalInjectionHardStop:
    def test_no_capital_fallback_constant(self):
        risk_dir = ROOT / "risk"
        violations: list[str] = []

        for path in risk_dir.rglob("*.py"):
            if _is_under(path, TESTS_DIR):
                continue

            for idx, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                if "100000" not in line:
                    continue
                if line.strip().startswith("#"):
                    continue
                if any(token in line for token in ("except", "RuntimeError", "try", "fallback")):
                    violations.append(f"{path.relative_to(ROOT)}:{idx}:{line.strip()}")

        assert not violations, (
            "VIOLATION: capital fallback pattern found. Capital must be injected: "
            f"{violations}"
        )

    def test_capital_raises_if_not_set(self):
        monitor = KillSwitchMonitor(RiskLimits(max_daily_loss_pct=0.02))

        with pytest.raises(RuntimeError, match="Capital not set"):
            monitor._get_capital()
