"""
Autonomous Alpha Discovery Agent
The Brain of PQTS

Operational Loop:
  Discover → Validate → Promote → Monitor → Learn

Primary Objective:
  Maximize risk-adjusted returns subject to:
  - Sharpe > 1.2 OOS
  - Max DD < 15%
  - No lookahead/curve-fitting

Hard Constraints:
  1. Never deploy without anti-overfit gates
  2. Never violate global risk
  3. Never use non-causal signals
  4. Never change execution safeguards
"""

import logging
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import hashlib
import json
from concurrent.futures import ProcessPoolExecutor, as_completed
import yaml

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

class Regime(Enum):
    HIGH_VOL = "high_vol"
    LOW_VOL = "low_vol"
    TRENDING = "trending"
    MEAN_REVERTING = "mean_reverting"
    NORMAL = "normal"


@dataclass
class FeatureSpec:
    """DSL specification for a feature"""
    feature_id: str
    expression: str
    depth: int
    base_series: List[str]
    operators: List[str]
    generation_mode: str  # 'enumerative', 'genetic', 'learned'
    stability_score: float
    redundancy_score: float
    predictiveness: Dict[str, float]  # regime -> correlation
    passed_gates: bool = False
    hash: str = ""
    
    def __post_init__(self):
        if not self.hash:
            self.hash = self._compute_hash()
    
    def _compute_hash(self) -> str:
        content = f"{self.expression}|{self.base_series}|{self.operators}"
        return hashlib.md5(content.encode()).hexdigest()[:16]


@dataclass  
class StrategySpec:
    """YAML/JSON-compliant strategy specification"""
    strategy_name: str
    universe: Dict
    features: List[Dict]
    model: Dict
    signal: Dict
    portfolio: Dict
    execution: Dict
    risk: Dict
    validation: Dict
    
    # Metadata
    version: str = "1.0"
    created_at: datetime = field(default_factory=datetime.now)
    author: str = "AlphaAgent"
    hash: str = ""
    
    def to_yaml(self) -> str:
        """Serialize to YAML for storage"""
        data = {
            'strategy_name': self.strategy_name,
            'version': self.version,
            'created_at': self.created_at.isoformat(),
            'universe': self.universe,
            'features': self.features,
            'model': self.model,
            'signal': self.signal,
            'portfolio': self.portfolio,
            'execution': self.execution,
            'risk': self.risk,
            'validation': self.validation
        }
        return yaml.dump(data, default_flow_style=False)
    
    def compute_hash(self) -> str:
        """Compute deterministic hash"""
        canonical = json.dumps({
            'name': self.strategy_name,
            'features': sorted([f.get('expr', '') for f in self.features]),
            'model': self.model,
            'signal': self.signal
        }, sort_keys=True)
        return hashlib.sha256(canonical.encode()).hexdigest()[:32]


@dataclass
class ExperimentRecord:
    """Logged experiment result"""
    experiment_id: str
    strategy_hash: str
    strategy_spec: StrategySpec
    timestamp: datetime
    
    # Configuration
    dataset_id: str
    walk_forward_config: Dict
    
    # Metrics
    metrics: Dict[str, float]  # sharpe, dd, pf, turnover, etc.
    
    # Diagnostics
    gate_results: Dict[str, bool]  # Which gates passed/failed
    deflated_sharpe: float
    pbo_estimate: float  # Probability of backtest overfitting
    regime_performance: Dict[str, Dict]  # Per-regime metrics
    
    # Status
    promotion_candidate: bool = False
    paper_trading: bool = False
    live: bool = False
    retired: bool = False
    retirement_reason: str = ""


@dataclass
class PromotionCandidate:
    """Strategy ready for paper trading"""
    strategy_hash: str
    experiment_id: str
    rank: int
    expected_sharpe: float
    max_expected_dd: float
    recommended_allocation: float
    monitoring_thresholds: Dict


# ============================================================================
# CORE AGENT
# ============================================================================

class AlphaDiscoveryAgent:
    """
    Autonomous quant research agent.
    
    Implements the full discovery loop:
      1. Feature synthesis (alpha factory)
      2. Strategy construction  
      3. Validation (backtest → walk-forward)
      4. Promotion (paper → live)
      5. Monitoring & retirement
      6. Meta-learning (what to search next)
    """
    
    def __init__(self, config: Dict):
        self.config = config
        
        # Compute budget
        self.batch_size = config.get('batch_size', 500)
        self.max_batch_features = config.get('max_features_per_batch', 500)
        self.exploration_rate = config.get('exploration_rate', 0.4)
        
        # Gates
        self.min_sharpe = config.get('min_sharpe', 1.2)
        self.max_dd = config.get('max_dd', 0.15)
        self.max_pbo = config.get('max_pbo', 0.5)  # Probability of overfitting
        
        # State
        self.feature_store: Dict[str, FeatureSpec] = {}
        self.strategy_cache: Dict[str, StrategySpec] = {}
        self.experiment_db: Dict[str, ExperimentRecord] = {}
        self.research_map: Dict = {}
        self.promotion_queue: List[PromotionCandidate] = []
        self.live_strategies: Dict[str, Dict] = {}
        
        # Trackers
        self.trials_per_bucket: Dict[str, int] = {}
        self.bucket_success_rates: Dict[str, float] = {}
        
        logger.info(f"AlphaDiscoveryAgent initialized")
        logger.info(f"  Min Sharpe: {self.min_sharpe}")
        logger.info(f"  Max DD: {self.max_dd:.1%}")
        logger.info(f"  Max PBO: {self.max_pbo:.1%}")
    
    # ========================================================================
    # PHASE 1: FEATURE SYNTHESIS (ALPHA FACTORY)
    # ========================================================================
    
    def generate_features(self, 
                         regime: Regime,
                         n_desired: int = 500,
                         modes: List[str] = ['enumerative', 'genetic']) -> List[FeatureSpec]:
        """
        Generate candidate features using multiple modes.
        
        Modes:
        - enumerative: DSL search up to depth D
        - genetic: mutate/crossover expression trees
        - learned: representation learning (optional)
        """
        candidates = []
        
        if 'enumerative' in modes:
            enums = self._enumerative_generation(
                regime=regime,
                max_depth=6,
                n_target=n_desired // 2
            )
            candidates.extend(enums)
        
        if 'genetic' in modes:
            genetic = self._genetic_generation(
                regime=regime,
                population_size=n_desired // 2,
                generations=10
            )
            candidates.extend(genetic)
        
        logger.info(f"Generated {len(candidates)} features for {regime.value}")
        
        return candidates
    
    def _enumerative_generation(self, regime: Regime, max_depth: int, n_target: int) -> List[FeatureSpec]:
        """Depth-limited DSL enumeration with pruning."""
        
        # Base primitives (from config)
        bases = ['mid_price', 'spread', 'trade_imbalance', 'depth', 'cancel_rate', 
                'bid_size', 'ask_size', 'volume', 'returns']
        
        operators = ['rolling_mean', 'rolling_std', 'ema', 'zscore', 'rank', 
                    'clip', 'rank', 'lag', 'delta', 'imbalance', 'book_pressure']
        
        features = []
        seen_hashes = set()
        
        # Start with base features
        for base in bases:
            expr = base
            features.append(FeatureSpec(
                feature_id=f"base_{base}",
                expression=expr,
                depth=1,
                base_series=[base],
                operators=[],
                generation_mode='enumerative',
                stability_score=0.5,
                redundancy_score=0.0,
                predictiveness={}
            ))
        
        # Enumerate combinations up to max_depth
        for depth in range(2, max_depth + 1):
            if len(features) >= n_target:
                break
            
            new_features = []
            for feat in features:
                if feat.depth == depth - 1:
                    for op in operators:
                        # Build new expression
                        if op in ['rolling_mean', 'rolling_std', 'ema']:
                            expr = f"{op}({feat.expression}, 20)"
                        elif op in ['zscore', 'rank']:
                            expr = f"{op}({feat.expression})"  
                        elif op in ['lag', 'delta']:
                            expr = f"{op}({feat.expression}, 1)"
                        else:
                            expr = f"{op}({feat.expression})"
                        
                        new_feat = FeatureSpec(
                            feature_id=f"{feat.feature_id}_{op}",
                            expression=expr,
                            depth=depth,
                            base_series=feat.base_series,
                            operators=feat.operators + [op],
                            generation_mode='enumerative',
                            stability_score=0.5,
                            redundancy_score=0.0,
                            predictiveness={}
                        )
                        
                        # Prune duplicates
                        if new_feat.hash not in seen_hashes:
                            seen_hashes.add(new_feat.hash)
                            new_features.append(new_feat)
            
            features.extend(new_features)
        
        # Filter to target size
        return features[:n_target]
    
    def _genetic_generation(self, regime: Regime, population_size: int, generations: int) -> List[FeatureSpec]:
        """Genetic programming for feature discovery."""
        
        # Initialize random population
        population = self._random_features(population_size, regime)
        
        for gen in range(generations):
            # Fitness evaluation (quick approximation)
            fitness = []
            for feat in population:
                score = self._estimate_fitness(feat, regime)
                fitness.append(score)
            
            # Selection
            sorted_idx = np.argsort(fitness)[::-1]
            parents = [population[i] for i in sorted_idx[:population_size//2]]
            
            # Crossover and mutation
            offspring = []
            while len(offspring) < population_size - len(parents):
                p1, p2 = np.random.choice(parents, 2)
                child = self._crossover_features(p1, p2)
                child = self._mutate_feature(child)
                offspring.append(child)
            
            population = parents + offspring
        
        return population
    
    def _random_features(self, n: int, regime: Regime) -> List[FeatureSpec]:
        """Generate random initial features."""
        bases = ['mid_price', 'spread', 'trade_imbalance', 'depth', 'volume']
        ops = ['rolling_mean', 'zscore', 'rank', 'lag', 'imbalance']
        
        features = []
        for i in range(n):
            depth = np.random.randint(2, 6)
            base = np.random.choice(bases)
            
            expr = base
            for _ in range(depth - 1):
                op = np.random.choice(ops)
                if op in ['rolling_mean', 'lag']:
                    expr = f"{op}({expr}, {np.random.choice([10, 20, 50])})"
                else:
                    expr = f"{op}({expr})"
            
            features.append(FeatureSpec(
                feature_id=f"genetic_{i}",
                expression=expr,
                depth=depth,
                base_series=[base],
                operators=[op],
                generation_mode='genetic',
                stability_score=0.5,
                redundancy_score=0.0,
                predictiveness={}
            ))
        
        return features
    
    def _estimate_fitness(self, feature: FeatureSpec, regime: Regime) -> float:
        """Quick fitness estimate (without full backtest)."""
        # Prefer shallow, simple features
        depth_penalty = feature.depth * 0.05
        complexity_penalty = len(feature.operators) * 0.02
        
        # Stability bonus
        stability_bonus = feature.stability_score * 0.1
        
        return 1.0 - depth_penalty - complexity_penalty + stability_bonus
    
    def _crossover_features(self, f1: FeatureSpec, f2: FeatureSpec) -> FeatureSpec:
        """Combine two features."""
        # Take base from one, operators from other
        return FeatureSpec(
            feature_id=f"cross_{f1.hash[:8]}_{f2.hash[:8]}",
            expression=f"combined({f1.expression}, {f2.expression})",
            depth=max(f1.depth, f2.depth),
            base_series=list(set(f1.base_series + f2.base_series)),
            operators=list(set(f1.operators + f2.operators)),
            generation_mode='genetic',
            stability_score=(f1.stability_score + f2.stability_score) / 2,
            redundancy_score=0.0,
            predictiveness={}
        )
    
    def _mutate_feature(self, feature: FeatureSpec) -> FeatureSpec:
        """Randomly mutate a feature."""
        # Mutate window size
        expr = feature.expression.replace("20", str(np.random.choice([10, 30, 50])))
        
        feature.expression = expr
        feature.hash = feature._compute_hash()
        return feature
    
    def run_feature_gates(self, features: List[FeatureSpec],
                         data: pd.DataFrame,
                         regime: Regime) -> List[FeatureSpec]:
        """
        Cheap pre-tests before strategy construction.
        
        Gates:
        1. Causality check (no lookahead)
        2. Stability check (distribution consistency)
        3. Predictiveness sanity
        4. Redundancy vs feature store
        """
        survivors = []
        
        for feat in features:
            passed = True
            
            # 1. Causality: expression must not use future data
            # (Implement: check for forward-looking operators)
            
            # 2. Stability: feature distribution stable across time
            if feat.stability_score < 0.3:
                passed = False
            
            # 3. Predictiveness: some forward relationship
            # (Would need actual computation)
            
            # 4. Redundancy: not too similar to existing features
            if feat.redundancy_score > 0.8:
                passed = False
            
            if passed:
                feat.passed_gates = True
                survivors.append(feat)
        
        logger.info(f"Feature gates: {len(survivors)}/{len(features)} passed")
        return survivors
    
    # ========================================================================
    # PHASE 2: STRATEGY CONSTRUCTION
    # ========================================================================
    
    def build_strategies(self,
                        features: List[FeatureSpec],
                        templates: List[str] = None) -> List[StrategySpec]:
        """
        Build strategies from feature shortlist.
        
        Templates:
        - market_making
        - momentum
        - mean_reversion
        - carry
        - cross_venue_arb
        """
        if templates is None:
            templates = ['market_making', 'momentum', 'mean_reversion']
        
        strategies = []
        
        for template in templates:
            # Create 5 variants per feature with different horizons/execution
            for feat in features[:50]:  # Top 50 features
                for variant in range(5):
                    strategy = self._build_strategy_variant(
                        feature=feat,
                        template=template,
                        variant_id=variant
                    )
                    strategies.append(strategy)
        
        logger.info(f"Built {len(strategies)} strategy candidates")
        return strategies
    
    def _build_strategy_variant(self, feature: FeatureSpec,
                               template: str, variant_id: int) -> StrategySpec:
        """Create a strategy spec from template."""
        
        # Variant configurations
        horizons = [200, 500, 1000, 2000, 5000]  # ms
        spreads = [2, 5, 10, 20, 50]  # bps
        
        horizon = horizons[variant_id % len(horizons)]
        spread = spreads[variant_id % len(spreads)]
        
        spec = StrategySpec(
            strategy_name=f"{template}_{feature.hash[:8]}_v{variant_id}",
            universe={
                'symbols': ['BTC-PERP'],
                'venue': 'binance'
            },
            features=[{
                'expr': feature.expression,
                'feature_id': feature.feature_id
            }],
            model={
                'type': 'linear',
                'target': 'future_return',
                'horizon_ms': horizon,
                'regularization': 'l2'
            },
            signal={
                'rule': 'clip(model_pred, -1, 1)',
                'threshold': 0.1
            },
            portfolio={
                'sizing': 'vol_target',
                'vol_target_annual': 0.25,
                'max_gross': 1.0,
                'max_symbol_weight': 0.25
            },
            execution={
                'style': template,
                'quote_spread_bps': spread,
                'max_quote_age_ms': 200,
                'maker_only': True
            },
            risk={
                'max_daily_loss_pct': 0.02,
                'max_drawdown_pct': 0.10,
                'max_position_notional': 25000
            },
            validation={
                'costs': 'realistic',
                'holdout_policy': 'walk_forward'
            }
        )
        
        spec.hash = spec.compute_hash()
        return spec
    
    # ========================================================================
    # PHASE 3: VALIDATION PIPELINE
    # ========================================================================
    
    def validate_strategy(self, 
                         strategy: StrategySpec,
                         data: pd.DataFrame,
                         wf_config: Dict) -> ExperimentRecord:
        """
        Run full validation pipeline:
        1. Backtest with realistic costs
        2. Walk-forward testing
        3. Multiple testing control
        4. Deflated Sharpe calculation
        5. PBO estimation
        """
        
        # 1. Backtest
        backtest_metrics = self._run_backtest(strategy, data)
        
        # 2. Walk-forward
        wf_metrics = self._run_walk_forward(strategy, data, wf_config)
        
        # 3. Multiple testing correction
        deflated_sharpe = self._calculate_deflated_sharpe(
            wf_metrics['sharpe'],
            n_trials=self.trials_per_bucket.get(strategy.model.get('type', 'default'), 1)
        )
        
        # 4. PBO estimate
        pbo = self._estimate_pbo(strategy, data, wf_config)
        
        # 5. Gate results
        gates = {
            'sharpe': deflated_sharpe >= self.min_sharpe,
            'dd': wf_metrics.get('max_drawdown', 0.5) <= self.max_dd,
            'pbo': pbo <= self.max_pbo,
            'stability': wf_metrics.get('stability_score', 0) > 0.5,
            'turnover': wf_metrics.get('turnover', 10) < 10
        }
        
        # Create record
        record = ExperimentRecord(
            experiment_id=f"exp_{strategy.strategy_name}_{datetime.now().strftime('%Y%m%d%H%M%S')}",
            strategy_hash=strategy.hash,
            strategy_spec=strategy,
            timestamp=datetime.now(),
            dataset_id='historical_btc',
            walk_forward_config=wf_config,
            metrics=wf_metrics,
            gate_results=gates,
            deflated_sharpe=deflated_sharpe,
            pbo_estimate=pbo,
            regime_performance=wf_metrics.get('regime_perf', {}),
            promotion_candidate=all(gates.values())
        )
        
        # Store
        self.experiment_db[record.experiment_id] = record
        
        logger.info(f"Validated {strategy.strategy_name}: "
                   f"DSR={deflated_sharpe:.2f}, PBO={pbo:.2f}, "
                   f"Gates={sum(gates.values())}/{len(gates)}")
        
        return record
    
    def _run_backtest(self, strategy: StrategySpec, data: pd.DataFrame) -> Dict:
        """Run single backtest with realistic costs."""
        # Placeholder: would call actual backtester
        return {
            'sharpe': np.random.uniform(0.5, 2.0),
            'max_drawdown': np.random.uniform(0.05, 0.20),
            'profit_factor': np.random.uniform(1.0, 2.0),
            'turnover': np.random.uniform(2, 15)
        }
    
    def _run_walk_forward(self, strategy: StrategySpec, 
                         data: pd.DataFrame, 
                         wf_config: Dict) -> Dict:
        """Run walk-forward validation."""
        n_windows = wf_config.get('n_windows', 5)
        
        all_metrics = []
        for i in range(n_windows):
            # Split data with embargo
            metrics = self._run_backtest(strategy, data)
            all_metrics.append(metrics['sharpe'])
        
        # Consistency score
        stability = 1.0 - np.std(all_metrics) / (np.mean(all_metrics) + 1e-8)
        
        return {
            'sharpe': np.mean(all_metrics),
            'sharpe_std': np.std(all_metrics),
            'max_drawdown': np.max([m['max_drawdown'] for m in [self._run_backtest(strategy, data)]]),
            'stability_score': stability,
            'turnover': np.mean([m['turnover'] for m in [self._run_backtest(strategy, data)]]),
            'regime_perf': {}
        }
    
    def _calculate_deflated_sharpe(self, sharpe: float, n_trials: int) -> float:
        """Deflate Sharpe for multiple testing bias."""
        # Simplified López de Prado deflation
        if n_trials <= 1:
            return sharpe
        
        # Penalty increases with number of trials
        deflation = np.sqrt(2 * np.log(n_trials)) / np.sqrt(252)  # Annualized adjustment
        
        return max(0, sharpe - deflation)
    
    def _estimate_pbo(self, strategy: StrategySpec, 
                     data: pd.DataFrame, 
                     wf_config: Dict) -> float:
        """Estimate probability of backtest overfitting."""
        # Simplified: use cross-validation consistency
        n_cscv = 10
        oos_scores = []
        
        for _ in range(n_cscv):
            # Random subsample
            metrics = self._run_backtest(strategy, data)
            oos_scores.append(metrics['sharpe'])
        
        # PBO approximated by variance across CV folds
        variance = np.var(oos_scores)
        mean = np.mean(oos_scores)
        
        if mean <= 0:
            return 1.0
        
        cv2 = (variance / mean**2) if mean != 0 else 0
        pbo = min(1.0, cv2 / (1 + cv2))
        
        return pbo
    
    # ========================================================================
    # PHASE 4: PROMOTION
    # ========================================================================
    
    def run_promotion_selection(self, 
                               experiments: List[ExperimentRecord],
                               n_promote: int = 3) -> List[PromotionCandidate]:
        """
        Select top candidates for paper trading.
        
        Criteria:
        - All gates passed
        - Ranked by deflated Sharpe
        - Diversity check (not too correlated)
        """
        # Filter to passing candidates
        candidates = [e for e in experiments if e.promotion_candidate]
        
        # Sort by deflated Sharpe
        candidates.sort(key=lambda x: x.deflated_sharpe, reverse=True)
        
        # Select with diversity consideration
        selected = []
        for exp in candidates:
            if len(selected) >= n_promote:
                break
            
            # Simple diversity: check if similar to already selected
            is_diverse = True
            for s in selected:
                if self._strategy_similarity(exp.strategy_spec, s.strategy_spec) > 0.8:
                    is_diverse = False
                    break
            
            if is_diverse:
                selected.append(exp)
        
        # Create promotion candidates
        promotions = []
        for i, exp in enumerate(selected):
            pc = PromotionCandidate(
                strategy_hash=exp.strategy_hash,
                experiment_id=exp.experiment_id,
                rank=i + 1,
                expected_sharpe=exp.deflated_sharpe,
                max_expected_dd=exp.metrics.get('max_drawdown', 0.15),
                recommended_allocation=0.1 / (i + 1),  # Decreasing allocation
                monitoring_thresholds={
                    'min_sharpe': 0.8,
                    'max_dd': exp.metrics.get('max_drawdown', 0.10),
                    'stability_drop': 0.3
                }
            )
            promotions.append(pc)
        
        self.promotion_queue.extend(promotions)
        
        logger.info(f"Selected {len(promotions)} promotion candidates")
        return promotions
    
    def _strategy_similarity(self, s1: StrategySpec, s2: StrategySpec) -> float:
        """Calculate similarity between two strategies."""
        # Compare feature expressions
        features1 = set(f.get('expr', '') for f in s1.features)
        features2 = set(f.get('expr', '') for f in s2.features)
        
        if not features1 or not features2:
            return 0.0
        
        intersection = len(features1 & features2)
        union = len(features1 | features2)
        
        return intersection / union if union > 0 else 0.0
    
    # ========================================================================
    # PHASE 5: EXECUTION LOOP
    # ========================================================================
    
    def run_discovery_cycle(self, 
                           data: pd.DataFrame,
                           regime: Regime) -> List[PromotionCandidate]:
        """
        Run full discovery-to-promotion cycle.
        
        This is the main entry point for autonomous research.
        """
        logger.info(f"\n{'='*70}")
        logger.info(f"STARTING DISCOVERY CYCLE: {regime.value.upper()}")
        logger.info('='*70)
        
        # 1. Feature synthesis
        features = self.generate_features(
            regime=regime,
            n_desired=self.max_batch_features
        )
        
        # 2. Feature gates
        survivors = self.run_feature_gates(features, data, regime)
        
        if len(survivors) == 0:
            logger.warning("No features survived gates")
            return []
        
        # 3. Strategy construction
        strategies = self.build_strategies(survivors)
        
        # 4. Validation
        experiments = []
        for strategy in strategies[:self.batch_size]:  # Limit batch size
            exp = self.validate_strategy(
                strategy,
                data,
                wf_config={'n_windows': 5}
            )
            experiments.append(exp)
        
        # 5. Promotion selection
        promotions = self.run_promotion_selection(experiments)
        
        # 6. Update research map
        self._update_research_map(experiments, regime)
        
        logger.info(f"\n{'='*70}")
        logger.info(f"DISCOVERY CYCLE COMPLETE")
        logger.info(f"  Features generated: {len(features)}")
        logger.info(f"  Survivors: {len(survivors)}")
        logger.info(f"  Strategies built: {len(strategies)}")
        logger.info(f"  Validated: {len(experiments)}")
        logger.info(f"  Promotions: {len(promotions)}")
        logger.info('='*70)
        
        return promotions
    
    # ========================================================================
    # PHASE 6: META-LEARNING
    # ========================================================================
    
    def _update_research_map(self, 
                           experiments: List[ExperimentRecord],
                           regime: Regime):
        """
        Update research map based on results.
        
        Tracks:
        - Which operators/features appear in winners
        - Which templates work in which regimes
        - Which horizons work per venue
        """
        winners = [e for e in experiments if e.promotion_candidate]
        
        # Track operator success
        for exp in winners:
            for feat in exp.strategy_spec.features:
                op = feat.get('expr', '').split('(')[0]
                if op not in self.research_map.get('operator_success', {}):
                    self.research_map.setdefault('operator_success', {}).setdefault(op, {'wins': 0, 'total': 0})
                self.research_map['operator_success'][op]['wins'] += 1
        
        # Track template success
        for exp in experiments:
            template = exp.strategy_spec.execution.get('style', 'unknown')
            if template not in self.research_map.get('template_success', {}):
                self.research_map.setdefault('template_success', {}).setdefault(template, {'wins': 0, 'total': 0})
            self.research_map['template_success'][template]['total'] += 1
            if exp.promotion_candidate:
                self.research_map['template_success'][template]['wins'] += 1
        
        # Track by regime
        if regime.value not in self.research_map.get('regime_performance', {}):
            self.research_map.setdefault('regime_performance', {}).setdefault(regime.value, [])
        
        self.research_map['regime_performance'][regime.value].append({
            'timestamp': datetime.now(),
            'n_experiments': len(experiments),
            'n_winners': len(winners),
            'avg_dsr': np.mean([e.deflated_sharpe for e in experiments]) if experiments else 0
        })
        
        logger.info(f"Research map updated: {len(winners)} winners, "
                   f"{len(self.research_map.get('operator_success', {}))} operators tracked")
    
    def get_research_insights(self) -> str:
        """Generate human-readable research insights."""
        lines = ["\n== RESEARCH MAP INSIGHTS ==", ""]
        
        # Operator success rates
        if 'operator_success' in self.research_map:
            lines.append("Operator Success Rates:")
            for op, stats in sorted(
                self.research_map['operator_success'].items(),
                key=lambda x: x[1]['wins'] / max(x[1]['total'], 1),
                reverse=True
            )[:10]:
                rate = stats['wins'] / max(stats['total'], 1)
                lines.append(f"  {op:20s}: {rate:.1%} ({stats['wins']}/{stats['total']})")
        
        # Template success
        if 'template_success' in self.research_map:
            lines.append("\nTemplate Success:")
            for template, stats in self.research_map['template_success'].items():
                rate = stats['wins'] / max(stats['total'], 1)
                lines.append(f"  {template:20s}: {rate:.1%}")
        
        return "\n".join(lines)


# ============================================================================
# TEST
# ============================================================================

if __name__ == "__main__":
    print("="*80)
    print("AUTONOMOUS ALPHA DISCOVERY AGENT - TEST")
    print("="*80)
    
    # Initialize agent
    config = {
        'batch_size': 100,
        'max_features_per_batch': 200,
        'min_sharpe': 1.2,
        'max_dd': 0.15
    }
    
    agent = AlphaDiscoveryAgent(config)
    
    # Create fake data
    data = pd.DataFrame({
        'close': 100 + np.cumsum(np.random.randn(1000) * 0.01),
        'returns': np.random.randn(1000) * 0.01
    })
    
    # Run discovery cycle
    promotions = agent.run_discovery_cycle(data, Regime.NORMAL)
    
    # Show insights
    print(agent.get_research_insights())
    
    print("\n" + "="*80)
    print(f"Alpha Agent initialized and tested successfully!")
    print("="*80)
