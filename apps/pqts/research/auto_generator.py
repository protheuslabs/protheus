# Auto-Strategy Generator
import logging
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Any
from itertools import product
from dataclasses import dataclass
import hashlib
import json

logger = logging.getLogger(__name__)


@dataclass
class StrategyVariant:
    strategy_id: str
    strategy_type: str
    features: List[str]
    parameters: Dict[str, Any]
    priority: int = 0


class StrategySearchSpace:
    """Defines the search space for auto-strategy generation."""

    def __init__(self):
        self.features = {
            "order_book": [
                "ob_imbalance",
                "ob_depth_ratio",
                "ob_spread",
                "ob_pressure",
                "cancel_rate",
            ],
            "trade_flow": [
                "flow_aggressor_ratio",
                "large_trade_flow",
                "volume_velocity",
                "trade_imbalance",
            ],
            "volatility": [
                "realized_vol_1h",
                "realized_vol_24h",
                "vol_regime",
                "volatility_percentile",
                "atr_ratio",
            ],
            "momentum": ["price_momentum_5m", "price_momentum_1h", "rsi_14", "macd_signal"],
            "microstructure": [
                "kyle_lambda",
                "amihud_illiquidity",
                "price_impact",
                "quote_intensity",
            ],
        }
        self.parameter_spaces = {
            "market_making": {
                "spread_bps": [20, 30, 50, 75, 100],
                "skew_factor": [0.0, 0.25, 0.5, 0.75, 1.0],
            },
            "stat_arb": {"entry_zscore": [1.5, 2.0, 2.5, 3.0], "exit_zscore": [0.3, 0.5, 0.7]},
            "trend_following": {
                "lookback_periods": [10, 20, 50],
                "entry_threshold": [0.5, 1.0, 1.5],
            },
            "swing_trend": {"lookback_periods": [24, 48, 96], "entry_threshold": [0.4, 0.8, 1.2]},
            "hold_carry": {"rebalance_days": [3, 7, 14], "carry_threshold_bps": [5.0, 10.0, 15.0]},
        }
        self.model_types = ["linear", "xgboost", "lightgbm", "neural_net"]


class AutoStrategyGenerator:
    """Automatically generates strategy variants for AI optimization."""

    def __init__(self, search_space: StrategySearchSpace = None):
        self.search_space = search_space or StrategySearchSpace()
        self.generated_variants: List[StrategyVariant] = []
        self.generation_counter = 0
        logger.info("AutoStrategyGenerator initialized")

    def generate_feature_combinations(
        self, strategy_type: str, n_features: int = 3
    ) -> List[List[str]]:
        """Generate combinations of features to test."""
        relevant_groups = self._get_relevant_feature_groups(strategy_type)
        all_features = []
        for group in relevant_groups:
            all_features.extend(self.search_space.features.get(group, []))

        if strategy_type == "market_making":
            return [
                ["ob_imbalance", "vol_regime", "flow_aggressor_ratio"],
                ["ob_spread", "ob_pressure", "cancel_rate"],
                ["vol_regime", "kyle_lambda", "amihud_illiquidity"],
            ]
        elif strategy_type == "stat_arb":
            return [
                ["vol_regime", "realized_vol_1h", "price_momentum_1h"],
                ["price_momentum_5m", "rsi_14", "macd_signal"],
            ]
        elif strategy_type == "swing_trend":
            return [
                ["price_momentum_1h", "rsi_14", "vol_regime"],
                ["macd_signal", "atr_ratio", "volatility_percentile"],
            ]
        elif strategy_type == "hold_carry":
            return [
                ["realized_vol_24h", "atr_ratio", "amihud_illiquidity"],
                ["vol_regime", "kyle_lambda", "price_momentum_1h"],
            ]
        return [all_features[:n_features]]

    def generate_parameter_variants(self, strategy_type: str, n_variants: int = 10) -> List[Dict]:
        """Generate parameter variants for a strategy."""
        param_space = self.search_space.parameter_spaces.get(strategy_type, {})
        if not param_space:
            return [{}]

        variants = []
        if len(param_space) <= 2:
            keys = list(param_space.keys())
            values = [param_space[k] for k in keys]
            for combo in product(*values):
                variant = dict(zip(keys, combo))
                variants.append(variant)
        else:
            import random

            random.seed(42)
            for i in range(n_variants):
                variant = {param: random.choice(options) for param, options in param_space.items()}
                variants.append(variant)
        return variants

    def generate_strategy_variants(
        self, strategy_type: str, n_per_feature_set: int = 5
    ) -> List[StrategyVariant]:
        """Generate complete strategy variants for backtesting."""
        variants = []
        feature_combos = self.generate_feature_combinations(strategy_type)

        for features in feature_combos:
            param_variants = self.generate_parameter_variants(strategy_type, n_per_feature_set)
            for params in param_variants[:n_per_feature_set]:
                self.generation_counter += 1
                variant_str = (
                    f"{strategy_type}_{'_'.join(features[:2])}_{json.dumps(params, sort_keys=True)}"
                )
                variant_id = hashlib.md5(variant_str.encode()).hexdigest()[:8]
                variant = StrategyVariant(
                    strategy_id=f"{strategy_type}_{variant_id}",
                    strategy_type=strategy_type,
                    features=features,
                    parameters=params,
                    priority=n_per_feature_set - len(variants),
                )
                variants.append(variant)

        self.generated_variants.extend(variants)
        logger.info(f"Generated {len(variants)} variants for {strategy_type}")
        return variants

    def _get_relevant_feature_groups(self, strategy_type: str) -> List[str]:
        mapping = {
            "market_making": ["order_book", "trade_flow", "volatility", "microstructure"],
            "stat_arb": ["momentum", "volatility", "microstructure"],
            "trend_following": ["momentum", "volatility"],
            "swing_trend": ["momentum", "volatility", "microstructure"],
            "hold_carry": ["volatility", "microstructure", "trade_flow"],
        }
        return mapping.get(strategy_type, ["order_book", "momentum"])

    def export_variant_config(self, variant: StrategyVariant) -> Dict:
        """Export variant as config dict for PQTS."""
        return {
            "strategy_id": variant.strategy_id,
            "strategy_type": variant.strategy_type,
            "features": variant.features,
            "parameters": variant.parameters,
        }


if __name__ == "__main__":
    generator = AutoStrategyGenerator()
    mm_variants = generator.generate_strategy_variants("market_making", n_per_feature_set=2)
    print(f"Generated {len(mm_variants)} market making variants")
    for v in mm_variants:
        print(f"ID: {v.strategy_id}, Features: {v.features}, Params: {v.parameters}")
