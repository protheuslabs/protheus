"""Autopilot strategy selection with optional AI guidance and human overrides."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional

AUTOPILOT_MODES = {"manual", "auto", "hybrid"}


@dataclass(frozen=True)
class HumanStrategyOverride:
    include: List[str] = field(default_factory=list)
    exclude: List[str] = field(default_factory=list)
    replace_with: Optional[List[str]] = None


@dataclass(frozen=True)
class AutopilotDecision:
    mode: str
    selected_strategies: List[str]
    candidate_scores: Dict[str, float]
    ai_recommendations: List[str]
    reasons: List[str]
    overrides_applied: Dict[str, List[str]]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mode": self.mode,
            "selected_strategies": list(self.selected_strategies),
            "candidate_scores": dict(self.candidate_scores),
            "ai_recommendations": list(self.ai_recommendations),
            "reasons": list(self.reasons),
            "overrides_applied": dict(self.overrides_applied),
        }


class StrategyAutopilot:
    """
    Deterministic autopilot strategy selector.

    `manual`: leaves current strategy set untouched.
    `auto`: AI + config score ranking selects strategy set.
    `hybrid`: preserves existing set, then re-ranks with AI guidance.
    """

    def __init__(self, config: Optional[Mapping[str, Any]] = None):
        cfg = dict(config or {})
        mode = str(cfg.get("mode", "manual")).strip().lower()
        if mode not in AUTOPILOT_MODES:
            raise ValueError(
                f"Invalid autopilot mode '{mode}'. Expected one of {sorted(AUTOPILOT_MODES)}"
            )
        self.mode = mode
        self.min_active = max(int(cfg.get("min_active_strategies", 1)), 1)
        self.max_active = max(int(cfg.get("max_active_strategies", 4)), self.min_active)
        self.ai_rank_weight = float(cfg.get("ai_rank_weight", 1.0))
        self.enabled_bias = float(cfg.get("enabled_bias", 0.25))
        self.complexity_penalty_default = float(cfg.get("complexity_penalty_default", 0.0))
        self.simple_allowlist = {
            str(name).strip()
            for name in cfg.get(
                "simple_strategy_allowlist",
                [
                    "trend_following",
                    "mean_reversion",
                    "swing_trend",
                    "hold_carry",
                ],
            )
            if str(name).strip()
        }
        raw_complexity = cfg.get("complexity_penalty", {}) or {}
        self.complexity_penalty = {str(k): float(v) for k, v in raw_complexity.items()}

    def set_mode(self, mode: str) -> None:
        mode_token = str(mode).strip().lower()
        if mode_token not in AUTOPILOT_MODES:
            raise ValueError(
                f"Invalid autopilot mode '{mode_token}'. Expected one of {sorted(AUTOPILOT_MODES)}"
            )
        self.mode = mode_token

    @staticmethod
    def _extract_ai_recommendations(ai_recommendations: Optional[Iterable[str]]) -> List[str]:
        if ai_recommendations is None:
            return []
        seen = set()
        ordered: List[str] = []
        for name in ai_recommendations:
            token = str(name).strip()
            if not token or token in seen:
                continue
            seen.add(token)
            ordered.append(token)
        return ordered

    def _score_candidates(
        self,
        *,
        strategy_configs: Mapping[str, Mapping[str, Any]],
        current_active: Iterable[str],
        ai_recommendations: List[str],
    ) -> Dict[str, float]:
        active_set = {str(name) for name in current_active}
        ai_rank = {name: idx for idx, name in enumerate(ai_recommendations)}
        max_rank = max(len(ai_recommendations), 1)
        scores: Dict[str, float] = {}

        for strategy_name, cfg in sorted(strategy_configs.items()):
            score = float(cfg.get("autopilot_score", 0.0))
            if strategy_name in active_set:
                score += self.enabled_bias
            if strategy_name in ai_rank:
                # Higher boost for better AI rank.
                score += self.ai_rank_weight * (1.0 - (ai_rank[strategy_name] / max_rank))
            if strategy_name in self.simple_allowlist:
                score += float(cfg.get("simple_access_bonus", 0.20))
            complexity = float(
                cfg.get(
                    "complexity_penalty",
                    self.complexity_penalty.get(strategy_name, self.complexity_penalty_default),
                )
            )
            score -= max(complexity, 0.0)
            scores[strategy_name] = float(score)
        return scores

    @staticmethod
    def _rank_scores(scores: Mapping[str, float]) -> List[str]:
        return [
            name
            for name, _ in sorted(
                scores.items(),
                key=lambda item: (-float(item[1]), str(item[0])),
            )
        ]

    def decide(
        self,
        *,
        strategy_configs: Mapping[str, Mapping[str, Any]],
        current_active: Iterable[str],
        ai_recommendations: Optional[Iterable[str]] = None,
        human_override: Optional[HumanStrategyOverride] = None,
    ) -> AutopilotDecision:
        current = [name for name in current_active if name in strategy_configs]
        ai_ranked = self._extract_ai_recommendations(ai_recommendations)
        scores = self._score_candidates(
            strategy_configs=strategy_configs,
            current_active=current,
            ai_recommendations=ai_ranked,
        )
        ranked = self._rank_scores(scores)
        reasons: List[str] = []
        mode = self.mode

        if mode == "manual":
            selected = list(current)
            reasons.append("manual_mode_preserves_current_set")
        elif mode == "hybrid":
            seed = [name for name in current if name in ranked]
            for name in ranked:
                if len(seed) >= self.max_active:
                    break
                if name not in seed:
                    seed.append(name)
            selected = seed[: self.max_active]
            reasons.append("hybrid_mode_merged_current_with_ranked_candidates")
        else:
            selected = ranked[: self.max_active]
            reasons.append("auto_mode_selected_top_ranked_candidates")

        if len(selected) < self.min_active:
            for name in ranked:
                if name in selected:
                    continue
                selected.append(name)
                if len(selected) >= self.min_active:
                    break
            reasons.append("min_active_enforced")

        applied = {"include": [], "exclude": [], "replace_with": []}
        override = human_override
        if override is not None:
            if override.replace_with is not None:
                selected = [name for name in override.replace_with if str(name) in strategy_configs]
                applied["replace_with"] = [name for name in selected]
                reasons.append("human_override_replace_applied")
            exclude_set = {name for name in override.exclude if name in strategy_configs}
            if exclude_set:
                selected = [name for name in selected if name not in exclude_set]
                applied["exclude"] = sorted(exclude_set)
                reasons.append("human_override_exclude_applied")
            for name in override.include:
                if name not in strategy_configs:
                    continue
                if name not in selected:
                    selected.append(name)
                applied["include"].append(name)
            if applied["include"]:
                reasons.append("human_override_include_applied")

        selected = [name for name in selected if name in strategy_configs]
        selected = selected[: self.max_active]
        if not selected and ranked:
            selected = [ranked[0]]
            reasons.append("fallback_top_strategy_selected")

        return AutopilotDecision(
            mode=mode,
            selected_strategies=selected,
            candidate_scores={name: float(scores[name]) for name in ranked},
            ai_recommendations=ai_ranked,
            reasons=reasons,
            overrides_applied=applied,
        )
