use chrono::{DateTime, Duration, NaiveDate, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueuePressure {
    pub pressure: String,
    pub pending: f64,
    pub pending_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanInput {
    pub queue_pressure: QueuePressure,
    pub min_cells: u32,
    pub max_cells: u32,
    pub current_cells: u32,
    pub run_interval_minutes: f64,
    pub idle_release_minutes: f64,
    pub autopause_active: bool,
    pub last_run_minutes_ago: Option<f64>,
    pub last_high_pressure_minutes_ago: Option<f64>,
    pub trit_shadow_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanOutput {
    pub action: String,
    pub reason: String,
    pub pressure: String,
    pub pending: f64,
    pub pending_ratio: f64,
    pub current_cells: u32,
    pub target_cells: u32,
    pub warning_pressure: bool,
    pub high_pressure: bool,
    pub pressure_active: bool,
    pub cooldown_active: bool,
    pub idle_release_ready: bool,
    pub budget_blocked: bool,
    pub trit_shadow_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BatchMaxInput {
    pub enabled: bool,
    pub max_batch: u32,
    pub daily_remaining: Option<u32>,
    pub pressure: String,
    pub current_cells: u32,
    pub budget_blocked: bool,
    pub trit_shadow_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BatchMaxOutput {
    pub max: u32,
    pub reason: String,
    pub pressure: String,
    pub current_cells: u32,
    pub budget_blocked: bool,
    pub trit_shadow_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DynamicCapsInput {
    pub enabled: bool,
    pub base_daily_cap: u32,
    #[serde(default)]
    pub base_canary_cap: Option<u32>,
    pub candidate_pool_size: u32,
    pub queue_pressure: String,
    pub policy_hold_level: String,
    pub policy_hold_applicable: bool,
    pub spawn_boost_enabled: bool,
    pub spawn_boost_active: bool,
    pub shipped_today: f64,
    pub no_progress_streak: f64,
    pub gate_exhaustion_streak: f64,
    pub warn_factor: f64,
    pub critical_factor: f64,
    pub min_input_pool: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DynamicCapsOutput {
    pub enabled: bool,
    pub daily_runs_cap: u32,
    pub canary_daily_exec_cap: Option<u32>,
    pub input_candidates_cap: Option<u32>,
    #[serde(rename = "inputCandidateCap")]
    pub input_candidate_cap_alias: Option<u32>,
    pub low_yield: bool,
    pub high_yield: bool,
    pub spawn_reset_active: bool,
    pub queue_pressure: String,
    pub policy_hold_level: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenUsageInput {
    #[serde(default)]
    pub selected_model_tokens_est: Option<f64>,
    #[serde(default)]
    pub route_budget_request_tokens_est: Option<f64>,
    #[serde(default)]
    pub route_tokens_est: Option<f64>,
    #[serde(default)]
    pub fallback_est_tokens: Option<f64>,
    #[serde(default)]
    pub metrics_prompt_tokens: Option<f64>,
    #[serde(default)]
    pub metrics_input_tokens: Option<f64>,
    #[serde(default)]
    pub metrics_completion_tokens: Option<f64>,
    #[serde(default)]
    pub metrics_output_tokens: Option<f64>,
    #[serde(default)]
    pub metrics_total_tokens: Option<f64>,
    #[serde(default)]
    pub metrics_tokens_used: Option<f64>,
    #[serde(default)]
    pub metrics_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenUsageOutput {
    pub available: bool,
    pub source: String,
    pub actual_prompt_tokens: Option<f64>,
    pub actual_completion_tokens: Option<f64>,
    pub actual_total_tokens: Option<f64>,
    pub estimated_tokens: f64,
    pub effective_tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeQueueInput {
    #[serde(default)]
    pub pressure: Option<String>,
    #[serde(default)]
    pub pending: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub pending_ratio: Option<f64>,
    pub warn_pending_count: f64,
    pub critical_pending_count: f64,
    pub warn_pending_ratio: f64,
    pub critical_pending_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeQueueOutput {
    pub pressure: String,
    pub pending: f64,
    pub total: f64,
    pub pending_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaGateInput {
    #[serde(default)]
    pub min_count: Option<f64>,
    #[serde(default)]
    pub total_count: Option<f64>,
    #[serde(default)]
    pub contract_not_allowed_count: Option<f64>,
    #[serde(default)]
    pub unsupported_count: Option<f64>,
    #[serde(default)]
    pub structurally_supported_count: Option<f64>,
    #[serde(default)]
    pub contract_violation_count: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaGateOutput {
    pub pass: bool,
    pub reasons: Vec<String>,
    pub min_count: f64,
    pub total_count: f64,
    pub supported_count: f64,
    pub unsupported_count: f64,
    pub contract_violation_count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructuralPreviewCriteriaFailureInput {
    #[serde(default)]
    pub primary_failure: Option<String>,
    #[serde(default)]
    pub contract_not_allowed_count: Option<f64>,
    #[serde(default)]
    pub unsupported_count: Option<f64>,
    #[serde(default)]
    pub total_count: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructuralPreviewCriteriaFailureOutput {
    pub has_failure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldInput {
    pub target: String,
    pub gate_decision: String,
    pub route_decision: String,
    pub needs_manual_review: bool,
    pub executable: bool,
    #[serde(default)]
    pub budget_reason: String,
    #[serde(default)]
    pub route_reason: String,
    pub budget_blocked_flag: bool,
    pub budget_global_blocked: bool,
    pub budget_enforcement_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldOutput {
    pub hold: bool,
    pub hold_scope: Option<String>,
    pub hold_reason: Option<String>,
    pub route_block_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldResultInput {
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldResultOutput {
    pub is_policy_hold: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldRunEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub policy_hold: Option<bool>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldRunEventOutput {
    pub is_policy_hold_run_event: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreOnlyResultInput {
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreOnlyResultOutput {
    pub is_score_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreOnlyFailureLikeInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub preview_verification_present: Option<bool>,
    #[serde(default)]
    pub preview_verification_passed: Option<bool>,
    #[serde(default)]
    pub preview_verification_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreOnlyFailureLikeOutput {
    pub is_failure_like: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GateExhaustedAttemptInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GateExhaustedAttemptOutput {
    pub is_gate_exhausted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsecutiveGateExhaustedAttemptEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsecutiveGateExhaustedAttemptsInput {
    #[serde(default)]
    pub events: Vec<ConsecutiveGateExhaustedAttemptEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsecutiveGateExhaustedAttemptsOutput {
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunsSinceResetEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunsSinceResetIndexInput {
    #[serde(default)]
    pub events: Vec<RunsSinceResetEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunsSinceResetIndexOutput {
    pub start_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptEventIndexEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptEventIndicesInput {
    #[serde(default)]
    pub events: Vec<AttemptEventIndexEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptEventIndicesOutput {
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapacityCountedAttemptIndexEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub policy_hold: Option<bool>,
    #[serde(default)]
    pub proposal_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapacityCountedAttemptIndicesInput {
    #[serde(default)]
    pub events: Vec<CapacityCountedAttemptIndexEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapacityCountedAttemptIndicesOutput {
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsecutiveNoProgressEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsecutiveNoProgressRunsInput {
    #[serde(default)]
    pub events: Vec<ConsecutiveNoProgressEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsecutiveNoProgressRunsOutput {
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShippedCountEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShippedCountInput {
    #[serde(default)]
    pub events: Vec<ShippedCountEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShippedCountOutput {
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutedCountByRiskEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub proposal_risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutedCountByRiskInput {
    #[serde(default)]
    pub events: Vec<ExecutedCountByRiskEventInput>,
    #[serde(default)]
    pub risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutedCountByRiskOutput {
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunResultTallyEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunResultTallyInput {
    #[serde(default)]
    pub events: Vec<RunResultTallyEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunResultTallyOutput {
    pub counts: std::collections::BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SortedCountsInput {
    #[serde(default)]
    pub counts: std::collections::BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SortedCountItem {
    pub result: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SortedCountsOutput {
    pub items: Vec<SortedCountItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeProposalStatusInput {
    #[serde(default)]
    pub raw_status: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeProposalStatusOutput {
    pub normalized_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalStatusForQueuePressureInput {
    #[serde(default)]
    pub overlay_decision: Option<String>,
    #[serde(default)]
    pub proposal_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalStatusForQueuePressureOutput {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalStatusInput {
    #[serde(default)]
    pub overlay_decision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalStatusOutput {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinutesSinceTsInput {
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinutesSinceTsOutput {
    #[serde(default)]
    pub minutes_since: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DateWindowInput {
    #[serde(default)]
    pub end_date_str: Option<String>,
    #[serde(default)]
    pub days: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DateWindowOutput {
    #[serde(default)]
    pub dates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InWindowInput {
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub end_date_str: Option<String>,
    #[serde(default)]
    pub days: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InWindowOutput {
    pub in_window: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartOfNextUtcDayInput {
    #[serde(default)]
    pub date_str: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartOfNextUtcDayOutput {
    #[serde(default)]
    pub iso_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsoAfterMinutesInput {
    #[serde(default)]
    pub minutes: Option<f64>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsoAfterMinutesOutput {
    #[serde(default)]
    pub iso_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceHistoryMatchInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub event_capability_key: Option<String>,
    #[serde(default)]
    pub event_proposal_type: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceHistoryMatchOutput {
    pub matched: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceCooldownKeyInput {
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceCooldownKeyOutput {
    pub cooldown_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneWeightsInput {
    #[serde(default)]
    pub pressure: Option<String>,
    pub critical_weight: f64,
    pub standard_weight: f64,
    pub explore_weight: f64,
    pub quarantine_weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneWeightsOutput {
    pub critical: f64,
    pub standard: f64,
    pub explore: f64,
    pub quarantine: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalOutcomeStatusInput {
    #[serde(default)]
    pub overlay_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalOutcomeStatusOutput {
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueueUnderflowBackfillInput {
    pub underflow_backfill_max: f64,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub overlay_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueueUnderflowBackfillOutput {
    pub allow: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalRiskScoreInput {
    #[serde(default)]
    pub explicit_risk_score: Option<f64>,
    #[serde(default)]
    pub risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalRiskScoreOutput {
    pub risk_score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalScoreInput {
    pub impact_weight: f64,
    pub risk_penalty: f64,
    pub age_hours: f64,
    pub is_stub: bool,
    pub no_change_count: f64,
    pub reverted_count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalScoreOutput {
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalAdmissionPreviewInput {
    #[serde(default)]
    pub admission_preview: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalAdmissionPreviewOutput {
    #[serde(default)]
    pub preview: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImpactWeightInput {
    #[serde(default)]
    pub expected_impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImpactWeightOutput {
    pub weight: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RiskPenaltyInput {
    #[serde(default)]
    pub risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RiskPenaltyOutput {
    pub penalty: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EstimateTokensInput {
    #[serde(default)]
    pub expected_impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EstimateTokensOutput {
    pub est_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalRemediationDepthInput {
    #[serde(default)]
    pub remediation_depth: Option<f64>,
    #[serde(default)]
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalRemediationDepthOutput {
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDedupKeyInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub source_eye_id: Option<String>,
    #[serde(default)]
    pub remediation_kind: Option<String>,
    #[serde(default)]
    pub proposal_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDedupKeyOutput {
    pub dedup_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticTokenSimilarityInput {
    #[serde(default)]
    pub left_tokens: Vec<String>,
    #[serde(default)]
    pub right_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticTokenSimilarityOutput {
    pub similarity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticContextComparableInput {
    #[serde(default)]
    pub left_proposal_type: Option<String>,
    #[serde(default)]
    pub right_proposal_type: Option<String>,
    #[serde(default)]
    pub left_source_eye: Option<String>,
    #[serde(default)]
    pub right_source_eye: Option<String>,
    #[serde(default)]
    pub left_objective_id: Option<String>,
    #[serde(default)]
    pub right_objective_id: Option<String>,
    #[serde(default)]
    pub require_same_type: bool,
    #[serde(default)]
    pub require_shared_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticContextComparableOutput {
    pub comparable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticNearDuplicateFingerprintInput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub source_eye: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub token_stems: Vec<String>,
    #[serde(default)]
    pub eligible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticNearDuplicateMatchInput {
    pub fingerprint: SemanticNearDuplicateFingerprintInput,
    #[serde(default)]
    pub seen_fingerprints: Vec<SemanticNearDuplicateFingerprintInput>,
    #[serde(default)]
    pub min_similarity: f64,
    #[serde(default)]
    pub require_same_type: bool,
    #[serde(default)]
    pub require_shared_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticNearDuplicateMatchOutput {
    pub matched: bool,
    pub similarity: f64,
    pub proposal_id: Option<String>,
    pub proposal_type: Option<String>,
    pub source_eye: Option<String>,
    pub objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyRankScoreInput {
    pub composite_weight: f64,
    pub actionability_weight: f64,
    pub directive_fit_weight: f64,
    pub signal_quality_weight: f64,
    pub expected_value_weight: f64,
    pub value_density_weight: f64,
    pub risk_penalty_weight: f64,
    pub time_to_value_weight: f64,
    pub composite: f64,
    pub actionability: f64,
    pub directive_fit: f64,
    pub signal_quality: f64,
    pub expected_value: f64,
    pub value_density: f64,
    pub risk_penalty: f64,
    pub time_to_value: f64,
    pub non_yield_penalty: f64,
    pub collective_shadow_penalty: f64,
    pub collective_shadow_bonus: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyRankScoreOutput {
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExpectedValueSignalInput {
    #[serde(default)]
    pub explicit_score: Option<f64>,
    #[serde(default)]
    pub expected_value_usd: Option<f64>,
    #[serde(default)]
    pub oracle_priority_score: Option<f64>,
    pub impact_weight: f64,
    #[serde(default)]
    pub selected_currency: Option<String>,
    pub currency_multiplier: f64,
    pub matched_first_sentence_contains_selected: bool,
    pub currency_ranking_enabled: bool,
    pub oracle_applies: bool,
    pub oracle_pass: bool,
    pub rank_blend: f64,
    pub bonus_cap: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExpectedValueSignalOutput {
    pub score: f64,
    pub base_score: f64,
    pub source: String,
    pub value_oracle_priority: Option<f64>,
    pub currency_adjusted_score: Option<f64>,
    pub currency_delta: f64,
    pub oracle_applies: bool,
    pub oracle_pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValueSignalScoreInput {
    pub expected_value: f64,
    pub time_to_value: f64,
    pub actionability: f64,
    pub directive_fit: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValueSignalScoreOutput {
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyRankAdjustedInput {
    pub base: f64,
    pub pulse_score: f64,
    pub pulse_weight: f64,
    pub objective_allocation_score: f64,
    pub base_objective_weight: f64,
    pub canary_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyRankAdjustedBonus {
    pub pulse_weight: f64,
    pub pulse_score: f64,
    pub objective_weight: f64,
    pub objective_allocation_score: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyRankAdjustedOutput {
    pub adjusted: f64,
    pub bonus: StrategyRankAdjustedBonus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TritShadowRankScoreInput {
    pub score: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TritShadowRankScoreOutput {
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyCircuitCooldownInput {
    #[serde(default)]
    pub last_error_code: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    pub http_429_cooldown_hours: f64,
    pub http_5xx_cooldown_hours: f64,
    pub dns_error_cooldown_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyCircuitCooldownOutput {
    pub cooldown_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyTritShadowAdjustedInput {
    pub base_score: f64,
    pub bonus_raw: f64,
    pub bonus_blend: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyTritShadowAdjustedOutput {
    pub adjusted_score: f64,
    pub bonus_applied: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NonYieldPenaltyScoreInput {
    pub policy_hold_rate: f64,
    pub no_progress_rate: f64,
    pub stop_rate: f64,
    pub shipped_rate: f64,
    pub policy_hold_weight: f64,
    pub no_progress_weight: f64,
    pub stop_weight: f64,
    pub shipped_relief_weight: f64,
    pub max_penalty: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NonYieldPenaltyScoreOutput {
    pub penalty: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectiveShadowAdjustmentsInput {
    pub penalty_raw: f64,
    pub bonus_raw: f64,
    pub max_penalty: f64,
    pub max_bonus: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectiveShadowAdjustmentsOutput {
    pub penalty: f64,
    pub bonus: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyTritShadowRankRowInput {
    pub index: u32,
    pub proposal_id: String,
    pub legacy_rank: f64,
    pub trit_rank: f64,
    pub trit_label: String,
    pub trit_confidence: f64,
    #[serde(default)]
    pub trit_top_sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyTritShadowRankingSummaryInput {
    #[serde(default)]
    pub rows: Vec<StrategyTritShadowRankRowInput>,
    #[serde(default)]
    pub selected_proposal_id: Option<String>,
    #[serde(default)]
    pub selection_mode: Option<String>,
    pub top_k: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyTritShadowRankingSummaryOutput {
    pub considered: u32,
    #[serde(default)]
    pub selection_mode: Option<String>,
    #[serde(default)]
    pub selected_proposal_id: Option<String>,
    #[serde(default)]
    pub legacy_top_proposal_id: Option<String>,
    #[serde(default)]
    pub trit_top_proposal_id: Option<String>,
    pub diverged_from_legacy_top: bool,
    pub diverged_from_selected: bool,
    #[serde(default)]
    pub top: Vec<StrategyTritShadowRankRowInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShadowScopeMatchesInput {
    #[serde(default)]
    pub scope_type: Option<String>,
    #[serde(default)]
    pub scope_value: Option<String>,
    #[serde(default)]
    pub risk_levels: Vec<String>,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShadowScopeMatchesOutput {
    pub matched: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectiveShadowAggregateEntryInput {
    #[serde(default)]
    pub kind: Option<String>,
    pub confidence: f64,
    pub score_impact: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectiveShadowAggregateInput {
    #[serde(default)]
    pub entries: Vec<CollectiveShadowAggregateEntryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectiveShadowAggregateOutput {
    pub matches: u32,
    pub confidence_avg: f64,
    pub penalty_raw: f64,
    pub bonus_raw: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositeEligibilityScoreInput {
    pub quality_score: f64,
    pub directive_fit_score: f64,
    pub actionability_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositeEligibilityScoreOutput {
    pub score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimeToValueScoreInput {
    #[serde(default)]
    pub time_to_cash_hours: Option<f64>,
    #[serde(default)]
    pub expected_impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimeToValueScoreOutput {
    pub score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValueDensityScoreInput {
    pub expected_value: f64,
    pub est_tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValueDensityScoreOutput {
    pub score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierWeightInput {
    #[serde(default)]
    pub tier: Option<f64>,
    #[serde(default)]
    pub fallback: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierWeightOutput {
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeDirectiveTierInput {
    #[serde(default)]
    pub raw_tier: Option<f64>,
    #[serde(default)]
    pub fallback: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeDirectiveTierOutput {
    pub tier: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierMinShareInput {
    #[serde(default)]
    pub tier: Option<f64>,
    #[serde(default)]
    pub fallback: Option<f64>,
    #[serde(default)]
    pub t1_min_share: f64,
    #[serde(default)]
    pub t2_min_share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierMinShareOutput {
    pub min_share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierCoverageBonusInput {
    #[serde(default)]
    pub tier: Option<f64>,
    #[serde(default)]
    pub fallback: Option<f64>,
    #[serde(default)]
    pub attempts_today: f64,
    #[serde(default)]
    pub current_for_tier: f64,
    #[serde(default)]
    pub t1_min_share: f64,
    #[serde(default)]
    pub t2_min_share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierCoverageBonusOutput {
    pub bonus: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierReservationNeedInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub attempts_today: f64,
    #[serde(default)]
    pub tier1_attempts: f64,
    #[serde(default)]
    pub tier2_attempts: f64,
    #[serde(default)]
    pub tier1_min_share: f64,
    #[serde(default)]
    pub tier2_min_share: f64,
    #[serde(default)]
    pub candidate_tiers: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTierReservationNeedOutput {
    pub reserve: bool,
    #[serde(default)]
    pub tier: Option<u32>,
    #[serde(default)]
    pub min_share: Option<f64>,
    pub attempts_today: f64,
    #[serde(default)]
    pub current_tier_attempts: Option<f64>,
    #[serde(default)]
    pub required_after_next: Option<f64>,
    #[serde(default)]
    pub candidate_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PulseObjectiveCooldownActiveInput {
    #[serde(default)]
    pub no_progress_streak: f64,
    #[serde(default)]
    pub no_progress_limit: f64,
    #[serde(default)]
    pub last_attempt_ts: Option<String>,
    #[serde(default)]
    pub cooldown_hours: f64,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PulseObjectiveCooldownActiveOutput {
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTokenHitsInput {
    #[serde(default)]
    pub text_tokens: Vec<String>,
    #[serde(default)]
    pub text_stems: Vec<String>,
    #[serde(default)]
    pub directive_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveTokenHitsOutput {
    #[serde(default)]
    pub hits: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToStemInput {
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToStemOutput {
    pub stem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeDirectiveTextInput {
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeDirectiveTextOutput {
    pub normalized: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenizeDirectiveTextInput {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub stopwords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenizeDirectiveTextOutput {
    #[serde(default)]
    pub tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeSpacesInput {
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeSpacesOutput {
    pub normalized: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseLowerListInput {
    #[serde(default)]
    pub list: Vec<String>,
    #[serde(default)]
    pub csv: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseLowerListOutput {
    #[serde(default)]
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CanaryFailedChecksAllowedInput {
    #[serde(default)]
    pub failed_checks: Vec<String>,
    #[serde(default)]
    pub allowed_checks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CanaryFailedChecksAllowedOutput {
    pub allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalTextBlobEvidenceEntryInput {
    #[serde(default)]
    pub evidence_ref: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalTextBlobInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub suggested_next_command: Option<String>,
    #[serde(default)]
    pub suggested_command: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub evidence: Vec<ProposalTextBlobEvidenceEntryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalTextBlobOutput {
    pub blob: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PercentMentionsFromTextInput {
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PercentMentionsFromTextOutput {
    #[serde(default)]
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OptimizationMinDeltaPercentInput {
    #[serde(default)]
    pub high_accuracy_mode: bool,
    #[serde(default)]
    pub high_accuracy_value: f64,
    #[serde(default)]
    pub base_value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OptimizationMinDeltaPercentOutput {
    pub min_delta_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceEyeRefInput {
    #[serde(default)]
    pub meta_source_eye: Option<String>,
    #[serde(default)]
    pub first_evidence_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceEyeRefOutput {
    pub eye_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizedRiskInput {
    #[serde(default)]
    pub risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizedRiskOutput {
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseIsoTsInput {
    #[serde(default)]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseIsoTsOutput {
    #[serde(default)]
    pub timestamp_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractObjectiveIdTokenInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractObjectiveIdTokenOutput {
    #[serde(default)]
    pub objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionReserveSnapshotInput {
    pub cap: f64,
    pub used: f64,
    pub reserve_enabled: bool,
    pub reserve_ratio: f64,
    pub reserve_min_tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionReserveSnapshotOutput {
    pub enabled: bool,
    pub reserve_tokens: f64,
    pub reserve_remaining: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetPacingGateInput {
    pub est_tokens: f64,
    pub value_signal_score: f64,
    #[serde(default)]
    pub risk: Option<String>,
    pub snapshot_tight: bool,
    pub snapshot_autopause_active: bool,
    pub snapshot_remaining_ratio: f64,
    #[serde(default)]
    pub snapshot_pressure: Option<String>,
    pub execution_floor_deficit: bool,
    pub execution_reserve_enabled: bool,
    pub execution_reserve_remaining: f64,
    pub execution_reserve_min_value_signal: f64,
    pub budget_pacing_enabled: bool,
    pub min_remaining_ratio: f64,
    pub high_token_threshold: f64,
    pub min_value_signal_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetPacingGateOutput {
    pub pass: bool,
    #[serde(default)]
    pub reason: Option<String>,
    pub execution_reserve_bypass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityCapInput {
    #[serde(default)]
    pub caps: std::collections::BTreeMap<String, f64>,
    #[serde(default)]
    pub primary_key: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityCapOutput {
    #[serde(default)]
    pub cap: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EstimateTokensForCandidateInput {
    pub direct_est_tokens: f64,
    pub route_tokens_est: f64,
    pub fallback_estimate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EstimateTokensForCandidateOutput {
    pub est_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneUsageEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub selection_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneUsageInput {
    #[serde(default)]
    pub events: Vec<QosLaneUsageEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneUsageOutput {
    pub critical: u32,
    pub standard: u32,
    pub explore: u32,
    pub quarantine: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneShareCapExceededInput {
    #[serde(default)]
    pub lane: Option<String>,
    pub explore_usage: f64,
    pub quarantine_usage: f64,
    pub executed_count: f64,
    pub explore_max_share: f64,
    pub quarantine_max_share: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneShareCapExceededOutput {
    pub exceeded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneFromCandidateInput {
    pub queue_underflow_backfill: bool,
    pub pulse_tier: i64,
    #[serde(default)]
    pub proposal_type: Option<String>,
    pub deprioritized_source: bool,
    #[serde(default)]
    pub risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QosLaneFromCandidateOutput {
    pub lane: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EyeOutcomeEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub evidence_ref: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EyeOutcomeWindowCountInput {
    #[serde(default)]
    pub events: Vec<EyeOutcomeEventInput>,
    #[serde(default)]
    pub eye_ref: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub end_date_str: Option<String>,
    #[serde(default)]
    pub days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EyeOutcomeWindowCountOutput {
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EyeOutcomeLastHoursCountInput {
    #[serde(default)]
    pub events: Vec<EyeOutcomeEventInput>,
    #[serde(default)]
    pub eye_ref: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub hours: Option<f64>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EyeOutcomeLastHoursCountOutput {
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoProgressResultInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoProgressResultOutput {
    pub is_no_progress: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptRunEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptRunEventOutput {
    pub is_attempt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SafetyStopRunEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SafetyStopRunEventOutput {
    pub is_safety_stop: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NonYieldCategoryInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub policy_hold: Option<bool>,
    #[serde(default)]
    pub hold_reason: Option<String>,
    #[serde(default)]
    pub route_block_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NonYieldCategoryOutput {
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NonYieldReasonInput {
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub hold_reason: Option<String>,
    #[serde(default)]
    pub route_block_reason: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NonYieldReasonOutput {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalTypeFromRunEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalTypeFromRunEventOutput {
    pub proposal_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunEventObjectiveIdInput {
    #[serde(default)]
    pub directive_pulse_present: Option<bool>,
    #[serde(default)]
    pub directive_pulse_objective_id: Option<String>,
    #[serde(default)]
    pub objective_id_present: Option<bool>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub objective_binding_present: Option<bool>,
    #[serde(default)]
    pub objective_binding_objective_id: Option<String>,
    #[serde(default)]
    pub top_escalation_present: Option<bool>,
    #[serde(default)]
    pub top_escalation_objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunEventObjectiveIdOutput {
    pub objective_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunEventProposalIdInput {
    #[serde(default)]
    pub proposal_id_present: Option<bool>,
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub selected_proposal_id_present: Option<bool>,
    #[serde(default)]
    pub selected_proposal_id: Option<String>,
    #[serde(default)]
    pub top_escalation_present: Option<bool>,
    #[serde(default)]
    pub top_escalation_proposal_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunEventProposalIdOutput {
    pub proposal_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapacityCountedAttemptEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub policy_hold: Option<bool>,
    #[serde(default)]
    pub proposal_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapacityCountedAttemptEventOutput {
    pub capacity_counted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RepeatGateAnchorInput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub objective_binding_present: Option<bool>,
    #[serde(default)]
    pub objective_binding_pass: Option<bool>,
    #[serde(default)]
    pub objective_binding_required: Option<bool>,
    #[serde(default)]
    pub objective_binding_source: Option<String>,
    #[serde(default)]
    pub objective_binding_valid: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RepeatGateAnchorBindingOutput {
    pub pass: bool,
    pub required: bool,
    pub objective_id: String,
    pub source: String,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RepeatGateAnchorOutput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub objective_binding: Option<RepeatGateAnchorBindingOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteExecutionPolicyHoldInput {
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub gate_decision: Option<String>,
    #[serde(default)]
    pub route_decision_raw: Option<String>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub needs_manual_review: Option<bool>,
    #[serde(default)]
    pub executable: Option<bool>,
    #[serde(default)]
    pub budget_block_reason: Option<String>,
    #[serde(default)]
    pub budget_enforcement_reason: Option<String>,
    #[serde(default)]
    pub budget_global_reason: Option<String>,
    #[serde(default)]
    pub summary_reason: Option<String>,
    #[serde(default)]
    pub route_reason: Option<String>,
    #[serde(default)]
    pub budget_blocked: Option<bool>,
    #[serde(default)]
    pub budget_global_blocked: Option<bool>,
    #[serde(default)]
    pub budget_enforcement_blocked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldPressureEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub policy_hold: Option<bool>,
    #[serde(default)]
    pub ts_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldPressureInput {
    #[serde(default)]
    pub events: Vec<PolicyHoldPressureEventInput>,
    #[serde(default)]
    pub window_hours: Option<f64>,
    #[serde(default)]
    pub min_samples: Option<f64>,
    #[serde(default)]
    pub now_ms: Option<f64>,
    #[serde(default)]
    pub warn_rate: Option<f64>,
    #[serde(default)]
    pub hard_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldPressureOutput {
    pub window_hours: f64,
    pub min_samples: f64,
    pub samples: u32,
    pub policy_holds: u32,
    pub rate: f64,
    pub level: String,
    pub applicable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldPatternEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub hold_reason: Option<String>,
    #[serde(default)]
    pub route_block_reason: Option<String>,
    #[serde(default)]
    pub policy_hold: Option<bool>,
    #[serde(default)]
    pub ts_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldPatternInput {
    #[serde(default)]
    pub events: Vec<PolicyHoldPatternEventInput>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub window_hours: Option<f64>,
    #[serde(default)]
    pub repeat_threshold: Option<f64>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldPatternOutput {
    pub objective_id: Option<String>,
    pub window_hours: f64,
    pub repeat_threshold: f64,
    pub total_holds: u32,
    pub top_reason: Option<String>,
    pub top_count: u32,
    pub by_reason: std::collections::BTreeMap<String, u32>,
    pub should_dampen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldLatestEventEntryInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub policy_hold: Option<bool>,
    #[serde(default)]
    pub ts_ms: Option<f64>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub hold_reason: Option<String>,
    #[serde(default)]
    pub route_block_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldLatestEventInput {
    #[serde(default)]
    pub events: Vec<PolicyHoldLatestEventEntryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldLatestEventOutput {
    pub found: bool,
    pub event_index: Option<u32>,
    pub result: Option<String>,
    pub ts: Option<String>,
    pub ts_ms: Option<f64>,
    pub hold_reason: Option<String>,
    pub route_block_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldCooldownInput {
    #[serde(default)]
    pub base_minutes: Option<f64>,
    #[serde(default)]
    pub pressure_level: Option<String>,
    #[serde(default)]
    pub pressure_applicable: Option<bool>,
    #[serde(default)]
    pub last_result: Option<String>,
    #[serde(default)]
    pub now_ms: Option<f64>,
    #[serde(default)]
    pub cooldown_warn_minutes: Option<f64>,
    #[serde(default)]
    pub cooldown_hard_minutes: Option<f64>,
    #[serde(default)]
    pub cooldown_cap_minutes: Option<f64>,
    #[serde(default)]
    pub cooldown_manual_review_minutes: Option<f64>,
    #[serde(default)]
    pub cooldown_unchanged_state_minutes: Option<f64>,
    #[serde(default)]
    pub readiness_retry_minutes: Option<f64>,
    #[serde(default)]
    pub until_next_day_caps: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldCooldownOutput {
    pub cooldown_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReceiptVerdictInput {
    pub decision: String,
    pub exec_ok: bool,
    pub postconditions_ok: bool,
    pub dod_passed: bool,
    pub success_criteria_required: bool,
    pub success_criteria_passed: bool,
    pub queue_outcome_logged: bool,
    #[serde(default)]
    pub route_attestation_status: String,
    #[serde(default)]
    pub route_attestation_expected_model: String,
    #[serde(default)]
    pub success_criteria_primary_failure: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReceiptCheck {
    pub name: String,
    pub pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReceiptVerdictOutput {
    pub exec_check_name: String,
    pub checks: Vec<ReceiptCheck>,
    pub failed: Vec<String>,
    pub passed: bool,
    pub outcome: String,
    pub primary_failure: Option<String>,
    pub route_attestation_mismatch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutoscaleRequest {
    pub mode: String,
    #[serde(default)]
    pub plan_input: Option<PlanInput>,
    #[serde(default)]
    pub batch_input: Option<BatchMaxInput>,
    #[serde(default)]
    pub dynamic_caps_input: Option<DynamicCapsInput>,
    #[serde(default)]
    pub token_usage_input: Option<TokenUsageInput>,
    #[serde(default)]
    pub normalize_queue_input: Option<NormalizeQueueInput>,
    #[serde(default)]
    pub criteria_gate_input: Option<CriteriaGateInput>,
    #[serde(default)]
    pub structural_preview_criteria_failure_input: Option<StructuralPreviewCriteriaFailureInput>,
    #[serde(default)]
    pub policy_hold_input: Option<PolicyHoldInput>,
    #[serde(default)]
    pub policy_hold_result_input: Option<PolicyHoldResultInput>,
    #[serde(default)]
    pub policy_hold_run_event_input: Option<PolicyHoldRunEventInput>,
    #[serde(default)]
    pub score_only_result_input: Option<ScoreOnlyResultInput>,
    #[serde(default)]
    pub score_only_failure_like_input: Option<ScoreOnlyFailureLikeInput>,
    #[serde(default)]
    pub gate_exhausted_attempt_input: Option<GateExhaustedAttemptInput>,
    #[serde(default)]
    pub consecutive_gate_exhausted_attempts_input: Option<ConsecutiveGateExhaustedAttemptsInput>,
    #[serde(default)]
    pub runs_since_reset_index_input: Option<RunsSinceResetIndexInput>,
    #[serde(default)]
    pub attempt_event_indices_input: Option<AttemptEventIndicesInput>,
    #[serde(default)]
    pub capacity_counted_attempt_indices_input: Option<CapacityCountedAttemptIndicesInput>,
    #[serde(default)]
    pub consecutive_no_progress_runs_input: Option<ConsecutiveNoProgressRunsInput>,
    #[serde(default)]
    pub shipped_count_input: Option<ShippedCountInput>,
    #[serde(default)]
    pub executed_count_by_risk_input: Option<ExecutedCountByRiskInput>,
    #[serde(default)]
    pub run_result_tally_input: Option<RunResultTallyInput>,
    #[serde(default)]
    pub qos_lane_usage_input: Option<QosLaneUsageInput>,
    #[serde(default)]
    pub qos_lane_share_cap_exceeded_input: Option<QosLaneShareCapExceededInput>,
    #[serde(default)]
    pub qos_lane_from_candidate_input: Option<QosLaneFromCandidateInput>,
    #[serde(default)]
    pub eye_outcome_count_window_input: Option<EyeOutcomeWindowCountInput>,
    #[serde(default)]
    pub eye_outcome_count_last_hours_input: Option<EyeOutcomeLastHoursCountInput>,
    #[serde(default)]
    pub sorted_counts_input: Option<SortedCountsInput>,
    #[serde(default)]
    pub normalize_proposal_status_input: Option<NormalizeProposalStatusInput>,
    #[serde(default)]
    pub proposal_status_for_queue_pressure_input: Option<ProposalStatusForQueuePressureInput>,
    #[serde(default)]
    pub proposal_status_input: Option<ProposalStatusInput>,
    #[serde(default)]
    pub minutes_since_ts_input: Option<MinutesSinceTsInput>,
    #[serde(default)]
    pub date_window_input: Option<DateWindowInput>,
    #[serde(default)]
    pub in_window_input: Option<InWindowInput>,
    #[serde(default)]
    pub start_of_next_utc_day_input: Option<StartOfNextUtcDayInput>,
    #[serde(default)]
    pub iso_after_minutes_input: Option<IsoAfterMinutesInput>,
    #[serde(default)]
    pub execute_confidence_history_match_input: Option<ExecuteConfidenceHistoryMatchInput>,
    #[serde(default)]
    pub execute_confidence_cooldown_key_input: Option<ExecuteConfidenceCooldownKeyInput>,
    #[serde(default)]
    pub qos_lane_weights_input: Option<QosLaneWeightsInput>,
    #[serde(default)]
    pub proposal_outcome_status_input: Option<ProposalOutcomeStatusInput>,
    #[serde(default)]
    pub queue_underflow_backfill_input: Option<QueueUnderflowBackfillInput>,
    #[serde(default)]
    pub proposal_risk_score_input: Option<ProposalRiskScoreInput>,
    #[serde(default)]
    pub proposal_score_input: Option<ProposalScoreInput>,
    #[serde(default)]
    pub proposal_admission_preview_input: Option<ProposalAdmissionPreviewInput>,
    #[serde(default)]
    pub impact_weight_input: Option<ImpactWeightInput>,
    #[serde(default)]
    pub risk_penalty_input: Option<RiskPenaltyInput>,
    #[serde(default)]
    pub estimate_tokens_input: Option<EstimateTokensInput>,
    #[serde(default)]
    pub proposal_remediation_depth_input: Option<ProposalRemediationDepthInput>,
    #[serde(default)]
    pub proposal_dedup_key_input: Option<ProposalDedupKeyInput>,
    #[serde(default)]
    pub semantic_token_similarity_input: Option<SemanticTokenSimilarityInput>,
    #[serde(default)]
    pub semantic_context_comparable_input: Option<SemanticContextComparableInput>,
    #[serde(default)]
    pub semantic_near_duplicate_match_input: Option<SemanticNearDuplicateMatchInput>,
    #[serde(default)]
    pub strategy_rank_score_input: Option<StrategyRankScoreInput>,
    #[serde(default)]
    pub strategy_rank_adjusted_input: Option<StrategyRankAdjustedInput>,
    #[serde(default)]
    pub trit_shadow_rank_score_input: Option<TritShadowRankScoreInput>,
    #[serde(default)]
    pub strategy_circuit_cooldown_input: Option<StrategyCircuitCooldownInput>,
    #[serde(default)]
    pub strategy_trit_shadow_adjusted_input: Option<StrategyTritShadowAdjustedInput>,
    #[serde(default)]
    pub non_yield_penalty_score_input: Option<NonYieldPenaltyScoreInput>,
    #[serde(default)]
    pub collective_shadow_adjustments_input: Option<CollectiveShadowAdjustmentsInput>,
    #[serde(default)]
    pub strategy_trit_shadow_ranking_summary_input: Option<StrategyTritShadowRankingSummaryInput>,
    #[serde(default)]
    pub shadow_scope_matches_input: Option<ShadowScopeMatchesInput>,
    #[serde(default)]
    pub collective_shadow_aggregate_input: Option<CollectiveShadowAggregateInput>,
    #[serde(default)]
    pub expected_value_signal_input: Option<ExpectedValueSignalInput>,
    #[serde(default)]
    pub value_signal_score_input: Option<ValueSignalScoreInput>,
    #[serde(default)]
    pub composite_eligibility_score_input: Option<CompositeEligibilityScoreInput>,
    #[serde(default)]
    pub time_to_value_score_input: Option<TimeToValueScoreInput>,
    #[serde(default)]
    pub value_density_score_input: Option<ValueDensityScoreInput>,
    #[serde(default)]
    pub normalize_directive_tier_input: Option<NormalizeDirectiveTierInput>,
    #[serde(default)]
    pub directive_tier_weight_input: Option<DirectiveTierWeightInput>,
    #[serde(default)]
    pub directive_tier_min_share_input: Option<DirectiveTierMinShareInput>,
    #[serde(default)]
    pub directive_tier_coverage_bonus_input: Option<DirectiveTierCoverageBonusInput>,
    #[serde(default)]
    pub directive_tier_reservation_need_input: Option<DirectiveTierReservationNeedInput>,
    #[serde(default)]
    pub pulse_objective_cooldown_active_input: Option<PulseObjectiveCooldownActiveInput>,
    #[serde(default)]
    pub directive_token_hits_input: Option<DirectiveTokenHitsInput>,
    #[serde(default)]
    pub to_stem_input: Option<ToStemInput>,
    #[serde(default)]
    pub normalize_directive_text_input: Option<NormalizeDirectiveTextInput>,
    #[serde(default)]
    pub tokenize_directive_text_input: Option<TokenizeDirectiveTextInput>,
    #[serde(default)]
    pub normalize_spaces_input: Option<NormalizeSpacesInput>,
    #[serde(default)]
    pub parse_lower_list_input: Option<ParseLowerListInput>,
    #[serde(default)]
    pub canary_failed_checks_allowed_input: Option<CanaryFailedChecksAllowedInput>,
    #[serde(default)]
    pub proposal_text_blob_input: Option<ProposalTextBlobInput>,
    #[serde(default)]
    pub percent_mentions_from_text_input: Option<PercentMentionsFromTextInput>,
    #[serde(default)]
    pub optimization_min_delta_percent_input: Option<OptimizationMinDeltaPercentInput>,
    #[serde(default)]
    pub source_eye_ref_input: Option<SourceEyeRefInput>,
    #[serde(default)]
    pub normalized_risk_input: Option<NormalizedRiskInput>,
    #[serde(default)]
    pub parse_iso_ts_input: Option<ParseIsoTsInput>,
    #[serde(default)]
    pub extract_objective_id_token_input: Option<ExtractObjectiveIdTokenInput>,
    #[serde(default)]
    pub execution_reserve_snapshot_input: Option<ExecutionReserveSnapshotInput>,
    #[serde(default)]
    pub budget_pacing_gate_input: Option<BudgetPacingGateInput>,
    #[serde(default)]
    pub capability_cap_input: Option<CapabilityCapInput>,
    #[serde(default)]
    pub estimate_tokens_for_candidate_input: Option<EstimateTokensForCandidateInput>,
    #[serde(default)]
    pub no_progress_result_input: Option<NoProgressResultInput>,
    #[serde(default)]
    pub attempt_run_event_input: Option<AttemptRunEventInput>,
    #[serde(default)]
    pub safety_stop_run_event_input: Option<SafetyStopRunEventInput>,
    #[serde(default)]
    pub non_yield_category_input: Option<NonYieldCategoryInput>,
    #[serde(default)]
    pub non_yield_reason_input: Option<NonYieldReasonInput>,
    #[serde(default)]
    pub proposal_type_from_run_event_input: Option<ProposalTypeFromRunEventInput>,
    #[serde(default)]
    pub run_event_objective_id_input: Option<RunEventObjectiveIdInput>,
    #[serde(default)]
    pub run_event_proposal_id_input: Option<RunEventProposalIdInput>,
    #[serde(default)]
    pub capacity_counted_attempt_event_input: Option<CapacityCountedAttemptEventInput>,
    #[serde(default)]
    pub repeat_gate_anchor_input: Option<RepeatGateAnchorInput>,
    #[serde(default)]
    pub route_execution_policy_hold_input: Option<RouteExecutionPolicyHoldInput>,
    #[serde(default)]
    pub policy_hold_pressure_input: Option<PolicyHoldPressureInput>,
    #[serde(default)]
    pub policy_hold_pattern_input: Option<PolicyHoldPatternInput>,
    #[serde(default)]
    pub policy_hold_latest_event_input: Option<PolicyHoldLatestEventInput>,
    #[serde(default)]
    pub policy_hold_cooldown_input: Option<PolicyHoldCooldownInput>,
    #[serde(default)]
    pub receipt_verdict_input: Option<ReceiptVerdictInput>,
}

fn clamp_ratio(v: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

pub fn compute_plan(input: &PlanInput) -> PlanOutput {
    let pressure = input.queue_pressure.pressure.to_ascii_lowercase();
    let pending = input.queue_pressure.pending.max(0.0);
    let pending_ratio = clamp_ratio(input.queue_pressure.pending_ratio);
    let min_cells = input.min_cells;
    let max_cells = input.max_cells.max(min_cells);
    let current_cells = input.current_cells.max(min_cells).min(max_cells);
    let run_interval_minutes = input.run_interval_minutes.max(1.0);
    let idle_release_minutes = input.idle_release_minutes.max(run_interval_minutes);
    let high_pressure = pressure == "critical";
    let warning_pressure = pressure == "warning";
    let pressure_active = high_pressure || warning_pressure;

    let cooldown_active = input
        .last_run_minutes_ago
        .map(|v| v.is_finite() && v < run_interval_minutes)
        .unwrap_or(false);
    let idle_release_ready = current_cells > min_cells
        && !pressure_active
        && input
            .last_high_pressure_minutes_ago
            .map(|v| v.is_finite() && v >= idle_release_minutes)
            .unwrap_or(false);

    if input.trit_shadow_blocked {
        return PlanOutput {
            action: "hold".to_string(),
            reason: "shadow_hold".to_string(),
            pressure,
            pending,
            pending_ratio,
            current_cells,
            target_cells: current_cells,
            warning_pressure,
            high_pressure,
            pressure_active,
            cooldown_active,
            idle_release_ready,
            budget_blocked: input.autopause_active,
            trit_shadow_blocked: true,
        };
    }

    if input.autopause_active && pressure_active {
        return PlanOutput {
            action: "hold".to_string(),
            reason: "budget_autopause_active".to_string(),
            pressure,
            pending,
            pending_ratio,
            current_cells,
            target_cells: current_cells,
            warning_pressure,
            high_pressure,
            pressure_active,
            cooldown_active,
            idle_release_ready,
            budget_blocked: true,
            trit_shadow_blocked: false,
        };
    }

    if pressure_active && cooldown_active {
        return PlanOutput {
            action: "cooldown_hold".to_string(),
            reason: "cooldown_hold".to_string(),
            pressure,
            pending,
            pending_ratio,
            current_cells,
            target_cells: current_cells,
            warning_pressure,
            high_pressure,
            pressure_active,
            cooldown_active: true,
            idle_release_ready,
            budget_blocked: input.autopause_active,
            trit_shadow_blocked: false,
        };
    }

    if high_pressure && current_cells < max_cells {
        return PlanOutput {
            action: "scale_up".to_string(),
            reason: "backlog_critical".to_string(),
            pressure,
            pending,
            pending_ratio,
            current_cells,
            target_cells: max_cells,
            warning_pressure,
            high_pressure,
            pressure_active,
            cooldown_active,
            idle_release_ready,
            budget_blocked: input.autopause_active,
            trit_shadow_blocked: false,
        };
    }

    if warning_pressure && current_cells < max_cells {
        return PlanOutput {
            action: "scale_up".to_string(),
            reason: "backlog_warning".to_string(),
            pressure,
            pending,
            pending_ratio,
            current_cells,
            target_cells: (current_cells + 1).max(min_cells).min(max_cells),
            warning_pressure,
            high_pressure,
            pressure_active,
            cooldown_active,
            idle_release_ready,
            budget_blocked: input.autopause_active,
            trit_shadow_blocked: false,
        };
    }

    if idle_release_ready {
        return PlanOutput {
            action: "scale_down".to_string(),
            reason: "idle_release_ready".to_string(),
            pressure,
            pending,
            pending_ratio,
            current_cells,
            target_cells: min_cells,
            warning_pressure,
            high_pressure,
            pressure_active,
            cooldown_active,
            idle_release_ready: true,
            budget_blocked: input.autopause_active,
            trit_shadow_blocked: false,
        };
    }

    PlanOutput {
        action: "hold".to_string(),
        reason: if current_cells > min_cells && !pressure_active {
            "idle_hold".to_string()
        } else {
            "no_pressure".to_string()
        },
        pressure,
        pending,
        pending_ratio,
        current_cells,
        target_cells: current_cells,
        warning_pressure,
        high_pressure,
        pressure_active,
        cooldown_active,
        idle_release_ready,
        budget_blocked: input.autopause_active,
        trit_shadow_blocked: false,
    }
}

pub fn compute_batch_max(input: &BatchMaxInput) -> BatchMaxOutput {
    let pressure = input.pressure.to_ascii_lowercase();
    let max_batch = input.max_batch.max(1);
    let current_cells = input.current_cells;

    if !input.enabled {
        return BatchMaxOutput {
            max: 1,
            reason: "disabled".to_string(),
            pressure,
            current_cells,
            budget_blocked: input.budget_blocked,
            trit_shadow_blocked: input.trit_shadow_blocked,
        };
    }
    if input.budget_blocked {
        return BatchMaxOutput {
            max: 1,
            reason: "budget_blocked".to_string(),
            pressure,
            current_cells,
            budget_blocked: true,
            trit_shadow_blocked: input.trit_shadow_blocked,
        };
    }
    if input.trit_shadow_blocked {
        return BatchMaxOutput {
            max: 1,
            reason: "shadow_hold".to_string(),
            pressure,
            current_cells,
            budget_blocked: input.budget_blocked,
            trit_shadow_blocked: true,
        };
    }

    let mut suggested = 1_u32;
    if pressure == "critical" {
        suggested = max_batch.min((current_cells + 1).max(1));
    } else if pressure == "warning" {
        suggested = max_batch.min(2);
    }
    let mut reason = if suggested > 1 {
        "backlog_autoscale".to_string()
    } else {
        "no_pressure".to_string()
    };
    if let Some(remaining) = input.daily_remaining {
        if remaining < suggested {
            suggested = remaining.max(1);
            reason = "daily_cap_limited".to_string();
        }
    }

    BatchMaxOutput {
        max: suggested.max(1),
        reason,
        pressure,
        current_cells,
        budget_blocked: input.budget_blocked,
        trit_shadow_blocked: input.trit_shadow_blocked,
    }
}

pub fn compute_dynamic_caps(input: &DynamicCapsInput) -> DynamicCapsOutput {
    let mut out = DynamicCapsOutput {
        enabled: input.enabled,
        daily_runs_cap: input.base_daily_cap.max(1),
        canary_daily_exec_cap: input.base_canary_cap,
        input_candidates_cap: None,
        input_candidate_cap_alias: None,
        low_yield: false,
        high_yield: false,
        spawn_reset_active: false,
        queue_pressure: input.queue_pressure.to_ascii_lowercase(),
        policy_hold_level: input.policy_hold_level.to_ascii_lowercase(),
        reasons: Vec::new(),
    };

    let mark_low_yield = |reason: &str, out: &mut DynamicCapsOutput| {
        out.low_yield = true;
        if !out.reasons.iter().any(|r| r == reason) {
            out.reasons.push(reason.to_string());
        }
    };

    if input.enabled {
        let pressure = out.queue_pressure.as_str();
        let mut factor = 1.0_f64;
        if pressure == "critical" {
            factor = input.critical_factor;
            mark_low_yield("downshift_queue_backlog_critical", &mut out);
        } else if pressure == "warning" {
            factor = input.warn_factor;
            mark_low_yield("downshift_queue_backlog_warning", &mut out);
        }
        if factor < 1.0 {
            let lowered_runs = ((input.base_daily_cap as f64) * factor).floor() as u32;
            out.daily_runs_cap = out.daily_runs_cap.min(lowered_runs.max(1));
            if input.candidate_pool_size > 0 {
                let lowered_pool = ((input.candidate_pool_size as f64) * factor).floor() as u32;
                let lowered_pool = lowered_pool.max(input.min_input_pool.max(1));
                if lowered_pool < input.candidate_pool_size {
                    out.input_candidates_cap = Some(lowered_pool);
                    out.input_candidate_cap_alias = Some(lowered_pool);
                }
            }
        }
    }

    let hold_level = out.policy_hold_level.as_str();
    if input.policy_hold_applicable && hold_level == "hard" {
        out.daily_runs_cap = out.daily_runs_cap.min(1);
        out.high_yield = false;
        mark_low_yield("downshift_policy_hold_hard", &mut out);
    } else if input.policy_hold_applicable && hold_level == "warn" {
        let warn_cap = ((input.base_daily_cap as f64) * 0.6).floor() as u32;
        out.daily_runs_cap = out.daily_runs_cap.min(warn_cap.max(1));
        out.high_yield = false;
        mark_low_yield("downshift_policy_hold_warn", &mut out);
    }

    if input.spawn_boost_enabled && input.spawn_boost_active {
        out.daily_runs_cap = input.base_daily_cap.max(1);
        out.input_candidates_cap = None;
        out.input_candidate_cap_alias = None;
        out.low_yield = false;
        out.spawn_reset_active = true;
        if !out.reasons.iter().any(|r| r == "reset_caps_spawn_capacity") {
            out.reasons.push("reset_caps_spawn_capacity".to_string());
        }
    }

    if !out.low_yield {
        out.high_yield = input.shipped_today > 0.0
            && input.no_progress_streak <= 0.0
            && input.gate_exhaustion_streak <= 0.0;
    }

    out
}

fn non_negative_number(v: Option<f64>) -> Option<f64> {
    let n = v?;
    if n.is_finite() && n >= 0.0 {
        Some(n)
    } else {
        None
    }
}

pub fn compute_token_usage(input: &TokenUsageInput) -> TokenUsageOutput {
    let est_selected = non_negative_number(input.selected_model_tokens_est)
        .or_else(|| non_negative_number(input.route_budget_request_tokens_est))
        .or_else(|| non_negative_number(input.route_tokens_est))
        .or_else(|| non_negative_number(input.fallback_est_tokens))
        .unwrap_or(0.0);

    let prompt = non_negative_number(input.metrics_prompt_tokens)
        .or_else(|| non_negative_number(input.metrics_input_tokens));
    let completion = non_negative_number(input.metrics_completion_tokens)
        .or_else(|| non_negative_number(input.metrics_output_tokens));
    let total_direct = non_negative_number(input.metrics_total_tokens)
        .or_else(|| non_negative_number(input.metrics_tokens_used));

    let actual_total = if let Some(total) = total_direct {
        Some(total)
    } else if prompt.is_some() || completion.is_some() {
        Some(prompt.unwrap_or(0.0) + completion.unwrap_or(0.0))
    } else {
        None
    };

    let effective_tokens = actual_total.unwrap_or(est_selected);
    let source = if actual_total.is_some() {
        let raw = input
            .metrics_source
            .clone()
            .unwrap_or_else(|| "route_execute_metrics".to_string());
        let normalized = raw.trim();
        if normalized.is_empty() {
            "route_execute_metrics".to_string()
        } else {
            normalized.to_string()
        }
    } else {
        "estimated_fallback".to_string()
    };

    TokenUsageOutput {
        available: actual_total.is_some(),
        source,
        actual_prompt_tokens: prompt,
        actual_completion_tokens: completion,
        actual_total_tokens: actual_total,
        estimated_tokens: est_selected,
        effective_tokens,
    }
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

pub fn compute_normalize_queue(input: &NormalizeQueueInput) -> NormalizeQueueOutput {
    let pending = input.pending.unwrap_or(0.0).max(0.0);
    let total = input.total.unwrap_or(0.0).max(0.0);
    let pending_ratio = non_negative_number(input.pending_ratio)
        .map(clamp_ratio)
        .unwrap_or_else(|| {
            if total > 0.0 {
                clamp_ratio(pending / total)
            } else {
                0.0
            }
        });

    let mut pressure = input
        .pressure
        .clone()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if pressure != "critical" && pressure != "warning" && pressure != "normal" {
        pressure = "normal".to_string();
        if pending >= input.critical_pending_count || pending_ratio >= input.critical_pending_ratio
        {
            pressure = "critical".to_string();
        } else if pending >= input.warn_pending_count || pending_ratio >= input.warn_pending_ratio {
            pressure = "warning".to_string();
        }
    }

    NormalizeQueueOutput {
        pressure,
        pending,
        total,
        pending_ratio: round6(pending_ratio),
    }
}

pub fn compute_criteria_gate(input: &CriteriaGateInput) -> CriteriaGateOutput {
    let min_count = input.min_count.unwrap_or(0.0).max(0.0);
    let total_count = input.total_count.unwrap_or(0.0).max(0.0);
    let unsupported_count = (input.contract_not_allowed_count.unwrap_or(0.0).max(0.0)
        + input.unsupported_count.unwrap_or(0.0).max(0.0))
    .max(0.0);
    let supported_count = input
        .structurally_supported_count
        .unwrap_or(total_count - unsupported_count)
        .max(0.0);
    let contract_violation_count = input.contract_violation_count.unwrap_or(0.0).max(0.0);

    let mut reasons: Vec<String> = Vec::new();
    if total_count < min_count {
        reasons.push("criteria_count_below_min".to_string());
    }
    if contract_violation_count > 0.0 {
        reasons.push("criteria_contract_violation".to_string());
    }
    if supported_count < min_count {
        reasons.push("criteria_supported_count_below_min".to_string());
    }

    CriteriaGateOutput {
        pass: reasons.is_empty(),
        reasons,
        min_count,
        total_count,
        supported_count,
        unsupported_count,
        contract_violation_count,
    }
}

pub fn compute_structural_preview_criteria_failure(
    input: &StructuralPreviewCriteriaFailureInput,
) -> StructuralPreviewCriteriaFailureOutput {
    let primary = input
        .primary_failure
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if primary.contains("metric_not_allowed_for_capability")
        || primary.contains("insufficient_supported_metrics")
    {
        return StructuralPreviewCriteriaFailureOutput { has_failure: true };
    }

    let not_allowed = input.contract_not_allowed_count.unwrap_or(0.0).max(0.0);
    let unsupported = input.unsupported_count.unwrap_or(0.0).max(0.0);
    let total = input.total_count.unwrap_or(0.0).max(1.0);
    let has_failure = not_allowed > 0.0 || (unsupported > 0.0 && (unsupported / total) >= 0.5);
    StructuralPreviewCriteriaFailureOutput { has_failure }
}

fn normalize_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sanitize_directive_objective_id(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return String::new();
    }
    let bytes = value.as_bytes();
    if bytes.first().copied() != Some(b'T') {
        return String::new();
    }
    let mut idx: usize = 1;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx == 1 || idx >= bytes.len() || bytes[idx] != b'_' {
        return String::new();
    }
    idx += 1;
    if idx >= bytes.len() {
        return String::new();
    }
    if !bytes[idx..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
    {
        return String::new();
    }
    value.to_string()
}

fn sanitize_directive_objective_id_single_digit(raw: &str) -> String {
    let value = raw.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 4 {
        return String::new();
    }
    if bytes[0] != b'T' || !bytes[1].is_ascii_digit() || bytes[2] != b'_' {
        return String::new();
    }
    if !bytes[3..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
    {
        return String::new();
    }
    value.to_string()
}

fn sanitize_cooldown_fragment(raw: &str) -> String {
    normalize_spaces(raw)
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == ':' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
}

pub fn compute_policy_hold(input: &PolicyHoldInput) -> PolicyHoldOutput {
    let target = input.target.trim().to_ascii_lowercase();
    if target != "route" {
        return PolicyHoldOutput {
            hold: false,
            hold_scope: None,
            hold_reason: None,
            route_block_reason: None,
        };
    }

    let budget_reason = normalize_spaces(&input.budget_reason);
    let route_reason = normalize_spaces(&input.route_reason);
    let budget_signal_text =
        normalize_spaces(&format!("{budget_reason} {route_reason}")).to_ascii_lowercase();
    let budget_blocked_by_reason = budget_signal_text.contains("burn_rate_exceeded")
        || budget_signal_text.contains("budget_autopause")
        || budget_signal_text.contains("budget guard blocked")
        || budget_signal_text.contains("budget_deferred")
        || budget_signal_text.contains("budget_blocked");
    let budget_blocked = input.budget_blocked_flag
        || input.budget_global_blocked
        || input.budget_enforcement_blocked
        || budget_blocked_by_reason;

    if budget_blocked {
        let reason = if budget_reason.trim().is_empty() {
            "budget_guard_blocked".to_string()
        } else {
            budget_reason
        };
        return PolicyHoldOutput {
            hold: true,
            hold_scope: Some("budget".to_string()),
            hold_reason: Some(reason.clone()),
            route_block_reason: Some(reason),
        };
    }

    let gate_decision = input.gate_decision.trim().to_ascii_uppercase();
    let route_decision = input.route_decision.trim().to_ascii_uppercase();
    let manual_blocked =
        gate_decision == "MANUAL" || route_decision == "MANUAL" || input.needs_manual_review;
    if manual_blocked && !input.executable {
        return PolicyHoldOutput {
            hold: true,
            hold_scope: Some("proposal".to_string()),
            hold_reason: Some("gate_manual".to_string()),
            route_block_reason: Some("gate_manual".to_string()),
        };
    }

    PolicyHoldOutput {
        hold: false,
        hold_scope: None,
        hold_reason: None,
        route_block_reason: None,
    }
}

pub fn compute_route_execution_policy_hold(input: &RouteExecutionPolicyHoldInput) -> PolicyHoldOutput {
    let target = normalize_spaces(input.target.as_deref().unwrap_or("route")).to_ascii_lowercase();
    let gate_decision = normalize_spaces(input.gate_decision.as_deref().unwrap_or(""));
    let route_decision = {
        let raw = normalize_spaces(input.route_decision_raw.as_deref().unwrap_or(""));
        if !raw.is_empty() {
            raw
        } else {
            normalize_spaces(input.decision.as_deref().unwrap_or(""))
        }
    };
    let needs_manual_review = input.needs_manual_review.unwrap_or(false);
    let executable = input.executable.unwrap_or(true);

    let budget_reason = {
        let direct = normalize_spaces(input.budget_block_reason.as_deref().unwrap_or(""));
        if !direct.is_empty() {
            direct
        } else {
            let enforced = normalize_spaces(input.budget_enforcement_reason.as_deref().unwrap_or(""));
            if !enforced.is_empty() {
                enforced
            } else {
                normalize_spaces(input.budget_global_reason.as_deref().unwrap_or(""))
            }
        }
    };

    let route_reason = {
        let summary = normalize_spaces(input.summary_reason.as_deref().unwrap_or(""));
        if !summary.is_empty() {
            summary
        } else {
            normalize_spaces(input.route_reason.as_deref().unwrap_or(""))
        }
    };

    let normalized = PolicyHoldInput {
        target,
        gate_decision,
        route_decision,
        needs_manual_review,
        executable,
        budget_reason,
        route_reason,
        budget_blocked_flag: input.budget_blocked.unwrap_or(false),
        budget_global_blocked: input.budget_global_blocked.unwrap_or(false),
        budget_enforcement_blocked: input.budget_enforcement_blocked.unwrap_or(false),
    };
    compute_policy_hold(&normalized)
}

fn round3(v: f64) -> f64 {
    (v * 1_000.0).round() / 1_000.0
}

fn is_policy_hold_result(result: &str) -> bool {
    !result.is_empty()
        && (result.starts_with("no_candidates_policy_")
            || result == "stop_init_gate_budget_autopause"
            || result == "stop_init_gate_readiness"
            || result == "stop_init_gate_readiness_blocked"
            || result == "stop_init_gate_criteria_quality_insufficient"
            || result == "stop_repeat_gate_mutation_guard"
            || result == "score_only_fallback_route_block"
            || result == "score_only_fallback_low_execution_confidence")
}

pub fn compute_policy_hold_result(input: &PolicyHoldResultInput) -> PolicyHoldResultOutput {
    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    PolicyHoldResultOutput {
        is_policy_hold: is_policy_hold_result(&result),
    }
}

pub fn compute_policy_hold_run_event(input: &PolicyHoldRunEventInput) -> PolicyHoldRunEventOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    PolicyHoldRunEventOutput {
        is_policy_hold_run_event: event_type == "autonomy_run"
            && (input.policy_hold.unwrap_or(false) || is_policy_hold_result(&result)),
    }
}

pub fn compute_score_only_result(input: &ScoreOnlyResultInput) -> ScoreOnlyResultOutput {
    let result = input
        .result
        .as_ref()
        .map(|v| v.trim())
        .unwrap_or_default();
    ScoreOnlyResultOutput {
        is_score_only: result == "score_only_preview"
            || result == "score_only_evidence"
            || result == "stop_repeat_gate_preview_structural_cooldown"
            || result == "stop_repeat_gate_preview_churn_cooldown",
    }
}

pub fn compute_score_only_failure_like(
    input: &ScoreOnlyFailureLikeInput,
) -> ScoreOnlyFailureLikeOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return ScoreOnlyFailureLikeOutput {
            is_failure_like: false,
        };
    }

    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if !compute_score_only_result(&ScoreOnlyResultInput {
        result: Some(result.clone()),
    })
    .is_score_only
    {
        return ScoreOnlyFailureLikeOutput {
            is_failure_like: false,
        };
    }

    if result == "stop_repeat_gate_preview_structural_cooldown"
        || result == "stop_repeat_gate_preview_churn_cooldown"
    {
        return ScoreOnlyFailureLikeOutput {
            is_failure_like: true,
        };
    }

    if !input.preview_verification_present.unwrap_or(false) {
        return ScoreOnlyFailureLikeOutput {
            is_failure_like: false,
        };
    }
    if input.preview_verification_passed == Some(false) {
        return ScoreOnlyFailureLikeOutput {
            is_failure_like: true,
        };
    }
    let outcome = input
        .preview_verification_outcome
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    ScoreOnlyFailureLikeOutput {
        is_failure_like: outcome == "no_change",
    }
}

pub fn compute_gate_exhausted_attempt(
    input: &GateExhaustedAttemptInput,
) -> GateExhaustedAttemptOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return GateExhaustedAttemptOutput {
            is_gate_exhausted: false,
        };
    }

    let result = input
        .result
        .as_ref()
        .map(|v| v.trim())
        .unwrap_or_default();
    GateExhaustedAttemptOutput {
        is_gate_exhausted: result == "stop_repeat_gate_stale_signal"
            || result == "stop_repeat_gate_capability_cap"
            || result == "stop_repeat_gate_directive_pulse_cooldown"
            || result == "stop_repeat_gate_directive_pulse_tier_reservation"
            || result == "stop_repeat_gate_human_escalation_pending"
            || result == "init_gate_blocked_route"
            || result == "stop_init_gate_quality_exhausted"
            || result == "stop_init_gate_directive_fit_exhausted"
            || result == "stop_init_gate_actionability_exhausted"
            || result == "stop_init_gate_optimization_good_enough"
            || result == "stop_init_gate_value_signal_exhausted"
            || result == "stop_init_gate_tier1_governance"
            || result == "stop_init_gate_medium_risk_guard"
            || result == "stop_init_gate_medium_requires_canary"
            || result == "stop_init_gate_composite_exhausted"
            || result == "stop_repeat_gate_capability_cooldown"
            || result == "stop_repeat_gate_capability_no_change_cooldown"
            || result == "stop_repeat_gate_preview_churn_cooldown"
            || result == "stop_repeat_gate_medium_canary_cap"
            || result == "stop_repeat_gate_candidate_exhausted",
    }
}

pub fn compute_consecutive_gate_exhausted_attempts(
    input: &ConsecutiveGateExhaustedAttemptsInput,
) -> ConsecutiveGateExhaustedAttemptsOutput {
    let mut count: u32 = 0;
    for evt in input.events.iter().rev() {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }

        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let is_attempt = compute_attempt_run_event(&AttemptRunEventInput {
            event_type: Some(event_type),
            result: Some(result.clone()),
        })
        .is_attempt;
        if !is_attempt {
            continue;
        }

        let is_gate_exhausted = compute_gate_exhausted_attempt(&GateExhaustedAttemptInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some(result),
        })
        .is_gate_exhausted;
        if !is_gate_exhausted {
            break;
        }
        count += 1;
    }
    ConsecutiveGateExhaustedAttemptsOutput { count }
}

pub fn compute_runs_since_reset_index(input: &RunsSinceResetIndexInput) -> RunsSinceResetIndexOutput {
    let mut start_index: usize = 0;
    for (idx, evt) in input.events.iter().enumerate() {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type == "autonomy_reset" {
            start_index = idx + 1;
        }
    }
    RunsSinceResetIndexOutput {
        start_index: start_index as u32,
    }
}

pub fn compute_attempt_event_indices(input: &AttemptEventIndicesInput) -> AttemptEventIndicesOutput {
    let mut indices: Vec<u32> = Vec::new();
    for (idx, evt) in input.events.iter().enumerate() {
        let is_attempt = compute_attempt_run_event(&AttemptRunEventInput {
            event_type: evt.event_type.clone(),
            result: evt.result.clone(),
        })
        .is_attempt;
        if is_attempt {
            indices.push(idx as u32);
        }
    }
    AttemptEventIndicesOutput { indices }
}

pub fn compute_capacity_counted_attempt_indices(
    input: &CapacityCountedAttemptIndicesInput,
) -> CapacityCountedAttemptIndicesOutput {
    let mut indices: Vec<u32> = Vec::new();
    for (idx, evt) in input.events.iter().enumerate() {
        let counted = compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
            event_type: evt.event_type.clone(),
            result: evt.result.clone(),
            policy_hold: evt.policy_hold,
            proposal_id: evt.proposal_id.clone(),
        })
        .capacity_counted;
        if counted {
            indices.push(idx as u32);
        }
    }
    CapacityCountedAttemptIndicesOutput { indices }
}

pub fn compute_consecutive_no_progress_runs(
    input: &ConsecutiveNoProgressRunsInput,
) -> ConsecutiveNoProgressRunsOutput {
    let mut count: u32 = 0;
    for evt in input.events.iter().rev() {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }

        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let outcome = evt
            .outcome
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if result == "executed" && outcome == "shipped" {
            break;
        }
        let is_no_progress = compute_no_progress_result(&NoProgressResultInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some(result),
            outcome: Some(outcome),
        })
        .is_no_progress;
        if !is_no_progress {
            break;
        }
        count += 1;
    }
    ConsecutiveNoProgressRunsOutput { count }
}

pub fn compute_shipped_count(input: &ShippedCountInput) -> ShippedCountOutput {
    let mut count: u32 = 0;
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let outcome = evt
            .outcome
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type == "autonomy_run" && result == "executed" && outcome == "shipped" {
            count += 1;
        }
    }
    ShippedCountOutput { count }
}

fn normalize_risk_level(raw: &str) -> String {
    let level = raw.trim().to_ascii_lowercase();
    if level == "high" || level == "medium" || level == "low" {
        level
    } else {
        "low".to_string()
    }
}

pub fn compute_executed_count_by_risk(input: &ExecutedCountByRiskInput) -> ExecutedCountByRiskOutput {
    let target = normalize_risk_level(input.risk.as_deref().unwrap_or(""));
    let mut count: u32 = 0;
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }
        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if result != "executed" {
            continue;
        }
        let run_risk = if let Some(risk) = evt.risk.as_ref() {
            normalize_risk_level(risk)
        } else {
            normalize_risk_level(evt.proposal_risk.as_deref().unwrap_or(""))
        };
        if run_risk == target {
            count += 1;
        }
    }
    ExecutedCountByRiskOutput { count }
}

pub fn compute_run_result_tally(input: &RunResultTallyInput) -> RunResultTallyOutput {
    let mut counts: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }
        let key = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        let next = counts.get(&key).copied().unwrap_or(0).saturating_add(1);
        counts.insert(key, next);
    }
    RunResultTallyOutput { counts }
}

pub fn compute_sorted_counts(input: &SortedCountsInput) -> SortedCountsOutput {
    let mut items = input
        .counts
        .iter()
        .map(|(result, count)| SortedCountItem {
            result: result.to_string(),
            count: if count.is_finite() && *count > 0.0 {
                count.round() as u32
            } else {
                0
            },
        })
        .collect::<Vec<_>>();
    items.sort_by(|a, b| {
        if b.count != a.count {
            b.count.cmp(&a.count)
        } else {
            a.result.cmp(&b.result)
        }
    });
    SortedCountsOutput { items }
}

pub fn compute_normalize_proposal_status(
    input: &NormalizeProposalStatusInput,
) -> NormalizeProposalStatusOutput {
    let base = input
        .fallback
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "pending".to_string());
    let status = input
        .raw_status
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let normalized_status = if status.is_empty()
        || status == "unknown"
        || status == "new"
        || status == "queued"
        || status == "open"
        || status == "admitted"
    {
        base
    } else if status == "closed_won"
        || status == "won"
        || status == "paid"
        || status == "verified"
    {
        "closed".to_string()
    } else {
        status
    };
    NormalizeProposalStatusOutput { normalized_status }
}

pub fn compute_proposal_status(input: &ProposalStatusInput) -> ProposalStatusOutput {
    let overlay_decision = input
        .overlay_decision
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let status = if overlay_decision == "accept" {
        "accepted".to_string()
    } else if overlay_decision == "reject" {
        "rejected".to_string()
    } else if overlay_decision == "park" {
        "parked".to_string()
    } else {
        "pending".to_string()
    };
    ProposalStatusOutput { status }
}

pub fn compute_proposal_outcome_status(
    input: &ProposalOutcomeStatusInput,
) -> ProposalOutcomeStatusOutput {
    let outcome = input
        .overlay_outcome
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());
    ProposalOutcomeStatusOutput { outcome }
}

pub fn compute_queue_underflow_backfill(
    input: &QueueUnderflowBackfillInput,
) -> QueueUnderflowBackfillOutput {
    if input.underflow_backfill_max <= 0.0 {
        return QueueUnderflowBackfillOutput { allow: false };
    }
    let status = input
        .status
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if status != "accepted" {
        return QueueUnderflowBackfillOutput { allow: false };
    }
    let out = compute_proposal_outcome_status(&ProposalOutcomeStatusInput {
        overlay_outcome: input.overlay_outcome.clone(),
    })
    .outcome;
    QueueUnderflowBackfillOutput {
        allow: out.is_none(),
    }
}

pub fn compute_proposal_risk_score(input: &ProposalRiskScoreInput) -> ProposalRiskScoreOutput {
    if let Some(explicit) = input.explicit_risk_score {
        if explicit.is_finite() {
            let rounded = explicit.round();
            if rounded <= 0.0 {
                return ProposalRiskScoreOutput { risk_score: 0 };
            }
            if rounded >= 100.0 {
                return ProposalRiskScoreOutput { risk_score: 100 };
            }
            return ProposalRiskScoreOutput {
                risk_score: rounded as u32,
            };
        }
    }
    let risk = normalize_risk_level(input.risk.as_deref().unwrap_or(""));
    let risk_score = if risk == "high" {
        90
    } else if risk == "medium" {
        60
    } else {
        25
    };
    ProposalRiskScoreOutput { risk_score }
}

pub fn compute_proposal_score(input: &ProposalScoreInput) -> ProposalScoreOutput {
    let age_penalty = (input.age_hours / 24.0) * 0.6;
    let stub_penalty = if input.is_stub { 2.5 } else { 0.0 };
    let no_change_penalty = input.no_change_count * 1.5;
    let reverted_penalty = input.reverted_count * 3.0;
    ProposalScoreOutput {
        score: (input.impact_weight * 2.0)
            - (input.risk_penalty * 1.0)
            - age_penalty
            - stub_penalty
            - no_change_penalty
            - reverted_penalty,
    }
}

pub fn compute_proposal_admission_preview(
    input: &ProposalAdmissionPreviewInput,
) -> ProposalAdmissionPreviewOutput {
    let preview = input
        .admission_preview
        .as_ref()
        .filter(|v| v.is_object() || v.is_array())
        .cloned();
    ProposalAdmissionPreviewOutput { preview }
}

pub fn compute_impact_weight(input: &ImpactWeightInput) -> ImpactWeightOutput {
    let impact = input
        .expected_impact
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let weight = if impact == "high" {
        3
    } else if impact == "medium" {
        2
    } else {
        1
    };
    ImpactWeightOutput { weight }
}

pub fn compute_risk_penalty(input: &RiskPenaltyInput) -> RiskPenaltyOutput {
    let risk = input
        .risk
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let penalty = if risk == "high" {
        2
    } else if risk == "medium" {
        1
    } else {
        0
    };
    RiskPenaltyOutput { penalty }
}

pub fn compute_estimate_tokens(input: &EstimateTokensInput) -> EstimateTokensOutput {
    let impact = input
        .expected_impact
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let est_tokens = if impact == "high" {
        1400
    } else if impact == "medium" {
        800
    } else {
        300
    };
    EstimateTokensOutput { est_tokens }
}

pub fn compute_proposal_remediation_depth(
    input: &ProposalRemediationDepthInput,
) -> ProposalRemediationDepthOutput {
    if let Some(raw) = input.remediation_depth {
        if raw.is_finite() && raw >= 0.0 {
            return ProposalRemediationDepthOutput {
                depth: raw.round().clamp(0.0, u32::MAX as f64) as u32,
            };
        }
    }
    let trigger = input
        .trigger
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let depth = if trigger == "consecutive_failures" || trigger == "multi_eye_transport_failure" {
        1
    } else {
        0
    };
    ProposalRemediationDepthOutput { depth }
}

pub fn compute_proposal_dedup_key(input: &ProposalDedupKeyInput) -> ProposalDedupKeyOutput {
    let proposal_type = input
        .proposal_type
        .as_deref()
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase();
    let proposal_type = if proposal_type.is_empty() {
        "unknown".to_string()
    } else {
        proposal_type
    };
    let source_eye_id = input.source_eye_id.as_deref().unwrap_or("").trim();
    let remediation_kind = input
        .remediation_kind
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let proposal_id = input.proposal_id.as_deref().unwrap_or("unknown").trim();
    let dedup_key = if proposal_type.contains("remediation") {
        format!(
            "{}|{}|{}",
            proposal_type,
            source_eye_id,
            if remediation_kind.is_empty() {
                "none"
            } else {
                remediation_kind.as_str()
            }
        )
    } else {
        format!(
            "{}|{}|{}",
            proposal_type,
            source_eye_id,
            if proposal_id.is_empty() {
                "unknown"
            } else {
                proposal_id
            }
        )
    };
    ProposalDedupKeyOutput { dedup_key }
}

pub fn compute_semantic_token_similarity(
    input: &SemanticTokenSimilarityInput,
) -> SemanticTokenSimilarityOutput {
    let norm = |row: &String| -> Option<String> {
        let token = row.trim();
        if token.is_empty() {
            return None;
        }
        Some(token.to_string())
    };
    let left: std::collections::HashSet<String> =
        input.left_tokens.iter().filter_map(norm).collect();
    let right: std::collections::HashSet<String> =
        input.right_tokens.iter().filter_map(norm).collect();
    if left.is_empty() || right.is_empty() {
        return SemanticTokenSimilarityOutput { similarity: 0.0 };
    }
    let intersection = left.iter().filter(|token| right.contains(*token)).count() as f64;
    let union = (left.len() + right.len()) as f64 - intersection;
    if union <= 0.0 {
        return SemanticTokenSimilarityOutput { similarity: 0.0 };
    }
    let similarity = ((intersection / union) * 1_000_000.0).round() / 1_000_000.0;
    SemanticTokenSimilarityOutput {
        similarity: similarity.clamp(0.0, 1.0),
    }
}

pub fn compute_semantic_context_comparable(
    input: &SemanticContextComparableInput,
) -> SemanticContextComparableOutput {
    let left_type = input
        .left_proposal_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let right_type = input
        .right_proposal_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if input.require_same_type && !left_type.is_empty() && !right_type.is_empty() && left_type != right_type {
        return SemanticContextComparableOutput { comparable: false };
    }
    if !input.require_shared_context {
        return SemanticContextComparableOutput { comparable: true };
    }
    let left_eye = input
        .left_source_eye
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let right_eye = input
        .right_source_eye
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !left_eye.is_empty() && !right_eye.is_empty() && left_eye == right_eye {
        return SemanticContextComparableOutput { comparable: true };
    }
    let left_objective = input.left_objective_id.as_deref().unwrap_or("").trim();
    let right_objective = input.right_objective_id.as_deref().unwrap_or("").trim();
    if !left_objective.is_empty() && !right_objective.is_empty() && left_objective == right_objective {
        return SemanticContextComparableOutput { comparable: true };
    }
    SemanticContextComparableOutput { comparable: false }
}

fn semantic_token_set(tokens: &[String]) -> std::collections::HashSet<String> {
    tokens
        .iter()
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect()
}

fn semantic_jaccard_similarity(
    left_tokens: &[String],
    right_tokens: &[String],
) -> SemanticTokenSimilarityOutput {
    let left = semantic_token_set(left_tokens);
    let right = semantic_token_set(right_tokens);
    if left.is_empty() || right.is_empty() {
        return SemanticTokenSimilarityOutput { similarity: 0.0 };
    }
    let intersection = left.iter().filter(|token| right.contains(*token)).count() as f64;
    let union = (left.len() + right.len()) as f64 - intersection;
    if union <= 0.0 {
        return SemanticTokenSimilarityOutput { similarity: 0.0 };
    }
    let similarity = ((intersection / union) * 1_000_000.0).round() / 1_000_000.0;
    SemanticTokenSimilarityOutput {
        similarity: similarity.clamp(0.0, 1.0),
    }
}

fn semantic_context_comparable_for_fingerprints(
    left: &SemanticNearDuplicateFingerprintInput,
    right: &SemanticNearDuplicateFingerprintInput,
    require_same_type: bool,
    require_shared_context: bool,
) -> bool {
    let input = SemanticContextComparableInput {
        left_proposal_type: left.proposal_type.clone(),
        right_proposal_type: right.proposal_type.clone(),
        left_source_eye: left.source_eye.clone(),
        right_source_eye: right.source_eye.clone(),
        left_objective_id: left.objective_id.clone(),
        right_objective_id: right.objective_id.clone(),
        require_same_type,
        require_shared_context,
    };
    compute_semantic_context_comparable(&input).comparable
}

pub fn compute_semantic_near_duplicate_match(
    input: &SemanticNearDuplicateMatchInput,
) -> SemanticNearDuplicateMatchOutput {
    let min_similarity = if input.min_similarity.is_finite() {
        input.min_similarity
    } else {
        0.0
    };
    if !input.fingerprint.eligible {
        return SemanticNearDuplicateMatchOutput {
            matched: false,
            similarity: 0.0,
            proposal_id: None,
            proposal_type: None,
            source_eye: None,
            objective_id: None,
        };
    }
    let mut best: Option<SemanticNearDuplicateMatchOutput> = None;
    for candidate in &input.seen_fingerprints {
        if !candidate.eligible {
            continue;
        }
        if !semantic_context_comparable_for_fingerprints(
            &input.fingerprint,
            candidate,
            input.require_same_type,
            input.require_shared_context,
        ) {
            continue;
        }
        let similarity =
            semantic_jaccard_similarity(&input.fingerprint.token_stems, &candidate.token_stems)
                .similarity;
        if similarity < min_similarity {
            continue;
        }
        match &best {
            Some(existing) if similarity <= existing.similarity => {}
            _ => {
                best = Some(SemanticNearDuplicateMatchOutput {
                    matched: true,
                    similarity,
                    proposal_id: candidate.proposal_id.clone(),
                    proposal_type: candidate.proposal_type.clone(),
                    source_eye: candidate.source_eye.clone(),
                    objective_id: candidate.objective_id.clone(),
                });
            }
        }
    }

    best.unwrap_or(SemanticNearDuplicateMatchOutput {
        matched: false,
        similarity: 0.0,
        proposal_id: None,
        proposal_type: None,
        source_eye: None,
        objective_id: None,
    })
}

pub fn compute_strategy_rank_score(input: &StrategyRankScoreInput) -> StrategyRankScoreOutput {
    let raw = (input.composite_weight * input.composite)
        + (input.actionability_weight * input.actionability)
        + (input.directive_fit_weight * input.directive_fit)
        + (input.signal_quality_weight * input.signal_quality)
        + (input.expected_value_weight * input.expected_value)
        + (input.value_density_weight * input.value_density)
        - (input.risk_penalty_weight * input.risk_penalty)
        + (input.time_to_value_weight * input.time_to_value)
        - input.non_yield_penalty
        - input.collective_shadow_penalty
        + input.collective_shadow_bonus;
    StrategyRankScoreOutput {
        score: (raw * 1000.0).round() / 1000.0,
    }
}

pub fn compute_strategy_rank_adjusted(
    input: &StrategyRankAdjustedInput,
) -> StrategyRankAdjustedOutput {
    let to_fixed3 = |value: f64| -> f64 {
        format!("{value:.3}").parse::<f64>().unwrap_or(value)
    };
    let pulse_score = input.pulse_score.clamp(0.0, 100.0);
    let pulse_weight = input.pulse_weight.clamp(0.0, 1.0);
    let objective_allocation_score = input.objective_allocation_score.clamp(0.0, 100.0);
    let base_objective_weight = input.base_objective_weight.clamp(0.0, 1.0);
    let objective_weight = if input.canary_mode {
        base_objective_weight
    } else {
        to_fixed3(base_objective_weight * 0.35)
    };
    let pulse_bonus = pulse_weight * pulse_score;
    let objective_bonus = objective_weight * objective_allocation_score;
    let total = to_fixed3(pulse_bonus + objective_bonus);
    let adjusted = to_fixed3(input.base + total);

    StrategyRankAdjustedOutput {
        adjusted,
        bonus: StrategyRankAdjustedBonus {
            pulse_weight,
            pulse_score,
            objective_weight,
            objective_allocation_score,
            total,
        },
    }
}

pub fn compute_trit_shadow_rank_score(
    input: &TritShadowRankScoreInput,
) -> TritShadowRankScoreOutput {
    let to_fixed3 = |value: f64| -> f64 {
        format!("{value:.3}").parse::<f64>().unwrap_or(value)
    };
    let score = input.score.clamp(-1.0, 1.0);
    let confidence = input.confidence.clamp(0.0, 1.0);
    let normalized = ((score + 1.0) * 50.0) + (confidence * 10.0);
    let clamped = normalized.clamp(0.0, 100.0);
    TritShadowRankScoreOutput {
        score: to_fixed3(clamped),
    }
}

pub fn compute_strategy_circuit_cooldown(
    input: &StrategyCircuitCooldownInput,
) -> StrategyCircuitCooldownOutput {
    let mut err = input
        .last_error_code
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if err.is_empty() {
        err = input
            .last_error
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
    }
    if err.is_empty() {
        return StrategyCircuitCooldownOutput { cooldown_hours: 0.0 };
    }

    if err.contains("429") || err.contains("rate_limit") {
        return StrategyCircuitCooldownOutput {
            cooldown_hours: input.http_429_cooldown_hours,
        };
    }
    let has_5xx_code = err
        .as_bytes()
        .windows(3)
        .any(|window| window[0] == b'5' && window[1].is_ascii_digit() && window[2].is_ascii_digit());
    if err.contains("5xx") || err.contains("server_error") || has_5xx_code {
        return StrategyCircuitCooldownOutput {
            cooldown_hours: input.http_5xx_cooldown_hours,
        };
    }
    if err.contains("dns") || err.contains("enotfound") || err.contains("unreachable") {
        return StrategyCircuitCooldownOutput {
            cooldown_hours: input.dns_error_cooldown_hours,
        };
    }

    StrategyCircuitCooldownOutput { cooldown_hours: 0.0 }
}

pub fn compute_strategy_trit_shadow_adjusted(
    input: &StrategyTritShadowAdjustedInput,
) -> StrategyTritShadowAdjustedOutput {
    let to_fixed3 = |value: f64| -> f64 {
        format!("{value:.3}").parse::<f64>().unwrap_or(value)
    };
    let bonus_applied = to_fixed3(input.bonus_raw * input.bonus_blend);
    let adjusted_score = to_fixed3(input.base_score + bonus_applied);
    StrategyTritShadowAdjustedOutput {
        adjusted_score,
        bonus_applied,
    }
}

pub fn compute_non_yield_penalty_score(
    input: &NonYieldPenaltyScoreInput,
) -> NonYieldPenaltyScoreOutput {
    let to_fixed3 = |value: f64| -> f64 {
        format!("{value:.3}").parse::<f64>().unwrap_or(value)
    };
    let raw = (input.policy_hold_rate * input.policy_hold_weight)
        + (input.no_progress_rate * input.no_progress_weight)
        + (input.stop_rate * input.stop_weight)
        - (input.shipped_rate * input.shipped_relief_weight);
    let penalty = raw.clamp(0.0, input.max_penalty.max(0.0));
    NonYieldPenaltyScoreOutput {
        penalty: to_fixed3(penalty),
    }
}

pub fn compute_collective_shadow_adjustments(
    input: &CollectiveShadowAdjustmentsInput,
) -> CollectiveShadowAdjustmentsOutput {
    let to_fixed3 = |value: f64| -> f64 {
        format!("{value:.3}").parse::<f64>().unwrap_or(value)
    };
    CollectiveShadowAdjustmentsOutput {
        penalty: to_fixed3(input.penalty_raw.clamp(0.0, input.max_penalty.max(0.0))),
        bonus: to_fixed3(input.bonus_raw.clamp(0.0, input.max_bonus.max(0.0))),
    }
}

pub fn compute_strategy_trit_shadow_ranking_summary(
    input: &StrategyTritShadowRankingSummaryInput,
) -> StrategyTritShadowRankingSummaryOutput {
    let mut ranked = input.rows.clone();
    ranked.sort_by(|a, b| {
        b.trit_rank
            .partial_cmp(&a.trit_rank)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.legacy_rank
                    .partial_cmp(&a.legacy_rank)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.proposal_id.cmp(&b.proposal_id))
    });

    let legacy_top = input
        .rows
        .first()
        .map(|row| row.proposal_id.trim().to_string())
        .filter(|s| !s.is_empty());
    let trit_top = ranked
        .first()
        .map(|row| row.proposal_id.trim().to_string())
        .filter(|s| !s.is_empty());
    let selected = input
        .selected_proposal_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let selected_opt = if selected.is_empty() {
        None
    } else {
        Some(selected)
    };
    let mode = input
        .selection_mode
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let mode_opt = if mode.is_empty() { None } else { Some(mode) };

    let top_k = input.top_k.max(1) as usize;
    let top = ranked.into_iter().take(top_k).collect::<Vec<_>>();
    StrategyTritShadowRankingSummaryOutput {
        considered: input.rows.len() as u32,
        selection_mode: mode_opt,
        selected_proposal_id: selected_opt.clone(),
        legacy_top_proposal_id: legacy_top.clone(),
        trit_top_proposal_id: trit_top.clone(),
        diverged_from_legacy_top: match (&legacy_top, &trit_top) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        },
        diverged_from_selected: match (&selected_opt, &trit_top) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        },
        top,
    }
}

pub fn compute_shadow_scope_matches(input: &ShadowScopeMatchesInput) -> ShadowScopeMatchesOutput {
    let scope_type = input
        .scope_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let scope_value = input
        .scope_value
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let risk_levels = input
        .risk_levels
        .iter()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    let risk = input
        .risk
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let proposal_type = input
        .proposal_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let capability_key = input
        .capability_key
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let objective_id = input
        .objective_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    let matched = match scope_type.as_str() {
        "proposal_type" => !scope_value.is_empty() && !proposal_type.is_empty() && scope_value == proposal_type,
        "capability_key" => !scope_value.is_empty() && !capability_key.is_empty() && scope_value == capability_key,
        "objective_id" => !scope_value.is_empty() && !objective_id.is_empty() && scope_value == objective_id,
        "global" => {
            if risk_levels.is_empty() {
                true
            } else {
                !risk.is_empty() && risk_levels.iter().any(|v| v == &risk)
            }
        }
        _ => false,
    };
    ShadowScopeMatchesOutput { matched }
}

pub fn compute_collective_shadow_aggregate(
    input: &CollectiveShadowAggregateInput,
) -> CollectiveShadowAggregateOutput {
    let to_fixed4 = |value: f64| -> f64 {
        format!("{value:.4}").parse::<f64>().unwrap_or(value)
    };
    let to_fixed3 = |value: f64| -> f64 {
        format!("{value:.3}").parse::<f64>().unwrap_or(value)
    };
    let matches = input.entries.len() as u32;
    if matches == 0 {
        return CollectiveShadowAggregateOutput {
            matches: 0,
            confidence_avg: 0.0,
            penalty_raw: 0.0,
            bonus_raw: 0.0,
        };
    }

    let confidence_sum = input
        .entries
        .iter()
        .map(|row| row.confidence.max(0.0).min(1.0))
        .sum::<f64>();
    let confidence_avg = to_fixed4(confidence_sum / (matches as f64));

    let penalty_raw = input
        .entries
        .iter()
        .filter(|row| {
            row.kind
                .as_deref()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("avoid")
        })
        .map(|row| row.score_impact.max(0.0) * row.confidence.max(0.0).min(1.0))
        .sum::<f64>();
    let bonus_raw = input
        .entries
        .iter()
        .filter(|row| {
            row.kind
                .as_deref()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("reinforce")
        })
        .map(|row| row.score_impact.max(0.0) * row.confidence.max(0.0).min(1.0))
        .sum::<f64>();

    CollectiveShadowAggregateOutput {
        matches,
        confidence_avg,
        penalty_raw: to_fixed3(penalty_raw),
        bonus_raw: to_fixed3(bonus_raw),
    }
}

pub fn compute_expected_value_signal(
    input: &ExpectedValueSignalInput,
) -> ExpectedValueSignalOutput {
    let clamp_score = |value: f64| -> f64 {
        if !value.is_finite() {
            0.0
        } else if value <= 0.0 {
            0.0
        } else if value >= 100.0 {
            100.0
        } else {
            value
        }
    };
    let round_score = |value: f64| -> f64 { clamp_score(value.round()) };
    let to_fixed3 = |value: f64| -> f64 {
        format!("{value:.3}").parse::<f64>().unwrap_or(value)
    };
    let selected_currency = input.selected_currency.as_deref().unwrap_or("").trim();
    let oracle_priority = input
        .oracle_priority_score
        .filter(|value| value.is_finite())
        .map(round_score);

    let (base_score, source) = if let Some(explicit) = input.explicit_score {
        if explicit.is_finite() {
            (round_score(explicit), "expected_value_score".to_string())
        } else if let Some(usd) = input.expected_value_usd {
            if usd.is_finite() && usd > 0.0 {
                (
                    round_score((usd.max(1.0).log10()) * 30.0),
                    "expected_value_usd".to_string(),
                )
            } else if let Some(priority) = oracle_priority {
                (priority, "value_oracle_priority_score".to_string())
            } else {
                (
                    round_score(clamp_score(input.impact_weight) * 20.0),
                    "impact_weight_fallback".to_string(),
                )
            }
        } else if let Some(priority) = oracle_priority {
            (priority, "value_oracle_priority_score".to_string())
        } else {
            (
                round_score(clamp_score(input.impact_weight) * 20.0),
                "impact_weight_fallback".to_string(),
            )
        }
    } else if let Some(usd) = input.expected_value_usd {
        if usd.is_finite() && usd > 0.0 {
            (
                round_score((usd.max(1.0).log10()) * 30.0),
                "expected_value_usd".to_string(),
            )
        } else if let Some(priority) = oracle_priority {
            (priority, "value_oracle_priority_score".to_string())
        } else {
            (
                round_score(clamp_score(input.impact_weight) * 20.0),
                "impact_weight_fallback".to_string(),
            )
        }
    } else if let Some(priority) = oracle_priority {
        (priority, "value_oracle_priority_score".to_string())
    } else {
        (
            round_score(clamp_score(input.impact_weight) * 20.0),
            "impact_weight_fallback".to_string(),
        )
    };

    let currency_adjusted_score = oracle_priority.map(|priority| {
        round_score(priority * if input.currency_multiplier.is_finite() {
            input.currency_multiplier.max(0.0)
        } else {
            1.0
        })
    });
    let apply_currency_rank = input.currency_ranking_enabled
        && input.oracle_applies
        && input.oracle_pass
        && currency_adjusted_score.is_some();
    let first_sentence_bonus = if apply_currency_rank
        && !selected_currency.is_empty()
        && input.matched_first_sentence_contains_selected
    {
        2.0
    } else {
        0.0
    };

    let delta = if apply_currency_rank {
        let adjusted = currency_adjusted_score.unwrap_or(0.0);
        let blend = if input.rank_blend.is_finite() {
            input.rank_blend.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let blended = (base_score * (1.0 - blend)) + (adjusted * blend) + first_sentence_bonus;
        let cap = if input.bonus_cap.is_finite() {
            input.bonus_cap.max(0.0)
        } else {
            0.0
        };
        (blended - base_score).clamp(-cap, cap)
    } else {
        0.0
    };
    let score = round_score(base_score + delta);

    ExpectedValueSignalOutput {
        score,
        base_score,
        source,
        value_oracle_priority: oracle_priority,
        currency_adjusted_score,
        currency_delta: to_fixed3(delta),
        oracle_applies: input.oracle_applies,
        oracle_pass: input.oracle_pass,
    }
}

pub fn compute_value_signal_score(input: &ValueSignalScoreInput) -> ValueSignalScoreOutput {
    let raw = (input.expected_value * 0.52)
        + (input.time_to_value * 0.22)
        + (input.actionability * 0.18)
        + (input.directive_fit * 0.08);
    ValueSignalScoreOutput {
        score: (raw * 1000.0).round() / 1000.0,
    }
}

pub fn compute_composite_eligibility_score(
    input: &CompositeEligibilityScoreInput,
) -> CompositeEligibilityScoreOutput {
    let clamp = |v: f64| -> f64 {
        if !v.is_finite() || v < 0.0 {
            0.0
        } else if v > 100.0 {
            100.0
        } else {
            v
        }
    };
    let q = clamp(input.quality_score);
    let d = clamp(input.directive_fit_score);
    let a = clamp(input.actionability_score);
    let weighted = (q * 0.42) + (d * 0.26) + (a * 0.32);
    let rounded = weighted.round();
    let score = if rounded <= 0.0 {
        0
    } else if rounded >= 100.0 {
        100
    } else {
        rounded as u32
    };
    CompositeEligibilityScoreOutput { score }
}

pub fn compute_time_to_value_score(input: &TimeToValueScoreInput) -> TimeToValueScoreOutput {
    if let Some(hours) = input.time_to_cash_hours {
        if hours.is_finite() && hours >= 0.0 {
            let score = 100.0 - (hours.min(168.0) / 168.0) * 100.0;
            let rounded = score.round();
            let clamped = if rounded <= 0.0 {
                0
            } else if rounded >= 100.0 {
                100
            } else {
                rounded as u32
            };
            return TimeToValueScoreOutput { score: clamped };
        }
    }
    let impact = input
        .expected_impact
        .as_ref()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    let score = if impact == "high" {
        40
    } else if impact == "medium" {
        55
    } else {
        70
    };
    TimeToValueScoreOutput { score }
}

pub fn compute_value_density_score(input: &ValueDensityScoreInput) -> ValueDensityScoreOutput {
    let value = if !input.expected_value.is_finite() || input.expected_value < 0.0 {
        0.0
    } else if input.expected_value > 100.0 {
        100.0
    } else {
        input.expected_value
    };
    let tokens = if !input.est_tokens.is_finite() {
        80.0
    } else if input.est_tokens < 80.0 {
        80.0
    } else if input.est_tokens > 12000.0 {
        12000.0
    } else {
        input.est_tokens
    };
    if value <= 0.0 {
        return ValueDensityScoreOutput { score: 0 };
    }
    let score = (value * 1000.0) / tokens.max(80.0);
    let rounded = score.round();
    let clamped = if rounded <= 0.0 {
        0
    } else if rounded >= 100.0 {
        100
    } else {
        rounded as u32
    };
    ValueDensityScoreOutput { score: clamped }
}

pub fn compute_normalize_directive_tier(
    input: &NormalizeDirectiveTierInput,
) -> NormalizeDirectiveTierOutput {
    let fallback = input
        .fallback
        .filter(|v| v.is_finite())
        .unwrap_or(3.0);
    let raw = input
        .raw_tier
        .filter(|v| v.is_finite())
        .unwrap_or(fallback);
    let tier = raw.round().max(1.0);
    NormalizeDirectiveTierOutput {
        tier: tier as u32,
    }
}

pub fn compute_directive_tier_weight(
    input: &DirectiveTierWeightInput,
) -> DirectiveTierWeightOutput {
    let fallback = input
        .fallback
        .filter(|v| v.is_finite())
        .unwrap_or(3.0);
    let raw = input
        .tier
        .filter(|v| v.is_finite())
        .unwrap_or(fallback);
    let normalized_tier = raw.round().max(1.0);
    let weight = if normalized_tier <= 1.0 {
        1.3
    } else if normalized_tier <= 2.0 {
        1.0
    } else if normalized_tier <= 3.0 {
        0.82
    } else {
        0.7
    };
    DirectiveTierWeightOutput { weight }
}

pub fn compute_directive_tier_min_share(
    input: &DirectiveTierMinShareInput,
) -> DirectiveTierMinShareOutput {
    let fallback = input
        .fallback
        .filter(|v| v.is_finite())
        .unwrap_or(3.0);
    let raw = input
        .tier
        .filter(|v| v.is_finite())
        .unwrap_or(fallback);
    let normalized_tier = raw.round().max(1.0);
    let clamp_ratio = |value: f64| -> f64 {
        if !value.is_finite() {
            0.0
        } else {
            value.clamp(0.0, 1.0)
        }
    };
    let min_share = if normalized_tier <= 1.0 {
        clamp_ratio(input.t1_min_share)
    } else if normalized_tier <= 2.0 {
        clamp_ratio(input.t2_min_share)
    } else {
        0.0
    };
    DirectiveTierMinShareOutput { min_share }
}

pub fn compute_directive_tier_coverage_bonus(
    input: &DirectiveTierCoverageBonusInput,
) -> DirectiveTierCoverageBonusOutput {
    let fallback = input
        .fallback
        .filter(|v| v.is_finite())
        .unwrap_or(3.0);
    let raw = input
        .tier
        .filter(|v| v.is_finite())
        .unwrap_or(fallback);
    let normalized_tier = raw.round().max(1.0);
    let attempts_today = if input.attempts_today.is_finite() {
        input.attempts_today.max(0.0)
    } else {
        0.0
    };
    let current_for_tier = if input.current_for_tier.is_finite() {
        input.current_for_tier.max(0.0)
    } else {
        0.0
    };

    if attempts_today <= 0.0 {
        let bonus = if normalized_tier <= 1.0 {
            8.0
        } else if normalized_tier <= 2.0 {
            4.0
        } else {
            0.0
        };
        return DirectiveTierCoverageBonusOutput { bonus };
    }

    let min_share = compute_directive_tier_min_share(&DirectiveTierMinShareInput {
        tier: Some(normalized_tier),
        fallback: Some(3.0),
        t1_min_share: input.t1_min_share,
        t2_min_share: input.t2_min_share,
    })
    .min_share;
    if min_share <= 0.0 {
        return DirectiveTierCoverageBonusOutput { bonus: 0.0 };
    }

    let expected = (attempts_today * min_share).ceil();
    let deficit = (expected - current_for_tier).max(0.0);
    let bonus = (deficit * 6.0).min(18.0);
    DirectiveTierCoverageBonusOutput { bonus }
}

pub fn compute_directive_tier_reservation_need(
    input: &DirectiveTierReservationNeedInput,
) -> DirectiveTierReservationNeedOutput {
    let attempts_today = if input.attempts_today.is_finite() {
        input.attempts_today.max(0.0)
    } else {
        0.0
    };
    if !input.enabled || !input.available {
        return DirectiveTierReservationNeedOutput {
            reserve: false,
            tier: None,
            min_share: None,
            attempts_today,
            current_tier_attempts: None,
            required_after_next: None,
            candidate_count: None,
        };
    }

    let clamp_ratio = |value: f64| -> f64 {
        if !value.is_finite() {
            0.0
        } else {
            value.clamp(0.0, 1.0)
        }
    };
    let normalize_tier = |raw: f64, fallback: f64| -> f64 {
        let source = if raw.is_finite() { raw } else { fallback };
        source.round().max(1.0)
    };
    let candidate_tiers = input
        .candidate_tiers
        .iter()
        .map(|raw| normalize_tier(*raw, 99.0))
        .collect::<Vec<_>>();
    for tier in [1.0_f64, 2.0_f64] {
        let min_share = if tier <= 1.0 {
            clamp_ratio(input.tier1_min_share)
        } else {
            clamp_ratio(input.tier2_min_share)
        };
        if min_share <= 0.0 {
            continue;
        }
        let current = if tier <= 1.0 {
            input.tier1_attempts
        } else {
            input.tier2_attempts
        };
        let current = if current.is_finite() {
            current.max(0.0)
        } else {
            0.0
        };
        let required_after_next = ((attempts_today + 1.0) * min_share).ceil();
        if current >= required_after_next {
            continue;
        }
        let candidate_count = candidate_tiers
            .iter()
            .filter(|value| (**value - tier).abs() < 0.000001)
            .count() as u32;
        return DirectiveTierReservationNeedOutput {
            reserve: true,
            tier: Some(tier as u32),
            min_share: Some(min_share),
            attempts_today,
            current_tier_attempts: Some(current),
            required_after_next: Some(required_after_next),
            candidate_count: Some(candidate_count),
        };
    }
    DirectiveTierReservationNeedOutput {
        reserve: false,
        tier: None,
        min_share: None,
        attempts_today,
        current_tier_attempts: None,
        required_after_next: None,
        candidate_count: None,
    }
}

pub fn compute_pulse_objective_cooldown_active(
    input: &PulseObjectiveCooldownActiveInput,
) -> PulseObjectiveCooldownActiveOutput {
    let streak = input.no_progress_streak;
    if !streak.is_finite() {
        return PulseObjectiveCooldownActiveOutput { active: false };
    }
    let limit = if input.no_progress_limit.is_finite() {
        input.no_progress_limit
    } else {
        0.0
    };
    if streak < limit.max(1.0) {
        return PulseObjectiveCooldownActiveOutput { active: false };
    }
    let Some(last_attempt_ts) = input.last_attempt_ts.as_ref() else {
        return PulseObjectiveCooldownActiveOutput { active: false };
    };
    let Some(last_ms) = parse_rfc3339_ts_ms(last_attempt_ts.trim()) else {
        return PulseObjectiveCooldownActiveOutput { active: false };
    };
    let now_ms = input
        .now_ms
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    let age_hours = (now_ms - (last_ms as f64)) / (1000.0 * 60.0 * 60.0);
    let cooldown = if input.cooldown_hours.is_finite() {
        input.cooldown_hours
    } else {
        0.0
    };
    PulseObjectiveCooldownActiveOutput {
        active: age_hours < cooldown.max(1.0),
    }
}

pub fn compute_directive_token_hits(input: &DirectiveTokenHitsInput) -> DirectiveTokenHitsOutput {
    let text_tokens = input
        .text_tokens
        .iter()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let text_stems = input
        .text_stems
        .iter()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let mut hits = Vec::new();
    for token in &input.directive_tokens {
        let token = token.trim().to_string();
        if token.is_empty() {
            continue;
        }
        if text_tokens.contains(&token) {
            hits.push(token);
            continue;
        }
        let stem = if token.len() <= 5 {
            token.clone()
        } else {
            token[..5].to_string()
        };
        if !stem.is_empty() && text_stems.contains(&stem) {
            hits.push(token);
        }
    }
    DirectiveTokenHitsOutput { hits }
}

pub fn compute_to_stem(input: &ToStemInput) -> ToStemOutput {
    let token = input
        .token
        .as_ref()
        .map(|token| token.trim().to_string())
        .unwrap_or_default();
    let stem = if token.len() <= 5 {
        token
    } else {
        token[..5].to_string()
    };
    ToStemOutput { stem }
}

pub fn compute_normalize_directive_text(
    input: &NormalizeDirectiveTextInput,
) -> NormalizeDirectiveTextOutput {
    let text = input.text.as_deref().unwrap_or("");
    let lowered = text.to_ascii_lowercase();
    let mut scrubbed = String::with_capacity(lowered.len());
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            scrubbed.push(ch);
        } else {
            scrubbed.push(' ');
        }
    }
    let normalized = scrubbed.split_whitespace().collect::<Vec<_>>().join(" ");
    NormalizeDirectiveTextOutput { normalized }
}

pub fn compute_tokenize_directive_text(
    input: &TokenizeDirectiveTextInput,
) -> TokenizeDirectiveTextOutput {
    let normalized = compute_normalize_directive_text(&NormalizeDirectiveTextInput {
        text: input.text.clone(),
    })
    .normalized;
    if normalized.is_empty() {
        return TokenizeDirectiveTextOutput { tokens: Vec::new() };
    }
    let stopwords = input
        .stopwords
        .iter()
        .map(|word| word.trim().to_string())
        .filter(|word| !word.is_empty())
        .collect::<std::collections::BTreeSet<_>>();

    let tokens = normalized
        .split(' ')
        .filter(|token| token.len() >= 3)
        .filter(|token| !token.chars().all(|ch| ch.is_ascii_digit()))
        .filter(|token| !stopwords.contains(*token))
        .map(|token| token.to_string())
        .collect::<Vec<_>>();
    TokenizeDirectiveTextOutput { tokens }
}

pub fn compute_normalize_spaces(input: &NormalizeSpacesInput) -> NormalizeSpacesOutput {
    let text = input.text.as_deref().unwrap_or("");
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    NormalizeSpacesOutput { normalized }
}

pub fn compute_parse_lower_list(input: &ParseLowerListInput) -> ParseLowerListOutput {
    let items = if !input.list.is_empty() {
        input.list
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    } else {
        input
            .csv
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    };
    ParseLowerListOutput { items }
}

pub fn compute_canary_failed_checks_allowed(
    input: &CanaryFailedChecksAllowedInput,
) -> CanaryFailedChecksAllowedOutput {
    let failed = input
        .failed_checks
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let allowed = input
        .allowed_checks
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>();

    if failed.is_empty() || allowed.is_empty() {
        return CanaryFailedChecksAllowedOutput { allowed: false };
    }
    for check in &failed {
        if !allowed.contains(check) {
            return CanaryFailedChecksAllowedOutput { allowed: false };
        }
    }
    CanaryFailedChecksAllowedOutput { allowed: true }
}

pub fn compute_proposal_text_blob(input: &ProposalTextBlobInput) -> ProposalTextBlobOutput {
    let mut parts = vec![
        input.title.as_deref().unwrap_or("").trim().to_string(),
        input.summary.as_deref().unwrap_or("").trim().to_string(),
        input.suggested_next_command
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string(),
        input
            .suggested_command
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string(),
        input.notes.as_deref().unwrap_or("").trim().to_string(),
    ];
    for ev in &input.evidence {
        let evidence_ref = ev.evidence_ref.as_deref().unwrap_or("").trim().to_string();
        let path = ev.path.as_deref().unwrap_or("").trim().to_string();
        let title = ev.title.as_deref().unwrap_or("").trim().to_string();
        if !evidence_ref.is_empty() {
            parts.push(evidence_ref);
        }
        if !path.is_empty() {
            parts.push(path);
        }
        if !title.is_empty() {
            parts.push(title);
        }
    }
    parts.retain(|value| !value.is_empty());
    let joined = parts.join(" | ");
    let normalized = compute_normalize_spaces(&NormalizeSpacesInput { text: Some(joined) })
        .normalized
        .to_ascii_lowercase();
    ProposalTextBlobOutput { blob: normalized }
}

pub fn compute_percent_mentions_from_text(
    input: &PercentMentionsFromTextInput,
) -> PercentMentionsFromTextOutput {
    let text = input.text.as_deref().unwrap_or("");
    if text.is_empty() {
        return PercentMentionsFromTextOutput { values: Vec::new() };
    }
    let regex = Regex::new(r"(-?\d+(?:\.\d+)?)\s*%").expect("valid percent regex");
    let mut values = Vec::new();
    for capture in regex.captures_iter(text) {
        let raw = capture
            .get(1)
            .and_then(|value| value.as_str().parse::<f64>().ok());
        let Some(raw) = raw else {
            continue;
        };
        if !raw.is_finite() || raw <= 0.0 {
            continue;
        }
        values.push(raw.clamp(0.0, 100.0));
    }
    PercentMentionsFromTextOutput { values }
}

pub fn compute_optimization_min_delta_percent(
    input: &OptimizationMinDeltaPercentInput,
) -> OptimizationMinDeltaPercentOutput {
    let min_delta_percent = if input.high_accuracy_mode {
        input.high_accuracy_value
    } else {
        input.base_value
    };
    OptimizationMinDeltaPercentOutput { min_delta_percent }
}

pub fn compute_source_eye_ref(input: &SourceEyeRefInput) -> SourceEyeRefOutput {
    let meta_eye = input
        .meta_source_eye
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if !meta_eye.is_empty() {
        return SourceEyeRefOutput {
            eye_ref: format!("eye:{meta_eye}"),
        };
    }
    let evidence_ref = input
        .first_evidence_ref
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if evidence_ref.starts_with("eye:") {
        return SourceEyeRefOutput {
            eye_ref: evidence_ref,
        };
    }
    SourceEyeRefOutput {
        eye_ref: "eye:unknown_eye".to_string(),
    }
}

pub fn compute_normalized_risk(input: &NormalizedRiskInput) -> NormalizedRiskOutput {
    let risk = input
        .risk
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let normalized = if risk == "high" || risk == "medium" || risk == "low" {
        risk
    } else {
        "low".to_string()
    };
    NormalizedRiskOutput { risk: normalized }
}

pub fn compute_parse_iso_ts(input: &ParseIsoTsInput) -> ParseIsoTsOutput {
    let ts = input.ts.as_deref().unwrap_or("").trim();
    let timestamp_ms = parse_rfc3339_ts_ms(ts).map(|value| value as f64);
    ParseIsoTsOutput { timestamp_ms }
}

pub fn compute_extract_objective_id_token(
    input: &ExtractObjectiveIdTokenInput,
) -> ExtractObjectiveIdTokenOutput {
    let text = compute_normalize_spaces(&NormalizeSpacesInput {
        text: input.value.clone(),
    })
    .normalized;
    if text.is_empty() {
        return ExtractObjectiveIdTokenOutput { objective_id: None };
    }
    let direct = Regex::new(r"^T[0-9]+_[A-Za-z0-9_]+$").expect("valid direct objective regex");
    if direct.is_match(&text) {
        return ExtractObjectiveIdTokenOutput {
            objective_id: Some(text),
        };
    }
    let token = Regex::new(r"\b(T[0-9]+_[A-Za-z0-9_]+)\b").expect("valid token objective regex");
    let objective_id = token
        .captures(&text)
        .and_then(|capture| capture.get(1))
        .map(|match_| match_.as_str().to_string());
    ExtractObjectiveIdTokenOutput { objective_id }
}

pub fn compute_execution_reserve_snapshot(
    input: &ExecutionReserveSnapshotInput,
) -> ExecutionReserveSnapshotOutput {
    let token_cap = input.cap.max(0.0);
    let used_est = input.used.max(0.0);
    let reserve_target = if input.reserve_enabled {
        (token_cap * input.reserve_ratio)
            .round()
            .max(input.reserve_min_tokens)
    } else {
        0.0
    };
    let reserve_tokens = reserve_target.max(0.0).min(token_cap);
    let spend_beyond_non_reserve = (used_est - (token_cap - reserve_tokens).max(0.0)).max(0.0);
    let reserve_remaining = (reserve_tokens - spend_beyond_non_reserve).max(0.0);
    ExecutionReserveSnapshotOutput {
        enabled: input.reserve_enabled,
        reserve_tokens,
        reserve_remaining,
    }
}

pub fn compute_budget_pacing_gate(input: &BudgetPacingGateInput) -> BudgetPacingGateOutput {
    if !input.budget_pacing_enabled {
        return BudgetPacingGateOutput {
            pass: true,
            reason: None,
            execution_reserve_bypass: false,
        };
    }
    if !input.snapshot_tight {
        return BudgetPacingGateOutput {
            pass: true,
            reason: None,
            execution_reserve_bypass: false,
        };
    }
    let value_score = if !input.value_signal_score.is_finite() {
        0.0
    } else {
        input.value_signal_score.clamp(0.0, 100.0)
    };
    let est_tokens = if !input.est_tokens.is_finite() {
        0.0
    } else {
        input.est_tokens.max(0.0)
    };
    let normalized_risk = input.risk.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    let high_value_escape = value_score >= (input.min_value_signal_score + 20.0).max(85.0);
    if high_value_escape {
        return BudgetPacingGateOutput {
            pass: true,
            reason: None,
            execution_reserve_bypass: false,
        };
    }
    let reserve_bypass_allowed = input.execution_reserve_enabled
        && input.execution_floor_deficit
        && normalized_risk == "low"
        && value_score >= input.execution_reserve_min_value_signal
        && input.execution_reserve_remaining >= est_tokens;
    if reserve_bypass_allowed {
        return BudgetPacingGateOutput {
            pass: true,
            reason: Some("execution_floor_reserve_bypass".to_string()),
            execution_reserve_bypass: true,
        };
    }
    if input.snapshot_autopause_active && normalized_risk != "low" {
        return BudgetPacingGateOutput {
            pass: false,
            reason: Some("budget_pacing_autopause_risk_guard".to_string()),
            execution_reserve_bypass: false,
        };
    }
    if est_tokens >= input.high_token_threshold && value_score < input.min_value_signal_score {
        return BudgetPacingGateOutput {
            pass: false,
            reason: Some("budget_pacing_high_token_low_value".to_string()),
            execution_reserve_bypass: false,
        };
    }
    if input.snapshot_remaining_ratio <= input.min_remaining_ratio
        && value_score < input.min_value_signal_score
    {
        return BudgetPacingGateOutput {
            pass: false,
            reason: Some("budget_pacing_low_remaining_ratio".to_string()),
            execution_reserve_bypass: false,
        };
    }
    BudgetPacingGateOutput {
        pass: true,
        reason: None,
        execution_reserve_bypass: false,
    }
}

pub fn compute_capability_cap(input: &CapabilityCapInput) -> CapabilityCapOutput {
    let mut keys: Vec<String> = Vec::new();
    if let Some(primary) = input.primary_key.as_deref() {
        let key = primary.trim();
        if !key.is_empty() {
            keys.push(key.to_string());
        }
    }
    for alias in &input.aliases {
        let key = alias.trim();
        if key.is_empty() {
            continue;
        }
        if !keys.iter().any(|existing| existing == key) {
            keys.push(key.to_string());
        }
    }
    for key in keys {
        if let Some(raw) = input.caps.get(&key) {
            if raw.is_finite() && *raw >= 0.0 {
                return CapabilityCapOutput {
                    cap: Some(raw.round().clamp(0.0, u32::MAX as f64) as u32),
                };
            }
        }
    }
    CapabilityCapOutput { cap: None }
}

pub fn compute_estimate_tokens_for_candidate(
    input: &EstimateTokensForCandidateInput,
) -> EstimateTokensForCandidateOutput {
    let clamp = |v: f64| -> u32 {
        let rounded = if v.is_finite() { v.round() } else { 80.0 };
        if rounded <= 80.0 {
            80
        } else if rounded >= 12000.0 {
            12000
        } else {
            rounded as u32
        }
    };
    if input.direct_est_tokens.is_finite() && input.direct_est_tokens > 0.0 {
        return EstimateTokensForCandidateOutput {
            est_tokens: clamp(input.direct_est_tokens),
        };
    }
    if input.route_tokens_est.is_finite() && input.route_tokens_est > 0.0 {
        return EstimateTokensForCandidateOutput {
            est_tokens: clamp(input.route_tokens_est),
        };
    }
    EstimateTokensForCandidateOutput {
        est_tokens: clamp(input.fallback_estimate),
    }
}

pub fn compute_proposal_status_for_queue_pressure(
    input: &ProposalStatusForQueuePressureInput,
) -> ProposalStatusForQueuePressureOutput {
    let has_overlay_decision = input
        .overlay_decision
        .as_ref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let mut status = compute_proposal_status(&ProposalStatusInput {
        overlay_decision: input.overlay_decision.clone(),
    })
    .status;
    if has_overlay_decision {
        return ProposalStatusForQueuePressureOutput { status };
    }

    let explicit = compute_normalize_proposal_status(&NormalizeProposalStatusInput {
        raw_status: input.proposal_status.clone(),
        fallback: Some("pending".to_string()),
    })
    .normalized_status;
    if explicit == "accepted"
        || explicit == "closed"
        || explicit == "rejected"
        || explicit == "parked"
    {
        status = explicit;
    }
    ProposalStatusForQueuePressureOutput { status }
}

pub fn compute_minutes_since_ts(input: &MinutesSinceTsInput) -> MinutesSinceTsOutput {
    let ts_text = input
        .ts
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty());
    let Some(ts_text) = ts_text else {
        return MinutesSinceTsOutput {
            minutes_since: None,
        };
    };
    let parsed = DateTime::parse_from_rfc3339(ts_text)
        .ok()
        .map(|dt| dt.with_timezone(&Utc));
    let Some(parsed) = parsed else {
        return MinutesSinceTsOutput {
            minutes_since: None,
        };
    };
    let now_ms = input
        .now_ms
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    let ts_ms = parsed.timestamp_millis() as f64;
    let minutes_since = (now_ms - ts_ms) / 60000.0;
    MinutesSinceTsOutput {
        minutes_since: Some(minutes_since),
    }
}

pub fn compute_date_window(input: &DateWindowInput) -> DateWindowOutput {
    let end_date_str = input
        .end_date_str
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty());
    let Some(end_date_str) = end_date_str else {
        return DateWindowOutput { dates: Vec::new() };
    };
    let end = NaiveDate::parse_from_str(end_date_str, "%Y-%m-%d").ok();
    let Some(end) = end else {
        return DateWindowOutput { dates: Vec::new() };
    };
    let days = input.days.filter(|v| v.is_finite()).unwrap_or(0.0);
    if days <= 0.0 {
        return DateWindowOutput { dates: Vec::new() };
    }
    let mut dates: Vec<String> = Vec::new();
    let mut i = 0.0_f64;
    while i < days {
        let d = end - Duration::days(i as i64);
        dates.push(d.format("%Y-%m-%d").to_string());
        i += 1.0;
    }
    DateWindowOutput { dates }
}

pub fn compute_in_window(input: &InWindowInput) -> InWindowOutput {
    let ts = input
        .ts
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|dt| dt.with_timezone(&Utc));
    let Some(ts) = ts else {
        return InWindowOutput { in_window: false };
    };
    let end_date = input
        .end_date_str
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .and_then(|v| NaiveDate::parse_from_str(v, "%Y-%m-%d").ok());
    let Some(end_date) = end_date else {
        return InWindowOutput { in_window: false };
    };
    let end_naive = end_date
        .and_hms_milli_opt(23, 59, 59, 999)
        .unwrap_or_else(|| end_date.and_hms_opt(23, 59, 59).expect("valid hms"));
    let end = DateTime::<Utc>::from_naive_utc_and_offset(end_naive, Utc);
    let days = input.days.filter(|v| v.is_finite()).unwrap_or(0.0);
    if days <= 0.0 {
        return InWindowOutput { in_window: false };
    }
    let start_offset_days = (days - 1.0).floor() as i64;
    let start_date = end_date - Duration::days(start_offset_days);
    let start_naive = start_date
        .and_hms_milli_opt(0, 0, 0, 0)
        .unwrap_or_else(|| start_date.and_hms_opt(0, 0, 0).expect("valid hms"));
    let start = DateTime::<Utc>::from_naive_utc_and_offset(start_naive, Utc);
    InWindowOutput {
        in_window: ts >= start && ts <= end,
    }
}

pub fn compute_start_of_next_utc_day(
    input: &StartOfNextUtcDayInput,
) -> StartOfNextUtcDayOutput {
    let date_str = input
        .date_str
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty());
    let Some(date_str) = date_str else {
        return StartOfNextUtcDayOutput { iso_ts: None };
    };
    let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok();
    let Some(date) = date else {
        return StartOfNextUtcDayOutput { iso_ts: None };
    };
    let next = date + Duration::days(1);
    StartOfNextUtcDayOutput {
        iso_ts: Some(format!("{}T00:00:00.000Z", next.format("%Y-%m-%d"))),
    }
}

pub fn compute_iso_after_minutes(input: &IsoAfterMinutesInput) -> IsoAfterMinutesOutput {
    let minutes = input.minutes.filter(|v| v.is_finite());
    let Some(minutes) = minutes else {
        return IsoAfterMinutesOutput { iso_ts: None };
    };
    let safe_minutes = if minutes < 0.0 { 0.0 } else { minutes };
    let now_ms = input
        .now_ms
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    let target_ms = now_ms + (safe_minutes * 60_000.0);
    if !target_ms.is_finite() || target_ms < i64::MIN as f64 || target_ms > i64::MAX as f64 {
        return IsoAfterMinutesOutput { iso_ts: None };
    }
    let target = DateTime::<Utc>::from_timestamp_millis(target_ms as i64);
    let Some(target) = target else {
        return IsoAfterMinutesOutput { iso_ts: None };
    };
    IsoAfterMinutesOutput {
        iso_ts: Some(target.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
    }
}

pub fn compute_execute_confidence_history_match(
    input: &ExecuteConfidenceHistoryMatchInput,
) -> ExecuteConfidenceHistoryMatchOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return ExecuteConfidenceHistoryMatchOutput { matched: false };
    }
    let capability_key = input
        .capability_key
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let event_capability_key = input
        .event_capability_key
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !capability_key.is_empty() && !event_capability_key.is_empty() {
        return ExecuteConfidenceHistoryMatchOutput {
            matched: event_capability_key == capability_key,
        };
    }
    let proposal_type = input
        .proposal_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let event_proposal_type = input
        .event_proposal_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !proposal_type.is_empty() && !event_proposal_type.is_empty() {
        return ExecuteConfidenceHistoryMatchOutput {
            matched: event_proposal_type == proposal_type,
        };
    }
    ExecuteConfidenceHistoryMatchOutput { matched: false }
}

pub fn compute_execute_confidence_cooldown_key(
    input: &ExecuteConfidenceCooldownKeyInput,
) -> ExecuteConfidenceCooldownKeyOutput {
    let objective =
        sanitize_directive_objective_id_single_digit(input.objective_id.as_deref().unwrap_or(""));
    if !objective.is_empty() {
        let token = sanitize_cooldown_fragment(&objective);
        if !token.is_empty() {
            return ExecuteConfidenceCooldownKeyOutput {
                cooldown_key: format!("exec_confidence:objective:{token}"),
            };
        }
    }

    let capability = sanitize_cooldown_fragment(input.capability_key.as_deref().unwrap_or(""));
    if !capability.is_empty() {
        return ExecuteConfidenceCooldownKeyOutput {
            cooldown_key: format!("exec_confidence:capability:{capability}"),
        };
    }

    let proposal_type = sanitize_cooldown_fragment(input.proposal_type.as_deref().unwrap_or(""));
    if !proposal_type.is_empty() {
        return ExecuteConfidenceCooldownKeyOutput {
            cooldown_key: format!("exec_confidence:type:{proposal_type}"),
        };
    }

    ExecuteConfidenceCooldownKeyOutput {
        cooldown_key: String::new(),
    }
}

pub fn compute_qos_lane_weights(input: &QosLaneWeightsInput) -> QosLaneWeightsOutput {
    let pressure = input
        .pressure
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "normal".to_string());
    let mut out = QosLaneWeightsOutput {
        critical: input.critical_weight,
        standard: input.standard_weight,
        explore: input.explore_weight,
        quarantine: input.quarantine_weight,
    };
    if pressure == "warning" {
        out.explore = round6(out.explore * 0.75);
        out.quarantine = round6(out.quarantine * 0.35);
    } else if pressure == "critical" {
        out.critical = round6(out.critical * 1.2);
        out.standard = round6(out.standard * 1.1);
        out.explore = round6(out.explore * 0.3);
        out.quarantine = round6(out.quarantine * 0.1);
    }
    out
}

pub fn compute_qos_lane_usage(input: &QosLaneUsageInput) -> QosLaneUsageOutput {
    let mut out = QosLaneUsageOutput {
        critical: 0,
        standard: 0,
        explore: 0,
        quarantine: 0,
    };
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" || result != "executed" {
            continue;
        }
        let mode = evt
            .selection_mode
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if mode.contains("qos_critical_") {
            out.critical += 1;
        } else if mode.contains("qos_standard_") {
            out.standard += 1;
        } else if mode.contains("qos_explore_") {
            out.explore += 1;
        } else if mode.contains("qos_quarantine_") {
            out.quarantine += 1;
        }
    }
    out
}

pub fn compute_qos_lane_share_cap_exceeded(
    input: &QosLaneShareCapExceededInput,
) -> QosLaneShareCapExceededOutput {
    if input.executed_count <= 0.0 {
        return QosLaneShareCapExceededOutput { exceeded: false };
    }
    let lane = input
        .lane
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let exceeded = if lane == "explore" {
        (input.explore_usage / input.executed_count) >= input.explore_max_share
    } else if lane == "quarantine" {
        (input.quarantine_usage / input.executed_count) >= input.quarantine_max_share
    } else {
        false
    };
    QosLaneShareCapExceededOutput { exceeded }
}

pub fn compute_qos_lane_from_candidate(
    input: &QosLaneFromCandidateInput,
) -> QosLaneFromCandidateOutput {
    if input.queue_underflow_backfill {
        return QosLaneFromCandidateOutput {
            lane: "quarantine".to_string(),
        };
    }
    if input.pulse_tier <= 1 {
        return QosLaneFromCandidateOutput {
            lane: "critical".to_string(),
        };
    }
    let proposal_type = input
        .proposal_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if proposal_type == "directive_clarification" || proposal_type == "directive_decomposition" {
        return QosLaneFromCandidateOutput {
            lane: "critical".to_string(),
        };
    }
    if input.deprioritized_source {
        return QosLaneFromCandidateOutput {
            lane: "quarantine".to_string(),
        };
    }
    let risk = normalize_risk_level(input.risk.as_deref().unwrap_or(""));
    if risk == "medium" {
        return QosLaneFromCandidateOutput {
            lane: "explore".to_string(),
        };
    }
    QosLaneFromCandidateOutput {
        lane: "standard".to_string(),
    }
}

fn parse_rfc3339_ts_ms(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp_millis())
}

pub fn compute_eye_outcome_count_window(
    input: &EyeOutcomeWindowCountInput,
) -> EyeOutcomeWindowCountOutput {
    let eye_ref = input
        .eye_ref
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if eye_ref.is_empty() {
        return EyeOutcomeWindowCountOutput { count: 0 };
    }
    let outcome = input
        .outcome
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let end_date_raw = input
        .end_date_str
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let end_date = NaiveDate::parse_from_str(&end_date_raw, "%Y-%m-%d").ok();
    let Some(end_date) = end_date else {
        return EyeOutcomeWindowCountOutput { count: 0 };
    };
    let days = input.days.unwrap_or(1).max(1);
    let end_dt = end_date.and_hms_milli_opt(23, 59, 59, 999);
    let start_date = end_date - Duration::days(days - 1);
    let start_dt = start_date.and_hms_milli_opt(0, 0, 0, 0);
    let (Some(end_dt), Some(start_dt)) = (end_dt, start_dt) else {
        return EyeOutcomeWindowCountOutput { count: 0 };
    };
    let end_ms = end_dt.and_utc().timestamp_millis();
    let start_ms = start_dt.and_utc().timestamp_millis();

    let mut count: u32 = 0;
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "outcome" {
            continue;
        }
        let event_outcome = evt
            .outcome
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if event_outcome != outcome {
            continue;
        }
        let evidence_ref = evt
            .evidence_ref
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_default();
        if !evidence_ref.contains(&eye_ref) {
            continue;
        }
        let ts_ms = evt
            .ts
            .as_ref()
            .and_then(|v| parse_rfc3339_ts_ms(v.trim()));
        let Some(ts_ms) = ts_ms else {
            continue;
        };
        if ts_ms < start_ms || ts_ms > end_ms {
            continue;
        }
        count += 1;
    }
    EyeOutcomeWindowCountOutput { count }
}

pub fn compute_eye_outcome_count_last_hours(
    input: &EyeOutcomeLastHoursCountInput,
) -> EyeOutcomeLastHoursCountOutput {
    let eye_ref = input
        .eye_ref
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let hours = input.hours.unwrap_or(0.0);
    if eye_ref.is_empty() || !hours.is_finite() || hours <= 0.0 {
        return EyeOutcomeLastHoursCountOutput { count: 0 };
    }
    let outcome = input
        .outcome
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let now_ms = if let Some(v) = input.now_ms {
        if v.is_finite() { v } else { 0.0 }
    } else {
        Utc::now().timestamp_millis() as f64
    };
    let cutoff = now_ms - (hours * 3_600_000.0);

    let mut count: u32 = 0;
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "outcome" {
            continue;
        }
        let event_outcome = evt
            .outcome
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if event_outcome != outcome {
            continue;
        }
        let evidence_ref = evt
            .evidence_ref
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_default();
        if !evidence_ref.contains(&eye_ref) {
            continue;
        }
        let ts_ms = evt
            .ts
            .as_ref()
            .and_then(|v| parse_rfc3339_ts_ms(v.trim()));
        let Some(ts_ms) = ts_ms else {
            continue;
        };
        if (ts_ms as f64) < cutoff {
            continue;
        }
        count += 1;
    }
    EyeOutcomeLastHoursCountOutput { count }
}

pub fn compute_no_progress_result(input: &NoProgressResultInput) -> NoProgressResultOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return NoProgressResultOutput {
            is_no_progress: false,
        };
    }

    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if result == "executed" {
        let outcome = input
            .outcome
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        return NoProgressResultOutput {
            is_no_progress: outcome != "shipped",
        };
    }

    let is_no_progress = result == "init_gate_stub"
        || result == "init_gate_low_score"
        || result == "init_gate_blocked_route"
        || result == "stop_repeat_gate_capability_cap"
        || result == "stop_repeat_gate_directive_pulse_cooldown"
        || result == "stop_repeat_gate_directive_pulse_tier_reservation"
        || result == "stop_repeat_gate_human_escalation_pending"
        || result == "stop_repeat_gate_stale_signal"
        || result == "stop_init_gate_quality_exhausted"
        || result == "stop_init_gate_directive_fit_exhausted"
        || result == "stop_init_gate_actionability_exhausted"
        || result == "stop_init_gate_optimization_good_enough"
        || result == "stop_init_gate_value_signal_exhausted"
        || result == "stop_init_gate_tier1_governance"
        || result == "stop_init_gate_medium_risk_guard"
        || result == "stop_init_gate_medium_requires_canary"
        || result == "stop_init_gate_composite_exhausted"
        || result == "stop_repeat_gate_capability_cooldown"
        || result == "stop_repeat_gate_capability_no_change_cooldown"
        || result == "stop_repeat_gate_medium_canary_cap"
        || result == "stop_repeat_gate_candidate_exhausted"
        || result == "stop_repeat_gate_preview_churn_cooldown"
        || result == "stop_repeat_gate_exhaustion_cooldown"
        || result == "stop_repeat_gate_no_progress"
        || result == "stop_repeat_gate_dopamine";
    NoProgressResultOutput { is_no_progress }
}

pub fn compute_attempt_run_event(input: &AttemptRunEventInput) -> AttemptRunEventOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return AttemptRunEventOutput { is_attempt: false };
    }

    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let is_attempt = result == "executed"
        || result == "init_gate_stub"
        || result == "init_gate_low_score"
        || result == "init_gate_blocked_route"
        || result == "stop_repeat_gate_directive_pulse_cooldown"
        || result == "stop_repeat_gate_directive_pulse_tier_reservation"
        || result == "stop_repeat_gate_human_escalation_pending"
        || result == "stop_repeat_gate_capability_cap"
        || result == "stop_repeat_gate_stale_signal"
        || result == "stop_init_gate_quality_exhausted"
        || result == "stop_init_gate_directive_fit_exhausted"
        || result == "stop_init_gate_actionability_exhausted"
        || result == "stop_init_gate_optimization_good_enough"
        || result == "stop_init_gate_value_signal_exhausted"
        || result == "stop_init_gate_tier1_governance"
        || result == "stop_init_gate_composite_exhausted"
        || result == "stop_repeat_gate_capability_cooldown"
        || result == "stop_repeat_gate_capability_no_change_cooldown"
        || result == "stop_repeat_gate_preview_churn_cooldown"
        || result == "stop_repeat_gate_exhaustion_cooldown"
        || result == "stop_repeat_gate_candidate_exhausted";
    AttemptRunEventOutput { is_attempt }
}

pub fn compute_safety_stop_run_event(input: &SafetyStopRunEventInput) -> SafetyStopRunEventOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return SafetyStopRunEventOutput {
            is_safety_stop: false,
        };
    }

    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let is_safety_stop = result.contains("human_escalation")
        || result.contains("tier1_governance")
        || result.contains("medium_risk_guard")
        || result.contains("capability_cooldown")
        || result.contains("directive_pulse_tier_reservation");
    SafetyStopRunEventOutput { is_safety_stop }
}

pub fn compute_non_yield_category(input: &NonYieldCategoryInput) -> NonYieldCategoryOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return NonYieldCategoryOutput { category: None };
    }

    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if result.is_empty() || result == "lock_busy" || result == "stop_repeat_gate_interval" {
        return NonYieldCategoryOutput { category: None };
    }

    if input.policy_hold.unwrap_or(false) || is_policy_hold_result(&result) {
        let reason_raw = input
            .hold_reason
            .as_ref()
            .or(input.route_block_reason.as_ref())
            .map(|v| v.as_str())
            .unwrap_or(result.as_str());
        let reason = normalize_spaces(reason_raw).to_ascii_lowercase();
        let result_lc = result.to_ascii_lowercase();
        if result_lc.contains("budget")
            || reason.contains("budget")
            || reason.contains("autopause")
        {
            return NonYieldCategoryOutput {
                category: Some("budget_hold".to_string()),
            };
        }
        return NonYieldCategoryOutput {
            category: Some("policy_hold".to_string()),
        };
    }

    let safety = compute_safety_stop_run_event(&SafetyStopRunEventInput {
        event_type: input.event_type.clone(),
        result: input.result.clone(),
    });
    if safety.is_safety_stop {
        return NonYieldCategoryOutput {
            category: Some("safety_stop".to_string()),
        };
    }

    let no_progress = compute_no_progress_result(&NoProgressResultInput {
        event_type: input.event_type.clone(),
        result: input.result.clone(),
        outcome: input.outcome.clone(),
    });
    if no_progress.is_no_progress {
        return NonYieldCategoryOutput {
            category: Some("no_progress".to_string()),
        };
    }

    NonYieldCategoryOutput { category: None }
}

pub fn compute_non_yield_reason(input: &NonYieldReasonInput) -> NonYieldReasonOutput {
    let explicit_raw = input
        .hold_reason
        .as_ref()
        .or(input.route_block_reason.as_ref())
        .or(input.reason.as_ref())
        .map(|v| v.as_str())
        .unwrap_or("");
    let explicit = normalize_spaces(explicit_raw).to_ascii_lowercase();
    if !explicit.is_empty() {
        return NonYieldReasonOutput { reason: explicit };
    }

    let result = normalize_spaces(input.result.as_ref().map(|v| v.as_str()).unwrap_or(""))
        .to_ascii_lowercase();
    let outcome = normalize_spaces(input.outcome.as_ref().map(|v| v.as_str()).unwrap_or(""))
        .to_ascii_lowercase();
    let category = normalize_spaces(input.category.as_ref().map(|v| v.as_str()).unwrap_or(""))
        .to_ascii_lowercase();

    if category == "no_progress" && result == "executed" {
        return NonYieldReasonOutput {
            reason: if outcome.is_empty() {
                "executed_no_progress".to_string()
            } else {
                format!("executed_{outcome}")
            },
        };
    }

    if !result.is_empty() {
        return NonYieldReasonOutput { reason: result };
    }

    NonYieldReasonOutput {
        reason: format!(
            "{}_unknown",
            if category.is_empty() {
                "non_yield".to_string()
            } else {
                category
            }
        ),
    }
}

pub fn compute_proposal_type_from_run_event(
    input: &ProposalTypeFromRunEventInput,
) -> ProposalTypeFromRunEventOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return ProposalTypeFromRunEventOutput {
            proposal_type: String::new(),
        };
    }

    let direct = input
        .proposal_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !direct.is_empty() {
        return ProposalTypeFromRunEventOutput {
            proposal_type: direct,
        };
    }

    let capability = input
        .capability_key
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if capability.starts_with("proposal:") && capability.len() > "proposal:".len() {
        return ProposalTypeFromRunEventOutput {
            proposal_type: capability["proposal:".len()..].to_string(),
        };
    }

    ProposalTypeFromRunEventOutput {
        proposal_type: String::new(),
    }
}

pub fn compute_run_event_objective_id(input: &RunEventObjectiveIdInput) -> RunEventObjectiveIdOutput {
    let selected = if input.directive_pulse_present.unwrap_or(false) {
        input
            .directive_pulse_objective_id
            .as_ref()
            .map(|v| v.as_str())
            .unwrap_or("")
    } else if input.objective_id_present.unwrap_or(false) {
        input.objective_id.as_ref().map(|v| v.as_str()).unwrap_or("")
    } else if input.objective_binding_present.unwrap_or(false) {
        input
            .objective_binding_objective_id
            .as_ref()
            .map(|v| v.as_str())
            .unwrap_or("")
    } else if input.top_escalation_present.unwrap_or(false) {
        input
            .top_escalation_objective_id
            .as_ref()
            .map(|v| v.as_str())
            .unwrap_or("")
    } else {
        ""
    };

    RunEventObjectiveIdOutput {
        objective_id: sanitize_directive_objective_id(selected),
    }
}

pub fn compute_run_event_proposal_id(input: &RunEventProposalIdInput) -> RunEventProposalIdOutput {
    let selected = if input.proposal_id_present.unwrap_or(false) {
        input.proposal_id.as_ref().map(|v| v.as_str()).unwrap_or("")
    } else if input.selected_proposal_id_present.unwrap_or(false) {
        input
            .selected_proposal_id
            .as_ref()
            .map(|v| v.as_str())
            .unwrap_or("")
    } else if input.top_escalation_present.unwrap_or(false) {
        input
            .top_escalation_proposal_id
            .as_ref()
            .map(|v| v.as_str())
            .unwrap_or("")
    } else {
        ""
    };

    RunEventProposalIdOutput {
        proposal_id: normalize_spaces(selected),
    }
}

fn is_score_only_result_for_capacity(result: &str) -> bool {
    compute_score_only_result(&ScoreOnlyResultInput {
        result: Some(result.to_string()),
    })
    .is_score_only
}

pub fn compute_capacity_counted_attempt_event(
    input: &CapacityCountedAttemptEventInput,
) -> CapacityCountedAttemptEventOutput {
    let event_type = input
        .event_type
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if event_type != "autonomy_run" {
        return CapacityCountedAttemptEventOutput {
            capacity_counted: false,
        };
    }

    let result = input
        .result
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if result.is_empty() {
        return CapacityCountedAttemptEventOutput {
            capacity_counted: false,
        };
    }
    if input.policy_hold.unwrap_or(false) {
        return CapacityCountedAttemptEventOutput {
            capacity_counted: false,
        };
    }
    if is_policy_hold_result(&result)
        || result == "lock_busy"
        || result == "stop_repeat_gate_interval"
        || is_score_only_result_for_capacity(&result)
    {
        return CapacityCountedAttemptEventOutput {
            capacity_counted: false,
        };
    }
    if result == "executed" {
        return CapacityCountedAttemptEventOutput {
            capacity_counted: true,
        };
    }

    let is_attempt = compute_attempt_run_event(&AttemptRunEventInput {
        event_type: Some(event_type),
        result: Some(result),
    })
    .is_attempt;
    let proposal_id = normalize_spaces(input.proposal_id.as_deref().unwrap_or(""));
    CapacityCountedAttemptEventOutput {
        capacity_counted: is_attempt && !proposal_id.is_empty(),
    }
}

pub fn compute_repeat_gate_anchor(input: &RepeatGateAnchorInput) -> RepeatGateAnchorOutput {
    let proposal_id = normalize_spaces(input.proposal_id.as_deref().unwrap_or(""));
    let objective_id = normalize_spaces(input.objective_id.as_deref().unwrap_or(""));
    let objective_binding = if input.objective_binding_present.unwrap_or(false) && !objective_id.is_empty() {
        let source_raw = normalize_spaces(input.objective_binding_source.as_deref().unwrap_or(""));
        Some(RepeatGateAnchorBindingOutput {
            pass: input.objective_binding_pass.unwrap_or(true),
            required: input.objective_binding_required.unwrap_or(false),
            objective_id: objective_id.clone(),
            source: if source_raw.is_empty() {
                "repeat_gate_anchor".to_string()
            } else {
                source_raw
            },
            valid: input.objective_binding_valid.unwrap_or(true),
        })
    } else {
        None
    };

    RepeatGateAnchorOutput {
        proposal_id: if proposal_id.is_empty() {
            None
        } else {
            Some(proposal_id)
        },
        objective_id: if objective_id.is_empty() {
            None
        } else {
            Some(objective_id)
        },
        objective_binding,
    }
}

pub fn compute_policy_hold_pressure(input: &PolicyHoldPressureInput) -> PolicyHoldPressureOutput {
    let window_hours = input.window_hours.unwrap_or(24.0).max(1.0);
    let min_samples = input.min_samples.unwrap_or(1.0).max(1.0);
    let now_ms = non_negative_number(input.now_ms).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|v| v.as_millis() as f64)
            .unwrap_or(0.0)
    });
    let cutoff_ms = now_ms - (window_hours * 3_600_000.0);

    let mut attempts: u32 = 0;
    let mut policy_holds: u32 = 0;
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }
        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if result.is_empty() || result == "lock_busy" || result == "stop_repeat_gate_interval" {
            continue;
        }
        if let Some(ts_ms) = non_negative_number(evt.ts_ms) {
            if ts_ms < cutoff_ms {
                continue;
            }
        }
        attempts += 1;
        if evt.policy_hold.unwrap_or(false) || is_policy_hold_result(&result) {
            policy_holds += 1;
        }
    }

    let rate = if attempts > 0 {
        clamp_ratio((policy_holds as f64) / (attempts as f64))
    } else {
        0.0
    };
    let applicable = (attempts as f64) >= min_samples;
    let warn_rate = clamp_ratio(input.warn_rate.unwrap_or(0.25));
    let hard_rate = clamp_ratio(input.hard_rate.unwrap_or(0.4).max(warn_rate));
    let level = if !applicable {
        "normal".to_string()
    } else if rate >= hard_rate {
        "hard".to_string()
    } else if rate >= warn_rate {
        "warn".to_string()
    } else {
        "normal".to_string()
    };

    PolicyHoldPressureOutput {
        window_hours: round3(window_hours),
        min_samples: round3(min_samples),
        samples: attempts,
        policy_holds,
        rate: round3(rate),
        level,
        applicable,
    }
}

fn policy_hold_reason_from_event_input(evt: &PolicyHoldPatternEventInput) -> String {
    let explicit = normalize_spaces(
        &evt.hold_reason
            .as_ref()
            .or(evt.route_block_reason.as_ref())
            .map(|v| v.as_str())
            .unwrap_or(""),
    )
    .to_ascii_lowercase();
    if !explicit.is_empty() {
        return explicit;
    }
    normalize_spaces(evt.result.as_ref().map(|v| v.as_str()).unwrap_or("")).to_ascii_lowercase()
}

pub fn compute_policy_hold_pattern(input: &PolicyHoldPatternInput) -> PolicyHoldPatternOutput {
    let objective_id = normalize_spaces(input.objective_id.as_ref().map(|v| v.as_str()).unwrap_or(""));
    let window_hours = input.window_hours.unwrap_or(24.0).max(1.0);
    let repeat_threshold = input.repeat_threshold.unwrap_or(2.0).max(2.0);
    let now_ms = non_negative_number(input.now_ms).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|v| v.as_millis() as f64)
            .unwrap_or(0.0)
    });
    let cutoff_ms = now_ms - (window_hours * 3_600_000.0);

    let mut total_holds: u32 = 0;
    let mut by_reason: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }
        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let evt_objective = normalize_spaces(evt.objective_id.as_ref().map(|v| v.as_str()).unwrap_or(""));
        if objective_id.is_empty() || evt_objective != objective_id {
            continue;
        }
        if !evt.policy_hold.unwrap_or(false) && !is_policy_hold_result(&result) {
            continue;
        }
        if let Some(ts_ms) = non_negative_number(evt.ts_ms) {
            if ts_ms < cutoff_ms {
                continue;
            }
        }
        let reason = policy_hold_reason_from_event_input(evt);
        let key = if reason.is_empty() {
            "policy_hold_unknown".to_string()
        } else {
            reason
        };
        let current = by_reason.get(&key).copied().unwrap_or(0);
        by_reason.insert(key, current + 1);
        total_holds += 1;
    }

    let mut top_reason: Option<String> = None;
    let mut top_count: u32 = 0;
    for (reason, count) in &by_reason {
        if *count > top_count {
            top_reason = Some(reason.clone());
            top_count = *count;
        }
    }
    let should_dampen = (top_count as f64) >= repeat_threshold;

    PolicyHoldPatternOutput {
        objective_id: if objective_id.is_empty() {
            None
        } else {
            Some(objective_id)
        },
        window_hours: round3(window_hours),
        repeat_threshold: round3(repeat_threshold),
        total_holds,
        top_reason,
        top_count,
        by_reason,
        should_dampen,
    }
}

fn policy_hold_reason_from_latest_entry(evt: &PolicyHoldLatestEventEntryInput) -> Option<String> {
    let hold_reason = evt
        .hold_reason
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if hold_reason.is_some() {
        return hold_reason;
    }
    evt.route_block_reason
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn compute_policy_hold_latest_event(input: &PolicyHoldLatestEventInput) -> PolicyHoldLatestEventOutput {
    for (idx, evt) in input.events.iter().enumerate().rev() {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }

        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if !evt.policy_hold.unwrap_or(false) && !is_policy_hold_result(&result) {
            continue;
        }

        return PolicyHoldLatestEventOutput {
            found: true,
            event_index: Some(idx as u32),
            result: evt.result.as_ref().map(|v| v.to_string()),
            ts: evt.ts.as_ref().map(|v| v.to_string()).filter(|v| !v.trim().is_empty()),
            ts_ms: non_negative_number(evt.ts_ms),
            hold_reason: policy_hold_reason_from_latest_entry(evt),
            route_block_reason: evt
                .route_block_reason
                .as_ref()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty()),
        };
    }

    PolicyHoldLatestEventOutput {
        found: false,
        event_index: None,
        result: None,
        ts: None,
        ts_ms: None,
        hold_reason: None,
        route_block_reason: None,
    }
}

fn minutes_until_next_utc_day(now_ms: f64) -> u32 {
    let now = if now_ms.is_finite() && now_ms > 0.0 {
        now_ms as i64
    } else {
        0
    };
    if now <= 0 {
        return 0;
    }
    let secs = now / 1000;
    let rem_ms = (now % 1000) as u32;
    let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, rem_ms * 1_000_000) else {
        return 0;
    };
    let date = dt.date_naive();
    let Some(next_day) = date.succ_opt() else {
        return 0;
    };
    let Some(next_midnight) = next_day.and_hms_opt(0, 0, 0) else {
        return 0;
    };
    let delta_ms = (next_midnight - dt.naive_utc()).num_milliseconds().max(0);
    ((delta_ms + 59_999) / 60_000) as u32
}

pub fn compute_policy_hold_cooldown(input: &PolicyHoldCooldownInput) -> PolicyHoldCooldownOutput {
    let mut cooldown = non_negative_number(input.base_minutes).unwrap_or(0.0);
    let pressure_applicable = input.pressure_applicable.unwrap_or(false);
    let pressure_level = input
        .pressure_level
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let cooldown_warn = non_negative_number(input.cooldown_warn_minutes).unwrap_or(30.0);
    let cooldown_hard = non_negative_number(input.cooldown_hard_minutes).unwrap_or(60.0);

    if pressure_applicable && pressure_level == "hard" {
        cooldown = cooldown.max(cooldown_hard);
    } else if pressure_applicable && pressure_level == "warn" {
        cooldown = cooldown.max(cooldown_warn);
    }

    let result = input
        .last_result
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !result.is_empty() {
        let until_next_day_caps = input.until_next_day_caps.unwrap_or(true);
        let now_ms = non_negative_number(input.now_ms).unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|v| v.as_millis() as f64)
                .unwrap_or(0.0)
        });
        let cap_minutes = non_negative_number(input.cooldown_cap_minutes).unwrap_or(180.0);
        let manual_review_minutes =
            non_negative_number(input.cooldown_manual_review_minutes).unwrap_or(90.0);
        let unchanged_state_minutes =
            non_negative_number(input.cooldown_unchanged_state_minutes).unwrap_or(90.0);
        let readiness_retry_minutes = non_negative_number(input.readiness_retry_minutes).unwrap_or(120.0);

        if result == "no_candidates_policy_daily_cap" || result == "no_candidates_policy_canary_cap" {
            let cap_cooldown = if until_next_day_caps {
                minutes_until_next_utc_day(now_ms) as f64
            } else {
                cap_minutes
            };
            cooldown = cooldown.max(cap_cooldown);
        } else if result == "no_candidates_policy_manual_review_pending"
            || result == "stop_repeat_gate_human_escalation_pending"
        {
            cooldown = cooldown.max(manual_review_minutes);
        } else if result == "no_candidates_policy_unchanged_state" {
            cooldown = cooldown.max(unchanged_state_minutes);
        } else if result == "stop_init_gate_readiness"
            || result == "stop_init_gate_readiness_blocked"
            || result == "stop_init_gate_criteria_quality_insufficient"
        {
            cooldown = cooldown.max(readiness_retry_minutes);
        }
    }

    PolicyHoldCooldownOutput {
        cooldown_minutes: cooldown.round().max(0.0) as u32,
    }
}

pub fn compute_receipt_verdict(input: &ReceiptVerdictInput) -> ReceiptVerdictOutput {
    let decision = input.decision.trim().to_ascii_uppercase();
    let exec_check_name = if decision == "ACTUATE" {
        "actuation_execute_ok".to_string()
    } else if decision == "DIRECTIVE_VALIDATE" {
        "directive_validate_ok".to_string()
    } else if decision == "DIRECTIVE_DECOMPOSE" {
        "directive_decompose_ok".to_string()
    } else {
        "route_execute_ok".to_string()
    };

    let route_attestation_status = input.route_attestation_status.trim().to_ascii_lowercase();
    let route_expected_model = input.route_attestation_expected_model.trim();
    let route_attestation_mismatch =
        !route_expected_model.is_empty() && route_attestation_status == "mismatch";

    let criteria_pass = if input.success_criteria_required {
        input.success_criteria_passed
    } else {
        true
    };
    let checks = vec![
        ReceiptCheck {
            name: exec_check_name.clone(),
            pass: input.exec_ok,
        },
        ReceiptCheck {
            name: "postconditions_ok".to_string(),
            pass: input.postconditions_ok,
        },
        ReceiptCheck {
            name: "dod_passed".to_string(),
            pass: input.dod_passed,
        },
        ReceiptCheck {
            name: "success_criteria_met".to_string(),
            pass: criteria_pass,
        },
        ReceiptCheck {
            name: "queue_outcome_logged".to_string(),
            pass: input.queue_outcome_logged,
        },
        ReceiptCheck {
            name: "route_model_attested".to_string(),
            pass: !route_attestation_mismatch,
        },
    ];

    let failed: Vec<String> = checks
        .iter()
        .filter(|row| !row.pass)
        .map(|row| row.name.clone())
        .collect();
    let passed = failed.is_empty();
    let mut outcome = "shipped".to_string();
    let exec_check_pass = checks
        .iter()
        .find(|row| row.name == exec_check_name)
        .map(|row| row.pass)
        .unwrap_or(false);
    let postconditions_ok = checks
        .iter()
        .find(|row| row.name == "postconditions_ok")
        .map(|row| row.pass)
        .unwrap_or(false);
    let queue_outcome_logged = checks
        .iter()
        .find(|row| row.name == "queue_outcome_logged")
        .map(|row| row.pass)
        .unwrap_or(false);
    let route_model_attested = checks
        .iter()
        .find(|row| row.name == "route_model_attested")
        .map(|row| row.pass)
        .unwrap_or(false);
    let dod_passed = checks
        .iter()
        .find(|row| row.name == "dod_passed")
        .map(|row| row.pass)
        .unwrap_or(false);
    let success_criteria_met = checks
        .iter()
        .find(|row| row.name == "success_criteria_met")
        .map(|row| row.pass)
        .unwrap_or(false);

    if !exec_check_pass || !postconditions_ok || !queue_outcome_logged || !route_model_attested {
        outcome = "reverted".to_string();
    } else if !dod_passed || !success_criteria_met {
        outcome = "no_change".to_string();
    }

    let primary_failure = if let Some(first_failed) = failed.first() {
        if first_failed == "success_criteria_met"
            && input
                .success_criteria_primary_failure
                .as_ref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        {
            input.success_criteria_primary_failure.clone()
        } else {
            Some(first_failed.clone())
        }
    } else {
        None
    };

    ReceiptVerdictOutput {
        exec_check_name,
        checks,
        failed,
        passed,
        outcome,
        primary_failure,
        route_attestation_mismatch,
    }
}

pub fn run_autoscale_json(payload_json: &str) -> Result<String, String> {
    let request: AutoscaleRequest = serde_json::from_str(payload_json)
        .map_err(|e| format!("autoscale_request_parse_failed:{e}"))?;
    let mode = request.mode.to_ascii_lowercase();
    if mode == "plan" {
        let input = request
            .plan_input
            .ok_or_else(|| "autoscale_missing_plan_input".to_string())?;
        let out = compute_plan(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "plan",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_plan_encode_failed:{e}"));
    }
    if mode == "batch_max" {
        let input = request
            .batch_input
            .ok_or_else(|| "autoscale_missing_batch_input".to_string())?;
        let out = compute_batch_max(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "batch_max",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_batch_encode_failed:{e}"));
    }
    if mode == "dynamic_caps" {
        let input = request
            .dynamic_caps_input
            .ok_or_else(|| "autoscale_missing_dynamic_caps_input".to_string())?;
        let out = compute_dynamic_caps(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "dynamic_caps",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_dynamic_caps_encode_failed:{e}"));
    }
    if mode == "token_usage" {
        let input = request
            .token_usage_input
            .ok_or_else(|| "autoscale_missing_token_usage_input".to_string())?;
        let out = compute_token_usage(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "token_usage",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_token_usage_encode_failed:{e}"));
    }
    if mode == "normalize_queue" {
        let input = request
            .normalize_queue_input
            .ok_or_else(|| "autoscale_missing_normalize_queue_input".to_string())?;
        let out = compute_normalize_queue(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_queue",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_queue_encode_failed:{e}"));
    }
    if mode == "criteria_gate" {
        let input = request
            .criteria_gate_input
            .ok_or_else(|| "autoscale_missing_criteria_gate_input".to_string())?;
        let out = compute_criteria_gate(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "criteria_gate",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_criteria_gate_encode_failed:{e}"));
    }
    if mode == "structural_preview_criteria_failure" {
        let input = request
            .structural_preview_criteria_failure_input
            .ok_or_else(|| {
                "autoscale_missing_structural_preview_criteria_failure_input".to_string()
            })?;
        let out = compute_structural_preview_criteria_failure(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "structural_preview_criteria_failure",
            "payload": out
        }))
        .map_err(|e| {
            format!("autoscale_structural_preview_criteria_failure_encode_failed:{e}")
        });
    }
    if mode == "policy_hold" {
        let input = request
            .policy_hold_input
            .ok_or_else(|| "autoscale_missing_policy_hold_input".to_string())?;
        let out = compute_policy_hold(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_encode_failed:{e}"));
    }
    if mode == "policy_hold_result" {
        let input = request
            .policy_hold_result_input
            .ok_or_else(|| "autoscale_missing_policy_hold_result_input".to_string())?;
        let out = compute_policy_hold_result(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_result",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_result_encode_failed:{e}"));
    }
    if mode == "policy_hold_run_event" {
        let input = request
            .policy_hold_run_event_input
            .ok_or_else(|| "autoscale_missing_policy_hold_run_event_input".to_string())?;
        let out = compute_policy_hold_run_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_run_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_run_event_encode_failed:{e}"));
    }
    if mode == "score_only_result" {
        let input = request
            .score_only_result_input
            .ok_or_else(|| "autoscale_missing_score_only_result_input".to_string())?;
        let out = compute_score_only_result(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "score_only_result",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_score_only_result_encode_failed:{e}"));
    }
    if mode == "score_only_failure_like" {
        let input = request
            .score_only_failure_like_input
            .ok_or_else(|| "autoscale_missing_score_only_failure_like_input".to_string())?;
        let out = compute_score_only_failure_like(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "score_only_failure_like",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_score_only_failure_like_encode_failed:{e}"));
    }
    if mode == "gate_exhausted_attempt" {
        let input = request
            .gate_exhausted_attempt_input
            .ok_or_else(|| "autoscale_missing_gate_exhausted_attempt_input".to_string())?;
        let out = compute_gate_exhausted_attempt(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "gate_exhausted_attempt",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_gate_exhausted_attempt_encode_failed:{e}"));
    }
    if mode == "consecutive_gate_exhausted_attempts" {
        let input = request
            .consecutive_gate_exhausted_attempts_input
            .ok_or_else(|| {
                "autoscale_missing_consecutive_gate_exhausted_attempts_input".to_string()
            })?;
        let out = compute_consecutive_gate_exhausted_attempts(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "consecutive_gate_exhausted_attempts",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_consecutive_gate_exhausted_attempts_encode_failed:{e}"));
    }
    if mode == "runs_since_reset_index" {
        let input = request
            .runs_since_reset_index_input
            .ok_or_else(|| "autoscale_missing_runs_since_reset_index_input".to_string())?;
        let out = compute_runs_since_reset_index(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "runs_since_reset_index",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_runs_since_reset_index_encode_failed:{e}"));
    }
    if mode == "attempt_event_indices" {
        let input = request
            .attempt_event_indices_input
            .ok_or_else(|| "autoscale_missing_attempt_event_indices_input".to_string())?;
        let out = compute_attempt_event_indices(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "attempt_event_indices",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_attempt_event_indices_encode_failed:{e}"));
    }
    if mode == "capacity_counted_attempt_indices" {
        let input = request
            .capacity_counted_attempt_indices_input
            .ok_or_else(|| "autoscale_missing_capacity_counted_attempt_indices_input".to_string())?;
        let out = compute_capacity_counted_attempt_indices(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "capacity_counted_attempt_indices",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_capacity_counted_attempt_indices_encode_failed:{e}"));
    }
    if mode == "consecutive_no_progress_runs" {
        let input = request
            .consecutive_no_progress_runs_input
            .ok_or_else(|| "autoscale_missing_consecutive_no_progress_runs_input".to_string())?;
        let out = compute_consecutive_no_progress_runs(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "consecutive_no_progress_runs",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_consecutive_no_progress_runs_encode_failed:{e}"));
    }
    if mode == "shipped_count" {
        let input = request
            .shipped_count_input
            .ok_or_else(|| "autoscale_missing_shipped_count_input".to_string())?;
        let out = compute_shipped_count(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "shipped_count",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_shipped_count_encode_failed:{e}"));
    }
    if mode == "executed_count_by_risk" {
        let input = request
            .executed_count_by_risk_input
            .ok_or_else(|| "autoscale_missing_executed_count_by_risk_input".to_string())?;
        let out = compute_executed_count_by_risk(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "executed_count_by_risk",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_executed_count_by_risk_encode_failed:{e}"));
    }
    if mode == "run_result_tally" {
        let input = request
            .run_result_tally_input
            .ok_or_else(|| "autoscale_missing_run_result_tally_input".to_string())?;
        let out = compute_run_result_tally(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "run_result_tally",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_run_result_tally_encode_failed:{e}"));
    }
    if mode == "qos_lane_weights" {
        let input = request
            .qos_lane_weights_input
            .ok_or_else(|| "autoscale_missing_qos_lane_weights_input".to_string())?;
        let out = compute_qos_lane_weights(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "qos_lane_weights",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_qos_lane_weights_encode_failed:{e}"));
    }
    if mode == "qos_lane_usage" {
        let input = request
            .qos_lane_usage_input
            .ok_or_else(|| "autoscale_missing_qos_lane_usage_input".to_string())?;
        let out = compute_qos_lane_usage(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "qos_lane_usage",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_qos_lane_usage_encode_failed:{e}"));
    }
    if mode == "qos_lane_share_cap_exceeded" {
        let input = request
            .qos_lane_share_cap_exceeded_input
            .ok_or_else(|| "autoscale_missing_qos_lane_share_cap_exceeded_input".to_string())?;
        let out = compute_qos_lane_share_cap_exceeded(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "qos_lane_share_cap_exceeded",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_qos_lane_share_cap_exceeded_encode_failed:{e}"));
    }
    if mode == "qos_lane_from_candidate" {
        let input = request
            .qos_lane_from_candidate_input
            .ok_or_else(|| "autoscale_missing_qos_lane_from_candidate_input".to_string())?;
        let out = compute_qos_lane_from_candidate(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "qos_lane_from_candidate",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_qos_lane_from_candidate_encode_failed:{e}"));
    }
    if mode == "eye_outcome_count_window" {
        let input = request
            .eye_outcome_count_window_input
            .ok_or_else(|| "autoscale_missing_eye_outcome_count_window_input".to_string())?;
        let out = compute_eye_outcome_count_window(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "eye_outcome_count_window",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_eye_outcome_count_window_encode_failed:{e}"));
    }
    if mode == "eye_outcome_count_last_hours" {
        let input = request
            .eye_outcome_count_last_hours_input
            .ok_or_else(|| "autoscale_missing_eye_outcome_count_last_hours_input".to_string())?;
        let out = compute_eye_outcome_count_last_hours(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "eye_outcome_count_last_hours",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_eye_outcome_count_last_hours_encode_failed:{e}"));
    }
    if mode == "sorted_counts" {
        let input = request
            .sorted_counts_input
            .ok_or_else(|| "autoscale_missing_sorted_counts_input".to_string())?;
        let out = compute_sorted_counts(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "sorted_counts",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_sorted_counts_encode_failed:{e}"));
    }
    if mode == "normalize_proposal_status" {
        let input = request
            .normalize_proposal_status_input
            .ok_or_else(|| "autoscale_missing_normalize_proposal_status_input".to_string())?;
        let out = compute_normalize_proposal_status(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_proposal_status",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_proposal_status_encode_failed:{e}"));
    }
    if mode == "proposal_status" {
        let input = request
            .proposal_status_input
            .ok_or_else(|| "autoscale_missing_proposal_status_input".to_string())?;
        let out = compute_proposal_status(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_status",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_status_encode_failed:{e}"));
    }
    if mode == "proposal_outcome_status" {
        let input = request
            .proposal_outcome_status_input
            .ok_or_else(|| "autoscale_missing_proposal_outcome_status_input".to_string())?;
        let out = compute_proposal_outcome_status(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_outcome_status",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_outcome_status_encode_failed:{e}"));
    }
    if mode == "queue_underflow_backfill" {
        let input = request
            .queue_underflow_backfill_input
            .ok_or_else(|| "autoscale_missing_queue_underflow_backfill_input".to_string())?;
        let out = compute_queue_underflow_backfill(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "queue_underflow_backfill",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_queue_underflow_backfill_encode_failed:{e}"));
    }
    if mode == "proposal_risk_score" {
        let input = request
            .proposal_risk_score_input
            .ok_or_else(|| "autoscale_missing_proposal_risk_score_input".to_string())?;
        let out = compute_proposal_risk_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_risk_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_risk_score_encode_failed:{e}"));
    }
    if mode == "proposal_score" {
        let input = request
            .proposal_score_input
            .ok_or_else(|| "autoscale_missing_proposal_score_input".to_string())?;
        let out = compute_proposal_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_score_encode_failed:{e}"));
    }
    if mode == "proposal_admission_preview" {
        let input = request
            .proposal_admission_preview_input
            .ok_or_else(|| "autoscale_missing_proposal_admission_preview_input".to_string())?;
        let out = compute_proposal_admission_preview(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_admission_preview",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_admission_preview_encode_failed:{e}"));
    }
    if mode == "impact_weight" {
        let input = request
            .impact_weight_input
            .ok_or_else(|| "autoscale_missing_impact_weight_input".to_string())?;
        let out = compute_impact_weight(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "impact_weight",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_impact_weight_encode_failed:{e}"));
    }
    if mode == "risk_penalty" {
        let input = request
            .risk_penalty_input
            .ok_or_else(|| "autoscale_missing_risk_penalty_input".to_string())?;
        let out = compute_risk_penalty(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "risk_penalty",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_risk_penalty_encode_failed:{e}"));
    }
    if mode == "estimate_tokens" {
        let input = request
            .estimate_tokens_input
            .ok_or_else(|| "autoscale_missing_estimate_tokens_input".to_string())?;
        let out = compute_estimate_tokens(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "estimate_tokens",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_estimate_tokens_encode_failed:{e}"));
    }
    if mode == "proposal_remediation_depth" {
        let input = request.proposal_remediation_depth_input.ok_or_else(|| {
            "autoscale_missing_proposal_remediation_depth_input".to_string()
        })?;
        let out = compute_proposal_remediation_depth(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_remediation_depth",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_remediation_depth_encode_failed:{e}"));
    }
    if mode == "proposal_dedup_key" {
        let input = request
            .proposal_dedup_key_input
            .ok_or_else(|| "autoscale_missing_proposal_dedup_key_input".to_string())?;
        let out = compute_proposal_dedup_key(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_dedup_key",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_dedup_key_encode_failed:{e}"));
    }
    if mode == "semantic_token_similarity" {
        let input = request
            .semantic_token_similarity_input
            .ok_or_else(|| "autoscale_missing_semantic_token_similarity_input".to_string())?;
        let out = compute_semantic_token_similarity(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "semantic_token_similarity",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_semantic_token_similarity_encode_failed:{e}"));
    }
    if mode == "semantic_context_comparable" {
        let input = request
            .semantic_context_comparable_input
            .ok_or_else(|| "autoscale_missing_semantic_context_comparable_input".to_string())?;
        let out = compute_semantic_context_comparable(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "semantic_context_comparable",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_semantic_context_comparable_encode_failed:{e}"));
    }
    if mode == "semantic_near_duplicate_match" {
        let input = request
            .semantic_near_duplicate_match_input
            .ok_or_else(|| "autoscale_missing_semantic_near_duplicate_match_input".to_string())?;
        let out = compute_semantic_near_duplicate_match(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "semantic_near_duplicate_match",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_semantic_near_duplicate_match_encode_failed:{e}"));
    }
    if mode == "strategy_rank_score" {
        let input = request
            .strategy_rank_score_input
            .ok_or_else(|| "autoscale_missing_strategy_rank_score_input".to_string())?;
        let out = compute_strategy_rank_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_rank_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_rank_score_encode_failed:{e}"));
    }
    if mode == "strategy_rank_adjusted" {
        let input = request
            .strategy_rank_adjusted_input
            .ok_or_else(|| "autoscale_missing_strategy_rank_adjusted_input".to_string())?;
        let out = compute_strategy_rank_adjusted(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_rank_adjusted",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_rank_adjusted_encode_failed:{e}"));
    }
    if mode == "trit_shadow_rank_score" {
        let input = request
            .trit_shadow_rank_score_input
            .ok_or_else(|| "autoscale_missing_trit_shadow_rank_score_input".to_string())?;
        let out = compute_trit_shadow_rank_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "trit_shadow_rank_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_trit_shadow_rank_score_encode_failed:{e}"));
    }
    if mode == "strategy_circuit_cooldown" {
        let input = request
            .strategy_circuit_cooldown_input
            .ok_or_else(|| "autoscale_missing_strategy_circuit_cooldown_input".to_string())?;
        let out = compute_strategy_circuit_cooldown(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_circuit_cooldown",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_circuit_cooldown_encode_failed:{e}"));
    }
    if mode == "strategy_trit_shadow_adjusted" {
        let input = request
            .strategy_trit_shadow_adjusted_input
            .ok_or_else(|| "autoscale_missing_strategy_trit_shadow_adjusted_input".to_string())?;
        let out = compute_strategy_trit_shadow_adjusted(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_trit_shadow_adjusted",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_trit_shadow_adjusted_encode_failed:{e}"));
    }
    if mode == "non_yield_penalty_score" {
        let input = request
            .non_yield_penalty_score_input
            .ok_or_else(|| "autoscale_missing_non_yield_penalty_score_input".to_string())?;
        let out = compute_non_yield_penalty_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "non_yield_penalty_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_non_yield_penalty_score_encode_failed:{e}"));
    }
    if mode == "collective_shadow_adjustments" {
        let input = request
            .collective_shadow_adjustments_input
            .ok_or_else(|| "autoscale_missing_collective_shadow_adjustments_input".to_string())?;
        let out = compute_collective_shadow_adjustments(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "collective_shadow_adjustments",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_collective_shadow_adjustments_encode_failed:{e}"));
    }
    if mode == "strategy_trit_shadow_ranking_summary" {
        let input = request
            .strategy_trit_shadow_ranking_summary_input
            .ok_or_else(|| "autoscale_missing_strategy_trit_shadow_ranking_summary_input".to_string())?;
        let out = compute_strategy_trit_shadow_ranking_summary(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_trit_shadow_ranking_summary",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_trit_shadow_ranking_summary_encode_failed:{e}"));
    }
    if mode == "shadow_scope_matches" {
        let input = request
            .shadow_scope_matches_input
            .ok_or_else(|| "autoscale_missing_shadow_scope_matches_input".to_string())?;
        let out = compute_shadow_scope_matches(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "shadow_scope_matches",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_shadow_scope_matches_encode_failed:{e}"));
    }
    if mode == "collective_shadow_aggregate" {
        let input = request
            .collective_shadow_aggregate_input
            .ok_or_else(|| "autoscale_missing_collective_shadow_aggregate_input".to_string())?;
        let out = compute_collective_shadow_aggregate(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "collective_shadow_aggregate",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_collective_shadow_aggregate_encode_failed:{e}"));
    }
    if mode == "expected_value_signal" {
        let input = request
            .expected_value_signal_input
            .ok_or_else(|| "autoscale_missing_expected_value_signal_input".to_string())?;
        let out = compute_expected_value_signal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "expected_value_signal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_expected_value_signal_encode_failed:{e}"));
    }
    if mode == "value_signal_score" {
        let input = request
            .value_signal_score_input
            .ok_or_else(|| "autoscale_missing_value_signal_score_input".to_string())?;
        let out = compute_value_signal_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "value_signal_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_value_signal_score_encode_failed:{e}"));
    }
    if mode == "composite_eligibility_score" {
        let input = request
            .composite_eligibility_score_input
            .ok_or_else(|| "autoscale_missing_composite_eligibility_score_input".to_string())?;
        let out = compute_composite_eligibility_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "composite_eligibility_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_composite_eligibility_score_encode_failed:{e}"));
    }
    if mode == "time_to_value_score" {
        let input = request
            .time_to_value_score_input
            .ok_or_else(|| "autoscale_missing_time_to_value_score_input".to_string())?;
        let out = compute_time_to_value_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "time_to_value_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_time_to_value_score_encode_failed:{e}"));
    }
    if mode == "value_density_score" {
        let input = request
            .value_density_score_input
            .ok_or_else(|| "autoscale_missing_value_density_score_input".to_string())?;
        let out = compute_value_density_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "value_density_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_value_density_score_encode_failed:{e}"));
    }
    if mode == "normalize_directive_tier" {
        let input = request
            .normalize_directive_tier_input
            .ok_or_else(|| "autoscale_missing_normalize_directive_tier_input".to_string())?;
        let out = compute_normalize_directive_tier(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_directive_tier",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_directive_tier_encode_failed:{e}"));
    }
    if mode == "directive_tier_weight" {
        let input = request
            .directive_tier_weight_input
            .ok_or_else(|| "autoscale_missing_directive_tier_weight_input".to_string())?;
        let out = compute_directive_tier_weight(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_tier_weight",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_tier_weight_encode_failed:{e}"));
    }
    if mode == "directive_tier_min_share" {
        let input = request
            .directive_tier_min_share_input
            .ok_or_else(|| "autoscale_missing_directive_tier_min_share_input".to_string())?;
        let out = compute_directive_tier_min_share(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_tier_min_share",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_tier_min_share_encode_failed:{e}"));
    }
    if mode == "directive_tier_coverage_bonus" {
        let input = request
            .directive_tier_coverage_bonus_input
            .ok_or_else(|| "autoscale_missing_directive_tier_coverage_bonus_input".to_string())?;
        let out = compute_directive_tier_coverage_bonus(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_tier_coverage_bonus",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_tier_coverage_bonus_encode_failed:{e}"));
    }
    if mode == "directive_tier_reservation_need" {
        let input = request
            .directive_tier_reservation_need_input
            .ok_or_else(|| "autoscale_missing_directive_tier_reservation_need_input".to_string())?;
        let out = compute_directive_tier_reservation_need(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_tier_reservation_need",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_tier_reservation_need_encode_failed:{e}"));
    }
    if mode == "pulse_objective_cooldown_active" {
        let input = request
            .pulse_objective_cooldown_active_input
            .ok_or_else(|| "autoscale_missing_pulse_objective_cooldown_active_input".to_string())?;
        let out = compute_pulse_objective_cooldown_active(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "pulse_objective_cooldown_active",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_pulse_objective_cooldown_active_encode_failed:{e}"));
    }
    if mode == "directive_token_hits" {
        let input = request
            .directive_token_hits_input
            .ok_or_else(|| "autoscale_missing_directive_token_hits_input".to_string())?;
        let out = compute_directive_token_hits(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_token_hits",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_token_hits_encode_failed:{e}"));
    }
    if mode == "to_stem" {
        let input = request
            .to_stem_input
            .ok_or_else(|| "autoscale_missing_to_stem_input".to_string())?;
        let out = compute_to_stem(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "to_stem",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_to_stem_encode_failed:{e}"));
    }
    if mode == "normalize_directive_text" {
        let input = request
            .normalize_directive_text_input
            .ok_or_else(|| "autoscale_missing_normalize_directive_text_input".to_string())?;
        let out = compute_normalize_directive_text(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_directive_text",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_directive_text_encode_failed:{e}"));
    }
    if mode == "tokenize_directive_text" {
        let input = request
            .tokenize_directive_text_input
            .ok_or_else(|| "autoscale_missing_tokenize_directive_text_input".to_string())?;
        let out = compute_tokenize_directive_text(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "tokenize_directive_text",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_tokenize_directive_text_encode_failed:{e}"));
    }
    if mode == "normalize_spaces" {
        let input = request
            .normalize_spaces_input
            .ok_or_else(|| "autoscale_missing_normalize_spaces_input".to_string())?;
        let out = compute_normalize_spaces(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_spaces",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_spaces_encode_failed:{e}"));
    }
    if mode == "parse_lower_list" {
        let input = request
            .parse_lower_list_input
            .ok_or_else(|| "autoscale_missing_parse_lower_list_input".to_string())?;
        let out = compute_parse_lower_list(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_lower_list",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_lower_list_encode_failed:{e}"));
    }
    if mode == "canary_failed_checks_allowed" {
        let input = request
            .canary_failed_checks_allowed_input
            .ok_or_else(|| "autoscale_missing_canary_failed_checks_allowed_input".to_string())?;
        let out = compute_canary_failed_checks_allowed(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "canary_failed_checks_allowed",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_canary_failed_checks_allowed_encode_failed:{e}"));
    }
    if mode == "proposal_text_blob" {
        let input = request
            .proposal_text_blob_input
            .ok_or_else(|| "autoscale_missing_proposal_text_blob_input".to_string())?;
        let out = compute_proposal_text_blob(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_text_blob",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_text_blob_encode_failed:{e}"));
    }
    if mode == "percent_mentions_from_text" {
        let input = request
            .percent_mentions_from_text_input
            .ok_or_else(|| "autoscale_missing_percent_mentions_from_text_input".to_string())?;
        let out = compute_percent_mentions_from_text(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "percent_mentions_from_text",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_percent_mentions_from_text_encode_failed:{e}"));
    }
    if mode == "optimization_min_delta_percent" {
        let input = request
            .optimization_min_delta_percent_input
            .ok_or_else(|| "autoscale_missing_optimization_min_delta_percent_input".to_string())?;
        let out = compute_optimization_min_delta_percent(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "optimization_min_delta_percent",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_optimization_min_delta_percent_encode_failed:{e}"));
    }
    if mode == "source_eye_ref" {
        let input = request
            .source_eye_ref_input
            .ok_or_else(|| "autoscale_missing_source_eye_ref_input".to_string())?;
        let out = compute_source_eye_ref(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "source_eye_ref",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_source_eye_ref_encode_failed:{e}"));
    }
    if mode == "normalized_risk" {
        let input = request
            .normalized_risk_input
            .ok_or_else(|| "autoscale_missing_normalized_risk_input".to_string())?;
        let out = compute_normalized_risk(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalized_risk",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalized_risk_encode_failed:{e}"));
    }
    if mode == "parse_iso_ts" {
        let input = request
            .parse_iso_ts_input
            .ok_or_else(|| "autoscale_missing_parse_iso_ts_input".to_string())?;
        let out = compute_parse_iso_ts(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_iso_ts",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_iso_ts_encode_failed:{e}"));
    }
    if mode == "extract_objective_id_token" {
        let input = request
            .extract_objective_id_token_input
            .ok_or_else(|| "autoscale_missing_extract_objective_id_token_input".to_string())?;
        let out = compute_extract_objective_id_token(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "extract_objective_id_token",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_extract_objective_id_token_encode_failed:{e}"));
    }
    if mode == "execution_reserve_snapshot" {
        let input = request
            .execution_reserve_snapshot_input
            .ok_or_else(|| "autoscale_missing_execution_reserve_snapshot_input".to_string())?;
        let out = compute_execution_reserve_snapshot(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "execution_reserve_snapshot",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_execution_reserve_snapshot_encode_failed:{e}"));
    }
    if mode == "budget_pacing_gate" {
        let input = request
            .budget_pacing_gate_input
            .ok_or_else(|| "autoscale_missing_budget_pacing_gate_input".to_string())?;
        let out = compute_budget_pacing_gate(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "budget_pacing_gate",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_budget_pacing_gate_encode_failed:{e}"));
    }
    if mode == "capability_cap" {
        let input = request
            .capability_cap_input
            .ok_or_else(|| "autoscale_missing_capability_cap_input".to_string())?;
        let out = compute_capability_cap(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "capability_cap",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_capability_cap_encode_failed:{e}"));
    }
    if mode == "estimate_tokens_for_candidate" {
        let input = request
            .estimate_tokens_for_candidate_input
            .ok_or_else(|| "autoscale_missing_estimate_tokens_for_candidate_input".to_string())?;
        let out = compute_estimate_tokens_for_candidate(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "estimate_tokens_for_candidate",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_estimate_tokens_for_candidate_encode_failed:{e}"));
    }
    if mode == "proposal_status_for_queue_pressure" {
        let input = request.proposal_status_for_queue_pressure_input.ok_or_else(|| {
            "autoscale_missing_proposal_status_for_queue_pressure_input".to_string()
        })?;
        let out = compute_proposal_status_for_queue_pressure(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_status_for_queue_pressure",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_status_for_queue_pressure_encode_failed:{e}"));
    }
    if mode == "minutes_since_ts" {
        let input = request
            .minutes_since_ts_input
            .ok_or_else(|| "autoscale_missing_minutes_since_ts_input".to_string())?;
        let out = compute_minutes_since_ts(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "minutes_since_ts",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_minutes_since_ts_encode_failed:{e}"));
    }
    if mode == "date_window" {
        let input = request
            .date_window_input
            .ok_or_else(|| "autoscale_missing_date_window_input".to_string())?;
        let out = compute_date_window(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "date_window",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_date_window_encode_failed:{e}"));
    }
    if mode == "in_window" {
        let input = request
            .in_window_input
            .ok_or_else(|| "autoscale_missing_in_window_input".to_string())?;
        let out = compute_in_window(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "in_window",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_in_window_encode_failed:{e}"));
    }
    if mode == "start_of_next_utc_day" {
        let input = request
            .start_of_next_utc_day_input
            .ok_or_else(|| "autoscale_missing_start_of_next_utc_day_input".to_string())?;
        let out = compute_start_of_next_utc_day(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "start_of_next_utc_day",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_start_of_next_utc_day_encode_failed:{e}"));
    }
    if mode == "iso_after_minutes" {
        let input = request
            .iso_after_minutes_input
            .ok_or_else(|| "autoscale_missing_iso_after_minutes_input".to_string())?;
        let out = compute_iso_after_minutes(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "iso_after_minutes",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_iso_after_minutes_encode_failed:{e}"));
    }
    if mode == "execute_confidence_history_match" {
        let input = request
            .execute_confidence_history_match_input
            .ok_or_else(|| "autoscale_missing_execute_confidence_history_match_input".to_string())?;
        let out = compute_execute_confidence_history_match(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "execute_confidence_history_match",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_execute_confidence_history_match_encode_failed:{e}"));
    }
    if mode == "execute_confidence_cooldown_key" {
        let input = request
            .execute_confidence_cooldown_key_input
            .ok_or_else(|| "autoscale_missing_execute_confidence_cooldown_key_input".to_string())?;
        let out = compute_execute_confidence_cooldown_key(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "execute_confidence_cooldown_key",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_execute_confidence_cooldown_key_encode_failed:{e}"));
    }
    if mode == "no_progress_result" {
        let input = request
            .no_progress_result_input
            .ok_or_else(|| "autoscale_missing_no_progress_result_input".to_string())?;
        let out = compute_no_progress_result(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "no_progress_result",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_no_progress_result_encode_failed:{e}"));
    }
    if mode == "attempt_run_event" {
        let input = request
            .attempt_run_event_input
            .ok_or_else(|| "autoscale_missing_attempt_run_event_input".to_string())?;
        let out = compute_attempt_run_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "attempt_run_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_attempt_run_event_encode_failed:{e}"));
    }
    if mode == "safety_stop_run_event" {
        let input = request
            .safety_stop_run_event_input
            .ok_or_else(|| "autoscale_missing_safety_stop_run_event_input".to_string())?;
        let out = compute_safety_stop_run_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "safety_stop_run_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_safety_stop_run_event_encode_failed:{e}"));
    }
    if mode == "non_yield_category" {
        let input = request
            .non_yield_category_input
            .ok_or_else(|| "autoscale_missing_non_yield_category_input".to_string())?;
        let out = compute_non_yield_category(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "non_yield_category",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_non_yield_category_encode_failed:{e}"));
    }
    if mode == "non_yield_reason" {
        let input = request
            .non_yield_reason_input
            .ok_or_else(|| "autoscale_missing_non_yield_reason_input".to_string())?;
        let out = compute_non_yield_reason(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "non_yield_reason",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_non_yield_reason_encode_failed:{e}"));
    }
    if mode == "proposal_type_from_run_event" {
        let input = request
            .proposal_type_from_run_event_input
            .ok_or_else(|| "autoscale_missing_proposal_type_from_run_event_input".to_string())?;
        let out = compute_proposal_type_from_run_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_type_from_run_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_type_from_run_event_encode_failed:{e}"));
    }
    if mode == "run_event_objective_id" {
        let input = request
            .run_event_objective_id_input
            .ok_or_else(|| "autoscale_missing_run_event_objective_id_input".to_string())?;
        let out = compute_run_event_objective_id(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "run_event_objective_id",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_run_event_objective_id_encode_failed:{e}"));
    }
    if mode == "run_event_proposal_id" {
        let input = request
            .run_event_proposal_id_input
            .ok_or_else(|| "autoscale_missing_run_event_proposal_id_input".to_string())?;
        let out = compute_run_event_proposal_id(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "run_event_proposal_id",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_run_event_proposal_id_encode_failed:{e}"));
    }
    if mode == "capacity_counted_attempt_event" {
        let input = request
            .capacity_counted_attempt_event_input
            .ok_or_else(|| "autoscale_missing_capacity_counted_attempt_event_input".to_string())?;
        let out = compute_capacity_counted_attempt_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "capacity_counted_attempt_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_capacity_counted_attempt_event_encode_failed:{e}"));
    }
    if mode == "repeat_gate_anchor" {
        let input = request
            .repeat_gate_anchor_input
            .ok_or_else(|| "autoscale_missing_repeat_gate_anchor_input".to_string())?;
        let out = compute_repeat_gate_anchor(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "repeat_gate_anchor",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_repeat_gate_anchor_encode_failed:{e}"));
    }
    if mode == "route_execution_policy_hold" {
        let input = request
            .route_execution_policy_hold_input
            .ok_or_else(|| "autoscale_missing_route_execution_policy_hold_input".to_string())?;
        let out = compute_route_execution_policy_hold(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "route_execution_policy_hold",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_route_execution_policy_hold_encode_failed:{e}"));
    }
    if mode == "policy_hold_pressure" {
        let input = request
            .policy_hold_pressure_input
            .ok_or_else(|| "autoscale_missing_policy_hold_pressure_input".to_string())?;
        let out = compute_policy_hold_pressure(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_pressure",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_pressure_encode_failed:{e}"));
    }
    if mode == "policy_hold_pattern" {
        let input = request
            .policy_hold_pattern_input
            .ok_or_else(|| "autoscale_missing_policy_hold_pattern_input".to_string())?;
        let out = compute_policy_hold_pattern(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_pattern",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_pattern_encode_failed:{e}"));
    }
    if mode == "policy_hold_latest_event" {
        let input = request
            .policy_hold_latest_event_input
            .ok_or_else(|| "autoscale_missing_policy_hold_latest_event_input".to_string())?;
        let out = compute_policy_hold_latest_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_latest_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_latest_event_encode_failed:{e}"));
    }
    if mode == "policy_hold_cooldown" {
        let input = request
            .policy_hold_cooldown_input
            .ok_or_else(|| "autoscale_missing_policy_hold_cooldown_input".to_string())?;
        let out = compute_policy_hold_cooldown(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_cooldown",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_cooldown_encode_failed:{e}"));
    }
    if mode == "receipt_verdict" {
        let input = request
            .receipt_verdict_input
            .ok_or_else(|| "autoscale_missing_receipt_verdict_input".to_string())?;
        let out = compute_receipt_verdict(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "receipt_verdict",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_receipt_verdict_encode_failed:{e}"));
    }
    Err(format!("autoscale_mode_unsupported:{mode}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_pressure_scales_up() {
        let out = compute_plan(&PlanInput {
            queue_pressure: QueuePressure {
                pressure: "critical".to_string(),
                pending: 40.0,
                pending_ratio: 0.7,
            },
            min_cells: 1,
            max_cells: 5,
            current_cells: 2,
            run_interval_minutes: 15.0,
            idle_release_minutes: 120.0,
            autopause_active: false,
            last_run_minutes_ago: Some(30.0),
            last_high_pressure_minutes_ago: Some(5.0),
            trit_shadow_blocked: false,
        });
        assert_eq!(out.action, "scale_up");
        assert_eq!(out.target_cells, 5);
    }

    #[test]
    fn budget_blocked_batch_caps_to_one() {
        let out = compute_batch_max(&BatchMaxInput {
            enabled: true,
            max_batch: 6,
            daily_remaining: Some(4),
            pressure: "critical".to_string(),
            current_cells: 4,
            budget_blocked: true,
            trit_shadow_blocked: false,
        });
        assert_eq!(out.max, 1);
        assert_eq!(out.reason, "budget_blocked");
    }

    #[test]
    fn autoscale_json_path_works() {
        let payload = serde_json::json!({
            "mode": "batch_max",
            "batch_input": {
                "enabled": true,
                "max_batch": 6,
                "daily_remaining": 2,
                "pressure": "warning",
                "current_cells": 3,
                "budget_blocked": false,
                "trit_shadow_blocked": false
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale");
        assert!(out.contains("\"mode\":\"batch_max\""));
    }

    #[test]
    fn dynamic_caps_warn_downshift_works() {
        let out = compute_dynamic_caps(&DynamicCapsInput {
            enabled: true,
            base_daily_cap: 6,
            base_canary_cap: None,
            candidate_pool_size: 24,
            queue_pressure: "warning".to_string(),
            policy_hold_level: "normal".to_string(),
            policy_hold_applicable: false,
            spawn_boost_enabled: false,
            spawn_boost_active: false,
            shipped_today: 0.0,
            no_progress_streak: 0.0,
            gate_exhaustion_streak: 0.0,
            warn_factor: 0.75,
            critical_factor: 0.5,
            min_input_pool: 8,
        });
        assert!(out.low_yield);
        assert!(out.daily_runs_cap < 6);
        assert!(out.input_candidates_cap.is_some());
        assert!(out
            .reasons
            .iter()
            .any(|r| r == "downshift_queue_backlog_warning"));
    }

    #[test]
    fn token_usage_prefers_actual_metrics() {
        let out = compute_token_usage(&TokenUsageInput {
            selected_model_tokens_est: Some(180.0),
            route_budget_request_tokens_est: None,
            route_tokens_est: Some(90.0),
            fallback_est_tokens: Some(60.0),
            metrics_prompt_tokens: Some(25.0),
            metrics_input_tokens: None,
            metrics_completion_tokens: Some(15.0),
            metrics_output_tokens: None,
            metrics_total_tokens: None,
            metrics_tokens_used: None,
            metrics_source: Some("route_execute_metrics".to_string()),
        });
        assert!(out.available);
        assert_eq!(out.actual_total_tokens, Some(40.0));
        assert_eq!(out.effective_tokens, 40.0);
        assert_eq!(out.source, "route_execute_metrics");
    }

    #[test]
    fn token_usage_falls_back_to_estimate() {
        let out = compute_token_usage(&TokenUsageInput {
            selected_model_tokens_est: Some(220.0),
            route_budget_request_tokens_est: Some(210.0),
            route_tokens_est: Some(200.0),
            fallback_est_tokens: Some(180.0),
            metrics_prompt_tokens: None,
            metrics_input_tokens: None,
            metrics_completion_tokens: None,
            metrics_output_tokens: None,
            metrics_total_tokens: None,
            metrics_tokens_used: None,
            metrics_source: None,
        });
        assert!(!out.available);
        assert_eq!(out.actual_total_tokens, None);
        assert_eq!(out.effective_tokens, 220.0);
        assert_eq!(out.source, "estimated_fallback");
    }

    #[test]
    fn normalize_queue_classifies_by_thresholds() {
        let out = compute_normalize_queue(&NormalizeQueueInput {
            pressure: Some("".to_string()),
            pending: Some(46.0),
            total: Some(120.0),
            pending_ratio: None,
            warn_pending_count: 45.0,
            critical_pending_count: 80.0,
            warn_pending_ratio: 0.30,
            critical_pending_ratio: 0.45,
        });
        assert_eq!(out.pressure, "warning");
        assert_eq!(out.pending, 46.0);
        assert_eq!(out.total, 120.0);
        assert!(out.pending_ratio > 0.38 && out.pending_ratio < 0.39);
    }

    #[test]
    fn normalize_queue_respects_explicit_pressure() {
        let out = compute_normalize_queue(&NormalizeQueueInput {
            pressure: Some("critical".to_string()),
            pending: Some(1.0),
            total: Some(100.0),
            pending_ratio: Some(0.01),
            warn_pending_count: 45.0,
            critical_pending_count: 80.0,
            warn_pending_ratio: 0.30,
            critical_pending_ratio: 0.45,
        });
        assert_eq!(out.pressure, "critical");
        assert_eq!(out.pending_ratio, 0.01);
    }

    #[test]
    fn criteria_gate_fails_on_contract_or_support_gaps() {
        let out = compute_criteria_gate(&CriteriaGateInput {
            min_count: Some(2.0),
            total_count: Some(2.0),
            contract_not_allowed_count: Some(1.0),
            unsupported_count: Some(0.0),
            structurally_supported_count: None,
            contract_violation_count: Some(1.0),
        });
        assert!(!out.pass);
        assert!(out
            .reasons
            .iter()
            .any(|r| r == "criteria_contract_violation"));
        assert!(out
            .reasons
            .iter()
            .any(|r| r == "criteria_supported_count_below_min"));
    }

    #[test]
    fn criteria_gate_passes_when_counts_are_satisfied() {
        let out = compute_criteria_gate(&CriteriaGateInput {
            min_count: Some(2.0),
            total_count: Some(3.0),
            contract_not_allowed_count: Some(0.0),
            unsupported_count: Some(0.0),
            structurally_supported_count: Some(3.0),
            contract_violation_count: Some(0.0),
        });
        assert!(out.pass);
        assert!(out.reasons.is_empty());
    }

    #[test]
    fn structural_preview_criteria_failure_detects_blocking_patterns() {
        let primary = compute_structural_preview_criteria_failure(
            &StructuralPreviewCriteriaFailureInput {
                primary_failure: Some("metric_not_allowed_for_capability".to_string()),
                contract_not_allowed_count: Some(0.0),
                unsupported_count: Some(0.0),
                total_count: Some(0.0),
            },
        );
        assert!(primary.has_failure);

        let unsupported = compute_structural_preview_criteria_failure(
            &StructuralPreviewCriteriaFailureInput {
                primary_failure: Some(String::new()),
                contract_not_allowed_count: Some(0.0),
                unsupported_count: Some(2.0),
                total_count: Some(3.0),
            },
        );
        assert!(unsupported.has_failure);

        let pass = compute_structural_preview_criteria_failure(
            &StructuralPreviewCriteriaFailureInput {
                primary_failure: Some(String::new()),
                contract_not_allowed_count: Some(0.0),
                unsupported_count: Some(1.0),
                total_count: Some(4.0),
            },
        );
        assert!(!pass.has_failure);
    }

    #[test]
    fn autoscale_json_structural_preview_criteria_failure_path_works() {
        let payload = serde_json::json!({
            "mode": "structural_preview_criteria_failure",
            "structural_preview_criteria_failure_input": {
                "primary_failure": "",
                "contract_not_allowed_count": 0,
                "unsupported_count": 2,
                "total_count": 3
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale structural_preview_criteria_failure");
        assert!(out.contains("\"mode\":\"structural_preview_criteria_failure\""));
    }

    #[test]
    fn policy_hold_blocks_budget_pressure() {
        let out = compute_policy_hold(&PolicyHoldInput {
            target: "route".to_string(),
            gate_decision: "ALLOW".to_string(),
            route_decision: "ALLOW".to_string(),
            needs_manual_review: false,
            executable: true,
            budget_reason: "budget guard blocked".to_string(),
            route_reason: "".to_string(),
            budget_blocked_flag: false,
            budget_global_blocked: false,
            budget_enforcement_blocked: false,
        });
        assert!(out.hold);
        assert_eq!(out.hold_scope, Some("budget".to_string()));
    }

    #[test]
    fn policy_hold_blocks_manual_non_executable_routes() {
        let out = compute_policy_hold(&PolicyHoldInput {
            target: "route".to_string(),
            gate_decision: "MANUAL".to_string(),
            route_decision: "ALLOW".to_string(),
            needs_manual_review: false,
            executable: false,
            budget_reason: "".to_string(),
            route_reason: "".to_string(),
            budget_blocked_flag: false,
            budget_global_blocked: false,
            budget_enforcement_blocked: false,
        });
        assert!(out.hold);
        assert_eq!(out.hold_scope, Some("proposal".to_string()));
        assert_eq!(out.hold_reason, Some("gate_manual".to_string()));
    }

    #[test]
    fn policy_hold_result_detects_known_policy_hold_codes() {
        let out = compute_policy_hold_result(&PolicyHoldResultInput {
            result: Some("stop_init_gate_readiness".to_string()),
        });
        assert!(out.is_policy_hold);

        let non_hold = compute_policy_hold_result(&PolicyHoldResultInput {
            result: Some("stop_init_gate_quality_exhausted".to_string()),
        });
        assert!(!non_hold.is_policy_hold);
    }

    #[test]
    fn autoscale_json_policy_hold_result_path_works() {
        let payload = serde_json::json!({
            "mode": "policy_hold_result",
            "policy_hold_result_input": {
                "result": "no_candidates_policy_daily_cap"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale policy_hold_result");
        assert!(out.contains("\"mode\":\"policy_hold_result\""));
    }

    #[test]
    fn policy_hold_run_event_classifies_expected_values() {
        let explicit = compute_policy_hold_run_event(&PolicyHoldRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            policy_hold: Some(true),
            result: Some("executed".to_string()),
        });
        assert!(explicit.is_policy_hold_run_event);

        let by_result = compute_policy_hold_run_event(&PolicyHoldRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            policy_hold: Some(false),
            result: Some("stop_init_gate_readiness".to_string()),
        });
        assert!(by_result.is_policy_hold_run_event);

        let non_hold = compute_policy_hold_run_event(&PolicyHoldRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            policy_hold: Some(false),
            result: Some("executed".to_string()),
        });
        assert!(!non_hold.is_policy_hold_run_event);
    }

    #[test]
    fn autoscale_json_policy_hold_run_event_path_works() {
        let payload = serde_json::json!({
            "mode": "policy_hold_run_event",
            "policy_hold_run_event_input": {
                "event_type": "autonomy_run",
                "policy_hold": false,
                "result": "stop_init_gate_readiness"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale policy_hold_run_event");
        assert!(out.contains("\"mode\":\"policy_hold_run_event\""));
    }

    #[test]
    fn score_only_result_classifies_expected_values() {
        let score_only = compute_score_only_result(&ScoreOnlyResultInput {
            result: Some("score_only_preview".to_string()),
        });
        assert!(score_only.is_score_only);

        let non_score_only = compute_score_only_result(&ScoreOnlyResultInput {
            result: Some("executed".to_string()),
        });
        assert!(!non_score_only.is_score_only);
    }

    #[test]
    fn autoscale_json_score_only_result_path_works() {
        let payload = serde_json::json!({
            "mode": "score_only_result",
            "score_only_result_input": {
                "result": "score_only_evidence"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale score_only_result");
        assert!(out.contains("\"mode\":\"score_only_result\""));
    }

    #[test]
    fn score_only_failure_like_classifies_expected_values() {
        let structural = compute_score_only_failure_like(&ScoreOnlyFailureLikeInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_preview_structural_cooldown".to_string()),
            preview_verification_present: Some(false),
            preview_verification_passed: None,
            preview_verification_outcome: None,
        });
        assert!(structural.is_failure_like);

        let no_change = compute_score_only_failure_like(&ScoreOnlyFailureLikeInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("score_only_preview".to_string()),
            preview_verification_present: Some(true),
            preview_verification_passed: Some(true),
            preview_verification_outcome: Some("no_change".to_string()),
        });
        assert!(no_change.is_failure_like);

        let clean = compute_score_only_failure_like(&ScoreOnlyFailureLikeInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("score_only_preview".to_string()),
            preview_verification_present: Some(true),
            preview_verification_passed: Some(true),
            preview_verification_outcome: Some("shipped".to_string()),
        });
        assert!(!clean.is_failure_like);
    }

    #[test]
    fn autoscale_json_score_only_failure_like_path_works() {
        let payload = serde_json::json!({
            "mode": "score_only_failure_like",
            "score_only_failure_like_input": {
                "event_type": "autonomy_run",
                "result": "score_only_preview",
                "preview_verification_present": true,
                "preview_verification_passed": true,
                "preview_verification_outcome": "no_change"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale score_only_failure_like");
        assert!(out.contains("\"mode\":\"score_only_failure_like\""));
    }

    #[test]
    fn gate_exhausted_attempt_classifies_expected_values() {
        let exhausted = compute_gate_exhausted_attempt(&GateExhaustedAttemptInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_stale_signal".to_string()),
        });
        assert!(exhausted.is_gate_exhausted);

        let non_exhausted = compute_gate_exhausted_attempt(&GateExhaustedAttemptInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("executed".to_string()),
        });
        assert!(!non_exhausted.is_gate_exhausted);
    }

    #[test]
    fn autoscale_json_gate_exhausted_attempt_path_works() {
        let payload = serde_json::json!({
            "mode": "gate_exhausted_attempt",
            "gate_exhausted_attempt_input": {
                "event_type": "autonomy_run",
                "result": "stop_repeat_gate_candidate_exhausted"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale gate_exhausted_attempt");
        assert!(out.contains("\"mode\":\"gate_exhausted_attempt\""));
    }

    #[test]
    fn consecutive_gate_exhausted_attempts_counts_tail_streak() {
        let out = compute_consecutive_gate_exhausted_attempts(&ConsecutiveGateExhaustedAttemptsInput {
            events: vec![
                ConsecutiveGateExhaustedAttemptEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                },
                ConsecutiveGateExhaustedAttemptEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_stale_signal".to_string()),
                },
                ConsecutiveGateExhaustedAttemptEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
                },
                ConsecutiveGateExhaustedAttemptEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("lock_busy".to_string()),
                },
            ],
        });
        assert_eq!(out.count, 2);
    }

    #[test]
    fn autoscale_json_consecutive_gate_exhausted_attempts_path_works() {
        let payload = serde_json::json!({
            "mode": "consecutive_gate_exhausted_attempts",
            "consecutive_gate_exhausted_attempts_input": {
                "events": [
                    {"event_type": "autonomy_run", "result": "stop_repeat_gate_stale_signal"},
                    {"event_type": "autonomy_run", "result": "stop_repeat_gate_candidate_exhausted"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale consecutive_gate_exhausted_attempts");
        assert!(out.contains("\"mode\":\"consecutive_gate_exhausted_attempts\""));
    }

    #[test]
    fn runs_since_reset_index_prefers_last_reset_marker() {
        let out = compute_runs_since_reset_index(&RunsSinceResetIndexInput {
            events: vec![
                RunsSinceResetEventInput {
                    event_type: Some("autonomy_run".to_string()),
                },
                RunsSinceResetEventInput {
                    event_type: Some("autonomy_reset".to_string()),
                },
                RunsSinceResetEventInput {
                    event_type: Some("autonomy_run".to_string()),
                },
                RunsSinceResetEventInput {
                    event_type: Some("autonomy_reset".to_string()),
                },
                RunsSinceResetEventInput {
                    event_type: Some("autonomy_run".to_string()),
                },
            ],
        });
        assert_eq!(out.start_index, 4);
    }

    #[test]
    fn autoscale_json_runs_since_reset_index_path_works() {
        let payload = serde_json::json!({
            "mode": "runs_since_reset_index",
            "runs_since_reset_index_input": {
                "events": [
                    {"event_type": "autonomy_run"},
                    {"event_type": "autonomy_reset"},
                    {"event_type": "autonomy_run"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale runs_since_reset_index");
        assert!(out.contains("\"mode\":\"runs_since_reset_index\""));
    }

    #[test]
    fn attempt_event_indices_filters_attempt_rows() {
        let out = compute_attempt_event_indices(&AttemptEventIndicesInput {
            events: vec![
                AttemptEventIndexEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                },
                AttemptEventIndexEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("lock_busy".to_string()),
                },
                AttemptEventIndexEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
                },
            ],
        });
        assert_eq!(out.indices, vec![0, 2]);
    }

    #[test]
    fn autoscale_json_attempt_event_indices_path_works() {
        let payload = serde_json::json!({
            "mode": "attempt_event_indices",
            "attempt_event_indices_input": {
                "events": [
                    {"event_type": "autonomy_run", "result": "executed"},
                    {"event_type": "autonomy_run", "result": "lock_busy"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale attempt_event_indices");
        assert!(out.contains("\"mode\":\"attempt_event_indices\""));
    }

    #[test]
    fn capacity_counted_attempt_indices_filters_expected_rows() {
        let out = compute_capacity_counted_attempt_indices(&CapacityCountedAttemptIndicesInput {
            events: vec![
                CapacityCountedAttemptIndexEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    policy_hold: Some(false),
                    proposal_id: Some("p1".to_string()),
                },
                CapacityCountedAttemptIndexEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("lock_busy".to_string()),
                    policy_hold: Some(false),
                    proposal_id: Some("p2".to_string()),
                },
                CapacityCountedAttemptIndexEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
                    policy_hold: Some(false),
                    proposal_id: Some("p3".to_string()),
                },
            ],
        });
        assert_eq!(out.indices, vec![0, 2]);
    }

    #[test]
    fn autoscale_json_capacity_counted_attempt_indices_path_works() {
        let payload = serde_json::json!({
            "mode": "capacity_counted_attempt_indices",
            "capacity_counted_attempt_indices_input": {
                "events": [
                    {
                        "event_type": "autonomy_run",
                        "result": "executed",
                        "policy_hold": false,
                        "proposal_id": "p1"
                    },
                    {
                        "event_type": "autonomy_run",
                        "result": "lock_busy",
                        "policy_hold": false,
                        "proposal_id": "p2"
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale capacity_counted_attempt_indices");
        assert!(out.contains("\"mode\":\"capacity_counted_attempt_indices\""));
    }

    #[test]
    fn consecutive_no_progress_runs_counts_tail_until_break() {
        let out = compute_consecutive_no_progress_runs(&ConsecutiveNoProgressRunsInput {
            events: vec![
                ConsecutiveNoProgressEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("no_change".to_string()),
                },
                ConsecutiveNoProgressEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_no_progress".to_string()),
                    outcome: None,
                },
                ConsecutiveNoProgressEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("shipped".to_string()),
                },
            ],
        });
        assert_eq!(out.count, 0);

        let out2 = compute_consecutive_no_progress_runs(&ConsecutiveNoProgressRunsInput {
            events: vec![
                ConsecutiveNoProgressEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("reverted".to_string()),
                },
                ConsecutiveNoProgressEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_no_progress".to_string()),
                    outcome: None,
                },
            ],
        });
        assert_eq!(out2.count, 2);
    }

    #[test]
    fn autoscale_json_consecutive_no_progress_runs_path_works() {
        let payload = serde_json::json!({
            "mode": "consecutive_no_progress_runs",
            "consecutive_no_progress_runs_input": {
                "events": [
                    {"event_type": "autonomy_run", "result": "executed", "outcome": "no_change"},
                    {"event_type": "autonomy_run", "result": "stop_repeat_gate_no_progress"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale consecutive_no_progress_runs");
        assert!(out.contains("\"mode\":\"consecutive_no_progress_runs\""));
    }

    #[test]
    fn shipped_count_counts_executed_shipped_rows() {
        let out = compute_shipped_count(&ShippedCountInput {
            events: vec![
                ShippedCountEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("shipped".to_string()),
                },
                ShippedCountEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("reverted".to_string()),
                },
                ShippedCountEventInput {
                    event_type: Some("outcome".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("shipped".to_string()),
                },
            ],
        });
        assert_eq!(out.count, 1);
    }

    #[test]
    fn autoscale_json_shipped_count_path_works() {
        let payload = serde_json::json!({
            "mode": "shipped_count",
            "shipped_count_input": {
                "events": [
                    {"event_type": "autonomy_run", "result": "executed", "outcome": "shipped"},
                    {"event_type": "autonomy_run", "result": "executed", "outcome": "reverted"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale shipped_count");
        assert!(out.contains("\"mode\":\"shipped_count\""));
    }

    #[test]
    fn executed_count_by_risk_counts_expected_rows() {
        let out = compute_executed_count_by_risk(&ExecutedCountByRiskInput {
            events: vec![
                ExecutedCountByRiskEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    risk: Some("medium".to_string()),
                    proposal_risk: None,
                },
                ExecutedCountByRiskEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    risk: None,
                    proposal_risk: Some("high".to_string()),
                },
                ExecutedCountByRiskEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_no_progress".to_string()),
                    risk: Some("medium".to_string()),
                    proposal_risk: None,
                },
            ],
            risk: Some("medium".to_string()),
        });
        assert_eq!(out.count, 1);
    }

    #[test]
    fn autoscale_json_executed_count_by_risk_path_works() {
        let payload = serde_json::json!({
            "mode": "executed_count_by_risk",
            "executed_count_by_risk_input": {
                "risk": "high",
                "events": [
                    {"event_type": "autonomy_run", "result": "executed", "risk": "high"},
                    {"event_type": "autonomy_run", "result": "executed", "risk": "medium"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale executed_count_by_risk");
        assert!(out.contains("\"mode\":\"executed_count_by_risk\""));
    }

    #[test]
    fn run_result_tally_counts_autonomy_run_results() {
        let out = compute_run_result_tally(&RunResultTallyInput {
            events: vec![
                RunResultTallyEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                },
                RunResultTallyEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_no_progress".to_string()),
                },
                RunResultTallyEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                },
                RunResultTallyEventInput {
                    event_type: Some("outcome".to_string()),
                    result: Some("executed".to_string()),
                },
            ],
        });
        assert_eq!(out.counts.get("executed").copied().unwrap_or(0), 2);
        assert_eq!(
            out.counts.get("stop_repeat_gate_no_progress").copied().unwrap_or(0),
            1
        );
    }

    #[test]
    fn autoscale_json_run_result_tally_path_works() {
        let payload = serde_json::json!({
            "mode": "run_result_tally",
            "run_result_tally_input": {
                "events": [
                    {"event_type": "autonomy_run", "result": "executed"},
                    {"event_type": "autonomy_run", "result": "executed"},
                    {"event_type": "autonomy_run", "result": "stop_repeat_gate_no_progress"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale run_result_tally");
        assert!(out.contains("\"mode\":\"run_result_tally\""));
    }

    #[test]
    fn qos_lane_weights_adjust_by_pressure() {
        let warning = compute_qos_lane_weights(&QosLaneWeightsInput {
            pressure: Some("warning".to_string()),
            critical_weight: 1.0,
            standard_weight: 1.0,
            explore_weight: 1.0,
            quarantine_weight: 1.0,
        });
        assert!((warning.explore - 0.75).abs() < 0.000001);
        assert!((warning.quarantine - 0.35).abs() < 0.000001);

        let critical = compute_qos_lane_weights(&QosLaneWeightsInput {
            pressure: Some("critical".to_string()),
            critical_weight: 1.0,
            standard_weight: 1.0,
            explore_weight: 1.0,
            quarantine_weight: 1.0,
        });
        assert!((critical.critical - 1.2).abs() < 0.000001);
        assert!((critical.standard - 1.1).abs() < 0.000001);
        assert!((critical.explore - 0.3).abs() < 0.000001);
        assert!((critical.quarantine - 0.1).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_qos_lane_weights_path_works() {
        let payload = serde_json::json!({
            "mode": "qos_lane_weights",
            "qos_lane_weights_input": {
                "pressure": "warning",
                "critical_weight": 1.0,
                "standard_weight": 1.0,
                "explore_weight": 1.0,
                "quarantine_weight": 1.0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale qos_lane_weights");
        assert!(out.contains("\"mode\":\"qos_lane_weights\""));
    }

    #[test]
    fn qos_lane_usage_counts_modes() {
        let out = compute_qos_lane_usage(&QosLaneUsageInput {
            events: vec![
                QosLaneUsageEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    selection_mode: Some("qos_critical_exploit".to_string()),
                },
                QosLaneUsageEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    selection_mode: Some("qos_explore_explore".to_string()),
                },
                QosLaneUsageEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_repeat_gate_no_progress".to_string()),
                    selection_mode: Some("qos_standard_exploit".to_string()),
                },
            ],
        });
        assert_eq!(out.critical, 1);
        assert_eq!(out.explore, 1);
        assert_eq!(out.standard, 0);
        assert_eq!(out.quarantine, 0);
    }

    #[test]
    fn autoscale_json_qos_lane_usage_path_works() {
        let payload = serde_json::json!({
            "mode": "qos_lane_usage",
            "qos_lane_usage_input": {
                "events": [
                    {"event_type": "autonomy_run", "result": "executed", "selection_mode": "qos_standard_exploit"},
                    {"event_type": "autonomy_run", "result": "executed", "selection_mode": "qos_quarantine_explore"}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale qos_lane_usage");
        assert!(out.contains("\"mode\":\"qos_lane_usage\""));
    }

    #[test]
    fn qos_lane_share_cap_exceeded_checks_explore_and_quarantine() {
        let explore = compute_qos_lane_share_cap_exceeded(&QosLaneShareCapExceededInput {
            lane: Some("explore".to_string()),
            explore_usage: 4.0,
            quarantine_usage: 1.0,
            executed_count: 10.0,
            explore_max_share: 0.35,
            quarantine_max_share: 0.2,
        });
        assert!(explore.exceeded);

        let quarantine = compute_qos_lane_share_cap_exceeded(&QosLaneShareCapExceededInput {
            lane: Some("quarantine".to_string()),
            explore_usage: 1.0,
            quarantine_usage: 1.0,
            executed_count: 10.0,
            explore_max_share: 0.35,
            quarantine_max_share: 0.2,
        });
        assert!(!quarantine.exceeded);
    }

    #[test]
    fn autoscale_json_qos_lane_share_cap_exceeded_path_works() {
        let payload = serde_json::json!({
            "mode": "qos_lane_share_cap_exceeded",
            "qos_lane_share_cap_exceeded_input": {
                "lane": "explore",
                "explore_usage": 4,
                "quarantine_usage": 1,
                "executed_count": 10,
                "explore_max_share": 0.35,
                "quarantine_max_share": 0.2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale qos_lane_share_cap_exceeded");
        assert!(out.contains("\"mode\":\"qos_lane_share_cap_exceeded\""));
    }

    #[test]
    fn qos_lane_from_candidate_routes_expected_lane() {
        let quarantine = compute_qos_lane_from_candidate(&QosLaneFromCandidateInput {
            queue_underflow_backfill: true,
            pulse_tier: 2,
            proposal_type: Some("directive_clarification".to_string()),
            deprioritized_source: false,
            risk: Some("medium".to_string()),
        });
        assert_eq!(quarantine.lane, "quarantine");

        let explore = compute_qos_lane_from_candidate(&QosLaneFromCandidateInput {
            queue_underflow_backfill: false,
            pulse_tier: 5,
            proposal_type: Some("other".to_string()),
            deprioritized_source: false,
            risk: Some("medium".to_string()),
        });
        assert_eq!(explore.lane, "explore");
    }

    #[test]
    fn autoscale_json_qos_lane_from_candidate_path_works() {
        let payload = serde_json::json!({
            "mode": "qos_lane_from_candidate",
            "qos_lane_from_candidate_input": {
                "queue_underflow_backfill": false,
                "pulse_tier": 1,
                "proposal_type": "directive_decomposition",
                "deprioritized_source": false,
                "risk": "low"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale qos_lane_from_candidate");
        assert!(out.contains("\"mode\":\"qos_lane_from_candidate\""));
    }

    #[test]
    fn eye_outcome_count_window_counts_matching_rows() {
        let out = compute_eye_outcome_count_window(&EyeOutcomeWindowCountInput {
            events: vec![
                EyeOutcomeEventInput {
                    event_type: Some("outcome".to_string()),
                    outcome: Some("success".to_string()),
                    evidence_ref: Some("eye:foo".to_string()),
                    ts: Some("2026-03-03T10:00:00.000Z".to_string()),
                },
                EyeOutcomeEventInput {
                    event_type: Some("outcome".to_string()),
                    outcome: Some("success".to_string()),
                    evidence_ref: Some("eye:bar".to_string()),
                    ts: Some("2026-03-03T10:00:00.000Z".to_string()),
                },
                EyeOutcomeEventInput {
                    event_type: Some("outcome".to_string()),
                    outcome: Some("success".to_string()),
                    evidence_ref: Some("eye:foo".to_string()),
                    ts: Some("2026-02-20T10:00:00.000Z".to_string()),
                },
            ],
            eye_ref: Some("eye:foo".to_string()),
            outcome: Some("success".to_string()),
            end_date_str: Some("2026-03-03".to_string()),
            days: Some(7),
        });
        assert_eq!(out.count, 1);
    }

    #[test]
    fn autoscale_json_eye_outcome_count_window_path_works() {
        let payload = serde_json::json!({
            "mode": "eye_outcome_count_window",
            "eye_outcome_count_window_input": {
                "eye_ref": "eye:foo",
                "outcome": "success",
                "end_date_str": "2026-03-03",
                "days": 3,
                "events": [
                    {
                        "event_type": "outcome",
                        "outcome": "success",
                        "evidence_ref": "eye:foo",
                        "ts": "2026-03-03T10:00:00.000Z"
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale eye_outcome_count_window");
        assert!(out.contains("\"mode\":\"eye_outcome_count_window\""));
    }

    #[test]
    fn eye_outcome_count_last_hours_counts_matching_rows() {
        let out = compute_eye_outcome_count_last_hours(&EyeOutcomeLastHoursCountInput {
            events: vec![
                EyeOutcomeEventInput {
                    event_type: Some("outcome".to_string()),
                    outcome: Some("success".to_string()),
                    evidence_ref: Some("eye:foo".to_string()),
                    ts: Some("2026-03-03T11:00:00.000Z".to_string()),
                },
                EyeOutcomeEventInput {
                    event_type: Some("outcome".to_string()),
                    outcome: Some("success".to_string()),
                    evidence_ref: Some("eye:foo".to_string()),
                    ts: Some("2026-03-02T10:00:00.000Z".to_string()),
                },
            ],
            eye_ref: Some("eye:foo".to_string()),
            outcome: Some("success".to_string()),
            hours: Some(3.0),
            now_ms: Some(1_772_503_200_000.0),
        });
        assert_eq!(out.count, 1);
    }

    #[test]
    fn autoscale_json_eye_outcome_count_last_hours_path_works() {
        let payload = serde_json::json!({
            "mode": "eye_outcome_count_last_hours",
            "eye_outcome_count_last_hours_input": {
                "eye_ref": "eye:foo",
                "outcome": "success",
                "hours": 6,
                "now_ms": 1772503200000.0,
                "events": [
                    {
                        "event_type": "outcome",
                        "outcome": "success",
                        "evidence_ref": "eye:foo",
                        "ts": "2026-03-03T11:00:00.000Z"
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale eye_outcome_count_last_hours");
        assert!(out.contains("\"mode\":\"eye_outcome_count_last_hours\""));
    }

    #[test]
    fn sorted_counts_orders_by_count_then_result() {
        let out = compute_sorted_counts(&SortedCountsInput {
            counts: std::collections::BTreeMap::from([
                ("b".to_string(), 2.0),
                ("a".to_string(), 2.0),
                ("c".to_string(), 1.0),
            ]),
        });
        assert_eq!(
            out.items,
            vec![
                SortedCountItem {
                    result: "a".to_string(),
                    count: 2
                },
                SortedCountItem {
                    result: "b".to_string(),
                    count: 2
                },
                SortedCountItem {
                    result: "c".to_string(),
                    count: 1
                }
            ]
        );
    }

    #[test]
    fn autoscale_json_sorted_counts_path_works() {
        let payload = serde_json::json!({
            "mode": "sorted_counts",
            "sorted_counts_input": {
                "counts": {
                    "executed": 2,
                    "stop_repeat_gate_no_progress": 1
                }
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale sorted_counts");
        assert!(out.contains("\"mode\":\"sorted_counts\""));
    }

    #[test]
    fn normalize_proposal_status_maps_expected_values() {
        let out = compute_normalize_proposal_status(&NormalizeProposalStatusInput {
            raw_status: Some("closed_won".to_string()),
            fallback: Some("pending".to_string()),
        });
        assert_eq!(out.normalized_status, "closed");

        let out2 = compute_normalize_proposal_status(&NormalizeProposalStatusInput {
            raw_status: Some("queued".to_string()),
            fallback: Some("pending".to_string()),
        });
        assert_eq!(out2.normalized_status, "pending");
    }

    #[test]
    fn autoscale_json_normalize_proposal_status_path_works() {
        let payload = serde_json::json!({
            "mode": "normalize_proposal_status",
            "normalize_proposal_status_input": {
                "raw_status": "closed_won",
                "fallback": "pending"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale normalize_proposal_status");
        assert!(out.contains("\"mode\":\"normalize_proposal_status\""));
    }

    #[test]
    fn proposal_status_maps_overlay_decision_values() {
        let accepted = compute_proposal_status(&ProposalStatusInput {
            overlay_decision: Some("accept".to_string()),
        });
        assert_eq!(accepted.status, "accepted");

        let rejected = compute_proposal_status(&ProposalStatusInput {
            overlay_decision: Some("reject".to_string()),
        });
        assert_eq!(rejected.status, "rejected");

        let parked = compute_proposal_status(&ProposalStatusInput {
            overlay_decision: Some("park".to_string()),
        });
        assert_eq!(parked.status, "parked");

        let pending = compute_proposal_status(&ProposalStatusInput {
            overlay_decision: Some("other".to_string()),
        });
        assert_eq!(pending.status, "pending");
    }

    #[test]
    fn autoscale_json_proposal_status_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_status",
            "proposal_status_input": {
                "overlay_decision": "accept"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_status");
        assert!(out.contains("\"mode\":\"proposal_status\""));
    }

    #[test]
    fn proposal_outcome_status_normalizes_or_none() {
        let out = compute_proposal_outcome_status(&ProposalOutcomeStatusInput {
            overlay_outcome: Some(" SHIPPED ".to_string()),
        });
        assert_eq!(out.outcome, Some("shipped".to_string()));

        let out2 = compute_proposal_outcome_status(&ProposalOutcomeStatusInput {
            overlay_outcome: Some("   ".to_string()),
        });
        assert_eq!(out2.outcome, None);
    }

    #[test]
    fn autoscale_json_proposal_outcome_status_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_outcome_status",
            "proposal_outcome_status_input": {
                "overlay_outcome": "shipped"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_outcome_status");
        assert!(out.contains("\"mode\":\"proposal_outcome_status\""));
    }

    #[test]
    fn queue_underflow_backfill_allows_only_accepted_without_outcome() {
        let allow = compute_queue_underflow_backfill(&QueueUnderflowBackfillInput {
            underflow_backfill_max: 2.0,
            status: Some("accepted".to_string()),
            overlay_outcome: Some(String::new()),
        });
        assert!(allow.allow);

        let deny = compute_queue_underflow_backfill(&QueueUnderflowBackfillInput {
            underflow_backfill_max: 2.0,
            status: Some("accepted".to_string()),
            overlay_outcome: Some("shipped".to_string()),
        });
        assert!(!deny.allow);
    }

    #[test]
    fn autoscale_json_queue_underflow_backfill_path_works() {
        let payload = serde_json::json!({
            "mode": "queue_underflow_backfill",
            "queue_underflow_backfill_input": {
                "underflow_backfill_max": 2,
                "status": "accepted",
                "overlay_outcome": ""
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale queue_underflow_backfill");
        assert!(out.contains("\"mode\":\"queue_underflow_backfill\""));
    }

    #[test]
    fn proposal_risk_score_prefers_explicit_then_maps_risk() {
        let explicit = compute_proposal_risk_score(&ProposalRiskScoreInput {
            explicit_risk_score: Some(61.8),
            risk: Some("low".to_string()),
        });
        assert_eq!(explicit.risk_score, 62);

        let high = compute_proposal_risk_score(&ProposalRiskScoreInput {
            explicit_risk_score: None,
            risk: Some("high".to_string()),
        });
        assert_eq!(high.risk_score, 90);
    }

    #[test]
    fn autoscale_json_proposal_risk_score_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_risk_score",
            "proposal_risk_score_input": {
                "explicit_risk_score": null,
                "risk": "medium"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_risk_score");
        assert!(out.contains("\"mode\":\"proposal_risk_score\""));
    }

    #[test]
    fn proposal_score_applies_weighted_penalties() {
        let out = compute_proposal_score(&ProposalScoreInput {
            impact_weight: 3.0,
            risk_penalty: 2.0,
            age_hours: 24.0,
            is_stub: false,
            no_change_count: 1.0,
            reverted_count: 0.0,
        });
        assert!((out.score - 1.9).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_proposal_score_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_score",
            "proposal_score_input": {
                "impact_weight": 3,
                "risk_penalty": 2,
                "age_hours": 24,
                "is_stub": false,
                "no_change_count": 1,
                "reverted_count": 0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_score");
        assert!(out.contains("\"mode\":\"proposal_score\""));
    }

    #[test]
    fn proposal_admission_preview_returns_object_only() {
        let object_preview = compute_proposal_admission_preview(&ProposalAdmissionPreviewInput {
            admission_preview: Some(serde_json::json!({"allow": true, "reason": "ok"})),
        });
        assert!(object_preview.preview.is_some());

        let array_preview = compute_proposal_admission_preview(&ProposalAdmissionPreviewInput {
            admission_preview: Some(serde_json::json!(["ok"])),
        });
        assert!(array_preview.preview.is_some());

        let scalar_preview = compute_proposal_admission_preview(&ProposalAdmissionPreviewInput {
            admission_preview: Some(serde_json::json!("not-an-object")),
        });
        assert!(scalar_preview.preview.is_none());
    }

    #[test]
    fn autoscale_json_proposal_admission_preview_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_admission_preview",
            "proposal_admission_preview_input": {
                "admission_preview": {
                    "allow": true,
                    "reason": "ok"
                }
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_admission_preview");
        assert!(out.contains("\"mode\":\"proposal_admission_preview\""));
    }

    #[test]
    fn impact_weight_maps_expected_impact() {
        let high = compute_impact_weight(&ImpactWeightInput {
            expected_impact: Some("high".to_string()),
        });
        assert_eq!(high.weight, 3);
        let low = compute_impact_weight(&ImpactWeightInput {
            expected_impact: Some("low".to_string()),
        });
        assert_eq!(low.weight, 1);
    }

    #[test]
    fn autoscale_json_impact_weight_path_works() {
        let payload = serde_json::json!({
            "mode": "impact_weight",
            "impact_weight_input": {
                "expected_impact": "medium"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale impact_weight");
        assert!(out.contains("\"mode\":\"impact_weight\""));
    }

    #[test]
    fn risk_penalty_maps_risk_levels() {
        let high = compute_risk_penalty(&RiskPenaltyInput {
            risk: Some("high".to_string()),
        });
        assert_eq!(high.penalty, 2);
        let low = compute_risk_penalty(&RiskPenaltyInput {
            risk: Some("low".to_string()),
        });
        assert_eq!(low.penalty, 0);
    }

    #[test]
    fn autoscale_json_risk_penalty_path_works() {
        let payload = serde_json::json!({
            "mode": "risk_penalty",
            "risk_penalty_input": {
                "risk": "medium"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale risk_penalty");
        assert!(out.contains("\"mode\":\"risk_penalty\""));
    }

    #[test]
    fn estimate_tokens_maps_expected_impact() {
        let high = compute_estimate_tokens(&EstimateTokensInput {
            expected_impact: Some("high".to_string()),
        });
        assert_eq!(high.est_tokens, 1400);
        let low = compute_estimate_tokens(&EstimateTokensInput {
            expected_impact: Some("low".to_string()),
        });
        assert_eq!(low.est_tokens, 300);
    }

    #[test]
    fn autoscale_json_estimate_tokens_path_works() {
        let payload = serde_json::json!({
            "mode": "estimate_tokens",
            "estimate_tokens_input": {
                "expected_impact": "medium"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale estimate_tokens");
        assert!(out.contains("\"mode\":\"estimate_tokens\""));
    }

    #[test]
    fn proposal_remediation_depth_prefers_explicit_then_trigger() {
        let explicit = compute_proposal_remediation_depth(&ProposalRemediationDepthInput {
            remediation_depth: Some(2.4),
            trigger: Some("consecutive_failures".to_string()),
        });
        assert_eq!(explicit.depth, 2);

        let trigger = compute_proposal_remediation_depth(&ProposalRemediationDepthInput {
            remediation_depth: None,
            trigger: Some("multi_eye_transport_failure".to_string()),
        });
        assert_eq!(trigger.depth, 1);

        let none = compute_proposal_remediation_depth(&ProposalRemediationDepthInput {
            remediation_depth: None,
            trigger: Some("".to_string()),
        });
        assert_eq!(none.depth, 0);
    }

    #[test]
    fn autoscale_json_proposal_remediation_depth_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_remediation_depth",
            "proposal_remediation_depth_input": {
                "remediation_depth": null,
                "trigger": "consecutive_failures"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_remediation_depth");
        assert!(out.contains("\"mode\":\"proposal_remediation_depth\""));
        assert!(out.contains("\"depth\":1"));
    }

    #[test]
    fn proposal_dedup_key_uses_remediation_and_id_paths() {
        let remediation = compute_proposal_dedup_key(&ProposalDedupKeyInput {
            proposal_type: Some("ops_remediation".to_string()),
            source_eye_id: Some("github_release".to_string()),
            remediation_kind: Some("transport".to_string()),
            proposal_id: Some("abc-1".to_string()),
        });
        assert_eq!(
            remediation.dedup_key,
            "ops_remediation|github_release|transport"
        );

        let generic = compute_proposal_dedup_key(&ProposalDedupKeyInput {
            proposal_type: Some("feature".to_string()),
            source_eye_id: Some("unknown_eye".to_string()),
            remediation_kind: None,
            proposal_id: Some("abc-1".to_string()),
        });
        assert_eq!(generic.dedup_key, "feature|unknown_eye|abc-1");
    }

    #[test]
    fn autoscale_json_proposal_dedup_key_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_dedup_key",
            "proposal_dedup_key_input": {
                "proposal_type": "ops_remediation",
                "source_eye_id": "github_release",
                "remediation_kind": "transport",
                "proposal_id": "abc-1"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_dedup_key");
        assert!(out.contains("\"mode\":\"proposal_dedup_key\""));
        assert!(out.contains("\"dedup_key\":\"ops_remediation|github_release|transport\""));
    }

    #[test]
    fn semantic_token_similarity_uses_jaccard_overlap() {
        let out = compute_semantic_token_similarity(&SemanticTokenSimilarityInput {
            left_tokens: vec![
                "bridge".to_string(),
                "rust".to_string(),
                "parity".to_string(),
                "rust".to_string(),
            ],
            right_tokens: vec![
                "rust".to_string(),
                "parity".to_string(),
                "tests".to_string(),
            ],
        });
        assert!((out.similarity - 0.5).abs() < 1e-6, "similarity={}", out.similarity);

        let empty = compute_semantic_token_similarity(&SemanticTokenSimilarityInput {
            left_tokens: vec![],
            right_tokens: vec!["anything".to_string()],
        });
        assert_eq!(empty.similarity, 0.0);
    }

    #[test]
    fn autoscale_json_semantic_token_similarity_path_works() {
        let payload = serde_json::json!({
            "mode": "semantic_token_similarity",
            "semantic_token_similarity_input": {
                "left_tokens": ["rust", "bridge", "parity"],
                "right_tokens": ["parity", "tests"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale semantic_token_similarity");
        assert!(out.contains("\"mode\":\"semantic_token_similarity\""));
        assert!(out.contains("\"similarity\":0.25"));
    }

    #[test]
    fn semantic_context_comparable_requires_type_and_shared_context() {
        let pass = compute_semantic_context_comparable(&SemanticContextComparableInput {
            left_proposal_type: Some("ops_remediation".to_string()),
            right_proposal_type: Some("ops_remediation".to_string()),
            left_source_eye: Some("github_release".to_string()),
            right_source_eye: Some("github_release".to_string()),
            left_objective_id: None,
            right_objective_id: None,
            require_same_type: true,
            require_shared_context: true,
        });
        assert!(pass.comparable);

        let blocked = compute_semantic_context_comparable(&SemanticContextComparableInput {
            left_proposal_type: Some("ops_remediation".to_string()),
            right_proposal_type: Some("feature".to_string()),
            left_source_eye: Some("github_release".to_string()),
            right_source_eye: Some("github_release".to_string()),
            left_objective_id: None,
            right_objective_id: None,
            require_same_type: true,
            require_shared_context: true,
        });
        assert!(!blocked.comparable);
    }

    #[test]
    fn autoscale_json_semantic_context_comparable_path_works() {
        let payload = serde_json::json!({
            "mode": "semantic_context_comparable",
            "semantic_context_comparable_input": {
                "left_proposal_type": "ops_remediation",
                "right_proposal_type": "ops_remediation",
                "left_source_eye": "github_release",
                "right_source_eye": "github_release",
                "left_objective_id": "",
                "right_objective_id": "",
                "require_same_type": true,
                "require_shared_context": true
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale semantic_context_comparable");
        assert!(out.contains("\"mode\":\"semantic_context_comparable\""));
        assert!(out.contains("\"comparable\":true"));
    }

    #[test]
    fn semantic_near_duplicate_match_selects_best_eligible_candidate() {
        let out = compute_semantic_near_duplicate_match(&SemanticNearDuplicateMatchInput {
            fingerprint: SemanticNearDuplicateFingerprintInput {
                proposal_id: Some("new-1".to_string()),
                proposal_type: Some("ops_remediation".to_string()),
                source_eye: Some("github_release".to_string()),
                objective_id: Some("obj-a".to_string()),
                token_stems: vec![
                    "rust".to_string(),
                    "bridge".to_string(),
                    "parity".to_string(),
                ],
                eligible: true,
            },
            seen_fingerprints: vec![
                SemanticNearDuplicateFingerprintInput {
                    proposal_id: Some("old-1".to_string()),
                    proposal_type: Some("ops_remediation".to_string()),
                    source_eye: Some("github_release".to_string()),
                    objective_id: Some("obj-a".to_string()),
                    token_stems: vec![
                        "rust".to_string(),
                        "bridge".to_string(),
                        "tests".to_string(),
                    ],
                    eligible: true,
                },
                SemanticNearDuplicateFingerprintInput {
                    proposal_id: Some("old-2".to_string()),
                    proposal_type: Some("ops_remediation".to_string()),
                    source_eye: Some("github_release".to_string()),
                    objective_id: Some("obj-a".to_string()),
                    token_stems: vec![
                        "rust".to_string(),
                        "bridge".to_string(),
                        "parity".to_string(),
                    ],
                    eligible: true,
                },
            ],
            min_similarity: 0.5,
            require_same_type: true,
            require_shared_context: true,
        });
        assert!(out.matched);
        assert_eq!(out.proposal_id.as_deref(), Some("old-2"));
        assert!((out.similarity - 1.0).abs() < 1e-6, "similarity={}", out.similarity);
    }

    #[test]
    fn autoscale_json_semantic_near_duplicate_match_path_works() {
        let payload = serde_json::json!({
            "mode": "semantic_near_duplicate_match",
            "semantic_near_duplicate_match_input": {
                "fingerprint": {
                    "proposal_id": "new-1",
                    "proposal_type": "ops_remediation",
                    "source_eye": "github_release",
                    "objective_id": "obj-a",
                    "token_stems": ["rust", "bridge", "parity"],
                    "eligible": true
                },
                "seen_fingerprints": [{
                    "proposal_id": "old-1",
                    "proposal_type": "ops_remediation",
                    "source_eye": "github_release",
                    "objective_id": "obj-a",
                    "token_stems": ["rust", "bridge", "tests"],
                    "eligible": true
                }],
                "min_similarity": 0.4,
                "require_same_type": true,
                "require_shared_context": true
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale semantic_near_duplicate_match");
        assert!(out.contains("\"mode\":\"semantic_near_duplicate_match\""));
        assert!(out.contains("\"matched\":true"));
    }

    #[test]
    fn strategy_rank_score_matches_weighted_formula() {
        let out = compute_strategy_rank_score(&StrategyRankScoreInput {
            composite_weight: 0.35,
            actionability_weight: 0.2,
            directive_fit_weight: 0.15,
            signal_quality_weight: 0.15,
            expected_value_weight: 0.1,
            value_density_weight: 0.08,
            risk_penalty_weight: 0.05,
            time_to_value_weight: 0.0,
            composite: 80.0,
            actionability: 70.0,
            directive_fit: 60.0,
            signal_quality: 75.0,
            expected_value: 55.0,
            value_density: 50.0,
            risk_penalty: 50.0,
            time_to_value: 40.0,
            non_yield_penalty: 1.5,
            collective_shadow_penalty: 0.5,
            collective_shadow_bonus: 0.2,
        });
        assert!((out.score - 67.45).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_strategy_rank_score_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_rank_score",
            "strategy_rank_score_input": {
                "composite_weight": 0.35,
                "actionability_weight": 0.2,
                "directive_fit_weight": 0.15,
                "signal_quality_weight": 0.15,
                "expected_value_weight": 0.1,
                "value_density_weight": 0.08,
                "risk_penalty_weight": 0.05,
                "time_to_value_weight": 0.0,
                "composite": 80,
                "actionability": 70,
                "directive_fit": 60,
                "signal_quality": 75,
                "expected_value": 55,
                "value_density": 50,
                "risk_penalty": 50,
                "time_to_value": 40,
                "non_yield_penalty": 1.5,
                "collective_shadow_penalty": 0.5,
                "collective_shadow_bonus": 0.2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale strategy_rank_score");
        assert!(out.contains("\"mode\":\"strategy_rank_score\""));
        assert!(out.contains("\"score\":67.45"));
    }

    #[test]
    fn strategy_rank_adjusted_matches_pulse_and_objective_bonus_formula() {
        let out = compute_strategy_rank_adjusted(&StrategyRankAdjustedInput {
            base: 65.4,
            pulse_score: 82.0,
            pulse_weight: 0.25,
            objective_allocation_score: 70.0,
            base_objective_weight: 0.3,
            canary_mode: false,
        });
        assert!((out.adjusted - 93.25).abs() < 0.000001);
        assert!((out.bonus.total - 27.85).abs() < 0.000001);
        assert!((out.bonus.objective_weight - 0.105).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_strategy_rank_adjusted_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_rank_adjusted",
            "strategy_rank_adjusted_input": {
                "base": 65.4,
                "pulse_score": 82,
                "pulse_weight": 0.25,
                "objective_allocation_score": 70,
                "base_objective_weight": 0.3,
                "canary_mode": false
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale strategy_rank_adjusted");
        assert!(out.contains("\"mode\":\"strategy_rank_adjusted\""));
        assert!(out.contains("\"adjusted\":93.25"));
    }

    #[test]
    fn trit_shadow_rank_score_normalizes_belief_with_confidence_bonus() {
        let out = compute_trit_shadow_rank_score(&TritShadowRankScoreInput {
            score: 0.35,
            confidence: 0.6,
        });
        assert!((out.score - 73.5).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_trit_shadow_rank_score_path_works() {
        let payload = serde_json::json!({
            "mode": "trit_shadow_rank_score",
            "trit_shadow_rank_score_input": {
                "score": 0.35,
                "confidence": 0.6
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale trit_shadow_rank_score");
        assert!(out.contains("\"mode\":\"trit_shadow_rank_score\""));
        assert!(out.contains("\"score\":73.5"));
    }

    #[test]
    fn strategy_circuit_cooldown_matches_error_classification() {
        let out = compute_strategy_circuit_cooldown(&StrategyCircuitCooldownInput {
            last_error_code: Some("HTTP 503".to_string()),
            last_error: None,
            http_429_cooldown_hours: 1.0,
            http_5xx_cooldown_hours: 6.0,
            dns_error_cooldown_hours: 3.0,
        });
        assert!((out.cooldown_hours - 6.0).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_strategy_circuit_cooldown_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_circuit_cooldown",
            "strategy_circuit_cooldown_input": {
                "last_error_code": "rate_limit_hit",
                "http_429_cooldown_hours": 2,
                "http_5xx_cooldown_hours": 8,
                "dns_error_cooldown_hours": 4
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale strategy_circuit_cooldown");
        assert!(out.contains("\"mode\":\"strategy_circuit_cooldown\""));
        assert!(out.contains("\"cooldown_hours\":2.0"));
    }

    #[test]
    fn strategy_trit_shadow_adjusted_applies_bonus_blend() {
        let out = compute_strategy_trit_shadow_adjusted(&StrategyTritShadowAdjustedInput {
            base_score: 68.75,
            bonus_raw: 12.345,
            bonus_blend: 0.4,
        });
        assert!((out.bonus_applied - 4.938).abs() < 0.000001);
        assert!((out.adjusted_score - 73.688).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_strategy_trit_shadow_adjusted_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_trit_shadow_adjusted",
            "strategy_trit_shadow_adjusted_input": {
                "base_score": 68.75,
                "bonus_raw": 12.345,
                "bonus_blend": 0.4
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale strategy_trit_shadow_adjusted");
        assert!(out.contains("\"mode\":\"strategy_trit_shadow_adjusted\""));
        assert!(out.contains("\"bonus_applied\":4.938"));
        assert!(out.contains("\"adjusted_score\":73.688"));
    }

    #[test]
    fn non_yield_penalty_score_applies_weighted_formula_and_clamp() {
        let out = compute_non_yield_penalty_score(&NonYieldPenaltyScoreInput {
            policy_hold_rate: 0.25,
            no_progress_rate: 0.5,
            stop_rate: 0.125,
            shipped_rate: 0.2,
            policy_hold_weight: 8.0,
            no_progress_weight: 6.0,
            stop_weight: 4.0,
            shipped_relief_weight: 3.0,
            max_penalty: 12.0,
        });
        assert!((out.penalty - 4.9).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_non_yield_penalty_score_path_works() {
        let payload = serde_json::json!({
            "mode": "non_yield_penalty_score",
            "non_yield_penalty_score_input": {
                "policy_hold_rate": 0.25,
                "no_progress_rate": 0.5,
                "stop_rate": 0.125,
                "shipped_rate": 0.2,
                "policy_hold_weight": 8,
                "no_progress_weight": 6,
                "stop_weight": 4,
                "shipped_relief_weight": 3,
                "max_penalty": 12
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale non_yield_penalty_score");
        assert!(out.contains("\"mode\":\"non_yield_penalty_score\""));
        assert!(out.contains("\"penalty\":4.9"));
    }

    #[test]
    fn collective_shadow_adjustments_clamps_penalty_and_bonus() {
        let out = compute_collective_shadow_adjustments(&CollectiveShadowAdjustmentsInput {
            penalty_raw: 18.4,
            bonus_raw: 2.718,
            max_penalty: 12.0,
            max_bonus: 6.0,
        });
        assert!((out.penalty - 12.0).abs() < 0.000001);
        assert!((out.bonus - 2.718).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_collective_shadow_adjustments_path_works() {
        let payload = serde_json::json!({
            "mode": "collective_shadow_adjustments",
            "collective_shadow_adjustments_input": {
                "penalty_raw": 18.4,
                "bonus_raw": 2.718,
                "max_penalty": 12,
                "max_bonus": 6
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale collective_shadow_adjustments");
        assert!(out.contains("\"mode\":\"collective_shadow_adjustments\""));
        assert!(out.contains("\"penalty\":12.0"));
        assert!(out.contains("\"bonus\":2.718"));
    }

    #[test]
    fn strategy_trit_shadow_ranking_summary_orders_and_flags_divergence() {
        let out = compute_strategy_trit_shadow_ranking_summary(&StrategyTritShadowRankingSummaryInput {
            rows: vec![
                StrategyTritShadowRankRowInput {
                    index: 0,
                    proposal_id: "a".to_string(),
                    legacy_rank: 92.0,
                    trit_rank: 71.0,
                    trit_label: "neutral".to_string(),
                    trit_confidence: 0.4,
                    trit_top_sources: vec!["x".to_string()],
                },
                StrategyTritShadowRankRowInput {
                    index: 1,
                    proposal_id: "b".to_string(),
                    legacy_rank: 80.0,
                    trit_rank: 95.0,
                    trit_label: "positive".to_string(),
                    trit_confidence: 0.8,
                    trit_top_sources: vec!["y".to_string()],
                },
            ],
            selected_proposal_id: Some("a".to_string()),
            selection_mode: Some("qos_standard_legacy".to_string()),
            top_k: 3,
        });
        assert_eq!(out.legacy_top_proposal_id.as_deref(), Some("a"));
        assert_eq!(out.trit_top_proposal_id.as_deref(), Some("b"));
        assert!(out.diverged_from_legacy_top);
        assert!(out.diverged_from_selected);
        assert_eq!(out.top.first().map(|row| row.proposal_id.as_str()), Some("b"));
    }

    #[test]
    fn autoscale_json_strategy_trit_shadow_ranking_summary_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_trit_shadow_ranking_summary",
            "strategy_trit_shadow_ranking_summary_input": {
                "rows": [
                    {
                        "index": 0,
                        "proposal_id": "a",
                        "legacy_rank": 92,
                        "trit_rank": 71,
                        "trit_label": "neutral",
                        "trit_confidence": 0.4,
                        "trit_top_sources": ["x"]
                    },
                    {
                        "index": 1,
                        "proposal_id": "b",
                        "legacy_rank": 80,
                        "trit_rank": 95,
                        "trit_label": "positive",
                        "trit_confidence": 0.8,
                        "trit_top_sources": ["y"]
                    }
                ],
                "selected_proposal_id": "a",
                "selection_mode": "qos_standard_legacy",
                "top_k": 3
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale strategy_trit_shadow_ranking_summary");
        assert!(out.contains("\"mode\":\"strategy_trit_shadow_ranking_summary\""));
        assert!(out.contains("\"trit_top_proposal_id\":\"b\""));
    }

    #[test]
    fn shadow_scope_matches_evaluates_scope_types() {
        let proposal_scope = compute_shadow_scope_matches(&ShadowScopeMatchesInput {
            scope_type: Some("proposal_type".to_string()),
            scope_value: Some("ops_remediation".to_string()),
            risk_levels: vec![],
            risk: Some("low".to_string()),
            proposal_type: Some("ops_remediation".to_string()),
            capability_key: Some("system_exec".to_string()),
            objective_id: Some("obj-1".to_string()),
        });
        assert!(proposal_scope.matched);

        let global_scope = compute_shadow_scope_matches(&ShadowScopeMatchesInput {
            scope_type: Some("global".to_string()),
            scope_value: None,
            risk_levels: vec!["high".to_string()],
            risk: Some("low".to_string()),
            proposal_type: None,
            capability_key: None,
            objective_id: None,
        });
        assert!(!global_scope.matched);
    }

    #[test]
    fn autoscale_json_shadow_scope_matches_path_works() {
        let payload = serde_json::json!({
            "mode": "shadow_scope_matches",
            "shadow_scope_matches_input": {
                "scope_type": "capability_key",
                "scope_value": "system_exec",
                "risk_levels": [],
                "risk": "medium",
                "proposal_type": "ops_remediation",
                "capability_key": "system_exec",
                "objective_id": "obj-1"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale shadow_scope_matches");
        assert!(out.contains("\"mode\":\"shadow_scope_matches\""));
        assert!(out.contains("\"matched\":true"));
    }

    #[test]
    fn collective_shadow_aggregate_computes_confidence_and_weighted_totals() {
        let out = compute_collective_shadow_aggregate(&CollectiveShadowAggregateInput {
            entries: vec![
                CollectiveShadowAggregateEntryInput {
                    kind: Some("avoid".to_string()),
                    confidence: 0.8,
                    score_impact: 10.0,
                },
                CollectiveShadowAggregateEntryInput {
                    kind: Some("reinforce".to_string()),
                    confidence: 0.5,
                    score_impact: 6.0,
                },
            ],
        });
        assert_eq!(out.matches, 2);
        assert!((out.confidence_avg - 0.65).abs() < 0.000001);
        assert!((out.penalty_raw - 8.0).abs() < 0.000001);
        assert!((out.bonus_raw - 3.0).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_collective_shadow_aggregate_path_works() {
        let payload = serde_json::json!({
            "mode": "collective_shadow_aggregate",
            "collective_shadow_aggregate_input": {
                "entries": [
                    { "kind": "avoid", "confidence": 0.8, "score_impact": 10 },
                    { "kind": "reinforce", "confidence": 0.5, "score_impact": 6 }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale collective_shadow_aggregate");
        assert!(out.contains("\"mode\":\"collective_shadow_aggregate\""));
        assert!(out.contains("\"penalty_raw\":8.0"));
        assert!(out.contains("\"bonus_raw\":3.0"));
    }

    #[test]
    fn expected_value_signal_applies_currency_rank_blending() {
        let out = compute_expected_value_signal(&ExpectedValueSignalInput {
            explicit_score: None,
            expected_value_usd: None,
            oracle_priority_score: Some(80.0),
            impact_weight: 2.0,
            selected_currency: Some("revenue".to_string()),
            currency_multiplier: 1.25,
            matched_first_sentence_contains_selected: true,
            currency_ranking_enabled: true,
            oracle_applies: true,
            oracle_pass: true,
            rank_blend: 0.35,
            bonus_cap: 12.0,
        });
        assert_eq!(out.source, "value_oracle_priority_score");
        assert_eq!(out.base_score, 80.0);
        assert_eq!(out.currency_adjusted_score, Some(100.0));
        assert_eq!(out.score, 89.0);
        assert_eq!(out.currency_delta, 9.0);
    }

    #[test]
    fn autoscale_json_expected_value_signal_path_works() {
        let payload = serde_json::json!({
            "mode": "expected_value_signal",
            "expected_value_signal_input": {
                "explicit_score": 42,
                "expected_value_usd": null,
                "oracle_priority_score": null,
                "impact_weight": 2.0,
                "selected_currency": "revenue",
                "currency_multiplier": 1.25,
                "matched_first_sentence_contains_selected": false,
                "currency_ranking_enabled": true,
                "oracle_applies": true,
                "oracle_pass": true,
                "rank_blend": 0.35,
                "bonus_cap": 12
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale expected_value_signal");
        assert!(out.contains("\"mode\":\"expected_value_signal\""));
        assert!(out.contains("\"source\":\"expected_value_score\""));
        assert!(out.contains("\"score\":42.0"));
    }

    #[test]
    fn value_signal_score_matches_weighted_formula() {
        let out = compute_value_signal_score(&ValueSignalScoreInput {
            expected_value: 55.0,
            time_to_value: 50.0,
            actionability: 70.0,
            directive_fit: 60.0,
        });
        assert!((out.score - 57.0).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_value_signal_score_path_works() {
        let payload = serde_json::json!({
            "mode": "value_signal_score",
            "value_signal_score_input": {
                "expected_value": 55,
                "time_to_value": 50,
                "actionability": 70,
                "directive_fit": 60
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale value_signal_score");
        assert!(out.contains("\"mode\":\"value_signal_score\""));
        assert!(out.contains("\"score\":57.0"));
    }

    #[test]
    fn composite_eligibility_score_applies_weighted_formula() {
        let out = compute_composite_eligibility_score(&CompositeEligibilityScoreInput {
            quality_score: 80.0,
            directive_fit_score: 50.0,
            actionability_score: 90.0,
        });
        assert_eq!(out.score, 75);
    }

    #[test]
    fn autoscale_json_composite_eligibility_score_path_works() {
        let payload = serde_json::json!({
            "mode": "composite_eligibility_score",
            "composite_eligibility_score_input": {
                "quality_score": 80,
                "directive_fit_score": 50,
                "actionability_score": 90
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale composite_eligibility_score");
        assert!(out.contains("\"mode\":\"composite_eligibility_score\""));
    }

    #[test]
    fn time_to_value_score_prefers_hours_then_impact() {
        let with_hours = compute_time_to_value_score(&TimeToValueScoreInput {
            time_to_cash_hours: Some(84.0),
            expected_impact: Some("low".to_string()),
        });
        assert_eq!(with_hours.score, 50);

        let from_impact = compute_time_to_value_score(&TimeToValueScoreInput {
            time_to_cash_hours: None,
            expected_impact: Some("medium".to_string()),
        });
        assert_eq!(from_impact.score, 55);
    }

    #[test]
    fn autoscale_json_time_to_value_score_path_works() {
        let payload = serde_json::json!({
            "mode": "time_to_value_score",
            "time_to_value_score_input": {
                "time_to_cash_hours": 24,
                "expected_impact": "high"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale time_to_value_score");
        assert!(out.contains("\"mode\":\"time_to_value_score\""));
    }

    #[test]
    fn value_density_score_scales_value_by_token_cost() {
        let out = compute_value_density_score(&ValueDensityScoreInput {
            expected_value: 60.0,
            est_tokens: 500.0,
        });
        assert_eq!(out.score, 100);

        let zero = compute_value_density_score(&ValueDensityScoreInput {
            expected_value: 0.0,
            est_tokens: 500.0,
        });
        assert_eq!(zero.score, 0);
    }

    #[test]
    fn directive_tier_weight_matches_tier_policy() {
        let p1 = compute_directive_tier_weight(&DirectiveTierWeightInput {
            tier: Some(1.0),
            fallback: Some(3.0),
        });
        assert!((p1.weight - 1.3).abs() < 0.000001);

        let p2 = compute_directive_tier_weight(&DirectiveTierWeightInput {
            tier: Some(2.0),
            fallback: Some(3.0),
        });
        assert!((p2.weight - 1.0).abs() < 0.000001);

        let p3 = compute_directive_tier_weight(&DirectiveTierWeightInput {
            tier: Some(3.0),
            fallback: Some(3.0),
        });
        assert!((p3.weight - 0.82).abs() < 0.000001);

        let fallback = compute_directive_tier_weight(&DirectiveTierWeightInput {
            tier: None,
            fallback: Some(2.0),
        });
        assert!((fallback.weight - 1.0).abs() < 0.000001);
    }

    #[test]
    fn normalize_directive_tier_clamps_and_rounds() {
        let out = compute_normalize_directive_tier(&NormalizeDirectiveTierInput {
            raw_tier: Some(0.4),
            fallback: Some(3.0),
        });
        assert_eq!(out.tier, 1);

        let rounded = compute_normalize_directive_tier(&NormalizeDirectiveTierInput {
            raw_tier: Some(2.6),
            fallback: Some(3.0),
        });
        assert_eq!(rounded.tier, 3);
    }

    #[test]
    fn autoscale_json_normalize_directive_tier_path_works() {
        let payload = serde_json::json!({
            "mode": "normalize_directive_tier",
            "normalize_directive_tier_input": {
                "raw_tier": 2.4,
                "fallback": 3
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale normalize_directive_tier");
        assert!(out.contains("\"mode\":\"normalize_directive_tier\""));
        assert!(out.contains("\"tier\":2"));
    }

    #[test]
    fn autoscale_json_directive_tier_weight_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_tier_weight",
            "directive_tier_weight_input": {
                "tier": 4,
                "fallback": 3
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_tier_weight");
        assert!(out.contains("\"mode\":\"directive_tier_weight\""));
        assert!(out.contains("\"weight\":0.7"));
    }

    #[test]
    fn directive_tier_min_share_matches_tier_policy() {
        let t1 = compute_directive_tier_min_share(&DirectiveTierMinShareInput {
            tier: Some(1.0),
            fallback: Some(3.0),
            t1_min_share: 0.35,
            t2_min_share: 0.2,
        });
        assert!((t1.min_share - 0.35).abs() < 0.000001);

        let t2 = compute_directive_tier_min_share(&DirectiveTierMinShareInput {
            tier: Some(2.0),
            fallback: Some(3.0),
            t1_min_share: 0.35,
            t2_min_share: 0.2,
        });
        assert!((t2.min_share - 0.2).abs() < 0.000001);

        let t3 = compute_directive_tier_min_share(&DirectiveTierMinShareInput {
            tier: Some(3.0),
            fallback: Some(3.0),
            t1_min_share: 0.35,
            t2_min_share: 0.2,
        });
        assert!((t3.min_share - 0.0).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_directive_tier_min_share_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_tier_min_share",
            "directive_tier_min_share_input": {
                "tier": 2,
                "fallback": 3,
                "t1_min_share": 0.35,
                "t2_min_share": 0.2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_tier_min_share");
        assert!(out.contains("\"mode\":\"directive_tier_min_share\""));
        assert!(out.contains("\"min_share\":0.2"));
    }

    #[test]
    fn directive_tier_coverage_bonus_matches_expected_formula() {
        let no_attempts = compute_directive_tier_coverage_bonus(&DirectiveTierCoverageBonusInput {
            tier: Some(1.0),
            fallback: Some(3.0),
            attempts_today: 0.0,
            current_for_tier: 0.0,
            t1_min_share: 0.35,
            t2_min_share: 0.2,
        });
        assert!((no_attempts.bonus - 8.0).abs() < 0.000001);

        let deficit = compute_directive_tier_coverage_bonus(&DirectiveTierCoverageBonusInput {
            tier: Some(2.0),
            fallback: Some(3.0),
            attempts_today: 10.0,
            current_for_tier: 0.0,
            t1_min_share: 0.35,
            t2_min_share: 0.2,
        });
        assert!((deficit.bonus - 12.0).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_directive_tier_coverage_bonus_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_tier_coverage_bonus",
            "directive_tier_coverage_bonus_input": {
                "tier": 2,
                "fallback": 3,
                "attempts_today": 8,
                "current_for_tier": 0,
                "t1_min_share": 0.35,
                "t2_min_share": 0.2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_tier_coverage_bonus");
        assert!(out.contains("\"mode\":\"directive_tier_coverage_bonus\""));
        assert!(out.contains("\"bonus\":12.0"));
    }

    #[test]
    fn directive_tier_reservation_need_reports_undercoverage() {
        let out = compute_directive_tier_reservation_need(&DirectiveTierReservationNeedInput {
            enabled: true,
            available: true,
            attempts_today: 10.0,
            tier1_attempts: 2.0,
            tier2_attempts: 3.0,
            tier1_min_share: 0.35,
            tier2_min_share: 0.2,
            candidate_tiers: vec![1.0, 1.0, 2.0, 3.0],
        });
        assert!(out.reserve);
        assert_eq!(out.tier, Some(1));
        assert_eq!(out.required_after_next, Some(4.0));
        assert_eq!(out.candidate_count, Some(2));
    }

    #[test]
    fn autoscale_json_directive_tier_reservation_need_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_tier_reservation_need",
            "directive_tier_reservation_need_input": {
                "enabled": true,
                "available": true,
                "attempts_today": 8,
                "tier1_attempts": 4,
                "tier2_attempts": 0,
                "tier1_min_share": 0.35,
                "tier2_min_share": 0.2,
                "candidate_tiers": [2, 2, 3]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_tier_reservation_need");
        assert!(out.contains("\"mode\":\"directive_tier_reservation_need\""));
        assert!(out.contains("\"tier\":2"));
        assert!(out.contains("\"reserve\":true"));
    }

    #[test]
    fn pulse_objective_cooldown_active_matches_threshold_and_age() {
        let now_ms = 1_700_000_000_000.0;
        let ts = DateTime::<Utc>::from_timestamp_millis((now_ms as i64) - (2 * 60 * 60 * 1000))
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let active = compute_pulse_objective_cooldown_active(&PulseObjectiveCooldownActiveInput {
            no_progress_streak: 4.0,
            no_progress_limit: 3.0,
            last_attempt_ts: Some(ts),
            cooldown_hours: 6.0,
            now_ms: Some(now_ms),
        });
        assert!(active.active);

        let inactive = compute_pulse_objective_cooldown_active(&PulseObjectiveCooldownActiveInput {
            no_progress_streak: 1.0,
            no_progress_limit: 3.0,
            last_attempt_ts: Some("2026-03-01T00:00:00.000Z".to_string()),
            cooldown_hours: 6.0,
            now_ms: Some(now_ms),
        });
        assert!(!inactive.active);
    }

    #[test]
    fn autoscale_json_pulse_objective_cooldown_active_path_works() {
        let now_ms = 1_700_000_000_000.0;
        let ts = DateTime::<Utc>::from_timestamp_millis((now_ms as i64) - (60 * 60 * 1000))
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let payload = serde_json::json!({
            "mode": "pulse_objective_cooldown_active",
            "pulse_objective_cooldown_active_input": {
                "no_progress_streak": 4,
                "no_progress_limit": 3,
                "last_attempt_ts": ts,
                "cooldown_hours": 6,
                "now_ms": now_ms
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale pulse_objective_cooldown_active");
        assert!(out.contains("\"mode\":\"pulse_objective_cooldown_active\""));
        assert!(out.contains("\"active\":true"));
    }

    #[test]
    fn directive_token_hits_matches_token_and_stem_logic() {
        let out = compute_directive_token_hits(&DirectiveTokenHitsInput {
            text_tokens: vec!["memory".to_string(), "drift".to_string()],
            text_stems: vec!["memor".to_string(), "drift".to_string()],
            directive_tokens: vec![
                "memory".to_string(),
                "memorize".to_string(),
                "security".to_string(),
            ],
        });
        assert_eq!(
            out.hits,
            vec!["memory".to_string(), "memorize".to_string()]
        );
    }

    #[test]
    fn autoscale_json_directive_token_hits_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_token_hits",
            "directive_token_hits_input": {
                "text_tokens": ["memory", "drift"],
                "text_stems": ["memor", "drift"],
                "directive_tokens": ["memory", "memorize", "security"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_token_hits");
        assert!(out.contains("\"mode\":\"directive_token_hits\""));
        assert!(out.contains("\"hits\":[\"memory\",\"memorize\"]"));
    }

    #[test]
    fn to_stem_matches_ts_semantics() {
        let short = compute_to_stem(&ToStemInput {
            token: Some("abc".to_string()),
        });
        assert_eq!(short.stem, "abc");

        let long = compute_to_stem(&ToStemInput {
            token: Some("memory".to_string()),
        });
        assert_eq!(long.stem, "memor");
    }

    #[test]
    fn autoscale_json_to_stem_path_works() {
        let payload = serde_json::json!({
            "mode": "to_stem",
            "to_stem_input": {
                "token": "security"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale to_stem");
        assert!(out.contains("\"mode\":\"to_stem\""));
        assert!(out.contains("\"stem\":\"secur\""));
    }

    #[test]
    fn normalize_directive_text_matches_ts_semantics() {
        let out = compute_normalize_directive_text(&NormalizeDirectiveTextInput {
            text: Some(" Memory++ Drift\nPlan! ".to_string()),
        });
        assert_eq!(out.normalized, "memory drift plan");
    }

    #[test]
    fn autoscale_json_normalize_directive_text_path_works() {
        let payload = serde_json::json!({
            "mode": "normalize_directive_text",
            "normalize_directive_text_input": {
                "text": " Safety-first, always. "
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale normalize_directive_text");
        assert!(out.contains("\"mode\":\"normalize_directive_text\""));
        assert!(out.contains("\"normalized\":\"safety first always\""));
    }

    #[test]
    fn tokenize_directive_text_matches_ts_filters() {
        let out = compute_tokenize_directive_text(&TokenizeDirectiveTextInput {
            text: Some("The memory plan 123 avoids drift".to_string()),
            stopwords: vec!["the".to_string(), "plan".to_string()],
        });
        assert_eq!(
            out.tokens,
            vec![
                "memory".to_string(),
                "avoids".to_string(),
                "drift".to_string()
            ]
        );
    }

    #[test]
    fn autoscale_json_tokenize_directive_text_path_works() {
        let payload = serde_json::json!({
            "mode": "tokenize_directive_text",
            "tokenize_directive_text_input": {
                "text": "The memory plan 123 avoids drift",
                "stopwords": ["the", "plan"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale tokenize_directive_text");
        assert!(out.contains("\"mode\":\"tokenize_directive_text\""));
        assert!(out.contains("\"tokens\":[\"memory\",\"avoids\",\"drift\"]"));
    }

    #[test]
    fn normalize_spaces_matches_ts_semantics() {
        let out = compute_normalize_spaces(&NormalizeSpacesInput {
            text: Some("  one\t two\nthree   ".to_string()),
        });
        assert_eq!(out.normalized, "one two three");
    }

    #[test]
    fn autoscale_json_normalize_spaces_path_works() {
        let payload = serde_json::json!({
            "mode": "normalize_spaces",
            "normalize_spaces_input": {
                "text": "  one\t two\nthree   "
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale normalize_spaces");
        assert!(out.contains("\"mode\":\"normalize_spaces\""));
        assert!(out.contains("\"normalized\":\"one two three\""));
    }

    #[test]
    fn parse_lower_list_matches_ts_semantics() {
        let from_list = compute_parse_lower_list(&ParseLowerListInput {
            list: vec![" A ".to_string(), "b".to_string(), "".to_string()],
            csv: Some("x,y".to_string()),
        });
        assert_eq!(from_list.items, vec!["a".to_string(), "b".to_string()]);

        let from_csv = compute_parse_lower_list(&ParseLowerListInput {
            list: vec![],
            csv: Some(" A, B ,,C ".to_string()),
        });
        assert_eq!(
            from_csv.items,
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn autoscale_json_parse_lower_list_path_works() {
        let payload = serde_json::json!({
            "mode": "parse_lower_list",
            "parse_lower_list_input": {
                "list": [],
                "csv": "A, B ,, C"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale parse_lower_list");
        assert!(out.contains("\"mode\":\"parse_lower_list\""));
        assert!(out.contains("\"items\":[\"a\",\"b\",\"c\"]"));
    }

    #[test]
    fn canary_failed_checks_allowed_matches_subset_rules() {
        let allowed = compute_canary_failed_checks_allowed(&CanaryFailedChecksAllowedInput {
            failed_checks: vec!["lint".to_string(), "format".to_string()],
            allowed_checks: vec!["lint".to_string(), "format".to_string(), "typecheck".to_string()],
        });
        assert!(allowed.allowed);

        let blocked = compute_canary_failed_checks_allowed(&CanaryFailedChecksAllowedInput {
            failed_checks: vec!["lint".to_string(), "security".to_string()],
            allowed_checks: vec!["lint".to_string(), "format".to_string()],
        });
        assert!(!blocked.allowed);
    }

    #[test]
    fn autoscale_json_canary_failed_checks_allowed_path_works() {
        let payload = serde_json::json!({
            "mode": "canary_failed_checks_allowed",
            "canary_failed_checks_allowed_input": {
                "failed_checks": ["lint", "format"],
                "allowed_checks": ["lint", "format", "typecheck"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale canary_failed_checks_allowed");
        assert!(out.contains("\"mode\":\"canary_failed_checks_allowed\""));
        assert!(out.contains("\"allowed\":true"));
    }

    #[test]
    fn proposal_text_blob_matches_join_and_normalization() {
        let out = compute_proposal_text_blob(&ProposalTextBlobInput {
            title: Some("Fix Drift".to_string()),
            summary: Some("Improve safety".to_string()),
            suggested_next_command: Some("run checks".to_string()),
            suggested_command: None,
            notes: Some(" urgent ".to_string()),
            evidence: vec![ProposalTextBlobEvidenceEntryInput {
                evidence_ref: Some("ref://a".to_string()),
                path: Some("docs/a.md".to_string()),
                title: Some("Doc A".to_string()),
            }],
        });
        assert_eq!(
            out.blob,
            "fix drift | improve safety | run checks | urgent | ref://a | docs/a.md | doc a"
        );
    }

    #[test]
    fn autoscale_json_proposal_text_blob_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_text_blob",
            "proposal_text_blob_input": {
                "title": "Fix Drift",
                "summary": "Improve safety",
                "suggested_next_command": "run checks",
                "notes": "urgent",
                "evidence": [
                    {
                        "evidence_ref": "ref://a",
                        "path": "docs/a.md",
                        "title": "Doc A"
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_text_blob");
        assert!(out.contains("\"mode\":\"proposal_text_blob\""));
        assert!(out.contains("\"blob\":\"fix drift | improve safety | run checks | urgent | ref://a | docs/a.md | doc a\""));
    }

    #[test]
    fn percent_mentions_from_text_matches_extraction_rules() {
        let out = compute_percent_mentions_from_text(&PercentMentionsFromTextInput {
            text: Some("improve by 12.5% then -2% then 140%".to_string()),
        });
        assert_eq!(out.values, vec![12.5, 100.0]);
    }

    #[test]
    fn autoscale_json_percent_mentions_from_text_path_works() {
        let payload = serde_json::json!({
            "mode": "percent_mentions_from_text",
            "percent_mentions_from_text_input": {
                "text": "gain 10% and 25%"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale percent_mentions_from_text");
        assert!(out.contains("\"mode\":\"percent_mentions_from_text\""));
        assert!(out.contains("\"values\":[10.0,25.0]"));
    }

    #[test]
    fn optimization_min_delta_percent_respects_mode() {
        let high = compute_optimization_min_delta_percent(&OptimizationMinDeltaPercentInput {
            high_accuracy_mode: true,
            high_accuracy_value: 3.5,
            base_value: 8.0,
        });
        assert!((high.min_delta_percent - 3.5).abs() < 0.000001);

        let normal = compute_optimization_min_delta_percent(&OptimizationMinDeltaPercentInput {
            high_accuracy_mode: false,
            high_accuracy_value: 3.5,
            base_value: 8.0,
        });
        assert!((normal.min_delta_percent - 8.0).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_optimization_min_delta_percent_path_works() {
        let payload = serde_json::json!({
            "mode": "optimization_min_delta_percent",
            "optimization_min_delta_percent_input": {
                "high_accuracy_mode": true,
                "high_accuracy_value": 3.5,
                "base_value": 8.0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale optimization_min_delta_percent");
        assert!(out.contains("\"mode\":\"optimization_min_delta_percent\""));
        assert!(out.contains("\"min_delta_percent\":3.5"));
    }

    #[test]
    fn source_eye_ref_prefers_meta_then_evidence_then_unknown() {
        let meta = compute_source_eye_ref(&SourceEyeRefInput {
            meta_source_eye: Some("primary".to_string()),
            first_evidence_ref: Some("eye:secondary".to_string()),
        });
        assert_eq!(meta.eye_ref, "eye:primary");

        let evidence = compute_source_eye_ref(&SourceEyeRefInput {
            meta_source_eye: None,
            first_evidence_ref: Some("eye:secondary".to_string()),
        });
        assert_eq!(evidence.eye_ref, "eye:secondary");

        let unknown = compute_source_eye_ref(&SourceEyeRefInput {
            meta_source_eye: None,
            first_evidence_ref: Some("ref://other".to_string()),
        });
        assert_eq!(unknown.eye_ref, "eye:unknown_eye");
    }

    #[test]
    fn autoscale_json_source_eye_ref_path_works() {
        let payload = serde_json::json!({
            "mode": "source_eye_ref",
            "source_eye_ref_input": {
                "meta_source_eye": "market",
                "first_evidence_ref": "eye:other"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale source_eye_ref");
        assert!(out.contains("\"mode\":\"source_eye_ref\""));
        assert!(out.contains("\"eye_ref\":\"eye:market\""));
    }

    #[test]
    fn normalized_risk_only_allows_expected_levels() {
        let high = compute_normalized_risk(&NormalizedRiskInput {
            risk: Some("HIGH".to_string()),
        });
        assert_eq!(high.risk, "high");

        let fallback = compute_normalized_risk(&NormalizedRiskInput {
            risk: Some("critical".to_string()),
        });
        assert_eq!(fallback.risk, "low");
    }

    #[test]
    fn autoscale_json_normalized_risk_path_works() {
        let payload = serde_json::json!({
            "mode": "normalized_risk",
            "normalized_risk_input": {
                "risk": "medium"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale normalized_risk");
        assert!(out.contains("\"mode\":\"normalized_risk\""));
        assert!(out.contains("\"risk\":\"medium\""));
    }

    #[test]
    fn parse_iso_ts_returns_timestamp_when_valid() {
        let valid = compute_parse_iso_ts(&ParseIsoTsInput {
            ts: Some("2026-03-01T00:00:00.000Z".to_string()),
        });
        assert!(valid.timestamp_ms.is_some());

        let invalid = compute_parse_iso_ts(&ParseIsoTsInput {
            ts: Some("not-a-date".to_string()),
        });
        assert!(invalid.timestamp_ms.is_none());
    }

    #[test]
    fn autoscale_json_parse_iso_ts_path_works() {
        let payload = serde_json::json!({
            "mode": "parse_iso_ts",
            "parse_iso_ts_input": {
                "ts": "2026-03-01T00:00:00.000Z"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale parse_iso_ts");
        assert!(out.contains("\"mode\":\"parse_iso_ts\""));
        assert!(out.contains("\"timestamp_ms\":"));
    }

    #[test]
    fn extract_objective_id_token_matches_expected_patterns() {
        let direct = compute_extract_objective_id_token(&ExtractObjectiveIdTokenInput {
            value: Some("T12_build_router".to_string()),
        });
        assert_eq!(direct.objective_id.as_deref(), Some("T12_build_router"));

        let embedded = compute_extract_objective_id_token(&ExtractObjectiveIdTokenInput {
            value: Some("objective: T8_fix_drift soon".to_string()),
        });
        assert_eq!(embedded.objective_id.as_deref(), Some("T8_fix_drift"));

        let none = compute_extract_objective_id_token(&ExtractObjectiveIdTokenInput {
            value: Some("no token".to_string()),
        });
        assert!(none.objective_id.is_none());
    }

    #[test]
    fn autoscale_json_extract_objective_id_token_path_works() {
        let payload = serde_json::json!({
            "mode": "extract_objective_id_token",
            "extract_objective_id_token_input": {
                "value": "objective: T8_fix_drift soon"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale extract_objective_id_token");
        assert!(out.contains("\"mode\":\"extract_objective_id_token\""));
        assert!(out.contains("\"objective_id\":\"T8_fix_drift\""));
    }

    #[test]
    fn autoscale_json_value_density_score_path_works() {
        let payload = serde_json::json!({
            "mode": "value_density_score",
            "value_density_score_input": {
                "expected_value": 40,
                "est_tokens": 1000
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale value_density_score");
        assert!(out.contains("\"mode\":\"value_density_score\""));
    }

    #[test]
    fn execution_reserve_snapshot_applies_reserve_math() {
        let out = compute_execution_reserve_snapshot(&ExecutionReserveSnapshotInput {
            cap: 1000.0,
            used: 950.0,
            reserve_enabled: true,
            reserve_ratio: 0.12,
            reserve_min_tokens: 600.0,
        });
        assert!(out.enabled);
        assert_eq!(out.reserve_tokens, 600.0);
        assert_eq!(out.reserve_remaining, 50.0);
    }

    #[test]
    fn autoscale_json_execution_reserve_snapshot_path_works() {
        let payload = serde_json::json!({
            "mode": "execution_reserve_snapshot",
            "execution_reserve_snapshot_input": {
                "cap": 1000,
                "used": 950,
                "reserve_enabled": true,
                "reserve_ratio": 0.12,
                "reserve_min_tokens": 600
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale execution_reserve_snapshot");
        assert!(out.contains("\"mode\":\"execution_reserve_snapshot\""));
    }

    #[test]
    fn budget_pacing_gate_blocks_high_token_low_value_when_tight() {
        let out = compute_budget_pacing_gate(&BudgetPacingGateInput {
            est_tokens: 1800.0,
            value_signal_score: 45.0,
            risk: Some("medium".to_string()),
            snapshot_tight: true,
            snapshot_autopause_active: false,
            snapshot_remaining_ratio: 0.18,
            snapshot_pressure: Some("hard".to_string()),
            execution_floor_deficit: false,
            execution_reserve_enabled: true,
            execution_reserve_remaining: 200.0,
            execution_reserve_min_value_signal: 70.0,
            budget_pacing_enabled: true,
            min_remaining_ratio: 0.2,
            high_token_threshold: 1200.0,
            min_value_signal_score: 60.0,
        });
        assert!(!out.pass);
        assert_eq!(out.reason.as_deref(), Some("budget_pacing_high_token_low_value"));
    }

    #[test]
    fn autoscale_json_budget_pacing_gate_path_works() {
        let payload = serde_json::json!({
            "mode": "budget_pacing_gate",
            "budget_pacing_gate_input": {
                "est_tokens": 300,
                "value_signal_score": 80,
                "risk": "low",
                "snapshot_tight": true,
                "snapshot_autopause_active": false,
                "snapshot_remaining_ratio": 0.12,
                "snapshot_pressure": "warn",
                "execution_floor_deficit": true,
                "execution_reserve_enabled": true,
                "execution_reserve_remaining": 500,
                "execution_reserve_min_value_signal": 70,
                "budget_pacing_enabled": true,
                "min_remaining_ratio": 0.2,
                "high_token_threshold": 1200,
                "min_value_signal_score": 60
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale budget_pacing_gate");
        assert!(out.contains("\"mode\":\"budget_pacing_gate\""));
        assert!(out.contains("\"pass\":true"));
    }

    #[test]
    fn capability_cap_prefers_primary_then_aliases() {
        let out = compute_capability_cap(&CapabilityCapInput {
            caps: std::collections::BTreeMap::from([
                ("proposal:ops_remediation".to_string(), 4.2),
                ("proposal:feature".to_string(), 2.0),
            ]),
            primary_key: Some("proposal:ops_remediation".to_string()),
            aliases: vec!["proposal:feature".to_string()],
        });
        assert_eq!(out.cap, Some(4));

        let alias = compute_capability_cap(&CapabilityCapInput {
            caps: std::collections::BTreeMap::from([("alias:key".to_string(), 3.0)]),
            primary_key: Some("missing:key".to_string()),
            aliases: vec!["alias:key".to_string()],
        });
        assert_eq!(alias.cap, Some(3));
    }

    #[test]
    fn autoscale_json_capability_cap_path_works() {
        let payload = serde_json::json!({
            "mode": "capability_cap",
            "capability_cap_input": {
                "caps": {
                    "proposal:ops_remediation": 5
                },
                "primary_key": "proposal:ops_remediation",
                "aliases": ["proposal:feature"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale capability_cap");
        assert!(out.contains("\"mode\":\"capability_cap\""));
        assert!(out.contains("\"cap\":5"));
    }

    #[test]
    fn estimate_tokens_for_candidate_prefers_direct_then_route_then_fallback() {
        let direct = compute_estimate_tokens_for_candidate(&EstimateTokensForCandidateInput {
            direct_est_tokens: 700.0,
            route_tokens_est: 300.0,
            fallback_estimate: 200.0,
        });
        assert_eq!(direct.est_tokens, 700);

        let route = compute_estimate_tokens_for_candidate(&EstimateTokensForCandidateInput {
            direct_est_tokens: 0.0,
            route_tokens_est: 320.0,
            fallback_estimate: 200.0,
        });
        assert_eq!(route.est_tokens, 320);
    }

    #[test]
    fn autoscale_json_estimate_tokens_for_candidate_path_works() {
        let payload = serde_json::json!({
            "mode": "estimate_tokens_for_candidate",
            "estimate_tokens_for_candidate_input": {
                "direct_est_tokens": 0,
                "route_tokens_est": 340,
                "fallback_estimate": 200
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale estimate_tokens_for_candidate");
        assert!(out.contains("\"mode\":\"estimate_tokens_for_candidate\""));
    }

    #[test]
    fn minutes_since_ts_uses_now_and_preserves_sign() {
        let out = compute_minutes_since_ts(&MinutesSinceTsInput {
            ts: Some("2026-03-03T11:00:00.000Z".to_string()),
            now_ms: Some(1_772_539_200_000.0),
        });
        let minutes = out.minutes_since.expect("minutes_since");
        assert!((minutes - 60.0).abs() < 0.000001);

        let future = compute_minutes_since_ts(&MinutesSinceTsInput {
            ts: Some("2026-03-03T13:00:00.000Z".to_string()),
            now_ms: Some(1_772_539_200_000.0),
        });
        let future_minutes = future.minutes_since.expect("future minutes");
        assert!((future_minutes + 60.0).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_minutes_since_ts_path_works() {
        let payload = serde_json::json!({
            "mode": "minutes_since_ts",
            "minutes_since_ts_input": {
                "ts": "2026-03-03T11:00:00.000Z",
                "now_ms": 1772539200000.0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale minutes_since_ts");
        assert!(out.contains("\"mode\":\"minutes_since_ts\""));
    }

    #[test]
    fn date_window_builds_descending_iso_dates() {
        let out = compute_date_window(&DateWindowInput {
            end_date_str: Some("2026-03-03".to_string()),
            days: Some(3.0),
        });
        assert_eq!(
            out.dates,
            vec![
                "2026-03-03".to_string(),
                "2026-03-02".to_string(),
                "2026-03-01".to_string()
            ]
        );
    }

    #[test]
    fn autoscale_json_date_window_path_works() {
        let payload = serde_json::json!({
            "mode": "date_window",
            "date_window_input": {
                "end_date_str": "2026-03-03",
                "days": 2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale date_window");
        assert!(out.contains("\"mode\":\"date_window\""));
    }

    #[test]
    fn in_window_checks_bounds_against_end_date() {
        let inside = compute_in_window(&InWindowInput {
            ts: Some("2026-03-03T12:00:00.000Z".to_string()),
            end_date_str: Some("2026-03-03".to_string()),
            days: Some(1.0),
        });
        assert!(inside.in_window);

        let outside = compute_in_window(&InWindowInput {
            ts: Some("2026-03-02T23:59:59.000Z".to_string()),
            end_date_str: Some("2026-03-03".to_string()),
            days: Some(1.0),
        });
        assert!(!outside.in_window);
    }

    #[test]
    fn autoscale_json_in_window_path_works() {
        let payload = serde_json::json!({
            "mode": "in_window",
            "in_window_input": {
                "ts": "2026-03-03T12:00:00.000Z",
                "end_date_str": "2026-03-03",
                "days": 2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale in_window");
        assert!(out.contains("\"mode\":\"in_window\""));
    }

    #[test]
    fn start_of_next_utc_day_returns_next_day_iso() {
        let out = compute_start_of_next_utc_day(&StartOfNextUtcDayInput {
            date_str: Some("2026-03-03".to_string()),
        });
        assert_eq!(out.iso_ts, Some("2026-03-04T00:00:00.000Z".to_string()));
    }

    #[test]
    fn autoscale_json_start_of_next_utc_day_path_works() {
        let payload = serde_json::json!({
            "mode": "start_of_next_utc_day",
            "start_of_next_utc_day_input": {
                "date_str": "2026-03-03"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale start_of_next_utc_day");
        assert!(out.contains("\"mode\":\"start_of_next_utc_day\""));
    }

    #[test]
    fn iso_after_minutes_builds_iso_and_clamps_negative() {
        let out = compute_iso_after_minutes(&IsoAfterMinutesInput {
            minutes: Some(30.0),
            now_ms: Some(1_772_539_200_000.0),
        });
        assert_eq!(out.iso_ts, Some("2026-03-03T12:30:00.000Z".to_string()));

        let clamped = compute_iso_after_minutes(&IsoAfterMinutesInput {
            minutes: Some(-15.0),
            now_ms: Some(1_772_539_200_000.0),
        });
        assert_eq!(clamped.iso_ts, Some("2026-03-03T12:00:00.000Z".to_string()));
    }

    #[test]
    fn autoscale_json_iso_after_minutes_path_works() {
        let payload = serde_json::json!({
            "mode": "iso_after_minutes",
            "iso_after_minutes_input": {
                "minutes": 5,
                "now_ms": 1772539200000.0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale iso_after_minutes");
        assert!(out.contains("\"mode\":\"iso_after_minutes\""));
    }

    #[test]
    fn execute_confidence_history_match_prefers_capability_then_type() {
        let cap_match = compute_execute_confidence_history_match(
            &ExecuteConfidenceHistoryMatchInput {
                event_type: Some("autonomy_run".to_string()),
                event_capability_key: Some("deploy".to_string()),
                event_proposal_type: Some("run".to_string()),
                proposal_type: Some("other".to_string()),
                capability_key: Some("deploy".to_string()),
            },
        );
        assert!(cap_match.matched);

        let type_match = compute_execute_confidence_history_match(
            &ExecuteConfidenceHistoryMatchInput {
                event_type: Some("autonomy_run".to_string()),
                event_capability_key: Some(String::new()),
                event_proposal_type: Some("ops".to_string()),
                proposal_type: Some("ops".to_string()),
                capability_key: Some(String::new()),
            },
        );
        assert!(type_match.matched);
    }

    #[test]
    fn autoscale_json_execute_confidence_history_match_path_works() {
        let payload = serde_json::json!({
            "mode": "execute_confidence_history_match",
            "execute_confidence_history_match_input": {
                "event_type": "autonomy_run",
                "event_capability_key": "deploy",
                "event_proposal_type": "ops",
                "proposal_type": "ops",
                "capability_key": "deploy"
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale execute_confidence_history_match");
        assert!(out.contains("\"mode\":\"execute_confidence_history_match\""));
    }

    #[test]
    fn execute_confidence_cooldown_key_prefers_objective_then_capability_then_type() {
        let objective = compute_execute_confidence_cooldown_key(&ExecuteConfidenceCooldownKeyInput {
            capability_key: Some("system_exec".to_string()),
            objective_id: Some("T1_Objective".to_string()),
            proposal_type: Some("ops_remediation".to_string()),
        });
        assert_eq!(objective.cooldown_key, "exec_confidence:objective:t1_objective");

        let capability = compute_execute_confidence_cooldown_key(&ExecuteConfidenceCooldownKeyInput {
            capability_key: Some("System Exec".to_string()),
            objective_id: Some("T12_Objective".to_string()),
            proposal_type: Some("ops_remediation".to_string()),
        });
        assert_eq!(capability.cooldown_key, "exec_confidence:capability:system_exec");

        let by_type = compute_execute_confidence_cooldown_key(&ExecuteConfidenceCooldownKeyInput {
            capability_key: Some(String::new()),
            objective_id: Some(String::new()),
            proposal_type: Some("Directive Decomposition".to_string()),
        });
        assert_eq!(by_type.cooldown_key, "exec_confidence:type:directive_decomposition");
    }

    #[test]
    fn autoscale_json_execute_confidence_cooldown_key_path_works() {
        let payload = serde_json::json!({
            "mode": "execute_confidence_cooldown_key",
            "execute_confidence_cooldown_key_input": {
                "capability_key": "System Exec",
                "objective_id": "T2_objective",
                "proposal_type": "ops_remediation"
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale execute_confidence_cooldown_key");
        assert!(out.contains("\"mode\":\"execute_confidence_cooldown_key\""));
    }

    #[test]
    fn proposal_status_for_queue_pressure_prefers_overlay_then_explicit_status() {
        let out = compute_proposal_status_for_queue_pressure(&ProposalStatusForQueuePressureInput {
            overlay_decision: Some("accept".to_string()),
            proposal_status: Some("rejected".to_string()),
        });
        assert_eq!(out.status, "accepted");

        let out2 = compute_proposal_status_for_queue_pressure(&ProposalStatusForQueuePressureInput {
            overlay_decision: None,
            proposal_status: Some("closed_won".to_string()),
        });
        assert_eq!(out2.status, "closed");

        let out3 = compute_proposal_status_for_queue_pressure(&ProposalStatusForQueuePressureInput {
            overlay_decision: None,
            proposal_status: Some("pending".to_string()),
        });
        assert_eq!(out3.status, "pending");
    }

    #[test]
    fn autoscale_json_proposal_status_for_queue_pressure_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_status_for_queue_pressure",
            "proposal_status_for_queue_pressure_input": {
                "overlay_decision": "accept",
                "proposal_status": "queued"
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale proposal_status_for_queue_pressure");
        assert!(out.contains("\"mode\":\"proposal_status_for_queue_pressure\""));
    }

    #[test]
    fn no_progress_result_classifies_core_cases() {
        let executed_no_change = compute_no_progress_result(&NoProgressResultInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("executed".to_string()),
            outcome: Some("no_change".to_string()),
        });
        assert!(executed_no_change.is_no_progress);

        let executed_shipped = compute_no_progress_result(&NoProgressResultInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("executed".to_string()),
            outcome: Some("shipped".to_string()),
        });
        assert!(!executed_shipped.is_no_progress);

        let blocked = compute_no_progress_result(&NoProgressResultInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_init_gate_quality_exhausted".to_string()),
            outcome: None,
        });
        assert!(blocked.is_no_progress);
    }

    #[test]
    fn autoscale_json_no_progress_result_path_works() {
        let payload = serde_json::json!({
            "mode": "no_progress_result",
            "no_progress_result_input": {
                "event_type": "autonomy_run",
                "result": "stop_repeat_gate_no_progress",
                "outcome": ""
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale no_progress_result");
        assert!(out.contains("\"mode\":\"no_progress_result\""));
    }

    #[test]
    fn attempt_run_event_classifies_core_cases() {
        let executed = compute_attempt_run_event(&AttemptRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("executed".to_string()),
        });
        assert!(executed.is_attempt);

        let blocked = compute_attempt_run_event(&AttemptRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
        });
        assert!(blocked.is_attempt);

        let non_attempt = compute_attempt_run_event(&AttemptRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_no_progress".to_string()),
        });
        assert!(!non_attempt.is_attempt);
    }

    #[test]
    fn autoscale_json_attempt_run_event_path_works() {
        let payload = serde_json::json!({
            "mode": "attempt_run_event",
            "attempt_run_event_input": {
                "event_type": "autonomy_run",
                "result": "stop_init_gate_quality_exhausted"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale attempt_run_event");
        assert!(out.contains("\"mode\":\"attempt_run_event\""));
    }

    #[test]
    fn safety_stop_run_event_classifies_core_cases() {
        let escalation = compute_safety_stop_run_event(&SafetyStopRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_human_escalation_pending".to_string()),
        });
        assert!(escalation.is_safety_stop);

        let capability = compute_safety_stop_run_event(&SafetyStopRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_capability_cooldown".to_string()),
        });
        assert!(capability.is_safety_stop);

        let non_safety = compute_safety_stop_run_event(&SafetyStopRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_no_progress".to_string()),
        });
        assert!(!non_safety.is_safety_stop);
    }

    #[test]
    fn autoscale_json_safety_stop_run_event_path_works() {
        let payload = serde_json::json!({
            "mode": "safety_stop_run_event",
            "safety_stop_run_event_input": {
                "event_type": "autonomy_run",
                "result": "stop_init_gate_tier1_governance"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale safety_stop_run_event");
        assert!(out.contains("\"mode\":\"safety_stop_run_event\""));
    }

    #[test]
    fn non_yield_category_classifies_policy_and_safety_and_progress() {
        let budget_hold = compute_non_yield_category(&NonYieldCategoryInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("no_candidates_policy_daily_cap".to_string()),
            outcome: None,
            policy_hold: Some(true),
            hold_reason: Some("budget guard blocked".to_string()),
            route_block_reason: None,
        });
        assert_eq!(budget_hold.category, Some("budget_hold".to_string()));

        let safety = compute_non_yield_category(&NonYieldCategoryInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_human_escalation_pending".to_string()),
            outcome: None,
            policy_hold: Some(false),
            hold_reason: None,
            route_block_reason: None,
        });
        assert_eq!(safety.category, Some("safety_stop".to_string()));

        let no_progress = compute_non_yield_category(&NonYieldCategoryInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("executed".to_string()),
            outcome: Some("no_change".to_string()),
            policy_hold: Some(false),
            hold_reason: None,
            route_block_reason: None,
        });
        assert_eq!(no_progress.category, Some("no_progress".to_string()));
    }

    #[test]
    fn autoscale_json_non_yield_category_path_works() {
        let payload = serde_json::json!({
            "mode": "non_yield_category",
            "non_yield_category_input": {
                "event_type": "autonomy_run",
                "result": "executed",
                "outcome": "no_change",
                "policy_hold": false,
                "hold_reason": "",
                "route_block_reason": ""
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale non_yield_category");
        assert!(out.contains("\"mode\":\"non_yield_category\""));
    }

    #[test]
    fn non_yield_reason_prefers_explicit_then_falls_back() {
        let explicit = compute_non_yield_reason(&NonYieldReasonInput {
            category: Some("policy_hold".to_string()),
            hold_reason: Some("Gate Manual".to_string()),
            route_block_reason: None,
            reason: None,
            result: Some("stop_init_gate_readiness".to_string()),
            outcome: None,
        });
        assert_eq!(explicit.reason, "gate manual");

        let no_progress_executed = compute_non_yield_reason(&NonYieldReasonInput {
            category: Some("no_progress".to_string()),
            hold_reason: None,
            route_block_reason: None,
            reason: None,
            result: Some("executed".to_string()),
            outcome: Some("no_change".to_string()),
        });
        assert_eq!(no_progress_executed.reason, "executed_no_change");

        let fallback = compute_non_yield_reason(&NonYieldReasonInput {
            category: Some("safety_stop".to_string()),
            hold_reason: None,
            route_block_reason: None,
            reason: None,
            result: None,
            outcome: None,
        });
        assert_eq!(fallback.reason, "safety_stop_unknown");
    }

    #[test]
    fn autoscale_json_non_yield_reason_path_works() {
        let payload = serde_json::json!({
            "mode": "non_yield_reason",
            "non_yield_reason_input": {
                "category": "no_progress",
                "result": "executed",
                "outcome": "no_change"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale non_yield_reason");
        assert!(out.contains("\"mode\":\"non_yield_reason\""));
    }

    #[test]
    fn proposal_type_from_run_event_prefers_direct_then_capability_key() {
        let direct = compute_proposal_type_from_run_event(&ProposalTypeFromRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            proposal_type: Some("Unknown".to_string()),
            capability_key: Some("proposal:directive".to_string()),
        });
        assert_eq!(direct.proposal_type, "unknown".to_string());

        let derived = compute_proposal_type_from_run_event(&ProposalTypeFromRunEventInput {
            event_type: Some("autonomy_run".to_string()),
            proposal_type: Some(String::new()),
            capability_key: Some("proposal:directive".to_string()),
        });
        assert_eq!(derived.proposal_type, "directive".to_string());
    }

    #[test]
    fn autoscale_json_proposal_type_from_run_event_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_type_from_run_event",
            "proposal_type_from_run_event_input": {
                "event_type": "autonomy_run",
                "proposal_type": "",
                "capability_key": "proposal:unknown"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_type_from_run_event");
        assert!(out.contains("\"mode\":\"proposal_type_from_run_event\""));
    }

    #[test]
    fn run_event_objective_id_uses_truthy_priority_then_sanitizes() {
        let from_objective = compute_run_event_objective_id(&RunEventObjectiveIdInput {
            directive_pulse_present: Some(false),
            directive_pulse_objective_id: Some(String::new()),
            objective_id_present: Some(true),
            objective_id: Some("T1_alpha".to_string()),
            objective_binding_present: Some(true),
            objective_binding_objective_id: Some("T1_beta".to_string()),
            top_escalation_present: Some(true),
            top_escalation_objective_id: Some("T1_gamma".to_string()),
        });
        assert_eq!(from_objective.objective_id, "T1_alpha".to_string());

        let blocked_by_truthy_invalid = compute_run_event_objective_id(&RunEventObjectiveIdInput {
            directive_pulse_present: Some(true),
            directive_pulse_objective_id: Some("   ".to_string()),
            objective_id_present: Some(true),
            objective_id: Some("T1_valid".to_string()),
            objective_binding_present: Some(false),
            objective_binding_objective_id: Some(String::new()),
            top_escalation_present: Some(false),
            top_escalation_objective_id: Some(String::new()),
        });
        assert_eq!(blocked_by_truthy_invalid.objective_id, String::new());
    }

    #[test]
    fn autoscale_json_run_event_objective_id_path_works() {
        let payload = serde_json::json!({
            "mode": "run_event_objective_id",
            "run_event_objective_id_input": {
                "directive_pulse_present": false,
                "directive_pulse_objective_id": "",
                "objective_id_present": true,
                "objective_id": "T1_alpha",
                "objective_binding_present": false,
                "objective_binding_objective_id": "",
                "top_escalation_present": false,
                "top_escalation_objective_id": ""
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale run_event_objective_id");
        assert!(out.contains("\"mode\":\"run_event_objective_id\""));
    }

    #[test]
    fn run_event_proposal_id_uses_truthy_priority_then_normalizes_spaces() {
        let from_direct = compute_run_event_proposal_id(&RunEventProposalIdInput {
            proposal_id_present: Some(true),
            proposal_id: Some("  p-001  ".to_string()),
            selected_proposal_id_present: Some(true),
            selected_proposal_id: Some("p-002".to_string()),
            top_escalation_present: Some(true),
            top_escalation_proposal_id: Some("p-003".to_string()),
        });
        assert_eq!(from_direct.proposal_id, "p-001".to_string());

        let from_selected = compute_run_event_proposal_id(&RunEventProposalIdInput {
            proposal_id_present: Some(false),
            proposal_id: Some(String::new()),
            selected_proposal_id_present: Some(true),
            selected_proposal_id: Some(" selected   proposal ".to_string()),
            top_escalation_present: Some(true),
            top_escalation_proposal_id: Some("p-003".to_string()),
        });
        assert_eq!(from_selected.proposal_id, "selected proposal".to_string());
    }

    #[test]
    fn autoscale_json_run_event_proposal_id_path_works() {
        let payload = serde_json::json!({
            "mode": "run_event_proposal_id",
            "run_event_proposal_id_input": {
                "proposal_id_present": false,
                "proposal_id": "",
                "selected_proposal_id_present": true,
                "selected_proposal_id": "p-009",
                "top_escalation_present": false,
                "top_escalation_proposal_id": ""
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale run_event_proposal_id");
        assert!(out.contains("\"mode\":\"run_event_proposal_id\""));
    }

    #[test]
    fn capacity_counted_attempt_event_classifies_expected_cases() {
        let executed = compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("executed".to_string()),
            policy_hold: Some(false),
            proposal_id: Some(String::new()),
        });
        assert!(executed.capacity_counted);

        let policy_hold = compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_init_gate_readiness".to_string()),
            policy_hold: Some(false),
            proposal_id: Some("p-001".to_string()),
        });
        assert!(!policy_hold.capacity_counted);

        let attempt_with_proposal = compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
            policy_hold: Some(false),
            proposal_id: Some("p-001".to_string()),
        });
        assert!(attempt_with_proposal.capacity_counted);

        let attempt_without_proposal = compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
            policy_hold: Some(false),
            proposal_id: Some(String::new()),
        });
        assert!(!attempt_without_proposal.capacity_counted);
    }

    #[test]
    fn autoscale_json_capacity_counted_attempt_event_path_works() {
        let payload = serde_json::json!({
            "mode": "capacity_counted_attempt_event",
            "capacity_counted_attempt_event_input": {
                "event_type": "autonomy_run",
                "result": "stop_repeat_gate_candidate_exhausted",
                "policy_hold": false,
                "proposal_id": "p-001"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale capacity_counted_attempt_event");
        assert!(out.contains("\"mode\":\"capacity_counted_attempt_event\""));
    }

    #[test]
    fn repeat_gate_anchor_builds_binding_only_with_objective_id() {
        let out = compute_repeat_gate_anchor(&RepeatGateAnchorInput {
            proposal_id: Some(" p-001 ".to_string()),
            objective_id: Some("T1_alpha".to_string()),
            objective_binding_present: Some(true),
            objective_binding_pass: Some(false),
            objective_binding_required: Some(true),
            objective_binding_source: Some("".to_string()),
            objective_binding_valid: Some(false),
        });
        assert_eq!(out.proposal_id, Some("p-001".to_string()));
        assert_eq!(out.objective_id, Some("T1_alpha".to_string()));
        assert!(out.objective_binding.is_some());
        let binding = out.objective_binding.expect("binding");
        assert!(!binding.pass);
        assert!(binding.required);
        assert_eq!(binding.source, "repeat_gate_anchor".to_string());
        assert!(!binding.valid);
    }

    #[test]
    fn autoscale_json_repeat_gate_anchor_path_works() {
        let payload = serde_json::json!({
            "mode": "repeat_gate_anchor",
            "repeat_gate_anchor_input": {
                "proposal_id": "p-002",
                "objective_id": "T1_alpha",
                "objective_binding_present": true,
                "objective_binding_pass": true,
                "objective_binding_required": false,
                "objective_binding_source": "repeat_gate_anchor",
                "objective_binding_valid": true
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale repeat_gate_anchor");
        assert!(out.contains("\"mode\":\"repeat_gate_anchor\""));
    }

    #[test]
    fn route_execution_policy_hold_maps_summary_fields() {
        let out = compute_route_execution_policy_hold(&RouteExecutionPolicyHoldInput {
            target: Some("route".to_string()),
            gate_decision: Some("allow".to_string()),
            route_decision_raw: None,
            decision: Some("manual".to_string()),
            needs_manual_review: Some(false),
            executable: Some(false),
            budget_block_reason: None,
            budget_enforcement_reason: None,
            budget_global_reason: None,
            summary_reason: Some("manual route".to_string()),
            route_reason: None,
            budget_blocked: Some(false),
            budget_global_blocked: Some(false),
            budget_enforcement_blocked: Some(false),
        });
        assert!(out.hold);
        assert_eq!(out.hold_scope, Some("proposal".to_string()));
        assert_eq!(out.hold_reason, Some("gate_manual".to_string()));
    }

    #[test]
    fn autoscale_json_route_execution_policy_hold_path_works() {
        let payload = serde_json::json!({
            "mode": "route_execution_policy_hold",
            "route_execution_policy_hold_input": {
                "target": "route",
                "gate_decision": "ALLOW",
                "decision": "ALLOW",
                "needs_manual_review": false,
                "executable": true,
                "budget_block_reason": "budget guard blocked",
                "budget_blocked": false,
                "budget_global_blocked": false,
                "budget_enforcement_blocked": false
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale route_execution_policy_hold");
        assert!(out.contains("\"mode\":\"route_execution_policy_hold\""));
    }

    #[test]
    fn policy_hold_pressure_classifies_hard_when_rate_crosses_threshold() {
        let out = compute_policy_hold_pressure(&PolicyHoldPressureInput {
            events: vec![
                PolicyHoldPressureEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("no_candidates_policy_daily_cap".to_string()),
                    policy_hold: Some(true),
                    ts_ms: Some(1_000_000.0),
                },
                PolicyHoldPressureEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_init_gate_budget_autopause".to_string()),
                    policy_hold: Some(true),
                    ts_ms: Some(1_100_000.0),
                },
                PolicyHoldPressureEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    policy_hold: Some(false),
                    ts_ms: Some(1_200_000.0),
                },
            ],
            window_hours: Some(24.0),
            min_samples: Some(2.0),
            now_ms: Some(1_500_000.0),
            warn_rate: Some(0.25),
            hard_rate: Some(0.4),
        });
        assert!(out.applicable);
        assert_eq!(out.samples, 3);
        assert_eq!(out.policy_holds, 2);
        assert_eq!(out.level, "hard");
        assert!(out.rate >= 0.66 && out.rate <= 0.667);
    }

    #[test]
    fn autoscale_json_policy_hold_pressure_path_works() {
        let payload = serde_json::json!({
            "mode": "policy_hold_pressure",
            "policy_hold_pressure_input": {
                "events": [
                    { "event_type": "autonomy_run", "result": "no_candidates_policy_daily_cap", "policy_hold": true, "ts_ms": 1100000.0 },
                    { "event_type": "autonomy_run", "result": "executed", "policy_hold": false, "ts_ms": 1200000.0 }
                ],
                "window_hours": 24,
                "min_samples": 1,
                "now_ms": 1500000,
                "warn_rate": 0.25,
                "hard_rate": 0.4
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale policy_hold_pressure");
        assert!(out.contains("\"mode\":\"policy_hold_pressure\""));
    }

    #[test]
    fn policy_hold_pattern_detects_repeat_reason() {
        let out = compute_policy_hold_pattern(&PolicyHoldPatternInput {
            events: vec![
                PolicyHoldPatternEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_init_gate_readiness".to_string()),
                    objective_id: Some("T1_alpha".to_string()),
                    hold_reason: Some("gate_manual".to_string()),
                    route_block_reason: None,
                    policy_hold: Some(true),
                    ts_ms: Some(1_100_000.0),
                },
                PolicyHoldPatternEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_init_gate_readiness".to_string()),
                    objective_id: Some("T1_alpha".to_string()),
                    hold_reason: Some("gate_manual".to_string()),
                    route_block_reason: None,
                    policy_hold: Some(true),
                    ts_ms: Some(1_200_000.0),
                },
                PolicyHoldPatternEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    objective_id: Some("T1_alpha".to_string()),
                    hold_reason: None,
                    route_block_reason: None,
                    policy_hold: Some(false),
                    ts_ms: Some(1_300_000.0),
                },
            ],
            objective_id: Some("T1_alpha".to_string()),
            window_hours: Some(24.0),
            repeat_threshold: Some(2.0),
            now_ms: Some(1_500_000.0),
        });
        assert_eq!(out.total_holds, 2);
        assert_eq!(out.top_reason, Some("gate_manual".to_string()));
        assert_eq!(out.top_count, 2);
        assert!(out.should_dampen);
    }

    #[test]
    fn autoscale_json_policy_hold_pattern_path_works() {
        let payload = serde_json::json!({
            "mode": "policy_hold_pattern",
            "policy_hold_pattern_input": {
                "events": [
                    {
                        "event_type": "autonomy_run",
                        "result": "stop_init_gate_readiness",
                        "objective_id": "T1_alpha",
                        "hold_reason": "gate_manual",
                        "policy_hold": true,
                        "ts_ms": 1200000.0
                    }
                ],
                "objective_id": "T1_alpha",
                "window_hours": 24,
                "repeat_threshold": 2,
                "now_ms": 1500000
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale policy_hold_pattern");
        assert!(out.contains("\"mode\":\"policy_hold_pattern\""));
    }

    #[test]
    fn policy_hold_latest_event_prefers_last_policy_hold_run() {
        let out = compute_policy_hold_latest_event(&PolicyHoldLatestEventInput {
            events: vec![
                PolicyHoldLatestEventEntryInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    policy_hold: Some(false),
                    ts_ms: Some(1_000_000.0),
                    ts: Some("2026-03-01T00:00:00.000Z".to_string()),
                    hold_reason: None,
                    route_block_reason: None,
                },
                PolicyHoldLatestEventEntryInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("stop_init_gate_readiness".to_string()),
                    policy_hold: Some(false),
                    ts_ms: Some(1_100_000.0),
                    ts: Some("2026-03-01T00:01:00.000Z".to_string()),
                    hold_reason: Some("gate_manual".to_string()),
                    route_block_reason: None,
                },
            ],
        });
        assert!(out.found);
        assert_eq!(out.result, Some("stop_init_gate_readiness".to_string()));
        assert_eq!(out.ts, Some("2026-03-01T00:01:00.000Z".to_string()));
        assert_eq!(out.hold_reason, Some("gate_manual".to_string()));
    }

    #[test]
    fn autoscale_json_policy_hold_latest_event_path_works() {
        let payload = serde_json::json!({
            "mode": "policy_hold_latest_event",
            "policy_hold_latest_event_input": {
                "events": [
                    { "event_type": "autonomy_run", "result": "executed", "policy_hold": false, "ts_ms": 1000000.0, "ts": "2026-03-01T00:00:00.000Z" },
                    { "event_type": "autonomy_run", "result": "stop_init_gate_budget_autopause", "policy_hold": false, "ts_ms": 1100000.0, "ts": "2026-03-01T00:01:00.000Z" }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale policy_hold_latest_event");
        assert!(out.contains("\"mode\":\"policy_hold_latest_event\""));
    }

    #[test]
    fn policy_hold_cooldown_escalates_for_cap_until_next_day() {
        let out = compute_policy_hold_cooldown(&PolicyHoldCooldownInput {
            base_minutes: Some(15.0),
            pressure_level: Some("warn".to_string()),
            pressure_applicable: Some(true),
            last_result: Some("no_candidates_policy_daily_cap".to_string()),
            now_ms: Some(1_700_000_000_000.0),
            cooldown_warn_minutes: Some(30.0),
            cooldown_hard_minutes: Some(60.0),
            cooldown_cap_minutes: Some(180.0),
            cooldown_manual_review_minutes: Some(90.0),
            cooldown_unchanged_state_minutes: Some(90.0),
            readiness_retry_minutes: Some(120.0),
            until_next_day_caps: Some(true),
        });
        assert!(out.cooldown_minutes >= 30);
    }

    #[test]
    fn autoscale_json_policy_hold_cooldown_path_works() {
        let payload = serde_json::json!({
            "mode": "policy_hold_cooldown",
            "policy_hold_cooldown_input": {
                "base_minutes": 15,
                "pressure_level": "hard",
                "pressure_applicable": true,
                "last_result": "stop_init_gate_readiness",
                "now_ms": 1700000000000i64,
                "cooldown_warn_minutes": 30,
                "cooldown_hard_minutes": 60,
                "cooldown_cap_minutes": 180,
                "cooldown_manual_review_minutes": 90,
                "cooldown_unchanged_state_minutes": 90,
                "readiness_retry_minutes": 120,
                "until_next_day_caps": true
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale policy_hold_cooldown");
        assert!(out.contains("\"mode\":\"policy_hold_cooldown\""));
    }

    #[test]
    fn receipt_verdict_reverts_when_exec_fails() {
        let out = compute_receipt_verdict(&ReceiptVerdictInput {
            decision: "ACTUATE".to_string(),
            exec_ok: false,
            postconditions_ok: true,
            dod_passed: true,
            success_criteria_required: true,
            success_criteria_passed: true,
            queue_outcome_logged: true,
            route_attestation_status: "ok".to_string(),
            route_attestation_expected_model: "gpt-5".to_string(),
            success_criteria_primary_failure: None,
        });
        assert_eq!(out.exec_check_name, "actuation_execute_ok");
        assert_eq!(out.outcome, "reverted");
        assert!(!out.passed);
        assert!(out.failed.iter().any(|f| f == "actuation_execute_ok"));
    }

    #[test]
    fn receipt_verdict_uses_criteria_primary_failure_when_present() {
        let out = compute_receipt_verdict(&ReceiptVerdictInput {
            decision: "ROUTE".to_string(),
            exec_ok: true,
            postconditions_ok: true,
            dod_passed: true,
            success_criteria_required: true,
            success_criteria_passed: false,
            queue_outcome_logged: true,
            route_attestation_status: "ok".to_string(),
            route_attestation_expected_model: "gpt-5".to_string(),
            success_criteria_primary_failure: Some("insufficient_supported_metrics".to_string()),
        });
        assert_eq!(out.outcome, "no_change");
        assert_eq!(
            out.primary_failure,
            Some("insufficient_supported_metrics".to_string())
        );
    }
}
