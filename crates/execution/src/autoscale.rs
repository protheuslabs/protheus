use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
pub struct ExecWindowMatchInput {
    #[serde(default)]
    pub ts_ms: Option<f64>,
    #[serde(default)]
    pub start_ms: Option<f64>,
    #[serde(default)]
    pub end_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecWindowMatchOutput {
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
pub struct ProposalSemanticFingerprintInput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub source_eye: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub text_blob: Option<String>,
    #[serde(default)]
    pub stopwords: Vec<String>,
    #[serde(default)]
    pub min_tokens: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalSemanticFingerprintOutput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    pub proposal_type: String,
    #[serde(default)]
    pub source_eye: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub token_stems: Vec<String>,
    pub token_count: u32,
    pub eligible: bool,
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
pub struct NormalizeValueCurrencyTokenInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub allowed_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeValueCurrencyTokenOutput {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListValueCurrenciesInput {
    #[serde(default)]
    pub value_list: Vec<String>,
    #[serde(default)]
    pub value_csv: Option<String>,
    #[serde(default)]
    pub allowed_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListValueCurrenciesOutput {
    #[serde(default)]
    pub currencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InferValueCurrenciesFromDirectiveBitsInput {
    #[serde(default)]
    pub bits: Vec<String>,
    #[serde(default)]
    pub allowed_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InferValueCurrenciesFromDirectiveBitsOutput {
    #[serde(default)]
    pub currencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HasLinkedObjectiveEntryInput {
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub directive_objective_id: Option<String>,
    #[serde(default)]
    pub directive: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HasLinkedObjectiveEntryOutput {
    pub linked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifiedEntryOutcomeInput {
    #[serde(default)]
    pub outcome_verified: bool,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifiedEntryOutcomeOutput {
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifiedRevenueActionInput {
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub outcome_verified: bool,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifiedRevenueActionOutput {
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinutesUntilNextUtcDayInput {
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinutesUntilNextUtcDayOutput {
    pub minutes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgeHoursInput {
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgeHoursOutput {
    pub age_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UrlDomainInput {
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UrlDomainOutput {
    pub domain: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DomainAllowedInput {
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub allowlist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DomainAllowedOutput {
    pub allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsExecuteModeInput {
    #[serde(default)]
    pub execution_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsExecuteModeOutput {
    pub execute_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionAllowedByFeatureFlagInput {
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub shadow_only: bool,
    #[serde(default)]
    pub autonomy_enabled: bool,
    #[serde(default)]
    pub canary_allow_with_flag_off: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionAllowedByFeatureFlagOutput {
    pub allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsTier1ObjectiveIdInput {
    #[serde(default)]
    pub objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsTier1ObjectiveIdOutput {
    pub tier1: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsTier1CandidateObjectiveInput {
    #[serde(default)]
    pub objective_binding_objective_id: Option<String>,
    #[serde(default)]
    pub directive_pulse_tier: Option<f64>,
    #[serde(default)]
    pub directive_pulse_objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsTier1CandidateObjectiveOutput {
    pub tier1: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NeedsExecutionQuotaInput {
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub shadow_only: bool,
    #[serde(default)]
    pub executed_today: f64,
    #[serde(default)]
    pub min_daily_executions: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NeedsExecutionQuotaOutput {
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeCriteriaMetricInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeCriteriaMetricOutput {
    pub metric: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EscapeRegExpInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EscapeRegExpOutput {
    pub escaped: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolTokenMentionedInput {
    #[serde(default)]
    pub blob: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolTokenMentionedOutput {
    pub mentioned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldReasonFromEventInput {
    #[serde(default)]
    pub hold_reason: Option<String>,
    #[serde(default)]
    pub route_block_reason: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldReasonFromEventOutput {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyMarkerTokensInput {
    #[serde(default)]
    pub objective_primary: Option<String>,
    #[serde(default)]
    pub objective_fitness_metric: Option<String>,
    #[serde(default)]
    pub objective_secondary: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyMarkerTokensOutput {
    #[serde(default)]
    pub tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityCooldownKeyInput {
    #[serde(default)]
    pub capability_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityCooldownKeyOutput {
    pub cooldown_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadinessRetryCooldownKeyInput {
    #[serde(default)]
    pub strategy_id: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadinessRetryCooldownKeyOutput {
    pub cooldown_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceEyeIdInput {
    #[serde(default)]
    pub eye_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceEyeIdOutput {
    pub eye_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeprioritizedSourceProposalInput {
    #[serde(default)]
    pub eye_id: Option<String>,
    #[serde(default)]
    pub deprioritized_eye_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeprioritizedSourceProposalOutput {
    pub deprioritized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositeEligibilityMinInput {
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub base_min: f64,
    #[serde(default)]
    pub canary_low_risk_relax: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositeEligibilityMinOutput {
    pub min_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClampThresholdInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClampThresholdOutput {
    pub threshold: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppliedThresholdsInput {
    #[serde(default)]
    pub base: std::collections::BTreeMap<String, f64>,
    #[serde(default)]
    pub deltas: std::collections::BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppliedThresholdsOutput {
    #[serde(default)]
    pub thresholds: std::collections::BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractEyeFromEvidenceRefInput {
    #[serde(default)]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractEyeFromEvidenceRefOutput {
    #[serde(default)]
    pub eye_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TotalOutcomesInput {
    #[serde(default)]
    pub shipped: f64,
    #[serde(default)]
    pub no_change: f64,
    #[serde(default)]
    pub reverted: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TotalOutcomesOutput {
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeriveEntityBiasInput {
    #[serde(default)]
    pub shipped: f64,
    #[serde(default)]
    pub no_change: f64,
    #[serde(default)]
    pub reverted: f64,
    #[serde(default)]
    pub min_total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeriveEntityBiasOutput {
    pub bias: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BuildOverlayEventInput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default, rename = "type")]
    pub event_type: Option<String>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub evidence_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BuildOverlayInput {
    #[serde(default)]
    pub events: Vec<BuildOverlayEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BuildOverlayOutcomeCountsOutput {
    pub shipped: u32,
    pub reverted: u32,
    pub no_change: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BuildOverlayEntryOutput {
    pub proposal_id: String,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub decision_ts: Option<String>,
    #[serde(default)]
    pub decision_reason: Option<String>,
    #[serde(default)]
    pub last_outcome: Option<String>,
    #[serde(default)]
    pub last_outcome_ts: Option<String>,
    #[serde(default)]
    pub last_evidence_ref: Option<String>,
    pub outcomes: BuildOverlayOutcomeCountsOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BuildOverlayOutput {
    #[serde(default)]
    pub entries: Vec<BuildOverlayEntryOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HasAdaptiveMutationSignalInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub adaptive_mutation: bool,
    #[serde(default)]
    pub mutation_proposal: bool,
    #[serde(default)]
    pub topology_mutation: bool,
    #[serde(default)]
    pub self_improvement_change: bool,
    #[serde(default)]
    pub signal_blob: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HasAdaptiveMutationSignalOutput {
    pub has_signal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdaptiveMutationExecutionGuardInput {
    #[serde(default)]
    pub guard_required: bool,
    #[serde(default)]
    pub applies: bool,
    #[serde(default)]
    pub metadata_applies: bool,
    #[serde(default)]
    pub guard_pass: bool,
    #[serde(default)]
    pub guard_reason: Option<String>,
    #[serde(default)]
    pub safety_attestation: Option<String>,
    #[serde(default)]
    pub rollback_receipt: Option<String>,
    #[serde(default)]
    pub guard_receipt_id: Option<String>,
    #[serde(default)]
    pub mutation_kernel_applies: bool,
    #[serde(default)]
    pub mutation_kernel_pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdaptiveMutationExecutionGuardControlsOutput {
    #[serde(default)]
    pub safety_attestation: Option<String>,
    #[serde(default)]
    pub rollback_receipt: Option<String>,
    #[serde(default)]
    pub guard_receipt_id: Option<String>,
    pub mutation_kernel_applies: bool,
    pub mutation_kernel_pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdaptiveMutationExecutionGuardOutput {
    pub required: bool,
    pub applies: bool,
    pub pass: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub controls: AdaptiveMutationExecutionGuardControlsOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategySelectionVariantInput {
    #[serde(default)]
    pub strategy_id: Option<String>,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategySelectionInput {
    #[serde(default)]
    pub date_str: Option<String>,
    #[serde(default)]
    pub attempt_index: f64,
    #[serde(default)]
    pub canary_enabled: bool,
    #[serde(default)]
    pub canary_allow_execute: bool,
    #[serde(default)]
    pub canary_fraction: f64,
    #[serde(default)]
    pub max_active: f64,
    #[serde(default)]
    pub fallback_strategy_id: Option<String>,
    #[serde(default)]
    pub variants: Vec<StrategySelectionVariantInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategySelectionRankedOutput {
    pub strategy_id: String,
    pub score: f64,
    pub confidence: f64,
    #[serde(default)]
    pub stage: Option<String>,
    pub execution_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategySelectionOutput {
    #[serde(default)]
    pub selected_strategy_id: Option<String>,
    pub mode: String,
    pub canary_enabled: bool,
    pub canary_due: bool,
    #[serde(default)]
    pub canary_every: Option<u32>,
    pub attempt_index: u32,
    pub active_count: u32,
    #[serde(default)]
    pub ranked: Vec<StrategySelectionRankedOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalibrationDeltasInput {
    #[serde(default)]
    pub executed_count: f64,
    #[serde(default)]
    pub shipped_rate: f64,
    #[serde(default)]
    pub no_change_rate: f64,
    #[serde(default)]
    pub reverted_rate: f64,
    #[serde(default)]
    pub exhausted: f64,
    #[serde(default)]
    pub min_executed: f64,
    #[serde(default)]
    pub tighten_min_executed: f64,
    #[serde(default)]
    pub loosen_low_shipped_rate: f64,
    #[serde(default)]
    pub loosen_exhausted_threshold: f64,
    #[serde(default)]
    pub tighten_min_shipped_rate: f64,
    #[serde(default)]
    pub max_delta: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalibrationDeltasOutput {
    pub min_signal_quality: f64,
    pub min_sensory_signal_score: f64,
    pub min_sensory_relevance_score: f64,
    pub min_directive_fit: f64,
    pub min_actionability_score: f64,
    pub min_eye_score_ema: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyAdmissionMutationGuardInput {
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub applies: bool,
    #[serde(default)]
    pub pass: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub controls: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyAdmissionDecisionInput {
    #[serde(default)]
    pub require_admission_preview: bool,
    #[serde(default)]
    pub preview_eligible: bool,
    #[serde(default)]
    pub preview_blocked_by: Vec<String>,
    #[serde(default)]
    pub mutation_guard: Option<StrategyAdmissionMutationGuardInput>,
    #[serde(default)]
    pub strategy_type_allowed: bool,
    #[serde(default)]
    pub max_risk_per_action: Option<f64>,
    #[serde(default)]
    pub strategy_max_risk_per_action: Option<f64>,
    #[serde(default)]
    pub hard_max_risk_per_action: Option<f64>,
    #[serde(default)]
    pub risk_score: Option<f64>,
    #[serde(default)]
    pub remediation_check_required: bool,
    #[serde(default)]
    pub remediation_depth: Option<f64>,
    #[serde(default)]
    pub remediation_max_depth: Option<f64>,
    #[serde(default)]
    pub dedup_key: Option<String>,
    #[serde(default)]
    pub duplicate_window_hours: Option<f64>,
    #[serde(default)]
    pub recent_count: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyAdmissionPreviewOutput {
    pub eligible: bool,
    #[serde(default)]
    pub blocked_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyAdmissionDecisionOutput {
    pub allow: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub admission_preview: Option<StrategyAdmissionPreviewOutput>,
    #[serde(default)]
    pub mutation_guard: Option<StrategyAdmissionMutationGuardInput>,
    #[serde(default)]
    pub risk_score: Option<f64>,
    #[serde(default)]
    pub max_risk_per_action: Option<f64>,
    #[serde(default)]
    pub strategy_max_risk_per_action: Option<f64>,
    #[serde(default)]
    pub hard_max_risk_per_action: Option<f64>,
    #[serde(default)]
    pub duplicate_window_hours: Option<f64>,
    #[serde(default)]
    pub recent_count: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExpectedValueScoreInput {
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExpectedValueScoreOutput {
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuggestRunBatchMaxInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub batch_max: f64,
    #[serde(default)]
    pub batch_reason: Option<String>,
    #[serde(default)]
    pub daily_remaining: f64,
    #[serde(default)]
    pub autoscale_hint: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuggestRunBatchMaxOutput {
    pub enabled: bool,
    pub max: f64,
    pub reason: String,
    pub daily_remaining: f64,
    pub autoscale_hint: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BacklogAutoscaleSnapshotInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub module: Option<String>,
    #[serde(default)]
    pub state: serde_json::Value,
    #[serde(default)]
    pub queue: serde_json::Value,
    #[serde(default)]
    pub current_cells: f64,
    #[serde(default)]
    pub plan: serde_json::Value,
    #[serde(default)]
    pub trit_productivity: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BacklogAutoscaleSnapshotOutput {
    pub enabled: bool,
    pub module: String,
    pub state: serde_json::Value,
    pub queue: serde_json::Value,
    pub current_cells: f64,
    pub plan: serde_json::Value,
    pub trit_productivity: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdmissionSummaryProposalInput {
    #[serde(default)]
    pub preview_eligible: Option<bool>,
    #[serde(default)]
    pub blocked_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdmissionSummaryInput {
    #[serde(default)]
    pub proposals: Vec<AdmissionSummaryProposalInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdmissionSummaryOutput {
    pub total: u32,
    pub eligible: u32,
    pub blocked: u32,
    pub blocked_by_reason: std::collections::BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnknownTypeQuarantineDecisionInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub type_in_quarantine_set: bool,
    #[serde(default)]
    pub allow_directive: bool,
    #[serde(default)]
    pub allow_tier1: bool,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub tier1_objective: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnknownTypeQuarantineDecisionOutput {
    pub block: bool,
    pub proposal_type: Option<String>,
    pub reason: Option<String>,
    pub objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InferOptimizationDeltaInput {
    #[serde(default)]
    pub optimization_delta_percent: Option<f64>,
    #[serde(default)]
    pub expected_optimization_percent: Option<f64>,
    #[serde(default)]
    pub expected_delta_percent: Option<f64>,
    #[serde(default)]
    pub estimated_improvement_percent: Option<f64>,
    #[serde(default)]
    pub target_improvement_percent: Option<f64>,
    #[serde(default)]
    pub performance_gain_percent: Option<f64>,
    #[serde(default)]
    pub text_blob: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InferOptimizationDeltaOutput {
    pub delta_percent: Option<f64>,
    pub delta_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OptimizationIntentProposalInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub blob: Option<String>,
    #[serde(default)]
    pub has_actuation_meta: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OptimizationIntentProposalOutput {
    pub intent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnlinkedOptimizationAdmissionInput {
    #[serde(default)]
    pub optimization_intent: bool,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub exempt_types: Vec<String>,
    #[serde(default)]
    pub linked: bool,
    #[serde(default)]
    pub normalized_risk: Option<String>,
    #[serde(default)]
    pub hard_block_high_risk: bool,
    #[serde(default)]
    pub penalty: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnlinkedOptimizationAdmissionOutput {
    pub applies: bool,
    pub linked: bool,
    pub penalty: f64,
    pub block: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OptimizationGoodEnoughInput {
    #[serde(default)]
    pub applies: bool,
    #[serde(default)]
    pub min_delta_percent: f64,
    #[serde(default)]
    pub require_delta: bool,
    #[serde(default)]
    pub high_accuracy_mode: bool,
    #[serde(default)]
    pub normalized_risk: Option<String>,
    #[serde(default)]
    pub delta_percent: Option<f64>,
    #[serde(default)]
    pub delta_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OptimizationGoodEnoughOutput {
    pub applies: bool,
    pub pass: bool,
    pub reason: Option<String>,
    pub delta_percent: Option<f64>,
    pub delta_source: Option<String>,
    pub min_delta_percent: f64,
    pub require_delta: bool,
    pub mode: String,
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDependencySummaryInput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub parent_objective_id: Option<String>,
    #[serde(default)]
    pub created_ids: Vec<String>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub created_count: Option<f64>,
    #[serde(default)]
    pub quality_ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDependencySummaryNode {
    pub id: String,
    pub kind: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDependencySummaryEdge {
    pub from: String,
    pub to: String,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDependencySummaryOutput {
    pub proposal_id: Option<String>,
    pub decision: String,
    pub source: Option<String>,
    pub parent_objective_id: Option<String>,
    pub child_objective_ids: Vec<String>,
    pub edge_count: u32,
    pub nodes: Vec<ProposalDependencySummaryNode>,
    pub edges: Vec<ProposalDependencySummaryEdge>,
    pub chain: Vec<String>,
    pub dry_run: bool,
    pub created_count: f64,
    pub quality_ok: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChooseSelectionModeInput {
    pub eligible_len: u32,
    pub executed_count: u32,
    pub explore_used: u32,
    pub exploit_used: u32,
    pub explore_quota: u32,
    pub every_n: u32,
    pub min_eligible: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChooseSelectionModeOutput {
    pub mode: String,
    pub index: u32,
    pub explore_used: u32,
    pub explore_quota: u32,
    pub exploit_used: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExploreQuotaForDayInput {
    #[serde(default)]
    pub daily_runs_cap: Option<f64>,
    #[serde(default)]
    pub explore_fraction: Option<f64>,
    #[serde(default)]
    pub default_max_runs: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExploreQuotaForDayOutput {
    pub quota: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediumRiskThresholdsInput {
    #[serde(default)]
    pub base_min_directive_fit: f64,
    #[serde(default)]
    pub base_min_actionability_score: f64,
    #[serde(default)]
    pub medium_risk_min_composite_eligibility: f64,
    #[serde(default)]
    pub min_composite_eligibility: f64,
    #[serde(default)]
    pub medium_risk_min_directive_fit: f64,
    #[serde(default)]
    pub default_min_directive_fit: f64,
    #[serde(default)]
    pub medium_risk_min_actionability: f64,
    #[serde(default)]
    pub default_min_actionability: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediumRiskThresholdsOutput {
    pub composite_min: f64,
    pub directive_fit_min: f64,
    pub actionability_min: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediumRiskGateDecisionInput {
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub composite_score: f64,
    #[serde(default)]
    pub directive_fit_score: f64,
    #[serde(default)]
    pub actionability_score: f64,
    #[serde(default)]
    pub composite_min: f64,
    #[serde(default)]
    pub directive_fit_min: f64,
    #[serde(default)]
    pub actionability_min: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediumRiskGateDecisionOutput {
    pub pass: bool,
    pub risk: String,
    pub reasons: Vec<String>,
    pub required: Option<MediumRiskThresholdsOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteBlockPrefilterInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub window_hours: f64,
    #[serde(default)]
    pub min_observations: f64,
    #[serde(default)]
    pub max_block_rate: f64,
    #[serde(default)]
    pub row_present: bool,
    #[serde(default)]
    pub attempts: f64,
    #[serde(default)]
    pub route_blocked: f64,
    #[serde(default)]
    pub route_block_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteBlockPrefilterOutput {
    pub enabled: bool,
    pub applicable: bool,
    pub pass: bool,
    pub reason: String,
    pub capability_key: Option<String>,
    pub window_hours: f64,
    pub min_observations: f64,
    pub max_block_rate: f64,
    pub attempts: f64,
    pub route_blocked: f64,
    pub route_block_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteExecutionSampleEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub execution_target: Option<String>,
    #[serde(default)]
    pub route_summary_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteExecutionSampleEventOutput {
    pub is_sample_event: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteBlockTelemetryEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub execution_target: Option<String>,
    #[serde(default)]
    pub route_summary_present: bool,
    #[serde(default)]
    pub capability_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteBlockTelemetrySummaryInput {
    #[serde(default)]
    pub events: Vec<RouteBlockTelemetryEventInput>,
    #[serde(default)]
    pub window_hours: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteBlockTelemetryCapabilityOutput {
    pub key: String,
    pub attempts: f64,
    pub route_blocked: f64,
    pub route_block_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouteBlockTelemetrySummaryOutput {
    pub window_hours: f64,
    pub sample_events: f64,
    pub by_capability: Vec<RouteBlockTelemetryCapabilityOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsStubProposalInput {
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsStubProposalOutput {
    pub is_stub: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentAutonomyRunEventsInput {
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
    #[serde(default)]
    pub cutoff_ms: f64,
    #[serde(default)]
    pub cap: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentAutonomyRunEventsOutput {
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalMetaIndexEntryInput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub eye_id: Option<String>,
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalMetaIndexInput {
    #[serde(default)]
    pub entries: Vec<ProposalMetaIndexEntryInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalMetaIndexEntryOutput {
    pub proposal_id: String,
    pub eye_id: String,
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalMetaIndexOutput {
    #[serde(default)]
    pub entries: Vec<ProposalMetaIndexEntryOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewLogEventsInput {
    #[serde(default)]
    pub before_run_len: Option<f64>,
    #[serde(default)]
    pub before_error_len: Option<f64>,
    #[serde(default)]
    pub after_runs: Vec<serde_json::Value>,
    #[serde(default)]
    pub after_errors: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewLogEventsOutput {
    #[serde(default)]
    pub runs: Vec<serde_json::Value>,
    #[serde(default)]
    pub errors: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutcomeBucketsInput {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutcomeBucketsOutput {
    pub shipped: f64,
    pub no_change: f64,
    pub reverted: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentRunEventsInput {
    #[serde(default)]
    pub day_events: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentRunEventsOutput {
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AllDecisionEventsInput {
    #[serde(default)]
    pub day_events: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AllDecisionEventsOutput {
    #[serde(default)]
    pub events: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CooldownActiveStateInput {
    #[serde(default)]
    pub until_ms: Option<f64>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CooldownActiveStateOutput {
    pub active: bool,
    pub expired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BumpCountInput {
    #[serde(default)]
    pub current_count: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BumpCountOutput {
    pub count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LockAgeMinutesInput {
    #[serde(default)]
    pub lock_ts: Option<String>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LockAgeMinutesOutput {
    #[serde(default)]
    pub age_minutes: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HashObjInput {
    #[serde(default)]
    pub json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HashObjOutput {
    #[serde(default)]
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssessSuccessCriteriaQualityCheckInput {
    #[serde(default)]
    pub evaluated: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssessSuccessCriteriaQualityInput {
    #[serde(default)]
    pub checks: Vec<AssessSuccessCriteriaQualityCheckInput>,
    #[serde(default)]
    pub total_count: f64,
    #[serde(default)]
    pub unknown_count: f64,
    #[serde(default)]
    pub synthesized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssessSuccessCriteriaQualityOutput {
    pub insufficient: bool,
    pub reasons: Vec<String>,
    pub total_count: f64,
    pub unknown_count_raw: f64,
    pub unknown_exempt_count: f64,
    pub unknown_count: f64,
    pub unknown_rate: f64,
    pub unsupported_count: f64,
    pub unsupported_rate: f64,
    pub synthesized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManualGatePrefilterInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub window_hours: f64,
    #[serde(default)]
    pub min_observations: f64,
    #[serde(default)]
    pub max_manual_block_rate: f64,
    #[serde(default)]
    pub row_present: bool,
    #[serde(default)]
    pub attempts: f64,
    #[serde(default)]
    pub manual_blocked: f64,
    #[serde(default)]
    pub manual_block_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManualGatePrefilterOutput {
    pub enabled: bool,
    pub applicable: bool,
    pub pass: bool,
    pub reason: String,
    pub capability_key: Option<String>,
    pub window_hours: f64,
    pub min_observations: f64,
    pub max_manual_block_rate: f64,
    pub attempts: f64,
    pub manual_blocked: f64,
    pub manual_block_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceCooldownActiveInput {
    #[serde(default)]
    pub cooldown_key: Option<String>,
    #[serde(default)]
    pub cooldown_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceCooldownActiveOutput {
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopBiasSummaryEntryInput {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub bias: f64,
    #[serde(default)]
    pub total: f64,
    #[serde(default)]
    pub shipped: f64,
    #[serde(default)]
    pub no_change: f64,
    #[serde(default)]
    pub reverted: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopBiasesSummaryInput {
    #[serde(default)]
    pub entries: Vec<TopBiasSummaryEntryInput>,
    #[serde(default)]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopBiasSummaryEntryOutput {
    pub key: String,
    pub bias: f64,
    pub total: f64,
    pub shipped: f64,
    pub no_change: f64,
    pub reverted: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TopBiasesSummaryOutput {
    pub rows: Vec<TopBiasSummaryEntryOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaPatternPenaltyPatternInput {
    pub key: String,
    #[serde(default)]
    pub failures: f64,
    #[serde(default)]
    pub passes: f64,
    #[serde(default)]
    pub last_failure_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaPatternPenaltyInput {
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub patterns: Vec<CriteriaPatternPenaltyPatternInput>,
    #[serde(default)]
    pub fail_threshold: f64,
    #[serde(default)]
    pub penalty_per_hit: f64,
    #[serde(default)]
    pub max_penalty: f64,
    #[serde(default)]
    pub window_days: f64,
    #[serde(default)]
    pub now_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaPatternPenaltyHitOutput {
    pub key: String,
    pub failures: f64,
    pub passes: f64,
    pub effective_failures: f64,
    pub penalty: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaPatternPenaltyOutput {
    pub penalty: f64,
    pub hit_patterns: Vec<CriteriaPatternPenaltyHitOutput>,
    pub threshold: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyThresholdOverridesInput {
    #[serde(default)]
    pub min_signal_quality: Option<f64>,
    #[serde(default)]
    pub min_sensory_signal_score: Option<f64>,
    #[serde(default)]
    pub min_sensory_relevance_score: Option<f64>,
    #[serde(default)]
    pub min_directive_fit: Option<f64>,
    #[serde(default)]
    pub min_actionability_score: Option<f64>,
    #[serde(default)]
    pub min_eye_score_ema: Option<f64>,
    #[serde(default)]
    pub override_min_signal_quality: Option<f64>,
    #[serde(default)]
    pub override_min_sensory_signal_score: Option<f64>,
    #[serde(default)]
    pub override_min_sensory_relevance_score: Option<f64>,
    #[serde(default)]
    pub override_min_directive_fit: Option<f64>,
    #[serde(default)]
    pub override_min_actionability_score: Option<f64>,
    #[serde(default)]
    pub override_min_eye_score_ema: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyThresholdOverridesOutput {
    pub min_signal_quality: f64,
    pub min_sensory_signal_score: f64,
    pub min_sensory_relevance_score: f64,
    pub min_directive_fit: f64,
    pub min_actionability_score: f64,
    pub min_eye_score_ema: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EffectiveAllowedRisksInput {
    #[serde(default)]
    pub default_risks: Vec<String>,
    #[serde(default)]
    pub strategy_allowed_risks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EffectiveAllowedRisksOutput {
    pub risks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseContextObjectiveStatInput {
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub tier: Option<f64>,
    #[serde(default)]
    pub attempts: Option<f64>,
    #[serde(default)]
    pub shipped: Option<f64>,
    #[serde(default)]
    pub no_change: Option<f64>,
    #[serde(default)]
    pub reverted: Option<f64>,
    #[serde(default)]
    pub no_progress_streak: Option<f64>,
    #[serde(default)]
    pub last_attempt_ts: Option<String>,
    #[serde(default)]
    pub last_shipped_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseContextInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub objectives: Vec<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub window_days: f64,
    #[serde(default)]
    pub urgency_hours: f64,
    #[serde(default)]
    pub no_progress_limit: f64,
    #[serde(default)]
    pub cooldown_hours: f64,
    #[serde(default)]
    pub tier_attempts_today: std::collections::BTreeMap<String, f64>,
    #[serde(default)]
    pub attempts_today: f64,
    #[serde(default)]
    pub objective_stats: Vec<DirectivePulseContextObjectiveStatInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseContextObjectiveStatOutput {
    pub objective_id: String,
    pub tier: u32,
    pub attempts: u32,
    pub shipped: u32,
    pub no_change: u32,
    pub reverted: u32,
    pub no_progress_streak: u32,
    #[serde(default)]
    pub last_attempt_ts: Option<String>,
    #[serde(default)]
    pub last_shipped_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseContextOutput {
    pub enabled: bool,
    pub available: bool,
    pub objectives: Vec<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
    pub window_days: f64,
    pub urgency_hours: f64,
    pub no_progress_limit: f64,
    pub cooldown_hours: f64,
    pub tier_attempts_today: std::collections::BTreeMap<String, f64>,
    pub attempts_today: f64,
    pub objective_stats: Vec<DirectivePulseContextObjectiveStatOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseStatsEventInput {
    #[serde(default)]
    pub day: Option<String>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub tier: Option<f64>,
    #[serde(default)]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseStatsInput {
    #[serde(default)]
    pub date_str: Option<String>,
    #[serde(default)]
    pub window_days: Option<f64>,
    #[serde(default)]
    pub events: Vec<DirectivePulseStatsEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseStatsOutput {
    pub tier_attempts_today: std::collections::BTreeMap<String, f64>,
    pub attempts_today: f64,
    pub objective_stats: Vec<DirectivePulseContextObjectiveStatOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompileDirectivePulseObjectivesInput {
    #[serde(default)]
    pub directives: Vec<serde_json::Value>,
    #[serde(default)]
    pub stopwords: Vec<String>,
    #[serde(default)]
    pub allowed_value_keys: Vec<String>,
    #[serde(default)]
    pub t1_min_share: Option<f64>,
    #[serde(default)]
    pub t2_min_share: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompileDirectivePulseObjectiveOutput {
    pub id: String,
    pub tier: u32,
    pub title: String,
    pub tier_weight: f64,
    pub min_share: f64,
    #[serde(default)]
    pub phrases: Vec<String>,
    #[serde(default)]
    pub tokens: Vec<String>,
    #[serde(default)]
    pub value_currencies: Vec<String>,
    #[serde(default)]
    pub primary_currency: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompileDirectivePulseObjectivesOutput {
    #[serde(default)]
    pub objectives: Vec<CompileDirectivePulseObjectiveOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseObjectivesProfileInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub load_error: Option<String>,
    #[serde(default)]
    pub objectives: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectivePulseObjectivesProfileOutput {
    pub enabled: bool,
    pub available: bool,
    #[serde(default)]
    pub objectives: Vec<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentDirectivePulseCooldownEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub sample_objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentDirectivePulseCooldownCountInput {
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub hours: Option<f64>,
    #[serde(default)]
    pub now_ms: Option<f64>,
    #[serde(default)]
    pub events: Vec<RecentDirectivePulseCooldownEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentDirectivePulseCooldownCountOutput {
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDirectiveTextInput {
    #[serde(default)]
    pub proposal: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalDirectiveTextOutput {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectiveIdsFromPulseContextInput {
    #[serde(default)]
    pub objectives: Vec<serde_json::Value>,
    #[serde(default)]
    pub fallback_enabled: bool,
    #[serde(default)]
    pub fallback_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectiveIdsFromPulseContextOutput {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldObjectiveContextInput {
    #[serde(default)]
    pub candidate_objective_ids: Vec<String>,
    #[serde(default)]
    pub pool_objective_ids: Vec<String>,
    #[serde(default)]
    pub dominant_objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyHoldObjectiveContextOutput {
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub objective_source: Option<String>,
    #[serde(default)]
    pub objective_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalSemanticObjectiveIdInput {
    #[serde(default)]
    pub proposal: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProposalSemanticObjectiveIdOutput {
    pub objective_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaPatternKeysRowInput {
    #[serde(default)]
    pub metric: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaPatternKeysInput {
    #[serde(default)]
    pub capability_key_hint: Option<String>,
    #[serde(default)]
    pub capability_descriptor_key: Option<String>,
    #[serde(default)]
    pub rows: Vec<CriteriaPatternKeysRowInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriteriaPatternKeysOutput {
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuccessCriteriaRequirementInput {
    #[serde(default)]
    pub require_success_criteria: Option<bool>,
    #[serde(default)]
    pub min_success_criteria_count: Option<f64>,
    #[serde(default)]
    pub policy_exempt_types: Vec<String>,
    #[serde(default)]
    pub env_exempt_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuccessCriteriaRequirementOutput {
    pub required: bool,
    pub min_count: f64,
    pub exempt_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuccessCriteriaPolicyForProposalInput {
    #[serde(default)]
    pub base_required: bool,
    #[serde(default)]
    pub base_min_count: f64,
    #[serde(default)]
    pub base_exempt_types: Vec<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuccessCriteriaPolicyForProposalOutput {
    pub required: bool,
    pub min_count: f64,
    pub exempt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityDescriptorInput {
    #[serde(default)]
    pub actuation_kind: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityDescriptorOutput {
    pub key: String,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeTokenUsageShapeInput {
    #[serde(default)]
    pub prompt_tokens: Option<f64>,
    #[serde(default)]
    pub input_tokens: Option<f64>,
    #[serde(default)]
    pub completion_tokens: Option<f64>,
    #[serde(default)]
    pub output_tokens: Option<f64>,
    #[serde(default)]
    pub total_tokens: Option<f64>,
    #[serde(default)]
    pub tokens_used: Option<f64>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeTokenUsageShapeValueOutput {
    #[serde(default)]
    pub prompt_tokens: Option<f64>,
    #[serde(default)]
    pub completion_tokens: Option<f64>,
    #[serde(default)]
    pub total_tokens: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeTokenUsageShapeOutput {
    pub has_value: bool,
    #[serde(default)]
    pub usage: Option<NormalizeTokenUsageShapeValueOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsDirectiveClarificationProposalInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsDirectiveClarificationProposalOutput {
    pub is_clarification: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsDirectiveDecompositionProposalInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IsDirectiveDecompositionProposalOutput {
    pub is_decomposition: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SanitizeDirectiveObjectiveIdInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SanitizeDirectiveObjectiveIdOutput {
    pub objective_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SanitizedDirectiveIdListInput {
    #[serde(default)]
    pub rows: Vec<String>,
    #[serde(default)]
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SanitizedDirectiveIdListOutput {
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseFirstJsonLineInput {
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseFirstJsonLineOutput {
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseJsonObjectsFromTextInput {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub max_objects: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseJsonObjectsFromTextOutput {
    #[serde(default)]
    pub objects: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadPathValueInput {
    #[serde(default)]
    pub obj: Option<serde_json::Value>,
    #[serde(default)]
    pub path_expr: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadPathValueOutput {
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NumberOrNullInput {
    #[serde(default)]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NumberOrNullOutput {
    #[serde(default)]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChooseEvidenceSelectionModeRunInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChooseEvidenceSelectionModeInput {
    #[serde(default)]
    pub eligible_len: Option<f64>,
    #[serde(default)]
    pub prior_runs: Vec<ChooseEvidenceSelectionModeRunInput>,
    #[serde(default)]
    pub evidence_sample_window: Option<f64>,
    #[serde(default)]
    pub mode_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChooseEvidenceSelectionModeOutput {
    pub mode: String,
    pub index: u32,
    pub sample_window: u32,
    pub sample_cursor: u32,
    pub prior_evidence_attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TruthyFlagInput {
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TruthyFlagOutput {
    pub value: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StableSelectionIndexInput {
    #[serde(default)]
    pub seed: Option<String>,
    #[serde(default)]
    pub size: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StableSelectionIndexOutput {
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AsStringArrayInput {
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AsStringArrayOutput {
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UniqSortedInput {
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UniqSortedOutput {
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeModelIdsInput {
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeModelIdsOutput {
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectedModelFromRunEventInput {
    #[serde(default)]
    pub route_summary: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectedModelFromRunEventOutput {
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadFirstNumericMetricInput {
    #[serde(default)]
    pub sources: Vec<serde_json::Value>,
    #[serde(default)]
    pub path_exprs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadFirstNumericMetricOutput {
    #[serde(default)]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseArgInput {
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseArgOutput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DateArgOrTodayInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub today: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DateArgOrTodayOutput {
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HasEnvNumericOverrideInput {
    pub present: bool,
    #[serde(default)]
    pub raw_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HasEnvNumericOverrideOutput {
    pub has_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CoalesceNumericInput {
    #[serde(default)]
    pub primary: Option<f64>,
    #[serde(default)]
    pub fallback: Option<f64>,
    #[serde(default)]
    pub null_fallback: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CoalesceNumericOutput {
    #[serde(default)]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClampNumberInput {
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClampNumberOutput {
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListProposalFilesInput {
    #[serde(default)]
    pub entries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListProposalFilesOutput {
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LatestProposalDateInput {
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub max_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LatestProposalDateOutput {
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseDirectiveFileArgInput {
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseDirectiveFileArgOutput {
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseDirectiveObjectiveArgInput {
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseDirectiveObjectiveArgOutput {
    pub objective_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NowIsoInput {
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NowIsoOutput {
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TodayStrInput {
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TodayStrOutput {
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HumanCanaryOverrideApprovalPhraseInput {
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub date_str: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HumanCanaryOverrideApprovalPhraseOutput {
    pub phrase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseHumanCanaryOverrideStateInput {
    #[serde(default)]
    pub record: Option<serde_json::Value>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseHumanCanaryOverrideStateOutput {
    pub active: bool,
    pub reason: String,
    #[serde(default)]
    pub expired: Option<bool>,
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub require_execution_mode: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DailyBudgetPathInput {
    #[serde(default)]
    pub state_dir: Option<String>,
    #[serde(default)]
    pub date_str: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DailyBudgetPathOutput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunsPathForInput {
    #[serde(default)]
    pub runs_dir: Option<String>,
    #[serde(default)]
    pub date_str: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunsPathForOutput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EffectiveTier1PolicyInput {
    #[serde(default)]
    pub execution_mode: Option<String>,
    pub tier1_burn_rate_multiplier: f64,
    pub tier1_canary_burn_rate_multiplier: f64,
    pub tier1_min_projected_tokens_for_burn_check: f64,
    pub tier1_canary_min_projected_tokens_for_burn_check: f64,
    pub tier1_drift_min_samples: f64,
    pub tier1_canary_drift_min_samples: f64,
    pub tier1_alignment_threshold: f64,
    pub tier1_canary_alignment_threshold: f64,
    pub tier1_canary_suppress_alignment_blocker: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EffectiveTier1PolicyOutput {
    #[serde(default)]
    pub execution_mode: Option<String>,
    pub canary_relaxed: bool,
    pub burn_rate_multiplier: f64,
    pub min_projected_tokens_for_burn_check: f64,
    pub drift_min_samples: f64,
    pub alignment_threshold: f64,
    pub suppress_alignment_blocker: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompactTier1ExceptionInput {
    #[serde(default)]
    pub tracked: Option<bool>,
    #[serde(default)]
    pub novel: Option<bool>,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub count: Option<f64>,
    #[serde(default)]
    pub recovery: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompactTier1ExceptionOutput {
    pub has_value: bool,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NextHumanEscalationClearAtInput {
    #[serde(default)]
    pub rows: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NextHumanEscalationClearAtOutput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelCatalogCanaryThresholdsInput {
    pub min_samples: f64,
    pub max_fail_rate: f64,
    pub max_route_block_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelCatalogCanaryThresholdsOutput {
    pub min_samples: f64,
    pub max_fail_rate: f64,
    pub max_route_block_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveClarificationExecSpecInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub meta_directive_objective_id: Option<String>,
    #[serde(default)]
    pub suggested_next_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveClarificationExecSpecOutput {
    pub applicable: bool,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveDecompositionExecSpecInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub meta_directive_objective_id: Option<String>,
    #[serde(default)]
    pub suggested_next_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveDecompositionExecSpecOutput {
    pub applicable: bool,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseActuationSpecInput {
    #[serde(default)]
    pub proposal: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseActuationSpecMutationGuard {
    pub applies: bool,
    pub pass: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub reasons: Vec<serde_json::Value>,
    #[serde(default)]
    pub controls: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseActuationSpecContext {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub safety_attestation_id: Option<String>,
    #[serde(default)]
    pub rollback_receipt_id: Option<String>,
    #[serde(default)]
    pub adaptive_mutation_guard_receipt_id: Option<String>,
    pub mutation_guard: ParseActuationSpecMutationGuard,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseActuationSpecOutput {
    pub has_spec: bool,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub context: Option<ParseActuationSpecContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskFromProposalInput {
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskFromProposalOutput {
    pub task: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseObjectiveIdFromEvidenceRefsInput {
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub objective_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseObjectiveIdFromEvidenceRefsOutput {
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub valid: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseObjectiveIdFromCommandInput {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub objective_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseObjectiveIdFromCommandOutput {
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub valid: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectiveIdForExecutionInput {
    #[serde(default)]
    pub objective_binding_id: Option<String>,
    #[serde(default)]
    pub directive_pulse_id: Option<String>,
    #[serde(default)]
    pub directive_action_id: Option<String>,
    #[serde(default)]
    pub meta_objective_id: Option<String>,
    #[serde(default)]
    pub meta_directive_objective_id: Option<String>,
    #[serde(default)]
    pub action_spec_objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectiveIdForExecutionOutput {
    #[serde(default)]
    pub objective_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShortTextInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub max_len: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ShortTextOutput {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizedSignalStatusInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizedSignalStatusOutput {
    pub status: String,
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
pub struct DodEvidenceDiffInput {
    #[serde(default)]
    pub before_artifacts: Option<f64>,
    #[serde(default)]
    pub before_entries: Option<f64>,
    #[serde(default)]
    pub before_revenue_actions: Option<f64>,
    #[serde(default)]
    pub before_registry_total: Option<f64>,
    #[serde(default)]
    pub before_registry_active: Option<f64>,
    #[serde(default)]
    pub before_registry_candidate: Option<f64>,
    #[serde(default)]
    pub before_habit_runs: Option<f64>,
    #[serde(default)]
    pub before_habit_errors: Option<f64>,
    #[serde(default)]
    pub after_artifacts: Option<f64>,
    #[serde(default)]
    pub after_entries: Option<f64>,
    #[serde(default)]
    pub after_revenue_actions: Option<f64>,
    #[serde(default)]
    pub after_registry_total: Option<f64>,
    #[serde(default)]
    pub after_registry_active: Option<f64>,
    #[serde(default)]
    pub after_registry_candidate: Option<f64>,
    #[serde(default)]
    pub after_habit_runs: Option<f64>,
    #[serde(default)]
    pub after_habit_errors: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DodEvidenceDiffOutput {
    pub artifacts_delta: f64,
    pub entries_delta: f64,
    pub revenue_actions_delta: f64,
    pub registry_total_delta: f64,
    pub registry_active_delta: f64,
    pub registry_candidate_delta: f64,
    pub habit_runs_delta: f64,
    pub habit_errors_delta: f64,
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
pub struct DefaultBacklogAutoscaleStateInput {
    #[serde(default)]
    pub module: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DefaultBacklogAutoscaleStateOutput {
    pub schema_id: String,
    pub schema_version: String,
    pub module: String,
    pub current_cells: f64,
    pub target_cells: f64,
    pub last_run_ts: Option<String>,
    pub last_high_pressure_ts: Option<String>,
    pub last_action: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeBacklogAutoscaleStateInput {
    #[serde(default)]
    pub module: String,
    #[serde(default)]
    pub src: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeBacklogAutoscaleStateOutput {
    pub schema_id: String,
    pub schema_version: String,
    pub module: String,
    pub current_cells: f64,
    pub target_cells: f64,
    pub last_run_ts: Option<String>,
    pub last_high_pressure_ts: Option<String>,
    pub last_action: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpawnAllocatedCellsInput {
    #[serde(default)]
    pub active_cells: Option<f64>,
    #[serde(default)]
    pub current_cells: Option<f64>,
    #[serde(default)]
    pub allocated_cells: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpawnAllocatedCellsOutput {
    pub active_cells: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpawnCapacityBoostRowInput {
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub granted_cells: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpawnCapacityBoostSnapshotInput {
    pub enabled: bool,
    pub lookback_minutes: f64,
    pub min_granted_cells: f64,
    pub now_ms: f64,
    #[serde(default)]
    pub rows: Vec<SpawnCapacityBoostRowInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpawnCapacityBoostSnapshotOutput {
    pub enabled: bool,
    pub active: bool,
    pub lookback_minutes: f64,
    pub min_granted_cells: f64,
    pub grant_count: i64,
    pub granted_cells: f64,
    pub latest_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InversionMaturityScoreInput {
    pub total_tests: f64,
    pub passed_tests: f64,
    pub destructive_failures: f64,
    pub target_test_count: f64,
    pub weight_pass_rate: f64,
    pub weight_non_destructive_rate: f64,
    pub weight_experience: f64,
    pub band_novice: f64,
    pub band_developing: f64,
    pub band_mature: f64,
    pub band_seasoned: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InversionMaturityScoreOutput {
    pub score: f64,
    pub band: String,
    pub pass_rate: f64,
    pub non_destructive_rate: f64,
    pub experience: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DefaultCriteriaPatternMemoryInput {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DefaultCriteriaPatternMemoryOutput {
    pub version: String,
    pub updated_at: Option<String>,
    pub patterns: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyExecutionModeEffectiveInput {
    #[serde(default)]
    pub strategy_mode: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyExecutionModeEffectiveOutput {
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyCanaryExecLimitEffectiveInput {
    #[serde(default)]
    pub strategy_limit: Option<serde_json::Value>,
    #[serde(default)]
    pub fallback: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyCanaryExecLimitEffectiveOutput {
    #[serde(default)]
    pub limit: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyExplorationEffectiveInput {
    #[serde(default)]
    pub strategy_exploration: Option<serde_json::Value>,
    #[serde(default)]
    pub default_fraction: Option<f64>,
    #[serde(default)]
    pub default_every_n: Option<f64>,
    #[serde(default)]
    pub default_min_eligible: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyExplorationEffectiveOutput {
    pub fraction: f64,
    pub every_n: f64,
    pub min_eligible: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyBudgetEffectiveInput {
    #[serde(default)]
    pub caps: Option<serde_json::Value>,
    #[serde(default)]
    pub hard_runs: Option<f64>,
    #[serde(default)]
    pub hard_tokens: Option<f64>,
    #[serde(default)]
    pub hard_per_action: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyBudgetEffectiveOutput {
    pub budget: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreexecVerdictFromSignalsInput {
    #[serde(default)]
    pub blockers: Vec<serde_json::Value>,
    #[serde(default)]
    pub signals: Option<serde_json::Value>,
    #[serde(default)]
    pub next_runnable_at: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreexecVerdictFromSignalsOutput {
    pub verdict: String,
    pub confidence: f64,
    pub blocker_count: u32,
    pub blocker_codes: Vec<String>,
    pub manual_action_required: bool,
    #[serde(default)]
    pub next_runnable_at: Option<String>,
    pub signals: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreOnlyProposalChurnInput {
    #[serde(default)]
    pub prior_runs: Vec<serde_json::Value>,
    #[serde(default)]
    pub proposal_id: Option<String>,
    #[serde(default)]
    pub window_hours: Option<f64>,
    #[serde(default)]
    pub now_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreOnlyProposalChurnOutput {
    pub count: u32,
    pub streak: u32,
    #[serde(default)]
    pub first_ts: Option<String>,
    #[serde(default)]
    pub last_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuccessCriteriaQualityAuditInput {
    #[serde(default)]
    pub verification: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuccessCriteriaQualityAuditOutput {
    pub verification: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectEyesTerminologyDriftInput {
    #[serde(default)]
    pub proposals: Vec<serde_json::Value>,
    #[serde(default)]
    pub tool_capability_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectEyesTerminologyDriftWarning {
    #[serde(default)]
    pub proposal_id: Option<String>,
    pub reason: String,
    pub matched_tools: Vec<String>,
    pub sample: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectEyesTerminologyDriftOutput {
    pub warnings: Vec<DetectEyesTerminologyDriftWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeStoredProposalRowInput {
    #[serde(default)]
    pub proposal: Option<serde_json::Value>,
    #[serde(default)]
    pub fallback: Option<String>,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub proposal_type_source: Option<String>,
    #[serde(default)]
    pub proposal_type_inferred: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NormalizeStoredProposalRowOutput {
    pub proposal: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentProposalKeyCountEventInput {
    #[serde(default)]
    pub proposal_key: Option<String>,
    #[serde(default)]
    pub ts_ms: Option<f64>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub is_attempt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentProposalKeyCountsInput {
    #[serde(default)]
    pub events: Vec<RecentProposalKeyCountEventInput>,
    #[serde(default)]
    pub cutoff_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentProposalKeyCountsOutput {
    pub counts: std::collections::BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityAttemptCountEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub is_attempt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityAttemptCountForDateInput {
    #[serde(default)]
    pub events: Vec<CapabilityAttemptCountEventInput>,
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityAttemptCountForDateOutput {
    pub count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityOutcomeStatsEventInput {
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityOutcomeStatsInWindowInput {
    #[serde(default)]
    pub events: Vec<CapabilityOutcomeStatsEventInput>,
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityOutcomeStatsInWindowOutput {
    pub executed: f64,
    pub shipped: f64,
    pub no_change: f64,
    pub reverted: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceHistoryEventInput {
    pub matched: bool,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceHistoryInput {
    pub window_days: f64,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub events: Vec<ExecuteConfidenceHistoryEventInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidenceHistoryOutput {
    pub window_days: f64,
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
    pub matched_events: f64,
    pub confidence_fallback: f64,
    pub route_blocked: f64,
    pub executed: f64,
    pub shipped: f64,
    pub no_change: f64,
    pub reverted: f64,
    pub no_change_rate: f64,
    pub reverted_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidencePolicyInput {
    #[serde(default)]
    pub proposal_type: Option<String>,
    #[serde(default)]
    pub capability_key: Option<String>,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
    pub adaptive_enabled: bool,
    pub base_composite_margin: f64,
    pub base_value_margin: f64,
    pub low_risk_relax_composite: f64,
    pub low_risk_relax_value: f64,
    pub fallback_relax_every: f64,
    pub fallback_relax_step: f64,
    pub fallback_relax_max: f64,
    pub fallback_relax_min_executed: f64,
    pub fallback_relax_min_shipped: f64,
    pub fallback_relax_min_ship_rate: f64,
    pub no_change_tighten_min_executed: f64,
    pub no_change_tighten_threshold: f64,
    pub no_change_tighten_step: f64,
    #[serde(default)]
    pub history: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecuteConfidencePolicyOutput {
    pub policy: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveFitAssessmentInput {
    pub min_directive_fit: f64,
    pub profile_available: bool,
    #[serde(default)]
    pub active_directive_ids: Vec<String>,
    #[serde(default)]
    pub positive_phrase_hits: Vec<String>,
    #[serde(default)]
    pub positive_token_hits: Vec<String>,
    #[serde(default)]
    pub strategy_hits: Vec<String>,
    #[serde(default)]
    pub negative_phrase_hits: Vec<String>,
    #[serde(default)]
    pub negative_token_hits: Vec<String>,
    pub strategy_token_count: f64,
    #[serde(default)]
    pub impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectiveFitAssessmentOutput {
    pub pass: bool,
    pub score: f64,
    pub profile_available: bool,
    #[serde(default)]
    pub active_directive_ids: Vec<String>,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub matched_positive: Vec<String>,
    #[serde(default)]
    pub matched_negative: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignalQualityAssessmentInput {
    pub min_signal_quality: f64,
    pub min_sensory_signal: f64,
    pub min_sensory_relevance: f64,
    pub min_eye_score_ema: f64,
    #[serde(default)]
    pub eye_id: Option<String>,
    #[serde(default)]
    pub score_source: Option<String>,
    #[serde(default)]
    pub impact: Option<String>,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub url_scheme: Option<String>,
    #[serde(default)]
    pub title_has_stub: bool,
    #[serde(default)]
    pub combined_item_score: Option<f64>,
    #[serde(default)]
    pub sensory_relevance_score: Option<f64>,
    #[serde(default)]
    pub sensory_relevance_tier: Option<String>,
    #[serde(default)]
    pub sensory_quality_score: Option<f64>,
    #[serde(default)]
    pub sensory_quality_tier: Option<String>,
    #[serde(default)]
    pub eye_known: bool,
    #[serde(default)]
    pub eye_status: Option<String>,
    #[serde(default)]
    pub eye_score_ema: Option<f64>,
    #[serde(default)]
    pub parser_type: Option<String>,
    #[serde(default)]
    pub parser_disallowed: bool,
    #[serde(default)]
    pub domain_allowlist_enforced: bool,
    #[serde(default)]
    pub domain_allowed: bool,
    #[serde(default)]
    pub eye_proposed_total: Option<f64>,
    #[serde(default)]
    pub eye_yield_rate: Option<f64>,
    pub calibration_eye_bias: f64,
    pub calibration_topic_bias: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignalQualityAssessmentOutput {
    pub pass: bool,
    pub score: f64,
    pub score_source: String,
    pub eye_id: String,
    #[serde(default)]
    pub sensory_relevance_score: Option<f64>,
    #[serde(default)]
    pub sensory_relevance_tier: Option<String>,
    #[serde(default)]
    pub sensory_quality_score: Option<f64>,
    #[serde(default)]
    pub sensory_quality_tier: Option<String>,
    #[serde(default)]
    pub eye_status: Option<String>,
    #[serde(default)]
    pub eye_score_ema: Option<f64>,
    #[serde(default)]
    pub parser_type: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    pub calibration_eye_bias: f64,
    pub calibration_topic_bias: f64,
    pub calibration_total_bias: f64,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionabilityAssessmentInput {
    pub min_actionability: f64,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub impact: Option<String>,
    pub validation_count: f64,
    pub specific_validation_count: f64,
    pub has_next_cmd: bool,
    pub generic_route_task: bool,
    pub next_cmd_has_dry_run: bool,
    pub looks_like_discovery_cmd: bool,
    pub has_action_verb: bool,
    pub has_opportunity: bool,
    pub has_concrete_target: bool,
    pub is_meta_coordination: bool,
    pub is_explainer: bool,
    pub mentions_proposal: bool,
    #[serde(default)]
    pub relevance_score: Option<f64>,
    #[serde(default)]
    pub directive_fit_score: Option<f64>,
    pub criteria_requirement_applied: bool,
    pub criteria_exempt_type: bool,
    pub criteria_min_count: f64,
    pub measurable_criteria_count: f64,
    pub criteria_total_count: f64,
    pub criteria_pattern_penalty: f64,
    #[serde(default)]
    pub criteria_pattern_hits: Option<serde_json::Value>,
    pub is_executable_proposal: bool,
    pub has_rollback_signal: bool,
    pub subdirective_required: bool,
    pub subdirective_has_concrete_target: bool,
    pub subdirective_has_expected_delta: bool,
    pub subdirective_has_verification_step: bool,
    pub subdirective_target_count: f64,
    pub subdirective_verify_count: f64,
    pub subdirective_success_criteria_count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionabilityAssessmentOutput {
    pub pass: bool,
    pub score: f64,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub executable: bool,
    pub rollback_signal: bool,
    pub generic_next_command_template: bool,
    pub subdirective_v2: serde_json::Value,
    pub success_criteria: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyProfileInput {
    #[serde(default)]
    pub strategy: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyProfileOutput {
    #[serde(default)]
    pub strategy: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveStrategyVariantsInput {
    #[serde(default)]
    pub listed: Vec<serde_json::Value>,
    #[serde(default)]
    pub primary: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveStrategyVariantsOutput {
    #[serde(default)]
    pub variants: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyScorecardSummariesInput {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub summaries: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyScorecardSummaryItemOutput {
    pub score: f64,
    pub confidence: f64,
    #[serde(default)]
    pub stage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyScorecardSummariesOutput {
    pub path: String,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub by_id: std::collections::BTreeMap<String, StrategyScorecardSummaryItemOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutcomeFitnessPolicyInput {
    #[serde(default)]
    pub policy: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutcomeFitnessPolicyOutput {
    pub policy: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoadEyesMapInput {
    #[serde(default)]
    pub cfg_eyes: Vec<serde_json::Value>,
    #[serde(default)]
    pub state_eyes: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoadEyesMapOutput {
    #[serde(default)]
    pub eyes: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FallbackDirectiveObjectiveIdsInput {
    #[serde(default)]
    pub directive_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FallbackDirectiveObjectiveIdsOutput {
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueuePressureSnapshotInput {
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default)]
    pub warn_count: f64,
    #[serde(default)]
    pub critical_count: f64,
    #[serde(default)]
    pub warn_ratio: f64,
    #[serde(default)]
    pub critical_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueuePressureSnapshotOutput {
    pub total: u32,
    pub pending: u32,
    pub accepted: u32,
    pub closed: u32,
    pub rejected: u32,
    pub parked: u32,
    pub pending_ratio: f64,
    pub pressure: String,
    pub warn_ratio: f64,
    pub critical_ratio: f64,
    pub warn_count: f64,
    pub critical_count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseSuccessCriteriaRowsInput {
    #[serde(default)]
    pub action_rows: Vec<serde_json::Value>,
    #[serde(default)]
    pub verify_rows: Vec<serde_json::Value>,
    #[serde(default)]
    pub validation_rows: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseSuccessCriteriaRowOutput {
    pub source: String,
    pub metric: String,
    pub target: String,
    pub measurable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParseSuccessCriteriaRowsOutput {
    #[serde(default)]
    pub rows: Vec<ParseSuccessCriteriaRowOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CollectOutcomeStatsBucketInput {
    #[serde(default)]
    pub shipped: f64,
    #[serde(default)]
    pub no_change: f64,
    #[serde(default)]
    pub reverted: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectOutcomeStatsInput {
    #[serde(default)]
    pub by_eye: std::collections::BTreeMap<String, CollectOutcomeStatsBucketInput>,
    #[serde(default)]
    pub by_topic: std::collections::BTreeMap<String, CollectOutcomeStatsBucketInput>,
    #[serde(default)]
    pub global: CollectOutcomeStatsBucketInput,
    #[serde(default)]
    pub eye_min_samples: f64,
    #[serde(default)]
    pub topic_min_samples: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectOutcomeStatsGlobalOutput {
    pub shipped: f64,
    pub no_change: f64,
    pub reverted: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectOutcomeStatsBiasOutput {
    pub shipped: f64,
    pub no_change: f64,
    pub reverted: f64,
    pub total: f64,
    pub bias: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectOutcomeStatsOutput {
    pub global: CollectOutcomeStatsGlobalOutput,
    #[serde(default)]
    pub eye_biases: std::collections::BTreeMap<String, CollectOutcomeStatsBiasOutput>,
    #[serde(default)]
    pub topic_biases: std::collections::BTreeMap<String, CollectOutcomeStatsBiasOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubdirectiveV2SignalsInput {
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub has_concrete_target: bool,
    #[serde(default)]
    pub has_expected_delta: bool,
    #[serde(default)]
    pub has_verification_step: bool,
    #[serde(default)]
    pub target_count: f64,
    #[serde(default)]
    pub verify_count: f64,
    #[serde(default)]
    pub success_criteria_count: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubdirectiveV2SignalsOutput {
    pub required: bool,
    pub has_concrete_target: bool,
    pub has_expected_delta: bool,
    pub has_verification_step: bool,
    pub target_count: f64,
    pub verify_count: f64,
    pub success_criteria_count: f64,
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
    pub dod_evidence_diff_input: Option<DodEvidenceDiffInput>,
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
    pub exec_window_match_input: Option<ExecWindowMatchInput>,
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
    pub proposal_semantic_fingerprint_input: Option<ProposalSemanticFingerprintInput>,
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
    pub normalize_value_currency_token_input: Option<NormalizeValueCurrencyTokenInput>,
    #[serde(default)]
    pub list_value_currencies_input: Option<ListValueCurrenciesInput>,
    #[serde(default)]
    pub infer_value_currencies_from_directive_bits_input:
        Option<InferValueCurrenciesFromDirectiveBitsInput>,
    #[serde(default)]
    pub has_linked_objective_entry_input: Option<HasLinkedObjectiveEntryInput>,
    #[serde(default)]
    pub verified_entry_outcome_input: Option<VerifiedEntryOutcomeInput>,
    #[serde(default)]
    pub verified_revenue_action_input: Option<VerifiedRevenueActionInput>,
    #[serde(default)]
    pub minutes_until_next_utc_day_input: Option<MinutesUntilNextUtcDayInput>,
    #[serde(default)]
    pub age_hours_input: Option<AgeHoursInput>,
    #[serde(default)]
    pub url_domain_input: Option<UrlDomainInput>,
    #[serde(default)]
    pub domain_allowed_input: Option<DomainAllowedInput>,
    #[serde(default)]
    pub is_execute_mode_input: Option<IsExecuteModeInput>,
    #[serde(default)]
    pub execution_allowed_by_feature_flag_input: Option<ExecutionAllowedByFeatureFlagInput>,
    #[serde(default)]
    pub is_tier1_objective_id_input: Option<IsTier1ObjectiveIdInput>,
    #[serde(default)]
    pub is_tier1_candidate_objective_input: Option<IsTier1CandidateObjectiveInput>,
    #[serde(default)]
    pub needs_execution_quota_input: Option<NeedsExecutionQuotaInput>,
    #[serde(default)]
    pub normalize_criteria_metric_input: Option<NormalizeCriteriaMetricInput>,
    #[serde(default)]
    pub escape_reg_exp_input: Option<EscapeRegExpInput>,
    #[serde(default)]
    pub tool_token_mentioned_input: Option<ToolTokenMentionedInput>,
    #[serde(default)]
    pub policy_hold_reason_from_event_input: Option<PolicyHoldReasonFromEventInput>,
    #[serde(default)]
    pub strategy_marker_tokens_input: Option<StrategyMarkerTokensInput>,
    #[serde(default)]
    pub capability_cooldown_key_input: Option<CapabilityCooldownKeyInput>,
    #[serde(default)]
    pub readiness_retry_cooldown_key_input: Option<ReadinessRetryCooldownKeyInput>,
    #[serde(default)]
    pub source_eye_id_input: Option<SourceEyeIdInput>,
    #[serde(default)]
    pub deprioritized_source_proposal_input: Option<DeprioritizedSourceProposalInput>,
    #[serde(default)]
    pub composite_eligibility_min_input: Option<CompositeEligibilityMinInput>,
    #[serde(default)]
    pub clamp_threshold_input: Option<ClampThresholdInput>,
    #[serde(default)]
    pub applied_thresholds_input: Option<AppliedThresholdsInput>,
    #[serde(default)]
    pub extract_eye_from_evidence_ref_input: Option<ExtractEyeFromEvidenceRefInput>,
    #[serde(default)]
    pub total_outcomes_input: Option<TotalOutcomesInput>,
    #[serde(default)]
    pub derive_entity_bias_input: Option<DeriveEntityBiasInput>,
    #[serde(default)]
    pub strategy_profile_input: Option<StrategyProfileInput>,
    #[serde(default)]
    pub active_strategy_variants_input: Option<ActiveStrategyVariantsInput>,
    #[serde(default)]
    pub strategy_scorecard_summaries_input: Option<StrategyScorecardSummariesInput>,
    #[serde(default)]
    pub outcome_fitness_policy_input: Option<OutcomeFitnessPolicyInput>,
    #[serde(default)]
    pub load_eyes_map_input: Option<LoadEyesMapInput>,
    #[serde(default)]
    pub fallback_directive_objective_ids_input: Option<FallbackDirectiveObjectiveIdsInput>,
    #[serde(default)]
    pub queue_pressure_snapshot_input: Option<QueuePressureSnapshotInput>,
    #[serde(default)]
    pub parse_success_criteria_rows_input: Option<ParseSuccessCriteriaRowsInput>,
    #[serde(default)]
    pub collect_outcome_stats_input: Option<CollectOutcomeStatsInput>,
    #[serde(default)]
    pub subdirective_v2_signals_input: Option<SubdirectiveV2SignalsInput>,
    #[serde(default)]
    pub build_overlay_input: Option<BuildOverlayInput>,
    #[serde(default)]
    pub has_adaptive_mutation_signal_input: Option<HasAdaptiveMutationSignalInput>,
    #[serde(default)]
    pub adaptive_mutation_execution_guard_input: Option<AdaptiveMutationExecutionGuardInput>,
    #[serde(default)]
    pub strategy_selection_input: Option<StrategySelectionInput>,
    #[serde(default)]
    pub calibration_deltas_input: Option<CalibrationDeltasInput>,
    #[serde(default)]
    pub strategy_admission_decision_input: Option<StrategyAdmissionDecisionInput>,
    #[serde(default)]
    pub expected_value_score_input: Option<ExpectedValueScoreInput>,
    #[serde(default)]
    pub suggest_run_batch_max_input: Option<SuggestRunBatchMaxInput>,
    #[serde(default)]
    pub backlog_autoscale_snapshot_input: Option<BacklogAutoscaleSnapshotInput>,
    #[serde(default)]
    pub admission_summary_input: Option<AdmissionSummaryInput>,
    #[serde(default)]
    pub unknown_type_quarantine_decision_input: Option<UnknownTypeQuarantineDecisionInput>,
    #[serde(default)]
    pub infer_optimization_delta_input: Option<InferOptimizationDeltaInput>,
    #[serde(default)]
    pub optimization_intent_proposal_input: Option<OptimizationIntentProposalInput>,
    #[serde(default)]
    pub unlinked_optimization_admission_input: Option<UnlinkedOptimizationAdmissionInput>,
    #[serde(default)]
    pub optimization_good_enough_input: Option<OptimizationGoodEnoughInput>,
    #[serde(default)]
    pub proposal_dependency_summary_input: Option<ProposalDependencySummaryInput>,
    #[serde(default)]
    pub choose_selection_mode_input: Option<ChooseSelectionModeInput>,
    #[serde(default)]
    pub explore_quota_for_day_input: Option<ExploreQuotaForDayInput>,
    #[serde(default)]
    pub medium_risk_thresholds_input: Option<MediumRiskThresholdsInput>,
    #[serde(default)]
    pub medium_risk_gate_decision_input: Option<MediumRiskGateDecisionInput>,
    #[serde(default)]
    pub route_block_prefilter_input: Option<RouteBlockPrefilterInput>,
    #[serde(default)]
    pub route_execution_sample_event_input: Option<RouteExecutionSampleEventInput>,
    #[serde(default)]
    pub route_block_telemetry_summary_input: Option<RouteBlockTelemetrySummaryInput>,
    #[serde(default)]
    pub is_stub_proposal_input: Option<IsStubProposalInput>,
    #[serde(default)]
    pub recent_autonomy_run_events_input: Option<RecentAutonomyRunEventsInput>,
    #[serde(default)]
    pub proposal_meta_index_input: Option<ProposalMetaIndexInput>,
    #[serde(default)]
    pub new_log_events_input: Option<NewLogEventsInput>,
    #[serde(default)]
    pub outcome_buckets_input: Option<OutcomeBucketsInput>,
    #[serde(default)]
    pub recent_run_events_input: Option<RecentRunEventsInput>,
    #[serde(default)]
    pub all_decision_events_input: Option<AllDecisionEventsInput>,
    #[serde(default)]
    pub cooldown_active_state_input: Option<CooldownActiveStateInput>,
    #[serde(default)]
    pub bump_count_input: Option<BumpCountInput>,
    #[serde(default)]
    pub lock_age_minutes_input: Option<LockAgeMinutesInput>,
    #[serde(default)]
    pub hash_obj_input: Option<HashObjInput>,
    #[serde(default)]
    pub assess_success_criteria_quality_input: Option<AssessSuccessCriteriaQualityInput>,
    #[serde(default)]
    pub manual_gate_prefilter_input: Option<ManualGatePrefilterInput>,
    #[serde(default)]
    pub execute_confidence_cooldown_active_input: Option<ExecuteConfidenceCooldownActiveInput>,
    #[serde(default)]
    pub top_biases_summary_input: Option<TopBiasesSummaryInput>,
    #[serde(default)]
    pub criteria_pattern_penalty_input: Option<CriteriaPatternPenaltyInput>,
    #[serde(default)]
    pub strategy_threshold_overrides_input: Option<StrategyThresholdOverridesInput>,
    #[serde(default)]
    pub effective_allowed_risks_input: Option<EffectiveAllowedRisksInput>,
    #[serde(default)]
    pub directive_pulse_context_input: Option<DirectivePulseContextInput>,
    #[serde(default)]
    pub directive_pulse_stats_input: Option<DirectivePulseStatsInput>,
    #[serde(default)]
    pub compile_directive_pulse_objectives_input: Option<CompileDirectivePulseObjectivesInput>,
    #[serde(default)]
    pub directive_pulse_objectives_profile_input: Option<DirectivePulseObjectivesProfileInput>,
    #[serde(default)]
    pub recent_directive_pulse_cooldown_count_input: Option<RecentDirectivePulseCooldownCountInput>,
    #[serde(default)]
    pub proposal_directive_text_input: Option<ProposalDirectiveTextInput>,
    #[serde(default)]
    pub objective_ids_from_pulse_context_input: Option<ObjectiveIdsFromPulseContextInput>,
    #[serde(default)]
    pub policy_hold_objective_context_input: Option<PolicyHoldObjectiveContextInput>,
    #[serde(default)]
    pub proposal_semantic_objective_id_input: Option<ProposalSemanticObjectiveIdInput>,
    #[serde(default)]
    pub criteria_pattern_keys_input: Option<CriteriaPatternKeysInput>,
    #[serde(default)]
    pub success_criteria_requirement_input: Option<SuccessCriteriaRequirementInput>,
    #[serde(default)]
    pub success_criteria_policy_for_proposal_input: Option<SuccessCriteriaPolicyForProposalInput>,
    #[serde(default)]
    pub capability_descriptor_input: Option<CapabilityDescriptorInput>,
    #[serde(default)]
    pub normalize_token_usage_shape_input: Option<NormalizeTokenUsageShapeInput>,
    #[serde(default)]
    pub is_directive_clarification_proposal_input: Option<IsDirectiveClarificationProposalInput>,
    #[serde(default)]
    pub is_directive_decomposition_proposal_input: Option<IsDirectiveDecompositionProposalInput>,
    #[serde(default)]
    pub sanitize_directive_objective_id_input: Option<SanitizeDirectiveObjectiveIdInput>,
    #[serde(default)]
    pub sanitized_directive_id_list_input: Option<SanitizedDirectiveIdListInput>,
    #[serde(default)]
    pub parse_first_json_line_input: Option<ParseFirstJsonLineInput>,
    #[serde(default)]
    pub parse_json_objects_from_text_input: Option<ParseJsonObjectsFromTextInput>,
    #[serde(default)]
    pub read_path_value_input: Option<ReadPathValueInput>,
    #[serde(default)]
    pub number_or_null_input: Option<NumberOrNullInput>,
    #[serde(default)]
    pub choose_evidence_selection_mode_input: Option<ChooseEvidenceSelectionModeInput>,
    #[serde(default)]
    pub truthy_flag_input: Option<TruthyFlagInput>,
    #[serde(default)]
    pub falsey_flag_input: Option<TruthyFlagInput>,
    #[serde(default)]
    pub stable_selection_index_input: Option<StableSelectionIndexInput>,
    #[serde(default)]
    pub as_string_array_input: Option<AsStringArrayInput>,
    #[serde(default)]
    pub uniq_sorted_input: Option<UniqSortedInput>,
    #[serde(default)]
    pub normalize_model_ids_input: Option<NormalizeModelIdsInput>,
    #[serde(default)]
    pub selected_model_from_run_event_input: Option<SelectedModelFromRunEventInput>,
    #[serde(default)]
    pub read_first_numeric_metric_input: Option<ReadFirstNumericMetricInput>,
    #[serde(default)]
    pub parse_arg_input: Option<ParseArgInput>,
    #[serde(default)]
    pub date_arg_or_today_input: Option<DateArgOrTodayInput>,
    #[serde(default)]
    pub has_env_numeric_override_input: Option<HasEnvNumericOverrideInput>,
    #[serde(default)]
    pub coalesce_numeric_input: Option<CoalesceNumericInput>,
    #[serde(default)]
    pub clamp_number_input: Option<ClampNumberInput>,
    #[serde(default)]
    pub list_proposal_files_input: Option<ListProposalFilesInput>,
    #[serde(default)]
    pub latest_proposal_date_input: Option<LatestProposalDateInput>,
    #[serde(default)]
    pub parse_directive_file_arg_input: Option<ParseDirectiveFileArgInput>,
    #[serde(default)]
    pub parse_directive_objective_arg_input: Option<ParseDirectiveObjectiveArgInput>,
    #[serde(default)]
    pub now_iso_input: Option<NowIsoInput>,
    #[serde(default)]
    pub today_str_input: Option<TodayStrInput>,
    #[serde(default)]
    pub human_canary_override_approval_phrase_input: Option<HumanCanaryOverrideApprovalPhraseInput>,
    #[serde(default)]
    pub parse_human_canary_override_state_input: Option<ParseHumanCanaryOverrideStateInput>,
    #[serde(default)]
    pub daily_budget_path_input: Option<DailyBudgetPathInput>,
    #[serde(default)]
    pub runs_path_for_input: Option<RunsPathForInput>,
    #[serde(default)]
    pub effective_tier1_policy_input: Option<EffectiveTier1PolicyInput>,
    #[serde(default)]
    pub compact_tier1_exception_input: Option<CompactTier1ExceptionInput>,
    #[serde(default)]
    pub next_human_escalation_clear_at_input: Option<NextHumanEscalationClearAtInput>,
    #[serde(default)]
    pub model_catalog_canary_thresholds_input: Option<ModelCatalogCanaryThresholdsInput>,
    #[serde(default)]
    pub directive_clarification_exec_spec_input: Option<DirectiveClarificationExecSpecInput>,
    #[serde(default)]
    pub directive_decomposition_exec_spec_input: Option<DirectiveDecompositionExecSpecInput>,
    #[serde(default)]
    pub parse_actuation_spec_input: Option<ParseActuationSpecInput>,
    #[serde(default)]
    pub task_from_proposal_input: Option<TaskFromProposalInput>,
    #[serde(default)]
    pub parse_objective_id_from_evidence_refs_input: Option<ParseObjectiveIdFromEvidenceRefsInput>,
    #[serde(default)]
    pub parse_objective_id_from_command_input: Option<ParseObjectiveIdFromCommandInput>,
    #[serde(default)]
    pub objective_id_for_execution_input: Option<ObjectiveIdForExecutionInput>,
    #[serde(default)]
    pub short_text_input: Option<ShortTextInput>,
    #[serde(default)]
    pub normalized_signal_status_input: Option<NormalizedSignalStatusInput>,
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
    #[serde(default)]
    pub default_backlog_autoscale_state_input: Option<DefaultBacklogAutoscaleStateInput>,
    #[serde(default)]
    pub normalize_backlog_autoscale_state_input: Option<NormalizeBacklogAutoscaleStateInput>,
    #[serde(default)]
    pub spawn_allocated_cells_input: Option<SpawnAllocatedCellsInput>,
    #[serde(default)]
    pub spawn_capacity_boost_snapshot_input: Option<SpawnCapacityBoostSnapshotInput>,
    #[serde(default)]
    pub inversion_maturity_score_input: Option<InversionMaturityScoreInput>,
    #[serde(default)]
    pub default_criteria_pattern_memory_input: Option<DefaultCriteriaPatternMemoryInput>,
    #[serde(default)]
    pub strategy_execution_mode_effective_input: Option<StrategyExecutionModeEffectiveInput>,
    #[serde(default)]
    pub strategy_canary_exec_limit_effective_input: Option<StrategyCanaryExecLimitEffectiveInput>,
    #[serde(default)]
    pub strategy_exploration_effective_input: Option<StrategyExplorationEffectiveInput>,
    #[serde(default)]
    pub strategy_budget_effective_input: Option<StrategyBudgetEffectiveInput>,
    #[serde(default)]
    pub preexec_verdict_from_signals_input: Option<PreexecVerdictFromSignalsInput>,
    #[serde(default)]
    pub score_only_proposal_churn_input: Option<ScoreOnlyProposalChurnInput>,
    #[serde(default)]
    pub success_criteria_quality_audit_input: Option<SuccessCriteriaQualityAuditInput>,
    #[serde(default)]
    pub detect_eyes_terminology_drift_input: Option<DetectEyesTerminologyDriftInput>,
    #[serde(default)]
    pub normalize_stored_proposal_row_input: Option<NormalizeStoredProposalRowInput>,
    #[serde(default)]
    pub recent_proposal_key_counts_input: Option<RecentProposalKeyCountsInput>,
    #[serde(default)]
    pub capability_attempt_count_for_date_input: Option<CapabilityAttemptCountForDateInput>,
    #[serde(default)]
    pub capability_outcome_stats_in_window_input: Option<CapabilityOutcomeStatsInWindowInput>,
    #[serde(default)]
    pub execute_confidence_history_input: Option<ExecuteConfidenceHistoryInput>,
    #[serde(default)]
    pub execute_confidence_policy_input: Option<ExecuteConfidencePolicyInput>,
    #[serde(default)]
    pub directive_fit_assessment_input: Option<DirectiveFitAssessmentInput>,
    #[serde(default)]
    pub signal_quality_assessment_input: Option<SignalQualityAssessmentInput>,
    #[serde(default)]
    pub actionability_assessment_input: Option<ActionabilityAssessmentInput>,
}

fn clamp_ratio(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
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
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == ':' || ch == '_' || ch == '-'
            {
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

pub fn compute_route_execution_policy_hold(
    input: &RouteExecutionPolicyHoldInput,
) -> PolicyHoldOutput {
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
            let enforced =
                normalize_spaces(input.budget_enforcement_reason.as_deref().unwrap_or(""));
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

pub fn compute_dod_evidence_diff(input: &DodEvidenceDiffInput) -> DodEvidenceDiffOutput {
    let before_artifacts = input.before_artifacts.unwrap_or(0.0);
    let before_entries = input.before_entries.unwrap_or(0.0);
    let before_revenue_actions = input.before_revenue_actions.unwrap_or(0.0);
    let before_registry_total = input.before_registry_total.unwrap_or(0.0);
    let before_registry_active = input.before_registry_active.unwrap_or(0.0);
    let before_registry_candidate = input.before_registry_candidate.unwrap_or(0.0);
    let before_habit_runs = input.before_habit_runs.unwrap_or(0.0);
    let before_habit_errors = input.before_habit_errors.unwrap_or(0.0);

    let after_artifacts = input.after_artifacts.unwrap_or(0.0);
    let after_entries = input.after_entries.unwrap_or(0.0);
    let after_revenue_actions = input.after_revenue_actions.unwrap_or(0.0);
    let after_registry_total = input.after_registry_total.unwrap_or(0.0);
    let after_registry_active = input.after_registry_active.unwrap_or(0.0);
    let after_registry_candidate = input.after_registry_candidate.unwrap_or(0.0);
    let after_habit_runs = input.after_habit_runs.unwrap_or(0.0);
    let after_habit_errors = input.after_habit_errors.unwrap_or(0.0);

    DodEvidenceDiffOutput {
        artifacts_delta: after_artifacts - before_artifacts,
        entries_delta: after_entries - before_entries,
        revenue_actions_delta: after_revenue_actions - before_revenue_actions,
        registry_total_delta: after_registry_total - before_registry_total,
        registry_active_delta: after_registry_active - before_registry_active,
        registry_candidate_delta: after_registry_candidate - before_registry_candidate,
        habit_runs_delta: after_habit_runs - before_habit_runs,
        habit_errors_delta: after_habit_errors - before_habit_errors,
    }
}

pub fn compute_score_only_result(input: &ScoreOnlyResultInput) -> ScoreOnlyResultOutput {
    let result = input.result.as_ref().map(|v| v.trim()).unwrap_or_default();
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

    let result = input.result.as_ref().map(|v| v.trim()).unwrap_or_default();
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

pub fn compute_runs_since_reset_index(
    input: &RunsSinceResetIndexInput,
) -> RunsSinceResetIndexOutput {
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

pub fn compute_attempt_event_indices(
    input: &AttemptEventIndicesInput,
) -> AttemptEventIndicesOutput {
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

pub fn compute_executed_count_by_risk(
    input: &ExecutedCountByRiskInput,
) -> ExecutedCountByRiskOutput {
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
    } else if status == "closed_won" || status == "won" || status == "paid" || status == "verified"
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

pub fn compute_proposal_semantic_fingerprint(
    input: &ProposalSemanticFingerprintInput,
) -> ProposalSemanticFingerprintOutput {
    let proposal_id_raw = normalize_spaces(input.proposal_id.as_deref().unwrap_or(""));
    let proposal_id = if proposal_id_raw.is_empty() {
        None
    } else {
        Some(proposal_id_raw)
    };
    let proposal_type =
        normalize_spaces(input.proposal_type.as_deref().unwrap_or("")).to_ascii_lowercase();
    let proposal_type = if proposal_type.is_empty() {
        "unknown".to_string()
    } else {
        proposal_type
    };
    let source_eye_raw =
        normalize_spaces(input.source_eye.as_deref().unwrap_or("")).to_ascii_lowercase();
    let source_eye = if source_eye_raw.is_empty() {
        None
    } else {
        Some(source_eye_raw)
    };
    let objective_id_raw = normalize_spaces(input.objective_id.as_deref().unwrap_or(""));
    let objective_id = if objective_id_raw.is_empty() {
        None
    } else {
        Some(objective_id_raw)
    };

    let text_blob = normalize_spaces(input.text_blob.as_deref().unwrap_or(""));
    let tokenized = compute_tokenize_directive_text(&TokenizeDirectiveTextInput {
        text: Some(text_blob),
        stopwords: input.stopwords.clone(),
    });
    let mut stems = std::collections::BTreeSet::new();
    for token in tokenized.tokens {
        let stem = compute_to_stem(&ToStemInput { token: Some(token) }).stem;
        if !stem.is_empty() {
            stems.insert(stem);
        }
    }
    let token_stems: Vec<String> = stems.into_iter().collect();
    let token_count = token_stems.len() as u32;
    let min_tokens = input.min_tokens.unwrap_or(4.0).max(0.0);
    let eligible = (token_count as f64) >= min_tokens;

    ProposalSemanticFingerprintOutput {
        proposal_id,
        proposal_type,
        source_eye,
        objective_id,
        token_stems,
        token_count,
        eligible,
    }
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
    if input.require_same_type
        && !left_type.is_empty()
        && !right_type.is_empty()
        && left_type != right_type
    {
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
    if !left_objective.is_empty()
        && !right_objective.is_empty()
        && left_objective == right_objective
    {
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
    let to_fixed3 = |value: f64| -> f64 { format!("{value:.3}").parse::<f64>().unwrap_or(value) };
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
    let to_fixed3 = |value: f64| -> f64 { format!("{value:.3}").parse::<f64>().unwrap_or(value) };
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
        return StrategyCircuitCooldownOutput {
            cooldown_hours: 0.0,
        };
    }

    if err.contains("429") || err.contains("rate_limit") {
        return StrategyCircuitCooldownOutput {
            cooldown_hours: input.http_429_cooldown_hours,
        };
    }
    let has_5xx_code = err.as_bytes().windows(3).any(|window| {
        window[0] == b'5' && window[1].is_ascii_digit() && window[2].is_ascii_digit()
    });
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

    StrategyCircuitCooldownOutput {
        cooldown_hours: 0.0,
    }
}

pub fn compute_strategy_trit_shadow_adjusted(
    input: &StrategyTritShadowAdjustedInput,
) -> StrategyTritShadowAdjustedOutput {
    let to_fixed3 = |value: f64| -> f64 { format!("{value:.3}").parse::<f64>().unwrap_or(value) };
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
    let to_fixed3 = |value: f64| -> f64 { format!("{value:.3}").parse::<f64>().unwrap_or(value) };
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
    let to_fixed3 = |value: f64| -> f64 { format!("{value:.3}").parse::<f64>().unwrap_or(value) };
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
        "proposal_type" => {
            !scope_value.is_empty() && !proposal_type.is_empty() && scope_value == proposal_type
        }
        "capability_key" => {
            !scope_value.is_empty() && !capability_key.is_empty() && scope_value == capability_key
        }
        "objective_id" => {
            !scope_value.is_empty() && !objective_id.is_empty() && scope_value == objective_id
        }
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
    let to_fixed4 = |value: f64| -> f64 { format!("{value:.4}").parse::<f64>().unwrap_or(value) };
    let to_fixed3 = |value: f64| -> f64 { format!("{value:.3}").parse::<f64>().unwrap_or(value) };
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
        .map(|row| row.confidence.clamp(0.0, 1.0))
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
        .map(|row| row.score_impact.max(0.0) * row.confidence.clamp(0.0, 1.0))
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
        .map(|row| row.score_impact.max(0.0) * row.confidence.clamp(0.0, 1.0))
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
        } else {
            value.clamp(0.0, 100.0)
        }
    };
    let round_score = |value: f64| -> f64 { clamp_score(value.round()) };
    let to_fixed3 = |value: f64| -> f64 { format!("{value:.3}").parse::<f64>().unwrap_or(value) };
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
        round_score(
            priority
                * if input.currency_multiplier.is_finite() {
                    input.currency_multiplier.max(0.0)
                } else {
                    1.0
                },
        )
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
    } else {
        input.est_tokens.clamp(80.0, 12000.0)
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
    let fallback = input.fallback.filter(|v| v.is_finite()).unwrap_or(3.0);
    let raw = input.raw_tier.filter(|v| v.is_finite()).unwrap_or(fallback);
    let tier = raw.round().max(1.0);
    NormalizeDirectiveTierOutput { tier: tier as u32 }
}

pub fn compute_directive_tier_weight(
    input: &DirectiveTierWeightInput,
) -> DirectiveTierWeightOutput {
    let fallback = input.fallback.filter(|v| v.is_finite()).unwrap_or(3.0);
    let raw = input.tier.filter(|v| v.is_finite()).unwrap_or(fallback);
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
    let fallback = input.fallback.filter(|v| v.is_finite()).unwrap_or(3.0);
    let raw = input.tier.filter(|v| v.is_finite()).unwrap_or(fallback);
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
    let fallback = input.fallback.filter(|v| v.is_finite()).unwrap_or(3.0);
    let raw = input.tier.filter(|v| v.is_finite()).unwrap_or(fallback);
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
        input
            .list
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
        input
            .suggested_next_command
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

fn normalize_value_currency_token_with_allowed(raw: &str, allowed_keys: &[String]) -> String {
    let token = raw.trim().to_ascii_lowercase();
    if token.is_empty() {
        return String::new();
    }
    if allowed_keys.is_empty() {
        return token;
    }
    if allowed_keys
        .iter()
        .any(|key| key.trim().eq_ignore_ascii_case(&token))
    {
        return token;
    }
    String::new()
}

pub fn compute_normalize_value_currency_token(
    input: &NormalizeValueCurrencyTokenInput,
) -> NormalizeValueCurrencyTokenOutput {
    let token = normalize_value_currency_token_with_allowed(
        input.value.as_deref().unwrap_or(""),
        &input.allowed_keys,
    );
    NormalizeValueCurrencyTokenOutput { token }
}

pub fn compute_list_value_currencies(
    input: &ListValueCurrenciesInput,
) -> ListValueCurrenciesOutput {
    let mut rows: Vec<String> = Vec::new();
    if !input.value_list.is_empty() {
        rows.extend(input.value_list.iter().map(|v| v.to_string()));
    } else if let Some(csv) = input.value_csv.as_deref() {
        rows.extend(
            csv.split(',')
                .map(|row| row.trim().to_string())
                .filter(|row| !row.is_empty()),
        );
    }
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for row in rows {
        let token = normalize_value_currency_token_with_allowed(&row, &input.allowed_keys);
        if token.is_empty() {
            continue;
        }
        if seen.insert(token.clone()) {
            out.push(token);
        }
    }
    ListValueCurrenciesOutput { currencies: out }
}

pub fn compute_infer_value_currencies_from_directive_bits(
    input: &InferValueCurrenciesFromDirectiveBitsInput,
) -> InferValueCurrenciesFromDirectiveBitsOutput {
    let blob = normalize_spaces(&input.bits.join(" ")).to_ascii_lowercase();
    if blob.is_empty() {
        return InferValueCurrenciesFromDirectiveBitsOutput {
            currencies: Vec::new(),
        };
    }

    let revenue_re =
        Regex::new(r"\b(revenue|mrr|arr|cash|money|usd|dollar|profit|pricing|invoice|paid|payment|billing|income)\b")
            .expect("valid revenue regex");
    let delivery_re =
        Regex::new(r"\b(deliver|delivery|ship|release|milestone|throughput|lead[\s_-]?time|cycle[\s_-]?time|backlog)\b")
            .expect("valid delivery regex");
    let user_re = Regex::new(
        r"\b(customer|user|adoption|engagement|retention|conversion|satisfaction|onboarding)\b",
    )
    .expect("valid user regex");
    let quality_re = Regex::new(
        r"\b(quality|reliab|uptime|error|stability|safety|accuracy|resilience|regression)\b",
    )
    .expect("valid quality regex");
    let time_re = Regex::new(
        r"\b(time[\s_-]*to[\s_-]*(?:value|cash|revenue)|hours?\s+saved|latency|faster|payback)\b",
    )
    .expect("valid time regex");
    let learning_re =
        Regex::new(r"\b(learn|discovery|research|insight|ab[\s_-]?test|hypothesis)\b")
            .expect("valid learning regex");

    let mut inferred: Vec<String> = Vec::new();
    if revenue_re.is_match(&blob) {
        inferred.push("revenue".to_string());
    }
    if delivery_re.is_match(&blob) {
        inferred.push("delivery".to_string());
    }
    if user_re.is_match(&blob) {
        inferred.push("user_value".to_string());
    }
    if quality_re.is_match(&blob) {
        inferred.push("quality".to_string());
    }
    if time_re.is_match(&blob) {
        inferred.push("time_savings".to_string());
    }
    if learning_re.is_match(&blob) {
        inferred.push("learning".to_string());
    }

    let list_out = compute_list_value_currencies(&ListValueCurrenciesInput {
        value_list: inferred,
        value_csv: None,
        allowed_keys: input.allowed_keys.clone(),
    });
    InferValueCurrenciesFromDirectiveBitsOutput {
        currencies: list_out.currencies,
    }
}

pub fn compute_has_linked_objective_entry(
    input: &HasLinkedObjectiveEntryInput,
) -> HasLinkedObjectiveEntryOutput {
    let linked = compute_extract_objective_id_token(&ExtractObjectiveIdTokenInput {
        value: input.objective_id.clone(),
    })
    .objective_id
    .is_some()
        || compute_extract_objective_id_token(&ExtractObjectiveIdTokenInput {
            value: input.directive_objective_id.clone(),
        })
        .objective_id
        .is_some()
        || compute_extract_objective_id_token(&ExtractObjectiveIdTokenInput {
            value: input.directive.clone(),
        })
        .objective_id
        .is_some();
    HasLinkedObjectiveEntryOutput { linked }
}

pub fn compute_verified_entry_outcome(
    input: &VerifiedEntryOutcomeInput,
) -> VerifiedEntryOutcomeOutput {
    if input.outcome_verified {
        return VerifiedEntryOutcomeOutput { verified: true };
    }
    let outcome = input
        .outcome
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let verified = matches!(
        outcome.as_str(),
        "verified"
            | "verified_success"
            | "verified_pass"
            | "shipped"
            | "closed_won"
            | "won"
            | "paid"
            | "revenue_verified"
            | "pass"
    );
    VerifiedEntryOutcomeOutput { verified }
}

pub fn compute_verified_revenue_action(
    input: &VerifiedRevenueActionInput,
) -> VerifiedRevenueActionOutput {
    if input.verified || input.outcome_verified {
        return VerifiedRevenueActionOutput { verified: true };
    }
    let status = input
        .status
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let verified = matches!(
        status.as_str(),
        "verified" | "won" | "paid" | "closed_won" | "received"
    );
    VerifiedRevenueActionOutput { verified }
}

pub fn compute_minutes_until_next_utc_day(
    input: &MinutesUntilNextUtcDayInput,
) -> MinutesUntilNextUtcDayOutput {
    let now = input
        .now_ms
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    if !now.is_finite() || now <= 0.0 {
        return MinutesUntilNextUtcDayOutput { minutes: 0.0 };
    }
    let Some(now_dt) = DateTime::<Utc>::from_timestamp_millis(now as i64) else {
        return MinutesUntilNextUtcDayOutput { minutes: 0.0 };
    };
    let next_day = DateTime::<Utc>::from_naive_utc_and_offset(
        now_dt
            .date_naive()
            .and_hms_milli_opt(0, 0, 0, 0)
            .expect("valid midnight")
            + Duration::days(1),
        Utc,
    );
    let delta_ms = (next_day.timestamp_millis() - now_dt.timestamp_millis()).max(0) as f64;
    let minutes = (delta_ms / 60000.0).ceil().max(0.0);
    MinutesUntilNextUtcDayOutput { minutes }
}

pub fn compute_age_hours(input: &AgeHoursInput) -> AgeHoursOutput {
    let date = input.date.as_deref().unwrap_or("").trim();
    if date.is_empty() {
        return AgeHoursOutput { age_hours: 0.0 };
    }
    let Ok(parsed_date) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return AgeHoursOutput { age_hours: 0.0 };
    };
    let Some(start_naive) = parsed_date.and_hms_milli_opt(0, 0, 0, 0) else {
        return AgeHoursOutput { age_hours: 0.0 };
    };
    let start = DateTime::<Utc>::from_naive_utc_and_offset(start_naive, Utc);
    let now_ms = input
        .now_ms
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    let age_hours = ((now_ms - start.timestamp_millis() as f64) / 3_600_000.0).max(0.0);
    AgeHoursOutput { age_hours }
}

pub fn compute_url_domain(input: &UrlDomainInput) -> UrlDomainOutput {
    let raw = input.url.as_deref().unwrap_or("").trim();
    if raw.is_empty() {
        return UrlDomainOutput {
            domain: String::new(),
        };
    }
    let Some((_, rest)) = raw.split_once("://") else {
        return UrlDomainOutput {
            domain: String::new(),
        };
    };
    let host_port = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if host_port.is_empty() {
        return UrlDomainOutput {
            domain: String::new(),
        };
    }
    let without_auth = host_port.rsplit('@').next().unwrap_or("");
    let host = if without_auth.starts_with('[') {
        without_auth
            .split(']')
            .next()
            .map(|v| format!("{v}]"))
            .unwrap_or_else(String::new)
    } else {
        without_auth.split(':').next().unwrap_or("").to_string()
    };
    UrlDomainOutput { domain: host }
}

pub fn compute_domain_allowed(input: &DomainAllowedInput) -> DomainAllowedOutput {
    let domain = input
        .domain
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if domain.is_empty() {
        return DomainAllowedOutput { allowed: false };
    }
    if input.allowlist.is_empty() {
        return DomainAllowedOutput { allowed: true };
    }
    let allowed = input.allowlist.iter().any(|raw| {
        let allowed_domain = raw.trim().to_ascii_lowercase();
        if allowed_domain.is_empty() {
            return false;
        }
        domain == allowed_domain || domain.ends_with(&format!(".{allowed_domain}"))
    });
    DomainAllowedOutput { allowed }
}

pub fn compute_is_execute_mode(input: &IsExecuteModeInput) -> IsExecuteModeOutput {
    let mode = input.execution_mode.as_deref().unwrap_or("");
    IsExecuteModeOutput {
        execute_mode: mode == "execute" || mode == "canary_execute",
    }
}

pub fn compute_execution_allowed_by_feature_flag(
    input: &ExecutionAllowedByFeatureFlagInput,
) -> ExecutionAllowedByFeatureFlagOutput {
    if input.shadow_only {
        return ExecutionAllowedByFeatureFlagOutput { allowed: true };
    }
    if input.autonomy_enabled {
        return ExecutionAllowedByFeatureFlagOutput { allowed: true };
    }
    let canary = input.execution_mode.as_deref().unwrap_or("");
    ExecutionAllowedByFeatureFlagOutput {
        allowed: input.canary_allow_with_flag_off && canary == "canary_execute",
    }
}

pub fn compute_is_tier1_objective_id(input: &IsTier1ObjectiveIdInput) -> IsTier1ObjectiveIdOutput {
    let id = input.objective_id.as_deref().unwrap_or("").trim();
    if id.is_empty() {
        return IsTier1ObjectiveIdOutput { tier1: false };
    }
    let re = Regex::new(r"(?i)^T1(?:\b|[_:-])").expect("valid tier1 objective regex");
    IsTier1ObjectiveIdOutput {
        tier1: re.is_match(id),
    }
}

pub fn compute_is_tier1_candidate_objective(
    input: &IsTier1CandidateObjectiveInput,
) -> IsTier1CandidateObjectiveOutput {
    let pulse_tier = compute_normalize_directive_tier(&NormalizeDirectiveTierInput {
        raw_tier: input.directive_pulse_tier,
        fallback: Some(99.0),
    })
    .tier;
    if pulse_tier <= 1 {
        return IsTier1CandidateObjectiveOutput { tier1: true };
    }
    let by_binding = compute_is_tier1_objective_id(&IsTier1ObjectiveIdInput {
        objective_id: input.objective_binding_objective_id.clone(),
    })
    .tier1;
    if by_binding {
        return IsTier1CandidateObjectiveOutput { tier1: true };
    }
    let by_pulse = compute_is_tier1_objective_id(&IsTier1ObjectiveIdInput {
        objective_id: input.directive_pulse_objective_id.clone(),
    })
    .tier1;
    IsTier1CandidateObjectiveOutput { tier1: by_pulse }
}

pub fn compute_needs_execution_quota(
    input: &NeedsExecutionQuotaInput,
) -> NeedsExecutionQuotaOutput {
    if input.shadow_only {
        return NeedsExecutionQuotaOutput { required: false };
    }
    let execute_mode = compute_is_execute_mode(&IsExecuteModeInput {
        execution_mode: input.execution_mode.clone(),
    })
    .execute_mode;
    if !execute_mode {
        return NeedsExecutionQuotaOutput { required: false };
    }
    if !input.min_daily_executions.is_finite() || input.min_daily_executions <= 0.0 {
        return NeedsExecutionQuotaOutput { required: false };
    }
    NeedsExecutionQuotaOutput {
        required: input.executed_today < input.min_daily_executions,
    }
}

pub fn compute_normalize_criteria_metric(
    input: &NormalizeCriteriaMetricInput,
) -> NormalizeCriteriaMetricOutput {
    let normalized = normalize_spaces(input.value.as_deref().unwrap_or(""));
    let metric = Regex::new(r"[\s-]+")
        .expect("valid criteria metric regex")
        .replace_all(&normalized.to_ascii_lowercase(), "_")
        .to_string();
    NormalizeCriteriaMetricOutput { metric }
}

pub fn compute_escape_reg_exp(input: &EscapeRegExpInput) -> EscapeRegExpOutput {
    let value = input.value.as_deref().unwrap_or("");
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(
            ch,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    EscapeRegExpOutput { escaped }
}

pub fn compute_tool_token_mentioned(input: &ToolTokenMentionedInput) -> ToolTokenMentionedOutput {
    let text = input.blob.as_deref().unwrap_or("");
    let tok = input
        .token
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if text.is_empty() || tok.is_empty() {
        return ToolTokenMentionedOutput { mentioned: false };
    }
    let escaped = compute_escape_reg_exp(&EscapeRegExpInput {
        value: Some(tok.clone()),
    })
    .escaped;
    let exact_re = Regex::new(&format!(r"\b{}\b", escaped)).expect("valid exact tool token regex");
    if exact_re.is_match(text) {
        return ToolTokenMentionedOutput { mentioned: true };
    }
    if tok == "bird_x" {
        let bird_re = Regex::new(r"\bbird[\s_-]*x\b").expect("valid bird_x regex");
        if bird_re.is_match(text) {
            return ToolTokenMentionedOutput { mentioned: true };
        }
    }
    ToolTokenMentionedOutput { mentioned: false }
}

pub fn compute_policy_hold_reason_from_event(
    input: &PolicyHoldReasonFromEventInput,
) -> PolicyHoldReasonFromEventOutput {
    let hold_reason = normalize_spaces(input.hold_reason.as_deref().unwrap_or(""));
    let route_block = normalize_spaces(input.route_block_reason.as_deref().unwrap_or(""));
    let explicit = if !hold_reason.is_empty() {
        hold_reason.to_ascii_lowercase()
    } else {
        route_block.to_ascii_lowercase()
    };
    if !explicit.is_empty() {
        return PolicyHoldReasonFromEventOutput { reason: explicit };
    }
    let result = normalize_spaces(input.result.as_deref().unwrap_or("")).to_ascii_lowercase();
    if !result.is_empty() {
        return PolicyHoldReasonFromEventOutput { reason: result };
    }
    PolicyHoldReasonFromEventOutput {
        reason: "policy_hold_unknown".to_string(),
    }
}

pub fn compute_strategy_marker_tokens(
    input: &StrategyMarkerTokensInput,
) -> StrategyMarkerTokensOutput {
    let mut token_set = std::collections::BTreeSet::new();
    let mut text_parts: Vec<String> = Vec::new();
    if let Some(primary) = input.objective_primary.as_ref() {
        text_parts.push(primary.clone());
    }
    if let Some(metric) = input.objective_fitness_metric.as_ref() {
        text_parts.push(metric.clone());
    }
    text_parts.extend(input.objective_secondary.iter().cloned());
    text_parts.extend(input.tags.iter().cloned());

    for part in text_parts {
        let normalized =
            compute_normalize_directive_text(&NormalizeDirectiveTextInput { text: Some(part) })
                .normalized;
        if normalized.is_empty() {
            continue;
        }
        let tokenized = compute_tokenize_directive_text(&TokenizeDirectiveTextInput {
            text: Some(normalized),
            stopwords: Vec::new(),
        })
        .tokens;
        for token in tokenized {
            token_set.insert(token);
        }
    }
    StrategyMarkerTokensOutput {
        tokens: token_set.into_iter().collect(),
    }
}

pub fn compute_capability_cooldown_key(
    input: &CapabilityCooldownKeyInput,
) -> CapabilityCooldownKeyOutput {
    let raw = input
        .capability_key
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if raw.is_empty() {
        return CapabilityCooldownKeyOutput {
            cooldown_key: String::new(),
        };
    }
    let normalized = Regex::new(r"[^a-z0-9:_-]")
        .expect("valid capability cooldown key regex")
        .replace_all(&raw, "_")
        .to_string();
    CapabilityCooldownKeyOutput {
        cooldown_key: format!("capability:{normalized}"),
    }
}

pub fn compute_readiness_retry_cooldown_key(
    input: &ReadinessRetryCooldownKeyInput,
) -> ReadinessRetryCooldownKeyOutput {
    let sid = normalize_spaces(input.strategy_id.as_deref().unwrap_or("")).to_ascii_lowercase();
    let sid = Regex::new(r"[^a-z0-9:_-]")
        .expect("valid readiness strategy regex")
        .replace_all(&sid, "_")
        .to_string();
    if sid.is_empty() {
        return ReadinessRetryCooldownKeyOutput {
            cooldown_key: String::new(),
        };
    }
    let mode = normalize_spaces(input.execution_mode.as_deref().unwrap_or("")).to_ascii_lowercase();
    let mode = Regex::new(r"[^a-z0-9:_-]")
        .expect("valid readiness mode regex")
        .replace_all(&mode, "_")
        .to_string();
    if mode.is_empty() {
        return ReadinessRetryCooldownKeyOutput {
            cooldown_key: format!("readiness:strategy:{sid}"),
        };
    }
    ReadinessRetryCooldownKeyOutput {
        cooldown_key: format!("readiness:strategy:{sid}:mode:{mode}"),
    }
}

pub fn compute_source_eye_id(input: &SourceEyeIdInput) -> SourceEyeIdOutput {
    let eye_ref = input.eye_ref.as_deref().unwrap_or("").trim();
    let eye_id = eye_ref.strip_prefix("eye:").unwrap_or(eye_ref).to_string();
    SourceEyeIdOutput { eye_id }
}

pub fn compute_deprioritized_source_proposal(
    input: &DeprioritizedSourceProposalInput,
) -> DeprioritizedSourceProposalOutput {
    let eye_id = input
        .eye_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if eye_id.is_empty() {
        return DeprioritizedSourceProposalOutput {
            deprioritized: false,
        };
    }
    let deprioritized = input
        .deprioritized_eye_ids
        .iter()
        .any(|row| row.trim().eq_ignore_ascii_case(&eye_id));
    DeprioritizedSourceProposalOutput { deprioritized }
}

pub fn compute_composite_eligibility_min(
    input: &CompositeEligibilityMinInput,
) -> CompositeEligibilityMinOutput {
    let normalized = normalize_risk_level(input.risk.as_deref().unwrap_or(""));
    let base_min = input.base_min;
    if normalized != "low" || input.execution_mode.as_deref().unwrap_or("") != "canary_execute" {
        return CompositeEligibilityMinOutput {
            min_score: base_min,
        };
    }
    let relax = input.canary_low_risk_relax.max(0.0);
    CompositeEligibilityMinOutput {
        min_score: (base_min - relax).max(55.0),
    }
}

pub fn compute_clamp_threshold(input: &ClampThresholdInput) -> ClampThresholdOutput {
    let name = input.name.as_deref().unwrap_or("").trim();
    let (lo, hi) = match name {
        "min_signal_quality" => (40.0, 90.0),
        "min_sensory_signal_score" => (35.0, 85.0),
        "min_sensory_relevance_score" => (35.0, 85.0),
        "min_directive_fit" => (25.0, 90.0),
        "min_actionability_score" => (30.0, 90.0),
        "min_eye_score_ema" => (30.0, 90.0),
        _ => (0.0, 100.0),
    };
    let rounded = if input.value.is_finite() {
        input.value.round()
    } else {
        0.0
    };
    let threshold = rounded.max(lo).min(hi);
    ClampThresholdOutput { threshold }
}

pub fn compute_applied_thresholds(input: &AppliedThresholdsInput) -> AppliedThresholdsOutput {
    let mut out = std::collections::BTreeMap::new();
    for (key, base_val) in input.base.iter() {
        if !base_val.is_finite() {
            continue;
        }
        let delta = input.deltas.get(key).copied().unwrap_or(0.0);
        let clamped = compute_clamp_threshold(&ClampThresholdInput {
            name: Some(key.clone()),
            value: base_val + delta,
        })
        .threshold;
        out.insert(key.clone(), clamped);
    }
    AppliedThresholdsOutput { thresholds: out }
}

pub fn compute_extract_eye_from_evidence_ref(
    input: &ExtractEyeFromEvidenceRefInput,
) -> ExtractEyeFromEvidenceRefOutput {
    let text = input.reference.as_deref().unwrap_or("");
    let re = Regex::new(r"\beye:([^\s]+)").expect("valid eye ref regex");
    let eye_id = re
        .captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string());
    ExtractEyeFromEvidenceRefOutput { eye_id }
}

pub fn compute_total_outcomes(input: &TotalOutcomesInput) -> TotalOutcomesOutput {
    let total = input.shipped + input.no_change + input.reverted;
    TotalOutcomesOutput { total }
}

pub fn compute_derive_entity_bias(input: &DeriveEntityBiasInput) -> DeriveEntityBiasOutput {
    let total = compute_total_outcomes(&TotalOutcomesInput {
        shipped: input.shipped,
        no_change: input.no_change,
        reverted: input.reverted,
    })
    .total;
    if total < input.min_total {
        return DeriveEntityBiasOutput { bias: 0.0, total };
    }
    let shipped_rate = if total > 0.0 {
        input.shipped / total
    } else {
        0.0
    };
    let churn_rate = if total > 0.0 {
        (input.no_change + input.reverted) / total
    } else {
        0.0
    };
    let bias = if shipped_rate >= 0.6 {
        -3.0
    } else if shipped_rate >= 0.45 {
        -2.0
    } else if churn_rate >= 0.8 {
        5.0
    } else if churn_rate >= 0.65 {
        3.0
    } else if churn_rate >= 0.5 {
        1.0
    } else {
        0.0
    };
    DeriveEntityBiasOutput { bias, total }
}

pub fn compute_build_overlay(input: &BuildOverlayInput) -> BuildOverlayOutput {
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, BuildOverlayEntryOutput> =
        std::collections::HashMap::new();
    for event in &input.events {
        let proposal_id = normalize_spaces(event.proposal_id.as_deref().unwrap_or(""));
        if proposal_id.is_empty() {
            continue;
        }
        if !map.contains_key(&proposal_id) {
            order.push(proposal_id.clone());
            map.insert(
                proposal_id.clone(),
                BuildOverlayEntryOutput {
                    proposal_id: proposal_id.clone(),
                    decision: None,
                    decision_ts: None,
                    decision_reason: None,
                    last_outcome: None,
                    last_outcome_ts: None,
                    last_evidence_ref: None,
                    outcomes: BuildOverlayOutcomeCountsOutput {
                        shipped: 0,
                        reverted: 0,
                        no_change: 0,
                    },
                },
            );
        }
        let Some(cur) = map.get_mut(&proposal_id) else {
            continue;
        };
        let event_type = normalize_spaces(event.event_type.as_deref().unwrap_or(""));
        let ts = event
            .ts
            .as_deref()
            .map(normalize_spaces)
            .unwrap_or_default();
        if event_type == "decision" {
            let decision = normalize_spaces(event.decision.as_deref().unwrap_or(""));
            if !decision.is_empty() {
                let newer = cur
                    .decision_ts
                    .as_deref()
                    .map(|row| ts.as_str() >= row)
                    .unwrap_or(true);
                if newer {
                    cur.decision = Some(decision);
                    cur.decision_ts = if ts.is_empty() {
                        None
                    } else {
                        Some(ts.clone())
                    };
                    let reason = normalize_spaces(event.reason.as_deref().unwrap_or(""));
                    cur.decision_reason = if reason.is_empty() {
                        None
                    } else {
                        Some(reason)
                    };
                }
            }
        } else if event_type == "outcome" {
            let outcome = normalize_spaces(event.outcome.as_deref().unwrap_or(""));
            if outcome == "shipped" {
                cur.outcomes.shipped += 1;
            } else if outcome == "reverted" {
                cur.outcomes.reverted += 1;
            } else if outcome == "no_change" {
                cur.outcomes.no_change += 1;
            }
            if !outcome.is_empty() {
                let newer = cur
                    .last_outcome_ts
                    .as_deref()
                    .map(|row| ts.as_str() >= row)
                    .unwrap_or(true);
                if newer {
                    cur.last_outcome = Some(outcome);
                    cur.last_outcome_ts = if ts.is_empty() {
                        None
                    } else {
                        Some(ts.clone())
                    };
                    let evidence_ref =
                        normalize_spaces(event.evidence_ref.as_deref().unwrap_or(""));
                    cur.last_evidence_ref = if evidence_ref.is_empty() {
                        None
                    } else {
                        Some(evidence_ref)
                    };
                }
            }
        }
    }
    let entries = order
        .into_iter()
        .filter_map(|proposal_id| map.remove(&proposal_id))
        .collect();
    BuildOverlayOutput { entries }
}

pub fn compute_has_adaptive_mutation_signal(
    input: &HasAdaptiveMutationSignalInput,
) -> HasAdaptiveMutationSignalOutput {
    let type_re = Regex::new(
        r"(?i)\b(adaptive[_-]?mutation|mutation(?:[_-]proposal)?|topology[_-]?mutation|genome[_-]?mutation|self[_-]?(?:mutation|modify)|branch[_-]?(?:rewire|prune))\b",
    )
    .expect("valid adaptive mutation type regex");
    let signal_re = Regex::new(
        r"(?i)\b(mutation(?:[_-]?(?:guard|policy|kernel|budget|ttl|quarantine|veto|rollback|lineage|attestation))?|topology[_-]?mutation|genome[_-]?mutation|self[_-]?(?:mutation|modify)|branch[_-]?(?:rewire|prune))\b",
    )
    .expect("valid adaptive mutation signal regex");
    let proposal_type = normalize_spaces(input.proposal_type.as_deref().unwrap_or(""));
    if !proposal_type.is_empty() && type_re.is_match(&proposal_type) {
        return HasAdaptiveMutationSignalOutput { has_signal: true };
    }
    if input.adaptive_mutation
        || input.mutation_proposal
        || input.topology_mutation
        || input.self_improvement_change
    {
        return HasAdaptiveMutationSignalOutput { has_signal: true };
    }
    let blob = input
        .signal_blob
        .as_deref()
        .map(normalize_spaces)
        .unwrap_or_default();
    if blob.is_empty() {
        return HasAdaptiveMutationSignalOutput { has_signal: false };
    }
    HasAdaptiveMutationSignalOutput {
        has_signal: type_re.is_match(&blob) || signal_re.is_match(&blob),
    }
}

pub fn compute_adaptive_mutation_execution_guard(
    input: &AdaptiveMutationExecutionGuardInput,
) -> AdaptiveMutationExecutionGuardOutput {
    if !input.guard_required {
        return AdaptiveMutationExecutionGuardOutput {
            required: false,
            applies: false,
            pass: true,
            reason: None,
            reasons: Vec::new(),
            controls: AdaptiveMutationExecutionGuardControlsOutput {
                safety_attestation: None,
                rollback_receipt: None,
                guard_receipt_id: None,
                mutation_kernel_applies: false,
                mutation_kernel_pass: true,
            },
        };
    }
    if !input.applies {
        return AdaptiveMutationExecutionGuardOutput {
            required: true,
            applies: false,
            pass: true,
            reason: None,
            reasons: Vec::new(),
            controls: AdaptiveMutationExecutionGuardControlsOutput {
                safety_attestation: None,
                rollback_receipt: None,
                guard_receipt_id: None,
                mutation_kernel_applies: false,
                mutation_kernel_pass: true,
            },
        };
    }

    let safety_attestation = normalize_spaces(input.safety_attestation.as_deref().unwrap_or(""));
    let rollback_receipt = normalize_spaces(input.rollback_receipt.as_deref().unwrap_or(""));
    let guard_receipt_id = normalize_spaces(input.guard_receipt_id.as_deref().unwrap_or(""));
    let mut reasons: Vec<String> = Vec::new();
    if !input.metadata_applies {
        reasons.push("adaptive_mutation_guard_metadata_missing".to_string());
    }
    if !input.guard_pass {
        let reason = normalize_spaces(
            input
                .guard_reason
                .as_deref()
                .unwrap_or("adaptive_mutation_guard_failed"),
        );
        reasons.push(if reason.is_empty() {
            "adaptive_mutation_guard_failed".to_string()
        } else {
            reason
        });
    }
    if safety_attestation.is_empty() {
        reasons.push("adaptive_mutation_missing_safety_attestation".to_string());
    }
    if rollback_receipt.is_empty() {
        reasons.push("adaptive_mutation_missing_rollback_receipt".to_string());
    }
    if guard_receipt_id.is_empty() {
        reasons.push("adaptive_mutation_missing_execution_guard_receipt".to_string());
    }
    if input.mutation_kernel_applies && !input.mutation_kernel_pass {
        reasons.push("adaptive_mutation_kernel_failed".to_string());
    }

    let mut uniq_reasons: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for reason in reasons {
        if reason.is_empty() || !seen.insert(reason.clone()) {
            continue;
        }
        uniq_reasons.push(reason);
    }
    let reason = uniq_reasons.first().cloned();
    AdaptiveMutationExecutionGuardOutput {
        required: true,
        applies: true,
        pass: uniq_reasons.is_empty(),
        reason,
        reasons: uniq_reasons,
        controls: AdaptiveMutationExecutionGuardControlsOutput {
            safety_attestation: if safety_attestation.is_empty() {
                None
            } else {
                Some(safety_attestation)
            },
            rollback_receipt: if rollback_receipt.is_empty() {
                None
            } else {
                Some(rollback_receipt)
            },
            guard_receipt_id: if guard_receipt_id.is_empty() {
                None
            } else {
                Some(guard_receipt_id)
            },
            mutation_kernel_applies: input.mutation_kernel_applies,
            mutation_kernel_pass: input.mutation_kernel_pass,
        },
    }
}

fn stable_selection_index(seed: &str, size: usize) -> usize {
    if size == 0 {
        return 0;
    }
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hash = hasher.finalize();
    let mut first_12 = String::with_capacity(12);
    for byte in hash[..6].iter() {
        first_12.push_str(&format!("{byte:02x}"));
    }
    let n = u64::from_str_radix(&first_12, 16).unwrap_or(0);
    (n % size as u64) as usize
}

pub fn compute_strategy_selection(input: &StrategySelectionInput) -> StrategySelectionOutput {
    let attempt_index = input.attempt_index.max(1.0).round() as u32;
    let mut variants: Vec<StrategySelectionRankedOutput> = input
        .variants
        .iter()
        .map(|row| StrategySelectionRankedOutput {
            strategy_id: normalize_spaces(row.strategy_id.as_deref().unwrap_or("")),
            score: if row.score.is_finite() {
                row.score
            } else {
                0.0
            },
            confidence: if row.confidence.is_finite() {
                row.confidence
            } else {
                0.0
            },
            stage: row
                .stage
                .as_ref()
                .map(|v| normalize_spaces(v))
                .filter(|v| !v.is_empty()),
            execution_mode: normalize_spaces(row.execution_mode.as_deref().unwrap_or("")),
        })
        .filter(|row| !row.strategy_id.is_empty())
        .collect();

    variants.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.strategy_id.cmp(&b.strategy_id))
    });
    let max_active = input.max_active.max(1.0).round() as usize;
    if variants.len() > max_active {
        variants.truncate(max_active);
    }

    let fallback_id = normalize_spaces(input.fallback_strategy_id.as_deref().unwrap_or(""));
    if variants.is_empty() {
        return StrategySelectionOutput {
            selected_strategy_id: if fallback_id.is_empty() {
                None
            } else {
                Some(fallback_id)
            },
            mode: "none".to_string(),
            canary_enabled: input.canary_enabled,
            canary_due: false,
            canary_every: None,
            attempt_index,
            active_count: 0,
            ranked: Vec::new(),
        };
    }

    let default_id = variants
        .first()
        .map(|row| row.strategy_id.clone())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            if fallback_id.is_empty() {
                None
            } else {
                Some(fallback_id.clone())
            }
        });

    let canary_pool: Vec<StrategySelectionRankedOutput> = variants
        .iter()
        .enumerate()
        .filter_map(|(idx, row)| {
            if idx == 0 {
                return None;
            }
            if input.canary_allow_execute {
                return Some(row.clone());
            }
            if row.execution_mode != "execute" {
                return Some(row.clone());
            }
            None
        })
        .collect();

    let canary_every = if input.canary_fraction.is_finite() && input.canary_fraction > 0.0 {
        Some((1.0 / input.canary_fraction).round().max(2.0) as u32)
    } else {
        None
    };
    let canary_due = input.canary_enabled
        && !canary_pool.is_empty()
        && canary_every
            .map(|every| attempt_index.is_multiple_of(every))
            .unwrap_or(false);
    let selected_strategy_id = if canary_due {
        let pool_ids: Vec<String> = canary_pool
            .iter()
            .map(|row| row.strategy_id.clone())
            .collect();
        let seed = format!(
            "{}|{}|{}",
            normalize_spaces(input.date_str.as_deref().unwrap_or("")),
            attempt_index,
            pool_ids.join(",")
        );
        let idx = stable_selection_index(&seed, canary_pool.len());
        canary_pool
            .get(idx)
            .map(|row| row.strategy_id.clone())
            .filter(|row| !row.is_empty())
            .or_else(|| default_id.clone())
    } else {
        default_id.clone()
    };

    StrategySelectionOutput {
        selected_strategy_id,
        mode: if canary_due {
            "canary_variant".to_string()
        } else {
            "primary_best".to_string()
        },
        canary_enabled: input.canary_enabled,
        canary_due,
        canary_every,
        attempt_index,
        active_count: variants.len() as u32,
        ranked: variants,
    }
}

pub fn compute_calibration_deltas(input: &CalibrationDeltasInput) -> CalibrationDeltasOutput {
    let mut out = CalibrationDeltasOutput {
        min_signal_quality: 0.0,
        min_sensory_signal_score: 0.0,
        min_sensory_relevance_score: 0.0,
        min_directive_fit: 0.0,
        min_actionability_score: 0.0,
        min_eye_score_ema: 0.0,
    };
    let executed_count = input.executed_count.max(0.0);
    let shipped_rate = input.shipped_rate;
    let no_change_rate = input.no_change_rate;
    let reverted_rate = input.reverted_rate;
    let exhausted = input.exhausted.max(0.0);
    let min_executed = input.min_executed.max(0.0);
    let tighten_min_executed = input.tighten_min_executed.max(0.0);
    let loosen_low_shipped_rate = input.loosen_low_shipped_rate;
    let loosen_exhausted_threshold = input.loosen_exhausted_threshold.max(0.0);
    let tighten_min_shipped_rate = input.tighten_min_shipped_rate;
    let max_delta = input.max_delta.max(0.0);

    let tighten_eligible = executed_count >= min_executed.max(tighten_min_executed);
    let loosen_eligible = executed_count >= min_executed;
    let low_ship_high_exhaustion = loosen_eligible
        && shipped_rate < loosen_low_shipped_rate
        && exhausted >= loosen_exhausted_threshold;

    if low_ship_high_exhaustion {
        out.min_signal_quality -= 3.0;
        out.min_directive_fit -= 3.0;
        out.min_actionability_score -= 2.0;
        out.min_sensory_relevance_score -= 1.0;
    } else if tighten_eligible {
        if no_change_rate >= 0.6 && shipped_rate >= tighten_min_shipped_rate {
            out.min_signal_quality += 3.0;
            out.min_directive_fit += 3.0;
            out.min_actionability_score += 2.0;
            out.min_sensory_relevance_score += 2.0;
        }
        if reverted_rate >= 0.15 {
            out.min_signal_quality += 2.0;
            out.min_actionability_score += 2.0;
        }
        if shipped_rate >= 0.45 && exhausted >= 2.0 {
            out.min_signal_quality -= 2.0;
            out.min_directive_fit -= 2.0;
            out.min_actionability_score -= 1.0;
        }
    } else if exhausted >= 3.0 {
        out.min_signal_quality -= 1.0;
        out.min_directive_fit -= 1.0;
    }

    out.min_signal_quality = out.min_signal_quality.clamp(-max_delta, max_delta);
    out.min_sensory_signal_score = out.min_sensory_signal_score.clamp(-max_delta, max_delta);
    out.min_sensory_relevance_score = out.min_sensory_relevance_score.clamp(-max_delta, max_delta);
    out.min_directive_fit = out.min_directive_fit.clamp(-max_delta, max_delta);
    out.min_actionability_score = out.min_actionability_score.clamp(-max_delta, max_delta);
    out.min_eye_score_ema = out.min_eye_score_ema.clamp(-max_delta, max_delta);
    out
}

pub fn compute_strategy_admission_decision(
    input: &StrategyAdmissionDecisionInput,
) -> StrategyAdmissionDecisionOutput {
    let preview_blocked: Vec<String> = input
        .preview_blocked_by
        .iter()
        .map(|row| normalize_spaces(row))
        .filter(|row| !row.is_empty())
        .take(6)
        .collect();
    if input.require_admission_preview && !input.preview_eligible {
        return StrategyAdmissionDecisionOutput {
            allow: false,
            reason: Some(
                preview_blocked
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "admission_preview_blocked".to_string()),
            ),
            admission_preview: Some(StrategyAdmissionPreviewOutput {
                eligible: false,
                blocked_by: preview_blocked,
            }),
            mutation_guard: None,
            risk_score: None,
            max_risk_per_action: None,
            strategy_max_risk_per_action: None,
            hard_max_risk_per_action: None,
            duplicate_window_hours: None,
            recent_count: None,
        };
    }

    if let Some(guard) = input.mutation_guard.as_ref() {
        if guard.applies && !guard.pass {
            return StrategyAdmissionDecisionOutput {
                allow: false,
                reason: Some(
                    normalize_spaces(guard.reason.as_deref().unwrap_or(""))
                        .chars()
                        .collect::<String>(),
                )
                .filter(|row| !row.is_empty())
                .or_else(|| Some("adaptive_mutation_execution_guard_blocked".to_string())),
                admission_preview: None,
                mutation_guard: Some(guard.clone()),
                risk_score: None,
                max_risk_per_action: None,
                strategy_max_risk_per_action: None,
                hard_max_risk_per_action: None,
                duplicate_window_hours: None,
                recent_count: None,
            };
        }
    }

    if !input.strategy_type_allowed {
        return StrategyAdmissionDecisionOutput {
            allow: false,
            reason: Some("strategy_type_filtered".to_string()),
            admission_preview: None,
            mutation_guard: None,
            risk_score: None,
            max_risk_per_action: None,
            strategy_max_risk_per_action: None,
            hard_max_risk_per_action: None,
            duplicate_window_hours: None,
            recent_count: None,
        };
    }

    if let Some(max_risk) = input.max_risk_per_action {
        let risk_score = input.risk_score.unwrap_or(0.0);
        if risk_score > max_risk {
            return StrategyAdmissionDecisionOutput {
                allow: false,
                reason: Some("strategy_risk_cap_exceeded".to_string()),
                admission_preview: None,
                mutation_guard: None,
                risk_score: Some(risk_score),
                max_risk_per_action: Some(max_risk),
                strategy_max_risk_per_action: input.strategy_max_risk_per_action,
                hard_max_risk_per_action: input.hard_max_risk_per_action,
                duplicate_window_hours: None,
                recent_count: None,
            };
        }
    }

    if input.remediation_check_required {
        let depth = input.remediation_depth.unwrap_or(0.0);
        let max_depth = input.remediation_max_depth.unwrap_or(f64::INFINITY);
        if depth > max_depth {
            return StrategyAdmissionDecisionOutput {
                allow: false,
                reason: Some("strategy_remediation_depth_exceeded".to_string()),
                admission_preview: None,
                mutation_guard: None,
                risk_score: None,
                max_risk_per_action: None,
                strategy_max_risk_per_action: None,
                hard_max_risk_per_action: None,
                duplicate_window_hours: None,
                recent_count: None,
            };
        }
    }

    let dedup_key = normalize_spaces(input.dedup_key.as_deref().unwrap_or(""));
    let recent_count = input.recent_count.unwrap_or(0.0);
    if !dedup_key.is_empty() && recent_count > 0.0 {
        return StrategyAdmissionDecisionOutput {
            allow: false,
            reason: Some("strategy_duplicate_window".to_string()),
            admission_preview: None,
            mutation_guard: None,
            risk_score: None,
            max_risk_per_action: None,
            strategy_max_risk_per_action: None,
            hard_max_risk_per_action: None,
            duplicate_window_hours: input.duplicate_window_hours,
            recent_count: Some(recent_count),
        };
    }

    StrategyAdmissionDecisionOutput {
        allow: true,
        reason: None,
        admission_preview: None,
        mutation_guard: None,
        risk_score: None,
        max_risk_per_action: None,
        strategy_max_risk_per_action: None,
        hard_max_risk_per_action: None,
        duplicate_window_hours: None,
        recent_count: None,
    }
}

pub fn compute_expected_value_score(input: &ExpectedValueScoreInput) -> ExpectedValueScoreOutput {
    let score = if input.score.is_finite() {
        input.score
    } else {
        0.0
    };
    ExpectedValueScoreOutput { score }
}

pub fn compute_suggest_run_batch_max(input: &SuggestRunBatchMaxInput) -> SuggestRunBatchMaxOutput {
    SuggestRunBatchMaxOutput {
        enabled: input.enabled,
        max: if input.batch_max.is_finite() {
            input.batch_max.max(1.0).floor()
        } else {
            1.0
        },
        reason: normalize_spaces(input.batch_reason.as_deref().unwrap_or("no_pressure")),
        daily_remaining: if input.daily_remaining.is_finite() {
            input.daily_remaining.max(0.0).floor()
        } else {
            0.0
        },
        autoscale_hint: input.autoscale_hint.clone(),
    }
}

pub fn compute_backlog_autoscale_snapshot(
    input: &BacklogAutoscaleSnapshotInput,
) -> BacklogAutoscaleSnapshotOutput {
    BacklogAutoscaleSnapshotOutput {
        enabled: input.enabled,
        module: normalize_spaces(input.module.as_deref().unwrap_or("")),
        state: input.state.clone(),
        queue: input.queue.clone(),
        current_cells: if input.current_cells.is_finite() {
            input.current_cells
        } else {
            0.0
        },
        plan: input.plan.clone(),
        trit_productivity: input.trit_productivity.clone(),
    }
}

pub fn compute_admission_summary(input: &AdmissionSummaryInput) -> AdmissionSummaryOutput {
    let mut eligible: u32 = 0;
    let mut blocked: u32 = 0;
    let mut blocked_by_reason = std::collections::BTreeMap::<String, u32>::new();
    for row in &input.proposals {
        let is_eligible = row.preview_eligible.unwrap_or(true);
        if is_eligible {
            eligible = eligible.saturating_add(1);
            continue;
        }
        blocked = blocked.saturating_add(1);
        if row.blocked_by.is_empty() {
            *blocked_by_reason.entry("unknown".to_string()).or_insert(0) += 1;
            continue;
        }
        for reason in &row.blocked_by {
            let key = reason.split_whitespace().collect::<Vec<_>>().join(" ");
            let normalized = if key.is_empty() {
                "unknown".to_string()
            } else {
                key
            };
            *blocked_by_reason.entry(normalized).or_insert(0) += 1;
        }
    }
    AdmissionSummaryOutput {
        total: input.proposals.len() as u32,
        eligible,
        blocked,
        blocked_by_reason,
    }
}

pub fn compute_unknown_type_quarantine_decision(
    input: &UnknownTypeQuarantineDecisionInput,
) -> UnknownTypeQuarantineDecisionOutput {
    let proposal_type = input
        .proposal_type
        .as_ref()
        .map(|v| {
            v.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        })
        .filter(|v| !v.is_empty());
    if !input.enabled {
        return UnknownTypeQuarantineDecisionOutput {
            block: false,
            proposal_type,
            reason: None,
            objective_id: None,
        };
    }
    if !input.type_in_quarantine_set {
        return UnknownTypeQuarantineDecisionOutput {
            block: false,
            proposal_type,
            reason: None,
            objective_id: None,
        };
    }
    let is_directive = matches!(
        proposal_type.as_deref(),
        Some("directive_clarification") | Some("directive_decomposition")
    );
    if input.allow_directive && is_directive {
        return UnknownTypeQuarantineDecisionOutput {
            block: false,
            proposal_type,
            reason: Some("directive_exempt".to_string()),
            objective_id: None,
        };
    }
    let objective_id = input
        .objective_id
        .as_ref()
        .map(|v| v.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|v| !v.is_empty());
    if input.allow_tier1 && input.tier1_objective {
        return UnknownTypeQuarantineDecisionOutput {
            block: false,
            proposal_type,
            reason: Some("tier1_objective_exempt".to_string()),
            objective_id,
        };
    }
    UnknownTypeQuarantineDecisionOutput {
        block: true,
        proposal_type,
        reason: Some("unknown_type_quarantine".to_string()),
        objective_id,
    }
}

pub fn compute_infer_optimization_delta(
    input: &InferOptimizationDeltaInput,
) -> InferOptimizationDeltaOutput {
    let direct_keys = [
        (
            input.optimization_delta_percent,
            "meta:optimization_delta_percent",
        ),
        (
            input.expected_optimization_percent,
            "meta:expected_optimization_percent",
        ),
        (input.expected_delta_percent, "meta:expected_delta_percent"),
        (
            input.estimated_improvement_percent,
            "meta:estimated_improvement_percent",
        ),
        (
            input.target_improvement_percent,
            "meta:target_improvement_percent",
        ),
        (
            input.performance_gain_percent,
            "meta:performance_gain_percent",
        ),
    ];
    for (value, source) in direct_keys {
        let Some(raw) = value else {
            continue;
        };
        if raw.is_finite() && raw > 0.0 {
            return InferOptimizationDeltaOutput {
                delta_percent: Some(round3(raw.clamp(0.0, 100.0))),
                delta_source: Some(source.to_string()),
            };
        }
    }
    let values = compute_percent_mentions_from_text(&PercentMentionsFromTextInput {
        text: input.text_blob.clone(),
    })
    .values;
    if values.is_empty() {
        return InferOptimizationDeltaOutput {
            delta_percent: None,
            delta_source: None,
        };
    }
    let max_val = values
        .into_iter()
        .fold(0.0_f64, |acc, v| if v > acc { v } else { acc });
    InferOptimizationDeltaOutput {
        delta_percent: Some(round3(max_val)),
        delta_source: Some("text:%".to_string()),
    }
}

pub fn compute_optimization_intent_proposal(
    input: &OptimizationIntentProposalInput,
) -> OptimizationIntentProposalOutput {
    let proposal_type = input
        .proposal_type
        .as_ref()
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_default();
    let blob = input.blob.as_deref().unwrap_or("");
    let canary_smoke_re = Regex::new(r"(?i)\bcanary\b|\bsmoke\s*test\b").expect("valid regex");
    let type_is_actuation = proposal_type.starts_with("actuation_")
        || proposal_type == "actuation"
        || input.has_actuation_meta;
    if type_is_actuation && canary_smoke_re.is_match(blob) {
        return OptimizationIntentProposalOutput { intent: false };
    }
    let intent_re = Regex::new(
        r"(?i)\b(optimi[sz]e|optimization|improv(?:e|ement)|tune|polish|streamlin|efficien(?:cy|t)|latency|throughput|cost|token(?:s)?|performance)\b",
    )
    .expect("valid regex");
    let has_intent = intent_re.is_match(&proposal_type) || intent_re.is_match(blob);
    if !has_intent {
        return OptimizationIntentProposalOutput { intent: false };
    }
    let exempt_re = Regex::new(
        r"(?i)\b(fail(?:ure)?|error|outage|broken|incident|security|integrity|violation|breach|timeout|rate\s*limit|dns|connection|recover|restore|rollback|revert|remediation)\b",
    )
    .expect("valid regex");
    if exempt_re.is_match(&proposal_type) || exempt_re.is_match(blob) {
        return OptimizationIntentProposalOutput { intent: false };
    }
    let opportunity_re = Regex::new(
        r"(?i)\b(opportunity|freelance|job|jobs|hiring|contract|contractor|gig|client|rfp|request for proposal|seeking|looking for)\b",
    )
    .expect("valid regex");
    if opportunity_re.is_match(blob) {
        return OptimizationIntentProposalOutput { intent: false };
    }
    OptimizationIntentProposalOutput { intent: true }
}

pub fn compute_unlinked_optimization_admission(
    input: &UnlinkedOptimizationAdmissionInput,
) -> UnlinkedOptimizationAdmissionOutput {
    if !input.optimization_intent {
        return UnlinkedOptimizationAdmissionOutput {
            applies: false,
            linked: true,
            penalty: 0.0,
            block: false,
            reason: None,
        };
    }
    let proposal_type = input
        .proposal_type
        .as_ref()
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_default();
    let exempt: std::collections::BTreeSet<String> = input
        .exempt_types
        .iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();
    if !proposal_type.is_empty() && exempt.contains(&proposal_type) {
        return UnlinkedOptimizationAdmissionOutput {
            applies: true,
            linked: true,
            penalty: 0.0,
            block: false,
            reason: Some("optimization_exempt_type".to_string()),
        };
    }
    if input.linked {
        return UnlinkedOptimizationAdmissionOutput {
            applies: true,
            linked: true,
            penalty: 0.0,
            block: false,
            reason: None,
        };
    }
    let normalized_risk = input
        .normalized_risk
        .as_ref()
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_else(|| "low".to_string());
    let high_risk_block = input.hard_block_high_risk && normalized_risk == "high";
    UnlinkedOptimizationAdmissionOutput {
        applies: true,
        linked: false,
        penalty: if input.penalty.is_finite() {
            input.penalty
        } else {
            0.0
        },
        block: high_risk_block,
        reason: Some(if high_risk_block {
            "optimization_unlinked_objective_high_risk_block".to_string()
        } else {
            "optimization_unlinked_objective_penalty".to_string()
        }),
    }
}

pub fn compute_optimization_good_enough(
    input: &OptimizationGoodEnoughInput,
) -> OptimizationGoodEnoughOutput {
    let mode = if input.high_accuracy_mode {
        "high_accuracy".to_string()
    } else {
        "default".to_string()
    };
    let risk = input
        .normalized_risk
        .as_ref()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| v == "high" || v == "medium" || v == "low")
        .unwrap_or_else(|| "low".to_string());
    if !input.applies {
        return OptimizationGoodEnoughOutput {
            applies: false,
            pass: true,
            reason: None,
            delta_percent: None,
            delta_source: None,
            min_delta_percent: input.min_delta_percent,
            require_delta: input.require_delta,
            mode,
            risk,
        };
    }
    let delta_percent = input.delta_percent.filter(|v| v.is_finite());
    if delta_percent.is_none() && input.require_delta {
        return OptimizationGoodEnoughOutput {
            applies: true,
            pass: false,
            reason: Some("optimization_delta_missing".to_string()),
            delta_percent: None,
            delta_source: None,
            min_delta_percent: input.min_delta_percent,
            require_delta: true,
            mode,
            risk,
        };
    }
    if let Some(delta) = delta_percent {
        if delta < input.min_delta_percent {
            return OptimizationGoodEnoughOutput {
                applies: true,
                pass: false,
                reason: Some("optimization_good_enough".to_string()),
                delta_percent: Some(delta),
                delta_source: input.delta_source.clone(),
                min_delta_percent: input.min_delta_percent,
                require_delta: input.require_delta,
                mode,
                risk,
            };
        }
    }
    OptimizationGoodEnoughOutput {
        applies: true,
        pass: true,
        reason: None,
        delta_percent,
        delta_source: input.delta_source.clone(),
        min_delta_percent: input.min_delta_percent,
        require_delta: input.require_delta,
        mode,
        risk,
    }
}

pub fn compute_proposal_dependency_summary(
    input: &ProposalDependencySummaryInput,
) -> ProposalDependencySummaryOutput {
    let proposal_id = input
        .proposal_id
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let decision = input
        .decision
        .as_ref()
        .map(|v| {
            v.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_uppercase()
        })
        .unwrap_or_default();
    let source = input
        .source
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let parent = input
        .parent_objective_id
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let mut child_ids = Vec::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    for raw in &input.created_ids {
        let id = raw.trim().to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        child_ids.push(id);
        if child_ids.len() >= 16 {
            break;
        }
    }

    let mut nodes = Vec::<ProposalDependencySummaryNode>::new();
    let mut edges = Vec::<ProposalDependencySummaryEdge>::new();
    if let Some(parent_id) = parent.clone() {
        nodes.push(ProposalDependencySummaryNode {
            id: parent_id.clone(),
            kind: "directive".to_string(),
            role: "parent".to_string(),
        });
        for child_id in &child_ids {
            nodes.push(ProposalDependencySummaryNode {
                id: child_id.clone(),
                kind: "directive".to_string(),
                role: "child".to_string(),
            });
            edges.push(ProposalDependencySummaryEdge {
                from: parent_id.clone(),
                to: child_id.clone(),
                relation: "parent_child".to_string(),
            });
        }
    } else {
        for child_id in &child_ids {
            nodes.push(ProposalDependencySummaryNode {
                id: child_id.clone(),
                kind: "directive".to_string(),
                role: "child".to_string(),
            });
        }
    }

    let chain = if let Some(parent_id) = parent.clone() {
        let mut out = vec![parent_id];
        out.extend(child_ids.clone());
        out
    } else {
        child_ids.clone()
    };

    ProposalDependencySummaryOutput {
        proposal_id,
        decision,
        source,
        parent_objective_id: parent,
        child_objective_ids: child_ids.clone(),
        edge_count: edges.len() as u32,
        nodes: nodes.into_iter().take(20).collect(),
        edges: edges.into_iter().take(20).collect(),
        chain,
        dry_run: input.dry_run,
        created_count: input
            .created_count
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(child_ids.len() as f64),
        quality_ok: input.quality_ok,
        reason: input
            .reason
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
    }
}

pub fn compute_choose_selection_mode(
    input: &ChooseSelectionModeInput,
) -> ChooseSelectionModeOutput {
    let mut mode = "exploit".to_string();
    let mut index: u32 = 0;
    let eligible_len = input.eligible_len;
    let min_eligible = input.min_eligible.max(2);
    let every_n = input.every_n.max(1);
    if eligible_len >= min_eligible
        && input.explore_used < input.explore_quota
        && input.executed_count > 0
        && input.executed_count.is_multiple_of(every_n)
    {
        mode = "explore".to_string();
        let middle = ((eligible_len as f64) / 2.0).floor() as u32;
        index = middle.clamp(1, eligible_len.saturating_sub(1));
    }
    ChooseSelectionModeOutput {
        mode,
        index,
        explore_used: input.explore_used,
        explore_quota: input.explore_quota,
        exploit_used: input.exploit_used,
    }
}

pub fn compute_explore_quota_for_day(input: &ExploreQuotaForDayInput) -> ExploreQuotaForDayOutput {
    let max_runs = input
        .daily_runs_cap
        .filter(|v| v.is_finite())
        .unwrap_or(input.default_max_runs);
    let clamped_max = max_runs.max(1.0);
    let frac = input
        .explore_fraction
        .filter(|v| v.is_finite())
        .unwrap_or(0.2)
        .clamp(0.05, 0.8);
    let quota = (clamped_max * frac).floor().max(1.0);
    ExploreQuotaForDayOutput {
        quota: quota as u32,
    }
}

pub fn compute_medium_risk_thresholds(
    input: &MediumRiskThresholdsInput,
) -> MediumRiskThresholdsOutput {
    let composite_min = input
        .medium_risk_min_composite_eligibility
        .max(input.min_composite_eligibility + 6.0);
    let directive_base = if input.base_min_directive_fit.is_finite() {
        input.base_min_directive_fit
    } else {
        input.default_min_directive_fit
    };
    let actionability_base = if input.base_min_actionability_score.is_finite() {
        input.base_min_actionability_score
    } else {
        input.default_min_actionability
    };
    let directive_fit_min = input
        .medium_risk_min_directive_fit
        .max(directive_base + 5.0);
    let actionability_min = input
        .medium_risk_min_actionability
        .max(actionability_base + 6.0);
    MediumRiskThresholdsOutput {
        composite_min,
        directive_fit_min,
        actionability_min,
    }
}

pub fn compute_medium_risk_gate_decision(
    input: &MediumRiskGateDecisionInput,
) -> MediumRiskGateDecisionOutput {
    let risk = input
        .risk
        .as_ref()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| v == "low" || v == "medium" || v == "high")
        .unwrap_or_else(|| "low".to_string());
    if risk != "medium" {
        return MediumRiskGateDecisionOutput {
            pass: true,
            risk,
            reasons: Vec::new(),
            required: None,
        };
    }
    let required = MediumRiskThresholdsOutput {
        composite_min: input.composite_min,
        directive_fit_min: input.directive_fit_min,
        actionability_min: input.actionability_min,
    };
    let mut reasons = Vec::<String>::new();
    if input.composite_score < required.composite_min {
        reasons.push("medium_composite_low".to_string());
    }
    if input.directive_fit_score < required.directive_fit_min {
        reasons.push("medium_directive_fit_low".to_string());
    }
    if input.actionability_score < required.actionability_min {
        reasons.push("medium_actionability_low".to_string());
    }
    MediumRiskGateDecisionOutput {
        pass: reasons.is_empty(),
        risk,
        reasons,
        required: Some(required),
    }
}

pub fn compute_route_block_prefilter(
    input: &RouteBlockPrefilterInput,
) -> RouteBlockPrefilterOutput {
    let key = input
        .capability_key
        .as_ref()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty());
    let mut out = RouteBlockPrefilterOutput {
        enabled: input.enabled,
        applicable: false,
        pass: true,
        reason: "disabled".to_string(),
        capability_key: key.clone(),
        window_hours: input.window_hours,
        min_observations: input.min_observations,
        max_block_rate: input.max_block_rate,
        attempts: 0.0,
        route_blocked: 0.0,
        route_block_rate: 0.0,
    };
    if !input.enabled {
        return out;
    }
    out.reason = "missing_capability_key".to_string();
    if key.is_none() {
        return out;
    }
    out.applicable = true;
    out.reason = "no_recent_route_samples".to_string();
    if !input.row_present {
        return out;
    }
    out.attempts = input.attempts.max(0.0);
    out.route_blocked = input.route_blocked.max(0.0);
    out.route_block_rate = input.route_block_rate.clamp(0.0, 1.0);
    if out.attempts < input.min_observations {
        out.reason = "insufficient_observations".to_string();
        return out;
    }
    if out.route_block_rate >= input.max_block_rate {
        out.pass = false;
        out.reason = "route_block_rate_exceeded".to_string();
        return out;
    }
    out.reason = "pass".to_string();
    out
}

pub fn compute_route_execution_sample_event(
    input: &RouteExecutionSampleEventInput,
) -> RouteExecutionSampleEventOutput {
    let event_type = input.event_type.as_deref().unwrap_or("");
    if event_type != "autonomy_run" {
        return RouteExecutionSampleEventOutput {
            is_sample_event: false,
        };
    }
    let result = input.result.as_deref().unwrap_or("").trim();
    if result.is_empty() {
        return RouteExecutionSampleEventOutput {
            is_sample_event: false,
        };
    }
    if result == "score_only_fallback_route_block" || result == "init_gate_blocked_route" {
        return RouteExecutionSampleEventOutput {
            is_sample_event: true,
        };
    }
    let target = input
        .execution_target
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if target == "route" {
        return RouteExecutionSampleEventOutput {
            is_sample_event: result == "executed",
        };
    }
    RouteExecutionSampleEventOutput {
        is_sample_event: result == "executed" && input.route_summary_present,
    }
}

pub fn compute_route_block_telemetry_summary(
    input: &RouteBlockTelemetrySummaryInput,
) -> RouteBlockTelemetrySummaryOutput {
    let mut rows = std::collections::HashMap::<String, RouteBlockTelemetryCapabilityOutput>::new();
    for evt in input.events.iter() {
        let sample = compute_route_execution_sample_event(&RouteExecutionSampleEventInput {
            event_type: evt.event_type.clone(),
            result: evt.result.clone(),
            execution_target: evt.execution_target.clone(),
            route_summary_present: evt.route_summary_present,
        });
        if !sample.is_sample_event {
            continue;
        }
        let key = evt
            .capability_key
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if key.is_empty() {
            continue;
        }
        let row = rows
            .entry(key.clone())
            .or_insert_with(|| RouteBlockTelemetryCapabilityOutput {
                key: key.clone(),
                attempts: 0.0,
                route_blocked: 0.0,
                route_block_rate: 0.0,
            });
        row.attempts += 1.0;
        let result = evt.result.as_deref().unwrap_or("").trim();
        if result == "score_only_fallback_route_block" || result == "init_gate_blocked_route" {
            row.route_blocked += 1.0;
        }
    }

    let mut by_capability = rows.into_values().collect::<Vec<_>>();
    by_capability.sort_by(|a, b| a.key.cmp(&b.key));
    for row in by_capability.iter_mut() {
        row.route_block_rate = if row.attempts > 0.0 {
            ((row.route_blocked / row.attempts) * 1000.0).round() / 1000.0
        } else {
            0.0
        };
    }

    RouteBlockTelemetrySummaryOutput {
        window_hours: input.window_hours.max(1.0),
        sample_events: input.events.len() as f64,
        by_capability,
    }
}

pub fn compute_is_stub_proposal(input: &IsStubProposalInput) -> IsStubProposalOutput {
    let title = input.title.as_deref().unwrap_or("");
    IsStubProposalOutput {
        is_stub: title.to_uppercase().contains("[STUB]"),
    }
}

pub fn compute_recent_autonomy_run_events(
    input: &RecentAutonomyRunEventsInput,
) -> RecentAutonomyRunEventsOutput {
    let cutoff_ms = if input.cutoff_ms.is_finite() {
        input.cutoff_ms
    } else {
        0.0
    };
    let mut cap = input.cap;
    if !cap.is_finite() {
        cap = 800.0;
    }
    cap = cap.max(50.0);

    let mut out = Vec::<serde_json::Value>::new();
    for evt in input.events.iter() {
        if (out.len() as f64) >= cap {
            break;
        }
        let event_type = evt
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if event_type != "autonomy_run" {
            continue;
        }
        let ts_raw = evt.get("ts").and_then(|v| v.as_str()).unwrap_or("").trim();
        if ts_raw.is_empty() {
            continue;
        }
        let Some(ts_ms) = parse_rfc3339_ts_ms(ts_raw) else {
            continue;
        };
        if (ts_ms as f64) < cutoff_ms {
            continue;
        }
        out.push(evt.clone());
    }

    RecentAutonomyRunEventsOutput { events: out }
}

pub fn compute_proposal_meta_index(input: &ProposalMetaIndexInput) -> ProposalMetaIndexOutput {
    let mut seen = std::collections::HashSet::<String>::new();
    let mut out = Vec::<ProposalMetaIndexEntryOutput>::new();
    for row in input.entries.iter() {
        let proposal_id = row.proposal_id.as_deref().unwrap_or("").trim().to_string();
        if proposal_id.is_empty() || seen.contains(&proposal_id) {
            continue;
        }
        seen.insert(proposal_id.clone());
        let eye_id = row.eye_id.as_deref().unwrap_or("").trim().to_string();
        let topics = row
            .topics
            .iter()
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .collect::<Vec<String>>();
        out.push(ProposalMetaIndexEntryOutput {
            proposal_id,
            eye_id,
            topics,
        });
    }
    ProposalMetaIndexOutput { entries: out }
}

fn js_slice_start(len: usize, raw: Option<f64>) -> usize {
    let Some(raw) = raw else {
        return 0;
    };
    if !raw.is_finite() {
        return 0;
    }
    let trunc = raw.trunc() as i64;
    if trunc >= 0 {
        (trunc as usize).min(len)
    } else {
        let idx = (len as i64) + trunc;
        if idx <= 0 {
            0
        } else {
            idx as usize
        }
    }
}

pub fn compute_new_log_events(input: &NewLogEventsInput) -> NewLogEventsOutput {
    let run_start = js_slice_start(input.after_runs.len(), input.before_run_len);
    let err_start = js_slice_start(input.after_errors.len(), input.before_error_len);
    NewLogEventsOutput {
        runs: input.after_runs[run_start..].to_vec(),
        errors: input.after_errors[err_start..].to_vec(),
    }
}

pub fn compute_outcome_buckets(_input: &OutcomeBucketsInput) -> OutcomeBucketsOutput {
    OutcomeBucketsOutput {
        shipped: 0.0,
        no_change: 0.0,
        reverted: 0.0,
    }
}

pub fn compute_recent_run_events(input: &RecentRunEventsInput) -> RecentRunEventsOutput {
    let mut events = Vec::<serde_json::Value>::new();
    for bucket in input.day_events.iter() {
        for evt in bucket.iter() {
            events.push(evt.clone());
        }
    }
    RecentRunEventsOutput { events }
}

pub fn compute_all_decision_events(input: &AllDecisionEventsInput) -> AllDecisionEventsOutput {
    let mut events = Vec::<serde_json::Value>::new();
    for bucket in input.day_events.iter() {
        for evt in bucket.iter() {
            events.push(evt.clone());
        }
    }
    AllDecisionEventsOutput { events }
}

pub fn compute_cooldown_active_state(
    input: &CooldownActiveStateInput,
) -> CooldownActiveStateOutput {
    let now_ms = input.now_ms.unwrap_or(0.0);
    let until_ms = input.until_ms.unwrap_or(f64::NAN);
    if !until_ms.is_finite() || until_ms <= 0.0 || !now_ms.is_finite() {
        return CooldownActiveStateOutput {
            active: false,
            expired: true,
        };
    }
    if now_ms > until_ms {
        return CooldownActiveStateOutput {
            active: false,
            expired: true,
        };
    }
    CooldownActiveStateOutput {
        active: true,
        expired: false,
    }
}

pub fn compute_bump_count(input: &BumpCountInput) -> BumpCountOutput {
    let current = input.current_count.unwrap_or(0.0);
    let base = if current.is_finite() { current } else { 0.0 };
    BumpCountOutput { count: base + 1.0 }
}

pub fn compute_lock_age_minutes(input: &LockAgeMinutesInput) -> LockAgeMinutesOutput {
    let ts_raw = input.lock_ts.as_deref().unwrap_or("").trim();
    if ts_raw.is_empty() {
        return LockAgeMinutesOutput { age_minutes: None };
    }
    let parsed = DateTime::parse_from_rfc3339(ts_raw)
        .map(|v| v.with_timezone(&Utc))
        .ok();
    let Some(parsed) = parsed else {
        return LockAgeMinutesOutput { age_minutes: None };
    };
    let now_ms = input
        .now_ms
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    if !now_ms.is_finite() {
        return LockAgeMinutesOutput { age_minutes: None };
    }
    let diff_ms = (now_ms - parsed.timestamp_millis() as f64).max(0.0);
    LockAgeMinutesOutput {
        age_minutes: Some(diff_ms / 60_000.0),
    }
}

pub fn compute_hash_obj(input: &HashObjInput) -> HashObjOutput {
    let json = input.json.as_deref().unwrap_or("");
    if json.is_empty() {
        return HashObjOutput { hash: None };
    }
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    let digest = hasher.finalize();
    HashObjOutput {
        hash: Some(format!("{:x}", digest)),
    }
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

pub fn compute_assess_success_criteria_quality(
    input: &AssessSuccessCriteriaQualityInput,
) -> AssessSuccessCriteriaQualityOutput {
    let checks = &input.checks;
    let total_count = input.total_count;
    let unknown_exempt_reasons = [
        "artifact_delta_unavailable",
        "entry_delta_unavailable",
        "revenue_delta_unavailable",
        "outreach_artifact_unavailable",
        "reply_or_interview_count_unavailable",
        "deferred_pending_window",
    ];
    let unknown_exempt_count = checks
        .iter()
        .filter(|row| {
            if row.evaluated {
                return false;
            }
            let reason = row.reason.as_deref().unwrap_or("").trim();
            unknown_exempt_reasons.contains(&reason)
        })
        .count() as f64;

    let unknown_count_raw = input.unknown_count;
    let unknown_count = (unknown_count_raw - unknown_exempt_count).max(0.0);
    let unknown_rate = if total_count > 0.0 {
        unknown_count / total_count
    } else if !checks.is_empty() {
        let unevaluated = checks.iter().filter(|row| !row.evaluated).count() as f64;
        (unevaluated - unknown_exempt_count).max(0.0) / (checks.len() as f64)
    } else {
        1.0
    };

    let unsupported_count = checks
        .iter()
        .filter(|row| {
            let reason = row.reason.as_deref().unwrap_or("").trim();
            reason == "unsupported_metric" || reason == "metric_not_allowed_for_capability"
        })
        .count() as f64;
    let unsupported_rate = if checks.is_empty() {
        0.0
    } else {
        unsupported_count / (checks.len() as f64)
    };

    let synthesized = input.synthesized;
    let mut reasons = Vec::<String>::new();
    if synthesized {
        reasons.push("synthesized_criteria".to_string());
    }
    if unknown_rate > 0.4 {
        reasons.push("high_unknown_rate".to_string());
    }
    if unsupported_rate > 0.5 {
        reasons.push("high_unsupported_rate".to_string());
    }

    AssessSuccessCriteriaQualityOutput {
        insufficient: !reasons.is_empty(),
        reasons,
        total_count,
        unknown_count_raw,
        unknown_exempt_count,
        unknown_count,
        unknown_rate: round4(unknown_rate),
        unsupported_count,
        unsupported_rate: round4(unsupported_rate),
        synthesized,
    }
}

pub fn compute_manual_gate_prefilter(
    input: &ManualGatePrefilterInput,
) -> ManualGatePrefilterOutput {
    let key = input
        .capability_key
        .as_ref()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty());
    let mut out = ManualGatePrefilterOutput {
        enabled: input.enabled,
        applicable: false,
        pass: true,
        reason: "disabled".to_string(),
        capability_key: key.clone(),
        window_hours: input.window_hours,
        min_observations: input.min_observations,
        max_manual_block_rate: input.max_manual_block_rate,
        attempts: 0.0,
        manual_blocked: 0.0,
        manual_block_rate: 0.0,
    };
    if !input.enabled {
        return out;
    }
    out.reason = "missing_capability_key".to_string();
    if key.is_none() {
        return out;
    }
    out.applicable = true;
    out.reason = "no_recent_manual_gate_samples".to_string();
    if !input.row_present {
        return out;
    }
    out.attempts = input.attempts.max(0.0);
    out.manual_blocked = input.manual_blocked.max(0.0);
    out.manual_block_rate = input.manual_block_rate.clamp(0.0, 1.0);
    if out.attempts < input.min_observations {
        out.reason = "insufficient_observations".to_string();
        return out;
    }
    if out.manual_block_rate >= input.max_manual_block_rate {
        out.pass = false;
        out.reason = "manual_gate_rate_exceeded".to_string();
        return out;
    }
    out.reason = "pass".to_string();
    out
}

pub fn compute_execute_confidence_cooldown_active(
    input: &ExecuteConfidenceCooldownActiveInput,
) -> ExecuteConfidenceCooldownActiveOutput {
    let key_present = input
        .cooldown_key
        .as_ref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    ExecuteConfidenceCooldownActiveOutput {
        active: key_present && input.cooldown_active,
    }
}

pub fn compute_top_biases_summary(input: &TopBiasesSummaryInput) -> TopBiasesSummaryOutput {
    let mut rows = input
        .entries
        .iter()
        .map(|row| TopBiasSummaryEntryOutput {
            key: row
                .key
                .as_ref()
                .map(|v| v.trim().to_string())
                .unwrap_or_default(),
            bias: row.bias,
            total: row.total,
            shipped: row.shipped,
            no_change: row.no_change,
            reverted: row.reverted,
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.bias
            .abs()
            .partial_cmp(&a.bias.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.total
                    .partial_cmp(&a.total)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.key.cmp(&b.key))
    });
    let limit = input.limit.max(1) as usize;
    rows.truncate(limit);
    TopBiasesSummaryOutput { rows }
}

pub fn compute_criteria_pattern_penalty(
    input: &CriteriaPatternPenaltyInput,
) -> CriteriaPatternPenaltyOutput {
    if input.keys.is_empty() {
        return CriteriaPatternPenaltyOutput {
            penalty: 0.0,
            hit_patterns: Vec::new(),
            threshold: input.fail_threshold,
        };
    }
    let mut pattern_map =
        std::collections::BTreeMap::<String, &CriteriaPatternPenaltyPatternInput>::new();
    for row in &input.patterns {
        let key = row.key.trim().to_string();
        if key.is_empty() {
            continue;
        }
        pattern_map.insert(key, row);
    }
    let window_ms = input.window_days.max(0.0) * 24.0 * 3600.0 * 1000.0;
    let now_ms = if input.now_ms.is_finite() {
        input.now_ms
    } else {
        0.0
    };
    let mut penalty = 0.0_f64;
    let mut hits = Vec::<CriteriaPatternPenaltyHitOutput>::new();
    for key in &input.keys {
        let k = key.trim().to_string();
        if k.is_empty() {
            continue;
        }
        let Some(row) = pattern_map.get(&k) else {
            continue;
        };
        if let Some(ts) = &row.last_failure_ts {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts.trim()) {
                let fail_ms = dt.with_timezone(&Utc).timestamp_millis() as f64;
                if window_ms > 0.0 && (now_ms - fail_ms) > window_ms {
                    continue;
                }
            }
        }
        let failures = row.failures.max(0.0);
        let passes = row.passes.max(0.0);
        let effective_failures = (failures - (passes * 0.5).floor()).max(0.0);
        if effective_failures < input.fail_threshold {
            continue;
        }
        let over = effective_failures - input.fail_threshold + 1.0;
        let row_penalty = over * input.penalty_per_hit;
        penalty += row_penalty;
        hits.push(CriteriaPatternPenaltyHitOutput {
            key: k,
            failures,
            passes,
            effective_failures,
            penalty: row_penalty,
        });
    }
    CriteriaPatternPenaltyOutput {
        penalty: penalty.round().clamp(0.0, input.max_penalty.max(0.0)),
        hit_patterns: hits.into_iter().take(4).collect(),
        threshold: input.fail_threshold,
    }
}

pub fn compute_strategy_threshold_overrides(
    input: &StrategyThresholdOverridesInput,
) -> StrategyThresholdOverridesOutput {
    let choose = |base: Option<f64>, override_val: Option<f64>| -> f64 {
        if let Some(v) = override_val {
            if v.is_finite() {
                return v;
            }
        }
        base.filter(|v| v.is_finite()).unwrap_or(0.0)
    };
    StrategyThresholdOverridesOutput {
        min_signal_quality: choose(input.min_signal_quality, input.override_min_signal_quality),
        min_sensory_signal_score: choose(
            input.min_sensory_signal_score,
            input.override_min_sensory_signal_score,
        ),
        min_sensory_relevance_score: choose(
            input.min_sensory_relevance_score,
            input.override_min_sensory_relevance_score,
        ),
        min_directive_fit: choose(input.min_directive_fit, input.override_min_directive_fit),
        min_actionability_score: choose(
            input.min_actionability_score,
            input.override_min_actionability_score,
        ),
        min_eye_score_ema: choose(input.min_eye_score_ema, input.override_min_eye_score_ema),
    }
}

pub fn compute_effective_allowed_risks(
    input: &EffectiveAllowedRisksInput,
) -> EffectiveAllowedRisksOutput {
    let normalize = |rows: &[String]| -> Vec<String> {
        let mut out = Vec::<String>::new();
        let mut seen = std::collections::BTreeSet::<String>::new();
        for row in rows {
            let v = row.trim().to_lowercase();
            if v.is_empty() || !seen.insert(v.clone()) {
                continue;
            }
            out.push(v);
        }
        out
    };
    let defaults = normalize(&input.default_risks);
    let from_strategy = normalize(&input.strategy_allowed_risks);
    EffectiveAllowedRisksOutput {
        risks: if from_strategy.is_empty() {
            defaults
        } else {
            from_strategy
        },
    }
}

pub fn compute_directive_pulse_context(
    input: &DirectivePulseContextInput,
) -> DirectivePulseContextOutput {
    let clamp_number = |value: f64, min: f64, max: f64| -> f64 {
        if !value.is_finite() {
            min
        } else {
            value.clamp(min, max)
        }
    };
    let to_count = |value: Option<f64>| -> u32 {
        let v = value.unwrap_or(0.0);
        if !v.is_finite() || v <= 0.0 {
            0
        } else {
            v.round() as u32
        }
    };
    let clean_optional = |value: &Option<String>| -> Option<String> {
        value
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };

    let mut tier_attempts_today = std::collections::BTreeMap::<String, f64>::new();
    for (k, v) in &input.tier_attempts_today {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let count = if v.is_finite() && *v > 0.0 { *v } else { 0.0 };
        tier_attempts_today.insert(key.to_string(), count.round());
    }

    let mut objective_stats = Vec::<DirectivePulseContextObjectiveStatOutput>::new();
    for row in &input.objective_stats {
        let objective_id = row
            .objective_id
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if objective_id.is_empty() {
            continue;
        }
        let tier_raw = row.tier.unwrap_or(3.0);
        let tier = if tier_raw.is_finite() {
            tier_raw.round().clamp(1.0, 9.0) as u32
        } else {
            3
        };
        objective_stats.push(DirectivePulseContextObjectiveStatOutput {
            objective_id,
            tier,
            attempts: to_count(row.attempts),
            shipped: to_count(row.shipped),
            no_change: to_count(row.no_change),
            reverted: to_count(row.reverted),
            no_progress_streak: to_count(row.no_progress_streak),
            last_attempt_ts: clean_optional(&row.last_attempt_ts),
            last_shipped_ts: clean_optional(&row.last_shipped_ts),
        });
    }

    DirectivePulseContextOutput {
        enabled: input.enabled,
        available: input.available,
        objectives: input.objectives.clone(),
        error: clean_optional(&input.error),
        window_days: clamp_number(input.window_days, 1.0, 60.0),
        urgency_hours: clamp_number(input.urgency_hours, 1.0, 240.0),
        no_progress_limit: clamp_number(input.no_progress_limit, 1.0, 12.0),
        cooldown_hours: clamp_number(input.cooldown_hours, 1.0, 168.0),
        tier_attempts_today,
        attempts_today: if input.attempts_today.is_finite() && input.attempts_today > 0.0 {
            input.attempts_today.round()
        } else {
            0.0
        },
        objective_stats,
    }
}

pub fn compute_directive_pulse_stats(
    input: &DirectivePulseStatsInput,
) -> DirectivePulseStatsOutput {
    let date_str = input
        .date_str
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();

    let mut tier_attempts_today = std::collections::BTreeMap::<String, f64>::new();
    let mut attempts_today = 0.0_f64;
    let mut objective_stats_by_id =
        std::collections::BTreeMap::<String, DirectivePulseContextObjectiveStatOutput>::new();

    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
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
        let day = evt
            .day
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let objective_id = evt
            .objective_id
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let pulse_tier = compute_normalize_directive_tier(&NormalizeDirectiveTierInput {
            raw_tier: evt.tier,
            fallback: Some(3.0),
        })
        .tier;

        let is_attempt = compute_attempt_run_event(&AttemptRunEventInput {
            event_type: Some(event_type.clone()),
            result: Some(result.clone()),
        })
        .is_attempt;
        if !is_attempt {
            continue;
        }

        if !date_str.is_empty() && day == date_str {
            let tier_key = pulse_tier.to_string();
            let next = tier_attempts_today.get(&tier_key).copied().unwrap_or(0.0) + 1.0;
            tier_attempts_today.insert(tier_key, next);
            attempts_today += 1.0;
        }

        if objective_id.is_empty() {
            continue;
        }

        let is_no_progress = compute_no_progress_result(&NoProgressResultInput {
            event_type: Some(event_type),
            result: Some(result.clone()),
            outcome: Some(outcome.clone()),
        })
        .is_no_progress;

        let entry = objective_stats_by_id
            .entry(objective_id.clone())
            .or_insert_with(|| DirectivePulseContextObjectiveStatOutput {
                objective_id: objective_id.clone(),
                tier: pulse_tier,
                attempts: 0,
                shipped: 0,
                no_change: 0,
                reverted: 0,
                no_progress_streak: 0,
                last_attempt_ts: None,
                last_shipped_ts: None,
            });

        entry.attempts += 1;
        entry.tier = pulse_tier;
        if let Some(ts) = evt
            .ts
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            entry.last_attempt_ts = Some(ts.clone());
        }

        let shipped = result == "executed" && outcome == "shipped";
        if shipped {
            entry.shipped += 1;
            entry.no_progress_streak = 0;
            if let Some(ts) = evt
                .ts
                .as_ref()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
            {
                entry.last_shipped_ts = Some(ts);
            }
        } else {
            if result == "executed" && outcome == "no_change" {
                entry.no_change += 1;
            }
            if result == "executed" && outcome == "reverted" {
                entry.reverted += 1;
            }
            if is_no_progress {
                entry.no_progress_streak += 1;
            }
        }
    }

    DirectivePulseStatsOutput {
        tier_attempts_today,
        attempts_today,
        objective_stats: objective_stats_by_id.into_values().collect(),
    }
}

fn json_path<'a>(root: &'a serde_json::Value, path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for key in path {
        current = current.as_object()?.get(*key)?;
    }
    Some(current)
}

fn js_like_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(v) => {
            if *v {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        serde_json::Value::Number(v) => v.to_string(),
        serde_json::Value::String(v) => v.clone(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(js_like_string)
            .collect::<Vec<_>>()
            .join(","),
        serde_json::Value::Object(_) => "[object Object]".to_string(),
    }
}

fn js_like_string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(rows)) => rows
            .iter()
            .map(js_like_string)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect(),
        Some(serde_json::Value::String(v)) if !v.trim().is_empty() => vec![v.trim().to_string()],
        _ => Vec::new(),
    }
}

fn js_array_to_strings(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(rows)) => rows
            .iter()
            .map(js_like_string)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn js_like_number(value: Option<&serde_json::Value>) -> Option<f64> {
    let v = value?;
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        serde_json::Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        serde_json::Value::Null => None,
        _ => None,
    }
}

pub fn compute_compile_directive_pulse_objectives(
    input: &CompileDirectivePulseObjectivesInput,
) -> CompileDirectivePulseObjectivesOutput {
    let mut out = Vec::<CompileDirectivePulseObjectiveOutput>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();

    for directive in &input.directives {
        let id_from_metadata =
            json_path(directive, &["data", "metadata", "id"]).map(js_like_string);
        let id_from_root = json_path(directive, &["id"]).map(js_like_string);
        let id = id_from_metadata
            .or(id_from_root)
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let id_upper = id.to_ascii_uppercase();
        if id_upper == "T0" || id_upper.starts_with("T0_") || id_upper.starts_with("T0-") {
            continue;
        }

        let tier_raw = js_like_number(json_path(directive, &["tier"])).or(js_like_number(
            json_path(directive, &["data", "metadata", "tier"]),
        ));
        let tier = compute_normalize_directive_tier(&NormalizeDirectiveTierInput {
            raw_tier: tier_raw,
            fallback: Some(3.0),
        })
        .tier;

        let mut phrases_raw = Vec::<String>::new();
        phrases_raw.extend(js_like_string_array(json_path(
            directive,
            &["data", "metadata", "description"],
        )));
        phrases_raw.extend(js_like_string_array(json_path(
            directive,
            &["data", "intent", "primary"],
        )));
        phrases_raw.extend(js_like_string_array(json_path(
            directive,
            &["data", "scope", "included"],
        )));
        phrases_raw.extend(js_like_string_array(json_path(
            directive,
            &["data", "success_metrics", "leading"],
        )));
        phrases_raw.extend(js_like_string_array(json_path(
            directive,
            &["data", "success_metrics", "lagging"],
        )));

        let mut phrase_set = std::collections::BTreeSet::<String>::new();
        for phrase in &phrases_raw {
            let normalized = compute_normalize_directive_text(&NormalizeDirectiveTextInput {
                text: Some(phrase.clone()),
            })
            .normalized;
            if !normalized.is_empty() && normalized.len() >= 6 {
                phrase_set.insert(normalized);
            }
        }
        let mut phrases = phrase_set.into_iter().collect::<Vec<_>>();
        if phrases.len() > 16 {
            phrases.truncate(16);
        }

        let mut token_set = std::collections::BTreeSet::<String>::new();
        for phrase in &phrases {
            let tokens = compute_tokenize_directive_text(&TokenizeDirectiveTextInput {
                text: Some(phrase.clone()),
                stopwords: input.stopwords.clone(),
            })
            .tokens;
            for token in tokens {
                let clean = token.trim();
                if !clean.is_empty() {
                    token_set.insert(clean.to_string());
                }
            }
        }
        let mut tokens = token_set.into_iter().collect::<Vec<_>>();
        if tokens.len() > 64 {
            tokens.truncate(64);
        }

        let mut explicit_rows = Vec::<String>::new();
        explicit_rows.extend(js_like_string_array(json_path(
            directive,
            &["data", "metadata", "value_currency"],
        )));
        explicit_rows.extend(js_like_string_array(json_path(
            directive,
            &["data", "metadata", "value_currencies"],
        )));
        explicit_rows.extend(js_like_string_array(json_path(
            directive,
            &["data", "value_currency"],
        )));
        explicit_rows.extend(js_like_string_array(json_path(
            directive,
            &["data", "value_currencies"],
        )));
        explicit_rows.extend(js_like_string_array(json_path(
            directive,
            &["data", "intent", "value_currency"],
        )));
        explicit_rows.extend(js_like_string_array(json_path(
            directive,
            &["data", "intent", "value_currencies"],
        )));

        let explicit_currencies = compute_list_value_currencies(&ListValueCurrenciesInput {
            value_list: explicit_rows,
            value_csv: None,
            allowed_keys: input.allowed_value_keys.clone(),
        })
        .currencies;

        let mut inference_bits = Vec::<String>::new();
        inference_bits.push(id.clone());
        inference_bits.extend(phrases_raw.iter().cloned());
        inference_bits.extend(phrases.iter().cloned());
        inference_bits.extend(tokens.iter().cloned());

        let inferred_currencies = compute_infer_value_currencies_from_directive_bits(
            &InferValueCurrenciesFromDirectiveBitsInput {
                bits: inference_bits,
                allowed_keys: input.allowed_value_keys.clone(),
            },
        )
        .currencies;

        let value_currencies = if explicit_currencies.is_empty() {
            inferred_currencies
        } else {
            let mut merged = explicit_currencies;
            merged.extend(inferred_currencies);
            compute_list_value_currencies(&ListValueCurrenciesInput {
                value_list: merged,
                value_csv: None,
                allowed_keys: input.allowed_value_keys.clone(),
            })
            .currencies
        };
        let primary_currency = value_currencies.first().cloned();

        let title_primary =
            js_like_string_array(json_path(directive, &["data", "intent", "primary"]));
        let title_description =
            js_like_string_array(json_path(directive, &["data", "metadata", "description"]));
        let title = title_primary
            .first()
            .cloned()
            .or_else(|| title_description.first().cloned())
            .unwrap_or_else(|| id.clone());

        let tier_weight = compute_directive_tier_weight(&DirectiveTierWeightInput {
            tier: Some(tier as f64),
            fallback: Some(3.0),
        })
        .weight;
        let min_share = compute_directive_tier_min_share(&DirectiveTierMinShareInput {
            tier: Some(tier as f64),
            fallback: Some(3.0),
            t1_min_share: input.t1_min_share.unwrap_or(0.5),
            t2_min_share: input.t2_min_share.unwrap_or(0.25),
        })
        .min_share;

        out.push(CompileDirectivePulseObjectiveOutput {
            id,
            tier,
            title,
            tier_weight,
            min_share,
            phrases,
            tokens,
            value_currencies,
            primary_currency,
        });
    }

    out.sort_by(|a, b| a.tier.cmp(&b.tier).then_with(|| a.id.cmp(&b.id)));
    CompileDirectivePulseObjectivesOutput { objectives: out }
}

pub fn compute_directive_pulse_objectives_profile(
    input: &DirectivePulseObjectivesProfileInput,
) -> DirectivePulseObjectivesProfileOutput {
    if !input.enabled {
        return DirectivePulseObjectivesProfileOutput {
            enabled: false,
            available: false,
            objectives: Vec::new(),
            error: Some("directive_pulse_disabled".to_string()),
        };
    }
    let load_error = input
        .load_error
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(200).collect::<String>());
    if let Some(err) = load_error {
        return DirectivePulseObjectivesProfileOutput {
            enabled: true,
            available: false,
            objectives: Vec::new(),
            error: Some(err),
        };
    }
    let objectives = input.objectives.clone();
    let available = !objectives.is_empty();
    DirectivePulseObjectivesProfileOutput {
        enabled: true,
        available,
        objectives,
        error: if available {
            None
        } else {
            Some("no_objectives".to_string())
        },
    }
}

pub fn compute_recent_directive_pulse_cooldown_count(
    input: &RecentDirectivePulseCooldownCountInput,
) -> RecentDirectivePulseCooldownCountOutput {
    let objective_id = input
        .objective_id
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if objective_id.is_empty() {
        return RecentDirectivePulseCooldownCountOutput { count: 0 };
    }
    let hours = non_negative_number(input.hours).unwrap_or(24.0).max(1.0);
    let now_ms = non_negative_number(input.now_ms).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|v| v.as_millis() as f64)
            .unwrap_or(0.0)
    });
    let cutoff = now_ms - (hours * 3_600_000.0);

    let mut count = 0_u32;
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if event_type != "autonomy_run" {
            continue;
        }
        let result = evt
            .result
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if result != "stop_repeat_gate_directive_pulse_cooldown" {
            continue;
        }
        let ts = evt
            .ts
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let ts_ms = compute_parse_iso_ts(&ParseIsoTsInput {
            ts: if ts.is_empty() { None } else { Some(ts) },
        })
        .timestamp_ms;
        let Some(ms) = ts_ms else {
            continue;
        };
        if ms < cutoff {
            continue;
        }
        let event_objective = evt
            .objective_id
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| {
                evt.sample_objective_id
                    .as_ref()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            })
            .unwrap_or_default();
        if event_objective == objective_id {
            count += 1;
        }
    }

    RecentDirectivePulseCooldownCountOutput { count }
}

pub fn compute_proposal_directive_text(
    input: &ProposalDirectiveTextInput,
) -> ProposalDirectiveTextOutput {
    let proposal = input.proposal.as_ref().unwrap_or(&serde_json::Value::Null);
    let mut parts = vec![
        js_like_string(json_path(proposal, &["title"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(json_path(proposal, &["type"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(json_path(proposal, &["summary"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(json_path(proposal, &["notes"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(json_path(proposal, &["expected_impact"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(json_path(proposal, &["risk"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(json_path(proposal, &["meta", "preview"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(json_path(proposal, &["meta", "url"]).unwrap_or(&serde_json::Value::Null)),
        js_like_string(
            json_path(proposal, &["meta", "normalized_objective"]).unwrap_or(&serde_json::Value::Null),
        ),
        js_like_string(
            json_path(proposal, &["meta", "normalized_expected_outcome"])
                .unwrap_or(&serde_json::Value::Null),
        ),
        js_like_string(
            json_path(proposal, &["meta", "normalized_validation_metric"])
                .unwrap_or(&serde_json::Value::Null),
        ),
    ];

    let hint_tokens = js_array_to_strings(json_path(proposal, &["meta", "normalized_hint_tokens"]));
    if !hint_tokens.is_empty() {
        parts.push(hint_tokens.join(" "));
    }
    let archetypes = js_array_to_strings(json_path(proposal, &["meta", "normalized_archetypes"]));
    if !archetypes.is_empty() {
        parts.push(archetypes.join(" "));
    }
    let topics = js_array_to_strings(json_path(proposal, &["meta", "topics"]));
    if !topics.is_empty() {
        parts.push(topics.join(" "));
    }
    let validation = js_array_to_strings(json_path(proposal, &["validation"]));
    if !validation.is_empty() {
        parts.push(validation.join(" "));
    }

    if let Some(serde_json::Value::Array(rows)) = json_path(proposal, &["evidence"]) {
        for ev in rows {
            parts.push(js_like_string(
                json_path(ev, &["match"]).unwrap_or(&serde_json::Value::Null),
            ));
            parts.push(js_like_string(
                json_path(ev, &["evidence_ref"]).unwrap_or(&serde_json::Value::Null),
            ));
        }
    }

    let joined = parts.join(" ");
    let normalized =
        compute_normalize_directive_text(&NormalizeDirectiveTextInput { text: Some(joined) })
            .normalized;
    ProposalDirectiveTextOutput { text: normalized }
}

pub fn compute_objective_ids_from_pulse_context(
    input: &ObjectiveIdsFromPulseContextInput,
) -> ObjectiveIdsFromPulseContextOutput {
    let mut ids = Vec::<String>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();

    for row in &input.objectives {
        let id = js_like_string(json_path(row, &["id"]).unwrap_or(&serde_json::Value::Null))
            .trim()
            .to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        ids.push(id);
    }

    if ids.is_empty() && input.fallback_enabled {
        for raw in &input.fallback_ids {
            let id = raw.trim().to_string();
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            ids.push(id);
        }
    }

    ObjectiveIdsFromPulseContextOutput { ids }
}

pub fn compute_policy_hold_objective_context(
    input: &PolicyHoldObjectiveContextInput,
) -> PolicyHoldObjectiveContextOutput {
    let mut ids = Vec::<String>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    for raw in &input.candidate_objective_ids {
        let id = compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
            value: Some(raw.clone()),
        })
        .objective_id;
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        ids.push(id);
    }
    if ids.is_empty() {
        for raw in &input.pool_objective_ids {
            let id = compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
                value: Some(raw.clone()),
            })
            .objective_id;
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            ids.push(id);
        }
    }
    let dominant = compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
        value: input.dominant_objective_id.clone(),
    })
    .objective_id;
    let objective_id = if !dominant.is_empty() {
        Some(dominant.clone())
    } else {
        ids.first().cloned()
    };
    let objective_source = if objective_id.is_some() {
        if !dominant.is_empty() {
            Some("directive_pulse_dominant".to_string())
        } else {
            Some("directive_pulse_pool".to_string())
        }
    } else {
        None
    };
    let objective_ids = if ids.len() > 1 {
        Some(ids.into_iter().take(8).collect())
    } else {
        None
    };
    PolicyHoldObjectiveContextOutput {
        objective_id,
        objective_source,
        objective_ids,
    }
}

pub fn compute_proposal_semantic_objective_id(
    input: &ProposalSemanticObjectiveIdInput,
) -> ProposalSemanticObjectiveIdOutput {
    let proposal = input.proposal.as_ref().unwrap_or(&serde_json::Value::Null);
    let candidates = vec![
        json_path(proposal, &["meta", "objective_id"]).map(js_like_string),
        json_path(proposal, &["meta", "directive_objective_id"]).map(js_like_string),
        json_path(proposal, &["meta", "linked_objective_id"]).map(js_like_string),
        Some(
            compute_parse_directive_objective_arg(&ParseDirectiveObjectiveArgInput {
                command: json_path(proposal, &["suggested_next_command"]).map(js_like_string),
            })
            .objective_id,
        ),
        Some(
            compute_parse_directive_objective_arg(&ParseDirectiveObjectiveArgInput {
                command: json_path(proposal, &["suggested_command"]).map(js_like_string),
            })
            .objective_id,
        ),
    ];
    for raw in candidates.into_iter().flatten() {
        let id = compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
            value: Some(raw),
        })
        .objective_id;
        if !id.is_empty() {
            return ProposalSemanticObjectiveIdOutput { objective_id: id };
        }
    }
    ProposalSemanticObjectiveIdOutput {
        objective_id: String::new(),
    }
}

pub fn compute_criteria_pattern_keys(
    input: &CriteriaPatternKeysInput,
) -> CriteriaPatternKeysOutput {
    let hint =
        normalize_spaces(input.capability_key_hint.as_deref().unwrap_or("")).to_ascii_lowercase();
    let descriptor = normalize_spaces(input.capability_descriptor_key.as_deref().unwrap_or(""))
        .to_ascii_lowercase();
    let cap_key = if !hint.is_empty() {
        hint
    } else if !descriptor.is_empty() {
        descriptor
    } else {
        "unknown".to_string()
    };
    let mut keys = std::collections::BTreeSet::<String>::new();
    for row in &input.rows {
        let metric = compute_normalize_criteria_metric(&NormalizeCriteriaMetricInput {
            value: row.metric.clone(),
        })
        .metric;
        if metric.is_empty() {
            continue;
        }
        keys.insert(format!("{cap_key}|{metric}"));
    }
    CriteriaPatternKeysOutput {
        keys: keys.into_iter().collect(),
    }
}

pub fn compute_success_criteria_requirement(
    input: &SuccessCriteriaRequirementInput,
) -> SuccessCriteriaRequirementOutput {
    let mut exempt_types = Vec::<String>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    for raw in input
        .policy_exempt_types
        .iter()
        .chain(input.env_exempt_types.iter())
    {
        let value = normalize_spaces(raw).to_ascii_lowercase();
        if value.is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        exempt_types.push(value);
    }
    let raw_min = input.min_success_criteria_count.unwrap_or(1.0);
    let min_count = if !raw_min.is_finite() || raw_min < 0.0 {
        0.0
    } else if raw_min > 5.0 {
        5.0
    } else {
        raw_min
    };
    SuccessCriteriaRequirementOutput {
        required: input.require_success_criteria.unwrap_or(true),
        min_count,
        exempt_types,
    }
}

pub fn compute_success_criteria_policy_for_proposal(
    input: &SuccessCriteriaPolicyForProposalInput,
) -> SuccessCriteriaPolicyForProposalOutput {
    let proposal_type =
        normalize_spaces(input.proposal_type.as_deref().unwrap_or("")).to_ascii_lowercase();
    let mut exempt = false;
    for raw in &input.base_exempt_types {
        let value = normalize_spaces(raw).to_ascii_lowercase();
        if !value.is_empty() && !proposal_type.is_empty() && value == proposal_type {
            exempt = true;
            break;
        }
    }
    SuccessCriteriaPolicyForProposalOutput {
        required: input.base_required && !exempt,
        min_count: input.base_min_count,
        exempt,
    }
}

pub fn compute_capability_descriptor(
    input: &CapabilityDescriptorInput,
) -> CapabilityDescriptorOutput {
    let kind = normalize_spaces(input.actuation_kind.as_deref().unwrap_or("")).to_ascii_lowercase();
    if !kind.is_empty() {
        return CapabilityDescriptorOutput {
            key: format!("actuation:{kind}"),
            aliases: vec!["actuation".to_string()],
        };
    }
    let proposal_type =
        normalize_spaces(input.proposal_type.as_deref().unwrap_or("")).to_ascii_lowercase();
    let typ = if proposal_type.is_empty() {
        "unknown".to_string()
    } else {
        proposal_type
    };
    CapabilityDescriptorOutput {
        key: format!("proposal:{typ}"),
        aliases: vec!["proposal".to_string()],
    }
}

pub fn compute_normalize_token_usage_shape(
    input: &NormalizeTokenUsageShapeInput,
) -> NormalizeTokenUsageShapeOutput {
    let prompt =
        non_negative_number(input.prompt_tokens).or(non_negative_number(input.input_tokens));
    let completion =
        non_negative_number(input.completion_tokens).or(non_negative_number(input.output_tokens));
    let total_direct =
        non_negative_number(input.total_tokens).or(non_negative_number(input.tokens_used));
    let total = if let Some(v) = total_direct {
        Some(v)
    } else if prompt.is_some() || completion.is_some() {
        Some(prompt.unwrap_or(0.0) + completion.unwrap_or(0.0))
    } else {
        None
    };
    if total.is_none() && prompt.is_none() && completion.is_none() {
        return NormalizeTokenUsageShapeOutput {
            has_value: false,
            usage: None,
        };
    }
    NormalizeTokenUsageShapeOutput {
        has_value: true,
        usage: Some(NormalizeTokenUsageShapeValueOutput {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: total,
            source: normalize_spaces(input.source.as_deref().unwrap_or("unknown")),
        }),
    }
}

pub fn compute_is_directive_clarification_proposal(
    input: &IsDirectiveClarificationProposalInput,
) -> IsDirectiveClarificationProposalOutput {
    let proposal_type = input
        .proposal_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    IsDirectiveClarificationProposalOutput {
        is_clarification: proposal_type == "directive_clarification",
    }
}

pub fn compute_is_directive_decomposition_proposal(
    input: &IsDirectiveDecompositionProposalInput,
) -> IsDirectiveDecompositionProposalOutput {
    let proposal_type = input
        .proposal_type
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    IsDirectiveDecompositionProposalOutput {
        is_decomposition: proposal_type == "directive_decomposition",
    }
}

pub fn compute_sanitize_directive_objective_id(
    input: &SanitizeDirectiveObjectiveIdInput,
) -> SanitizeDirectiveObjectiveIdOutput {
    let raw = input.value.as_deref().unwrap_or("").trim();
    if raw.is_empty() {
        return SanitizeDirectiveObjectiveIdOutput {
            objective_id: String::new(),
        };
    }
    let re = Regex::new(r"^T[0-9]_[A-Za-z0-9_]+$").expect("valid directive objective id regex");
    if !re.is_match(raw) {
        return SanitizeDirectiveObjectiveIdOutput {
            objective_id: String::new(),
        };
    }
    SanitizeDirectiveObjectiveIdOutput {
        objective_id: raw.to_string(),
    }
}

pub fn compute_sanitized_directive_id_list(
    input: &SanitizedDirectiveIdListInput,
) -> SanitizedDirectiveIdListOutput {
    let limit = input
        .limit
        .filter(|v| v.is_finite())
        .map(|v| v.max(0.0).floor() as usize)
        .unwrap_or(12usize)
        .min(200usize);
    if limit == 0 {
        return SanitizedDirectiveIdListOutput { ids: Vec::new() };
    }
    let mut out = Vec::<String>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    for row in input.rows.iter() {
        if out.len() >= limit {
            break;
        }
        let sanitized =
            compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
                value: Some(row.clone()),
            })
            .objective_id;
        if sanitized.is_empty() || !seen.insert(sanitized.clone()) {
            continue;
        }
        out.push(sanitized);
    }
    SanitizedDirectiveIdListOutput { ids: out }
}

pub fn compute_parse_first_json_line(input: &ParseFirstJsonLineInput) -> ParseFirstJsonLineOutput {
    let raw = input.text.as_deref().unwrap_or("").trim();
    if raw.is_empty() {
        return ParseFirstJsonLineOutput { value: None };
    }
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
        return ParseFirstJsonLineOutput {
            value: Some(parsed),
        };
    }
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') || !trimmed.ends_with('}') {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return ParseFirstJsonLineOutput {
                value: Some(parsed),
            };
        }
    }
    ParseFirstJsonLineOutput { value: None }
}

pub fn compute_parse_json_objects_from_text(
    input: &ParseJsonObjectsFromTextInput,
) -> ParseJsonObjectsFromTextOutput {
    let text = input.text.as_deref().unwrap_or("");
    let max_objects = input
        .max_objects
        .filter(|v| v.is_finite())
        .map(|v| v.max(0.0).floor() as usize)
        .unwrap_or(40usize)
        .min(500usize);
    if max_objects == 0 {
        return ParseJsonObjectsFromTextOutput {
            objects: Vec::new(),
        };
    }
    let mut out = Vec::<serde_json::Value>::new();
    for line in text.lines() {
        if out.len() >= max_objects {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') || !trimmed.ends_with('}') {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if parsed.is_object() {
                out.push(parsed);
            }
        }
    }
    ParseJsonObjectsFromTextOutput { objects: out }
}

pub fn compute_read_path_value(input: &ReadPathValueInput) -> ReadPathValueOutput {
    let Some(mut cur) = input.obj.as_ref() else {
        return ReadPathValueOutput { value: None };
    };
    let parts: Vec<&str> = input
        .path_expr
        .as_deref()
        .unwrap_or("")
        .split('.')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return ReadPathValueOutput { value: None };
    }
    for key in parts {
        let Some(map) = cur.as_object() else {
            return ReadPathValueOutput { value: None };
        };
        let Some(next) = map.get(key) else {
            return ReadPathValueOutput { value: None };
        };
        cur = next;
    }
    ReadPathValueOutput {
        value: Some(cur.clone()),
    }
}

pub fn compute_number_or_null(input: &NumberOrNullInput) -> NumberOrNullOutput {
    let value = input.value.filter(|v| v.is_finite() && *v >= 0.0);
    NumberOrNullOutput { value }
}

pub fn compute_choose_evidence_selection_mode(
    input: &ChooseEvidenceSelectionModeInput,
) -> ChooseEvidenceSelectionModeOutput {
    let eligible_len = input
        .eligible_len
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
        .max(0.0)
        .floor() as u32;
    let sample_window_raw = input
        .evidence_sample_window
        .filter(|v| v.is_finite())
        .unwrap_or(1.0)
        .max(1.0)
        .floor() as u32;
    let window = std::cmp::max(
        1u32,
        std::cmp::min(eligible_len.max(1u32), sample_window_raw),
    );
    let prior_evidence_attempts = input
        .prior_runs
        .iter()
        .filter(|e| {
            e.event_type
                .as_deref()
                .unwrap_or("")
                .trim()
                .eq("autonomy_run")
                && matches!(
                    e.result.as_deref().unwrap_or("").trim(),
                    "score_only_preview" | "score_only_evidence"
                )
        })
        .count() as u32;
    let cursor = if window > 0 {
        prior_evidence_attempts % window
    } else {
        0
    };
    let prefix = input
        .mode_prefix
        .as_deref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or("evidence");
    ChooseEvidenceSelectionModeOutput {
        mode: format!("{prefix}_sample"),
        index: cursor,
        sample_window: window,
        sample_cursor: cursor,
        prior_evidence_attempts,
    }
}

pub fn compute_truthy_flag(input: &TruthyFlagInput) -> TruthyFlagOutput {
    let value = match input.value.as_ref() {
        Some(serde_json::Value::Bool(v)) => *v,
        Some(serde_json::Value::Null) | None => false,
        Some(other) => {
            let text = match other {
                serde_json::Value::String(s) => s.clone(),
                _ => other.to_string(),
            };
            let normalized = text.trim().to_ascii_lowercase();
            normalized == "true" || normalized == "1" || normalized == "yes"
        }
    };
    TruthyFlagOutput { value }
}

pub fn compute_falsey_flag(input: &TruthyFlagInput) -> TruthyFlagOutput {
    let value = match input.value.as_ref() {
        Some(serde_json::Value::Bool(v)) => !*v,
        Some(serde_json::Value::Null) | None => false,
        Some(other) => {
            let text = match other {
                serde_json::Value::String(s) => s.clone(),
                _ => other.to_string(),
            };
            let normalized = text.trim().to_ascii_lowercase();
            normalized == "false" || normalized == "0" || normalized == "no"
        }
    };
    TruthyFlagOutput { value }
}

pub fn compute_stable_selection_index(
    input: &StableSelectionIndexInput,
) -> StableSelectionIndexOutput {
    let n = input
        .size
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
        .max(0.0)
        .floor() as u64;
    if n == 0 {
        return StableSelectionIndexOutput { index: 0 };
    }
    let seed = input.seed.as_deref().unwrap_or("");
    let hex = format!("{:x}", Sha256::digest(seed.as_bytes()));
    let slice = &hex[..std::cmp::min(12, hex.len())];
    let num = u64::from_str_radix(slice, 16).unwrap_or(0);
    StableSelectionIndexOutput {
        index: (num % n) as u32,
    }
}

pub fn compute_as_string_array(input: &AsStringArrayInput) -> AsStringArrayOutput {
    let mut out = Vec::<String>::new();
    match input.value.as_ref() {
        Some(serde_json::Value::Array(rows)) => {
            for row in rows {
                let value = match row {
                    serde_json::Value::String(s) => s.trim().to_string(),
                    serde_json::Value::Null => String::new(),
                    _ => row.to_string().trim().to_string(),
                };
                if !value.is_empty() {
                    out.push(value);
                }
            }
        }
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
        _ => {}
    }
    AsStringArrayOutput { values: out }
}

pub fn compute_uniq_sorted(input: &UniqSortedInput) -> UniqSortedOutput {
    let mut seen = std::collections::BTreeSet::<String>::new();
    for row in input.values.iter() {
        seen.insert(row.clone());
    }
    UniqSortedOutput {
        values: seen.into_iter().collect(),
    }
}

pub fn compute_normalize_model_ids(input: &NormalizeModelIdsInput) -> NormalizeModelIdsOutput {
    let limit = input
        .limit
        .filter(|v| v.is_finite())
        .map(|v| v.max(0.0).floor() as usize)
        .unwrap_or(128usize)
        .min(2000usize);
    if limit == 0 {
        return NormalizeModelIdsOutput { models: Vec::new() };
    }
    let mut out = Vec::<String>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    for raw in input.models.iter() {
        let value = raw.trim().to_string();
        if value.is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        out.push(value);
        if out.len() >= limit {
            break;
        }
    }
    NormalizeModelIdsOutput { models: out }
}

pub fn compute_selected_model_from_run_event(
    input: &SelectedModelFromRunEventInput,
) -> SelectedModelFromRunEventOutput {
    let Some(summary) = input.route_summary.as_ref().and_then(|v| v.as_object()) else {
        return SelectedModelFromRunEventOutput { model: None };
    };
    let keys = ["selected_model", "model", "selectedModel", "chosen_model"];
    for key in keys {
        let Some(v) = summary.get(key) else {
            continue;
        };
        let text = match v {
            serde_json::Value::String(s) => s.trim().to_string(),
            _ => v.to_string().trim().to_string(),
        };
        if !text.is_empty() {
            return SelectedModelFromRunEventOutput { model: Some(text) };
        }
    }
    SelectedModelFromRunEventOutput { model: None }
}

pub fn compute_read_first_numeric_metric(
    input: &ReadFirstNumericMetricInput,
) -> ReadFirstNumericMetricOutput {
    let to_non_negative = |value: Option<&serde_json::Value>| -> Option<f64> {
        let number = match value {
            None | Some(serde_json::Value::Null) => Some(0.0),
            Some(serde_json::Value::Number(n)) => n.as_f64(),
            Some(serde_json::Value::Bool(v)) => Some(if *v { 1.0 } else { 0.0 }),
            Some(serde_json::Value::String(s)) => {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    Some(0.0)
                } else {
                    trimmed.parse::<f64>().ok()
                }
            }
            _ => None,
        };
        number.filter(|v| v.is_finite() && *v >= 0.0)
    };
    for expr in input.path_exprs.iter() {
        for src in input.sources.iter() {
            let read = compute_read_path_value(&ReadPathValueInput {
                obj: Some(src.clone()),
                path_expr: Some(expr.clone()),
            });
            let n = to_non_negative(read.value.as_ref());
            if n.is_some() {
                return ReadFirstNumericMetricOutput { value: n };
            }
        }
    }
    ReadFirstNumericMetricOutput { value: None }
}

pub fn compute_parse_arg(input: &ParseArgInput) -> ParseArgOutput {
    let name = input.name.as_deref().unwrap_or("").trim();
    if name.is_empty() {
        return ParseArgOutput { value: None };
    }
    let pref = format!("--{}=", name);
    for arg in input.args.iter() {
        if arg.starts_with(&pref) {
            return ParseArgOutput {
                value: Some(arg[pref.len()..].to_string()),
            };
        }
    }
    ParseArgOutput { value: None }
}

pub fn compute_date_arg_or_today(input: &DateArgOrTodayInput) -> DateArgOrTodayOutput {
    let candidate = input.value.as_deref().unwrap_or("").trim();
    let looks_like_date = Regex::new(r"^\d{4}-\d{2}-\d{2}$")
        .expect("valid date arg regex")
        .is_match(candidate);
    if looks_like_date {
        return DateArgOrTodayOutput {
            date: candidate.to_string(),
        };
    }
    DateArgOrTodayOutput {
        date: input
            .today
            .as_deref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string()),
    }
}

pub fn compute_has_env_numeric_override(
    input: &HasEnvNumericOverrideInput,
) -> HasEnvNumericOverrideOutput {
    let non_empty = input
        .raw_value
        .as_deref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    HasEnvNumericOverrideOutput {
        has_override: input.present && non_empty,
    }
}

pub fn compute_coalesce_numeric(input: &CoalesceNumericInput) -> CoalesceNumericOutput {
    let primary = input.primary.filter(|v| v.is_finite());
    if primary.is_some() {
        return CoalesceNumericOutput { value: primary };
    }
    let fallback = input.fallback.filter(|v| v.is_finite());
    if fallback.is_some() {
        return CoalesceNumericOutput { value: fallback };
    }
    CoalesceNumericOutput {
        value: input.null_fallback.filter(|v| v.is_finite()),
    }
}

pub fn compute_clamp_number(input: &ClampNumberInput) -> ClampNumberOutput {
    let min = input.min.filter(|v| v.is_finite()).unwrap_or(0.0);
    let max = input.max.filter(|v| v.is_finite()).unwrap_or(min);
    let value = input.value.filter(|v| v.is_finite()).unwrap_or(min);
    ClampNumberOutput {
        value: if value < min {
            min
        } else if value > max {
            max
        } else {
            value
        },
    }
}

pub fn compute_list_proposal_files(input: &ListProposalFilesInput) -> ListProposalFilesOutput {
    let mut files = input
        .entries
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| {
            Regex::new(r"^\d{4}-\d{2}-\d{2}\.json$")
                .expect("valid proposal filename regex")
                .is_match(v)
        })
        .collect::<Vec<String>>();
    files.sort();
    ListProposalFilesOutput { files }
}

pub fn compute_latest_proposal_date(input: &LatestProposalDateInput) -> LatestProposalDateOutput {
    let max_date = input.max_date.as_deref().unwrap_or("").trim();
    let mut dates = input
        .files
        .iter()
        .map(|f| f.trim().trim_end_matches(".json").to_string())
        .filter(|d| {
            !d.is_empty()
                && Regex::new(r"^\d{4}-\d{2}-\d{2}$")
                    .expect("valid ymd regex")
                    .is_match(d)
        })
        .filter(|d| max_date.is_empty() || d.as_str() <= max_date)
        .collect::<Vec<String>>();
    dates.sort();
    LatestProposalDateOutput { date: dates.pop() }
}

pub fn compute_parse_directive_file_arg(
    input: &ParseDirectiveFileArgInput,
) -> ParseDirectiveFileArgOutput {
    let text = input.command.as_deref().unwrap_or("").trim();
    if text.is_empty() {
        return ParseDirectiveFileArgOutput {
            file: String::new(),
        };
    }
    let re = Regex::new(r#"(?:^|\s)--file=(?:"([^"]+)"|'([^']+)'|([^\s]+))"#)
        .expect("valid directive file arg regex");
    let raw = re
        .captures(text)
        .and_then(|caps| caps.get(1).or_else(|| caps.get(2)).or_else(|| caps.get(3)))
        .map(|m| m.as_str().trim().replace('\\', "/"))
        .unwrap_or_default();
    if raw.is_empty() {
        return ParseDirectiveFileArgOutput {
            file: String::new(),
        };
    }
    let allow = Regex::new(r"(?i)^config/directives/[A-Za-z0-9_]+\.ya?ml$")
        .expect("valid directive file allow regex");
    if !allow.is_match(&raw) {
        return ParseDirectiveFileArgOutput {
            file: String::new(),
        };
    }
    ParseDirectiveFileArgOutput { file: raw }
}

pub fn compute_parse_directive_objective_arg(
    input: &ParseDirectiveObjectiveArgInput,
) -> ParseDirectiveObjectiveArgOutput {
    let text = normalize_spaces(input.command.as_deref().unwrap_or(""));
    if text.is_empty() {
        return ParseDirectiveObjectiveArgOutput {
            objective_id: String::new(),
        };
    }
    let re = Regex::new(r#"(?:^|\s)--id=(?:"([^"]+)"|'([^']+)'|([^\s]+))"#)
        .expect("valid directive objective arg regex");
    let raw = re
        .captures(&text)
        .and_then(|caps| caps.get(1).or_else(|| caps.get(2)).or_else(|| caps.get(3)))
        .map(|m| normalize_spaces(m.as_str()))
        .unwrap_or_default();
    let sanitized = compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
        value: Some(raw),
    });
    ParseDirectiveObjectiveArgOutput {
        objective_id: sanitized.objective_id,
    }
}

pub fn compute_now_iso(input: &NowIsoInput) -> NowIsoOutput {
    if let Some(raw) = input.now_iso.as_deref() {
        let text = normalize_spaces(raw);
        if !text.is_empty() {
            if let Ok(dt) = DateTime::parse_from_rfc3339(&text) {
                return NowIsoOutput {
                    value: dt
                        .with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true),
                };
            }
        }
    }
    NowIsoOutput {
        value: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}

pub fn compute_today_str(input: &TodayStrInput) -> TodayStrOutput {
    if let Some(raw) = input.now_iso.as_deref() {
        let text = normalize_spaces(raw);
        if !text.is_empty() {
            if let Ok(dt) = DateTime::parse_from_rfc3339(&text) {
                return TodayStrOutput {
                    value: dt.with_timezone(&Utc).format("%Y-%m-%d").to_string(),
                };
            }
        }
    }
    TodayStrOutput {
        value: Utc::now().format("%Y-%m-%d").to_string(),
    }
}

pub fn compute_human_canary_override_approval_phrase(
    input: &HumanCanaryOverrideApprovalPhraseInput,
) -> HumanCanaryOverrideApprovalPhraseOutput {
    let prefix = input
        .prefix
        .as_deref()
        .map(normalize_spaces)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "I_APPROVE_ONE_SHOT_CANARY_OVERRIDE".to_string());
    let date_str = input.date_str.as_deref().unwrap_or("");
    let nonce = input.nonce.as_deref().unwrap_or("");
    HumanCanaryOverrideApprovalPhraseOutput {
        phrase: format!("{prefix}:{date_str}:{nonce}"),
    }
}

pub fn compute_parse_human_canary_override_state(
    input: &ParseHumanCanaryOverrideStateInput,
) -> ParseHumanCanaryOverrideStateOutput {
    let Some(record) = input.record.as_ref().and_then(|v| v.as_object()) else {
        return ParseHumanCanaryOverrideStateOutput {
            active: false,
            reason: "missing".to_string(),
            expired: None,
            remaining: None,
            expires_at: None,
            date: None,
            require_execution_mode: None,
            id: None,
            r#type: None,
        };
    };
    let now_ms = input
        .now_ms
        .filter(|v| v.is_finite())
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    let expires_at = record
        .get("expires_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let exp_ms = DateTime::parse_from_rfc3339(expires_at.trim())
        .map(|dt| dt.timestamp_millis() as f64)
        .ok();
    let remaining = match record.get("remaining_uses") {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        Some(serde_json::Value::Bool(v)) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    let expired = exp_ms.map(|v| now_ms > v).unwrap_or(true);
    if remaining <= 0.0 {
        return ParseHumanCanaryOverrideStateOutput {
            active: false,
            reason: "depleted".to_string(),
            expired: Some(expired),
            remaining: Some(remaining),
            expires_at: None,
            date: None,
            require_execution_mode: None,
            id: None,
            r#type: None,
        };
    }
    if expired {
        return ParseHumanCanaryOverrideStateOutput {
            active: false,
            reason: "expired".to_string(),
            expired: Some(true),
            remaining: Some(remaining),
            expires_at: None,
            date: None,
            require_execution_mode: None,
            id: None,
            r#type: None,
        };
    }
    ParseHumanCanaryOverrideStateOutput {
        active: true,
        reason: "ok".to_string(),
        expired: Some(false),
        remaining: Some(remaining),
        expires_at: Some(expires_at),
        date: Some(
            record
                .get("date")
                .map(|v| v.as_str().unwrap_or("").to_string())
                .unwrap_or_default(),
        ),
        require_execution_mode: Some(
            record
                .get("require_execution_mode")
                .map(|v| v.as_str().unwrap_or("").to_string())
                .unwrap_or_default(),
        ),
        id: Some(
            record
                .get("id")
                .map(|v| v.as_str().unwrap_or("").to_string())
                .unwrap_or_default(),
        ),
        r#type: Some(
            record
                .get("type")
                .map(|v| v.as_str().unwrap_or("").to_string())
                .unwrap_or_default(),
        ),
    }
}

pub fn compute_daily_budget_path(input: &DailyBudgetPathInput) -> DailyBudgetPathOutput {
    let state_dir = input.state_dir.as_deref().unwrap_or("").trim();
    let date_str = input.date_str.as_deref().unwrap_or("").trim();
    let path = std::path::Path::new(state_dir)
        .join(format!("{date_str}.json"))
        .to_string_lossy()
        .to_string();
    DailyBudgetPathOutput { path }
}

pub fn compute_runs_path_for(input: &RunsPathForInput) -> RunsPathForOutput {
    let runs_dir = input.runs_dir.as_deref().unwrap_or("").trim();
    let date_str = input.date_str.as_deref().unwrap_or("").trim();
    let path = std::path::Path::new(runs_dir)
        .join(format!("{date_str}.jsonl"))
        .to_string_lossy()
        .to_string();
    RunsPathForOutput { path }
}

pub fn compute_effective_tier1_policy(
    input: &EffectiveTier1PolicyInput,
) -> EffectiveTier1PolicyOutput {
    let mode = normalize_spaces(input.execution_mode.as_deref().unwrap_or("")).to_ascii_lowercase();
    let canary_relaxed = mode == "canary_execute";
    EffectiveTier1PolicyOutput {
        execution_mode: if mode.is_empty() {
            None
        } else {
            Some(mode.clone())
        },
        canary_relaxed,
        burn_rate_multiplier: if canary_relaxed {
            input
                .tier1_burn_rate_multiplier
                .max(input.tier1_canary_burn_rate_multiplier)
        } else {
            input.tier1_burn_rate_multiplier
        },
        min_projected_tokens_for_burn_check: if canary_relaxed {
            input
                .tier1_min_projected_tokens_for_burn_check
                .max(input.tier1_canary_min_projected_tokens_for_burn_check)
        } else {
            input.tier1_min_projected_tokens_for_burn_check
        },
        drift_min_samples: if canary_relaxed {
            input
                .tier1_drift_min_samples
                .max(input.tier1_canary_drift_min_samples)
        } else {
            input.tier1_drift_min_samples
        },
        alignment_threshold: if canary_relaxed {
            input
                .tier1_alignment_threshold
                .min(input.tier1_canary_alignment_threshold)
        } else {
            input.tier1_alignment_threshold
        },
        suppress_alignment_blocker: canary_relaxed && input.tier1_canary_suppress_alignment_blocker,
    }
}

pub fn compute_compact_tier1_exception(
    input: &CompactTier1ExceptionInput,
) -> CompactTier1ExceptionOutput {
    if input.tracked != Some(true) {
        return CompactTier1ExceptionOutput {
            has_value: false,
            value: None,
        };
    }
    let recovery = input.recovery.as_ref().and_then(|v| v.as_object());
    let stage = input
        .stage
        .as_deref()
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty());
    let error_code = input
        .error_code
        .as_deref()
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty());
    let signature = input
        .signature
        .as_deref()
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty());
    let recovery_action = recovery.and_then(|r| {
        r.get("action")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
    });
    let recovery_cooldown_hours = recovery
        .and_then(|r| r.get("cooldown_hours"))
        .and_then(|v| {
            if let Some(n) = v.as_f64() {
                Some(n)
            } else if let Some(s) = v.as_str() {
                s.trim().parse::<f64>().ok()
            } else {
                None
            }
        });
    let recovery_playbook = recovery.and_then(|r| {
        r.get("playbook")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
    });
    let recovery_reason = recovery.and_then(|r| {
        r.get("reason")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
    });
    let recovery_should_escalate = recovery
        .and_then(|r| r.get("should_escalate"))
        .and_then(|v| v.as_bool());
    let value = serde_json::json!({
        "novel": input.novel == Some(true),
        "stage": stage,
        "error_code": error_code,
        "signature": signature,
        "count": input.count.unwrap_or(0.0),
        "recovery_action": recovery_action,
        "recovery_cooldown_hours": recovery_cooldown_hours,
        "recovery_playbook": recovery_playbook,
        "recovery_reason": recovery_reason,
        "recovery_should_escalate": recovery_should_escalate
    });
    CompactTier1ExceptionOutput {
        has_value: true,
        value: Some(value),
    }
}

pub fn compute_next_human_escalation_clear_at(
    input: &NextHumanEscalationClearAtInput,
) -> NextHumanEscalationClearAtOutput {
    let mut min_dt: Option<DateTime<Utc>> = None;
    for row in input.rows.iter() {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let expires_at = obj
            .get("expires_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if expires_at.is_empty() {
            continue;
        }
        let Ok(dt) = DateTime::parse_from_rfc3339(&expires_at) else {
            continue;
        };
        let dt_utc = dt.with_timezone(&Utc);
        min_dt = Some(match min_dt {
            Some(prev) => {
                if dt_utc < prev {
                    dt_utc
                } else {
                    prev
                }
            }
            None => dt_utc,
        });
    }
    NextHumanEscalationClearAtOutput {
        value: min_dt.map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true)),
    }
}

pub fn compute_model_catalog_canary_thresholds(
    input: &ModelCatalogCanaryThresholdsInput,
) -> ModelCatalogCanaryThresholdsOutput {
    let min_samples = input.min_samples.round().clamp(1.0, 50.0);
    let max_fail_rate = input.max_fail_rate.clamp(0.0, 1.0);
    let max_route_block_rate = input.max_route_block_rate.clamp(0.0, 1.0);
    ModelCatalogCanaryThresholdsOutput {
        min_samples,
        max_fail_rate,
        max_route_block_rate,
    }
}

pub fn compute_directive_clarification_exec_spec(
    input: &DirectiveClarificationExecSpecInput,
) -> DirectiveClarificationExecSpecOutput {
    let proposal_type =
        normalize_spaces(input.proposal_type.as_deref().unwrap_or("")).to_ascii_lowercase();
    if proposal_type != "directive_clarification" {
        return DirectiveClarificationExecSpecOutput {
            applicable: false,
            ok: false,
            reason: None,
            decision: None,
            objective_id: None,
            file: None,
            source: None,
            args: Vec::new(),
        };
    }

    let objective_id =
        sanitize_directive_objective_id(input.meta_directive_objective_id.as_deref().unwrap_or(""));
    let mut rel_file = if objective_id.is_empty() {
        String::new()
    } else {
        format!("config/directives/{objective_id}.yaml")
    };
    let mut source = if objective_id.is_empty() {
        String::new()
    } else {
        "meta.directive_objective_id".to_string()
    };
    if rel_file.is_empty() {
        let parsed = compute_parse_directive_file_arg(&ParseDirectiveFileArgInput {
            command: input.suggested_next_command.clone(),
        });
        if !parsed.file.is_empty() {
            rel_file = parsed.file;
            source = "suggested_next_command".to_string();
        }
    }

    if rel_file.is_empty() {
        return DirectiveClarificationExecSpecOutput {
            applicable: true,
            ok: false,
            reason: Some("directive_clarification_missing_file".to_string()),
            decision: None,
            objective_id: None,
            file: None,
            source: None,
            args: Vec::new(),
        };
    }

    let file_name = std::path::Path::new(&rel_file)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_string();
    let file_name_lower = file_name.to_ascii_lowercase();
    let file_objective_id = if file_name_lower.ends_with(".yaml") {
        file_name[..file_name.len().saturating_sub(5)].to_string()
    } else if file_name_lower.ends_with(".yml") {
        file_name[..file_name.len().saturating_sub(4)].to_string()
    } else {
        file_name
    };
    let chosen_objective_id = if objective_id.is_empty() {
        file_objective_id
    } else {
        objective_id
    };

    DirectiveClarificationExecSpecOutput {
        applicable: true,
        ok: true,
        reason: None,
        decision: Some("DIRECTIVE_VALIDATE".to_string()),
        objective_id: Some(chosen_objective_id),
        file: Some(rel_file.clone()),
        source: if source.is_empty() {
            None
        } else {
            Some(source)
        },
        args: vec!["validate".to_string(), format!("--file={rel_file}")],
    }
}

pub fn compute_directive_decomposition_exec_spec(
    input: &DirectiveDecompositionExecSpecInput,
) -> DirectiveDecompositionExecSpecOutput {
    let proposal_type =
        normalize_spaces(input.proposal_type.as_deref().unwrap_or("")).to_ascii_lowercase();
    if proposal_type != "directive_decomposition" {
        return DirectiveDecompositionExecSpecOutput {
            applicable: false,
            ok: false,
            reason: None,
            decision: None,
            objective_id: None,
            source: None,
            args: Vec::new(),
        };
    }

    let objective_id =
        sanitize_directive_objective_id(input.meta_directive_objective_id.as_deref().unwrap_or(""));
    let command_id = compute_parse_directive_objective_arg(&ParseDirectiveObjectiveArgInput {
        command: input.suggested_next_command.clone(),
    })
    .objective_id;
    let chosen_id = if !objective_id.is_empty() {
        objective_id.clone()
    } else {
        command_id.clone()
    };
    let source = if !objective_id.is_empty() {
        "meta.directive_objective_id".to_string()
    } else if !command_id.is_empty() {
        "suggested_next_command".to_string()
    } else {
        String::new()
    };
    if chosen_id.is_empty() {
        return DirectiveDecompositionExecSpecOutput {
            applicable: true,
            ok: false,
            reason: Some("directive_decomposition_missing_objective_id".to_string()),
            decision: None,
            objective_id: None,
            source: None,
            args: Vec::new(),
        };
    }
    DirectiveDecompositionExecSpecOutput {
        applicable: true,
        ok: true,
        reason: None,
        decision: Some("DIRECTIVE_DECOMPOSE".to_string()),
        objective_id: Some(chosen_id.clone()),
        source: if source.is_empty() {
            None
        } else {
            Some(source)
        },
        args: vec!["decompose".to_string(), format!("--id={chosen_id}")],
    }
}

pub fn compute_parse_actuation_spec(input: &ParseActuationSpecInput) -> ParseActuationSpecOutput {
    let Some(proposal) = input.proposal.as_ref().and_then(|v| v.as_object()) else {
        return ParseActuationSpecOutput {
            has_spec: false,
            kind: None,
            params: None,
            context: None,
        };
    };

    let meta = proposal
        .get("meta")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let actuation = meta
        .get("actuation")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if actuation.is_empty() {
        return ParseActuationSpecOutput {
            has_spec: false,
            kind: None,
            params: None,
            context: None,
        };
    }
    let kind = normalize_spaces(actuation.get("kind").and_then(|v| v.as_str()).unwrap_or(""));
    if kind.is_empty() {
        return ParseActuationSpecOutput {
            has_spec: false,
            kind: None,
            params: None,
            context: None,
        };
    }
    let params = actuation
        .get("params")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let action_spec = proposal
        .get("action_spec")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let guard_controls = meta
        .get("adaptive_mutation_guard_controls")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let guard_controls_obj = guard_controls.as_object().cloned().unwrap_or_default();

    let proposal_id = normalize_spaces(proposal.get("id").and_then(|v| v.as_str()).unwrap_or(""));
    let mut objective_id = String::new();
    for candidate in [
        meta.get("objective_id")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        meta.get("directive_objective_id")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        action_spec
            .get("objective_id")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    ] {
        let id = sanitize_directive_objective_id(candidate);
        if !id.is_empty() {
            objective_id = id;
            break;
        }
    }
    let first_non_empty = |vals: Vec<String>| -> Option<String> {
        vals.into_iter()
            .map(|v| normalize_spaces(&v))
            .find(|v| !v.is_empty())
    };
    let safety_attestation_id = first_non_empty(vec![
        guard_controls_obj
            .get("safety_attestation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        meta.get("safety_attestation_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        meta.get("safety_attestation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        meta.get("attestation_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    ]);
    let rollback_receipt_id = first_non_empty(vec![
        guard_controls_obj
            .get("rollback_receipt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        meta.get("rollback_receipt_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        meta.get("rollback_receipt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        action_spec
            .get("rollback_receipt_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    ]);
    let adaptive_mutation_guard_receipt_id = first_non_empty(vec![
        guard_controls_obj
            .get("guard_receipt_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        meta.get("adaptive_mutation_guard_receipt_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        meta.get("mutation_guard_receipt_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    ]);
    let applies = meta
        .get("adaptive_mutation_guard_applies")
        .and_then(|v| v.as_bool())
        == Some(true);
    let pass = meta
        .get("adaptive_mutation_guard_pass")
        .and_then(|v| v.as_bool())
        != Some(false);
    let reason = first_non_empty(vec![meta
        .get("adaptive_mutation_guard_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()]);
    let reasons = meta
        .get("adaptive_mutation_guard_reasons")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .take(8)
                .cloned()
                .collect::<Vec<serde_json::Value>>()
        })
        .unwrap_or_default();

    ParseActuationSpecOutput {
        has_spec: true,
        kind: Some(kind),
        params: Some(params),
        context: Some(ParseActuationSpecContext {
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
            safety_attestation_id,
            rollback_receipt_id,
            adaptive_mutation_guard_receipt_id,
            mutation_guard: ParseActuationSpecMutationGuard {
                applies,
                pass,
                reason,
                reasons,
                controls: guard_controls,
            },
        }),
    }
}

pub fn compute_task_from_proposal(input: &TaskFromProposalInput) -> TaskFromProposalOutput {
    let proposal_id = normalize_spaces(input.proposal_id.as_deref().unwrap_or(""));
    let proposal_id = if proposal_id.is_empty() {
        "unknown".to_string()
    } else {
        proposal_id
    };
    let proposal_type_raw = input.proposal_type.as_deref().unwrap_or("task").to_string();
    let proposal_type = Regex::new(r"[^a-z0-9_-]")
        .expect("valid proposal type sanitize regex")
        .replace_all(&proposal_type_raw.to_ascii_lowercase(), "")
        .to_string();
    let eyes_re = Regex::new(r"\[Eyes:[^\]]+\]\s*").expect("valid eyes strip regex");
    let title_raw = input.title.as_deref().unwrap_or("").to_string();
    let title_clean = eyes_re.replace_all(&title_raw, "").to_string();
    let title: String = title_clean.chars().take(140).collect();
    TaskFromProposalOutput {
        task: format!("Execute bounded proposal {proposal_id} ({proposal_type}): {title}"),
    }
}

pub fn compute_parse_objective_id_from_evidence_refs(
    input: &ParseObjectiveIdFromEvidenceRefsInput,
) -> ParseObjectiveIdFromEvidenceRefsOutput {
    let objective_set: std::collections::BTreeSet<String> = input
        .objective_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    let pulse_re =
        Regex::new(r"(?i)directive_pulse/([A-Za-z0-9_]+)").expect("valid pulse objective regex");
    let direct_re =
        Regex::new(r"(?i)\bdirective:([A-Za-z0-9_]+)").expect("valid direct objective regex");
    let fallback_re =
        Regex::new(r"\b(T[0-9]_[A-Za-z0-9_]+)\b").expect("valid fallback objective regex");
    for row in input.evidence_refs.iter() {
        let reference = normalize_spaces(row);
        if reference.is_empty() {
            continue;
        }
        let pulse_match = pulse_re
            .captures(&reference)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().to_string());
        let direct_match = direct_re
            .captures(&reference)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().to_string());
        let fallback_match = fallback_re
            .captures(&reference)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().to_string());
        let raw = normalize_spaces(
            pulse_match
                .as_deref()
                .or(direct_match.as_deref())
                .or(fallback_match.as_deref())
                .unwrap_or(""),
        );
        let sanitized =
            compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
                value: Some(raw),
            });
        if sanitized.objective_id.is_empty() {
            continue;
        }
        let valid = objective_set.is_empty() || objective_set.contains(&sanitized.objective_id);
        return ParseObjectiveIdFromEvidenceRefsOutput {
            objective_id: Some(sanitized.objective_id),
            source: Some("evidence_ref".to_string()),
            valid: Some(valid),
        };
    }
    ParseObjectiveIdFromEvidenceRefsOutput {
        objective_id: None,
        source: None,
        valid: None,
    }
}

pub fn compute_parse_objective_id_from_command(
    input: &ParseObjectiveIdFromCommandInput,
) -> ParseObjectiveIdFromCommandOutput {
    let objective_set: std::collections::BTreeSet<String> = input
        .objective_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    let objective_out = compute_parse_directive_objective_arg(&ParseDirectiveObjectiveArgInput {
        command: input.command.clone(),
    });
    if objective_out.objective_id.is_empty() {
        return ParseObjectiveIdFromCommandOutput {
            objective_id: None,
            source: None,
            valid: None,
        };
    }
    let valid = objective_set.is_empty() || objective_set.contains(&objective_out.objective_id);
    ParseObjectiveIdFromCommandOutput {
        objective_id: Some(objective_out.objective_id),
        source: Some("suggested_next_command".to_string()),
        valid: Some(valid),
    }
}

pub fn compute_objective_id_for_execution(
    input: &ObjectiveIdForExecutionInput,
) -> ObjectiveIdForExecutionOutput {
    let candidates = [
        input.objective_binding_id.as_deref().unwrap_or(""),
        input.directive_pulse_id.as_deref().unwrap_or(""),
        input.directive_action_id.as_deref().unwrap_or(""),
        input.meta_objective_id.as_deref().unwrap_or(""),
        input.meta_directive_objective_id.as_deref().unwrap_or(""),
        input.action_spec_objective_id.as_deref().unwrap_or(""),
    ];
    for candidate in candidates {
        let sanitized =
            compute_sanitize_directive_objective_id(&SanitizeDirectiveObjectiveIdInput {
                value: Some(candidate.to_string()),
            });
        if !sanitized.objective_id.is_empty() {
            return ObjectiveIdForExecutionOutput {
                objective_id: Some(sanitized.objective_id),
            };
        }
    }
    ObjectiveIdForExecutionOutput { objective_id: None }
}

pub fn compute_short_text(input: &ShortTextInput) -> ShortTextOutput {
    let text = input.value.as_deref().unwrap_or("").to_string();
    let max = input
        .max_len
        .and_then(|v| {
            if v.is_finite() && v >= 0.0 {
                Some(v as usize)
            } else {
                None
            }
        })
        .unwrap_or(220usize);
    if text.chars().count() <= max {
        return ShortTextOutput { text };
    }
    let truncated: String = text.chars().take(max).collect();
    ShortTextOutput {
        text: format!("{truncated}..."),
    }
}

pub fn compute_normalized_signal_status(
    input: &NormalizedSignalStatusInput,
) -> NormalizedSignalStatusOutput {
    let raw = normalize_spaces(input.value.as_deref().unwrap_or("")).to_ascii_lowercase();
    if raw == "pass" || raw == "warn" || raw == "fail" {
        return NormalizedSignalStatusOutput { status: raw };
    }
    let fallback = input.fallback.as_deref().unwrap_or("unknown").to_string();
    NormalizedSignalStatusOutput { status: fallback }
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
    let normalized_risk = input
        .risk
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
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

pub fn compute_exec_window_match(input: &ExecWindowMatchInput) -> ExecWindowMatchOutput {
    let ts_ms = input.ts_ms.unwrap_or(f64::NAN);
    let start_ms = input.start_ms.unwrap_or(f64::NAN);
    let end_ms = input.end_ms.unwrap_or(f64::NAN);
    if !ts_ms.is_finite() || !start_ms.is_finite() || !end_ms.is_finite() {
        return ExecWindowMatchOutput { in_window: false };
    }
    if start_ms == 0.0 || end_ms == 0.0 {
        return ExecWindowMatchOutput { in_window: false };
    }
    ExecWindowMatchOutput {
        in_window: ts_ms >= start_ms && ts_ms <= end_ms,
    }
}

pub fn compute_start_of_next_utc_day(input: &StartOfNextUtcDayInput) -> StartOfNextUtcDayOutput {
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
        let ts_ms = evt.ts.as_ref().and_then(|v| parse_rfc3339_ts_ms(v.trim()));
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
        if v.is_finite() {
            v
        } else {
            0.0
        }
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
        let ts_ms = evt.ts.as_ref().and_then(|v| parse_rfc3339_ts_ms(v.trim()));
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
        if result_lc.contains("budget") || reason.contains("budget") || reason.contains("autopause")
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

    let result = normalize_spaces(input.result.as_deref().unwrap_or(""))
        .to_ascii_lowercase();
    let outcome = normalize_spaces(input.outcome.as_deref().unwrap_or(""))
        .to_ascii_lowercase();
    let category = normalize_spaces(input.category.as_deref().unwrap_or(""))
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

pub fn compute_run_event_objective_id(
    input: &RunEventObjectiveIdInput,
) -> RunEventObjectiveIdOutput {
    let selected = if input.directive_pulse_present.unwrap_or(false) {
        input
            .directive_pulse_objective_id
            .as_deref()
            .unwrap_or("")
    } else if input.objective_id_present.unwrap_or(false) {
        input
            .objective_id
            .as_deref()
            .unwrap_or("")
    } else if input.objective_binding_present.unwrap_or(false) {
        input
            .objective_binding_objective_id
            .as_deref()
            .unwrap_or("")
    } else if input.top_escalation_present.unwrap_or(false) {
        input
            .top_escalation_objective_id
            .as_deref()
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
        input.proposal_id.as_deref().unwrap_or("")
    } else if input.selected_proposal_id_present.unwrap_or(false) {
        input
            .selected_proposal_id
            .as_deref()
            .unwrap_or("")
    } else if input.top_escalation_present.unwrap_or(false) {
        input
            .top_escalation_proposal_id
            .as_deref()
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
    let objective_binding = if input.objective_binding_present.unwrap_or(false)
        && !objective_id.is_empty()
    {
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
        evt.hold_reason
            .as_ref()
            .or(evt.route_block_reason.as_ref())
            .map(|v| v.as_str())
            .unwrap_or(""),
    )
    .to_ascii_lowercase();
    if !explicit.is_empty() {
        return explicit;
    }
    normalize_spaces(evt.result.as_deref().unwrap_or("")).to_ascii_lowercase()
}

pub fn compute_policy_hold_pattern(input: &PolicyHoldPatternInput) -> PolicyHoldPatternOutput {
    let objective_id = normalize_spaces(
        input
            .objective_id
            .as_deref()
            .unwrap_or(""),
    );
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
        let evt_objective = normalize_spaces(evt.objective_id.as_deref().unwrap_or(""));
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

pub fn compute_policy_hold_latest_event(
    input: &PolicyHoldLatestEventInput,
) -> PolicyHoldLatestEventOutput {
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
            ts: evt
                .ts
                .as_ref()
                .map(|v| v.to_string())
                .filter(|v| !v.trim().is_empty()),
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
        let readiness_retry_minutes =
            non_negative_number(input.readiness_retry_minutes).unwrap_or(120.0);

        if result == "no_candidates_policy_daily_cap" || result == "no_candidates_policy_canary_cap"
        {
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

pub fn compute_default_backlog_autoscale_state(
    input: &DefaultBacklogAutoscaleStateInput,
) -> DefaultBacklogAutoscaleStateOutput {
    let module = {
        let normalized = input.module.trim();
        if normalized.is_empty() {
            "autonomy_backlog_autoscale".to_string()
        } else {
            normalized.to_string()
        }
    };
    DefaultBacklogAutoscaleStateOutput {
        schema_id: "autonomy_backlog_autoscale".to_string(),
        schema_version: "1.0.0".to_string(),
        module,
        current_cells: 0.0,
        target_cells: 0.0,
        last_run_ts: None,
        last_high_pressure_ts: None,
        last_action: None,
        updated_at: None,
    }
}

fn parse_non_negative_number(value: Option<&serde_json::Value>) -> Option<f64> {
    let parsed = match value {
        Some(v) => {
            if let Some(n) = v.as_f64() {
                Some(n)
            } else if let Some(s) = v.as_str() {
                s.trim().parse::<f64>().ok()
            } else {
                None
            }
        }
        None => None,
    }?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.max(0.0))
}

fn parse_clean_optional_string(value: Option<&serde_json::Value>) -> Option<String> {
    let raw = value.and_then(|v| v.as_str())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn compute_normalize_backlog_autoscale_state(
    input: &NormalizeBacklogAutoscaleStateInput,
) -> NormalizeBacklogAutoscaleStateOutput {
    let module_fallback = {
        let normalized = input.module.trim();
        if normalized.is_empty() {
            "autonomy_backlog_autoscale".to_string()
        } else {
            normalized.to_string()
        }
    };
    let src_obj = input.src.as_ref().and_then(|value| value.as_object());
    let module = src_obj
        .and_then(|obj| obj.get("module"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| module_fallback.clone());
    let current_cells =
        parse_non_negative_number(src_obj.and_then(|obj| obj.get("current_cells"))).unwrap_or(0.0);
    let target_cells =
        parse_non_negative_number(src_obj.and_then(|obj| obj.get("target_cells"))).unwrap_or(0.0);
    let last_run_ts = parse_clean_optional_string(src_obj.and_then(|obj| obj.get("last_run_ts")));
    let last_high_pressure_ts =
        parse_clean_optional_string(src_obj.and_then(|obj| obj.get("last_high_pressure_ts")));
    let last_action = parse_clean_optional_string(src_obj.and_then(|obj| obj.get("last_action")));
    let updated_at = parse_clean_optional_string(src_obj.and_then(|obj| obj.get("updated_at")));
    NormalizeBacklogAutoscaleStateOutput {
        schema_id: "autonomy_backlog_autoscale".to_string(),
        schema_version: "1.0.0".to_string(),
        module,
        current_cells,
        target_cells,
        last_run_ts,
        last_high_pressure_ts,
        last_action,
        updated_at,
    }
}

pub fn compute_spawn_allocated_cells(
    input: &SpawnAllocatedCellsInput,
) -> SpawnAllocatedCellsOutput {
    let resolved = input
        .active_cells
        .or(input.current_cells)
        .or(input.allocated_cells)
        .filter(|value| value.is_finite())
        .map(|value| value.max(0.0).floor() as i64);
    SpawnAllocatedCellsOutput {
        active_cells: resolved,
    }
}

pub fn compute_spawn_capacity_boost_snapshot(
    input: &SpawnCapacityBoostSnapshotInput,
) -> SpawnCapacityBoostSnapshotOutput {
    let base = SpawnCapacityBoostSnapshotOutput {
        enabled: input.enabled,
        active: false,
        lookback_minutes: input.lookback_minutes.max(0.0),
        min_granted_cells: input.min_granted_cells.max(0.0),
        grant_count: 0,
        granted_cells: 0.0,
        latest_ts: None,
    };
    if !input.enabled {
        return base;
    }
    if input.rows.is_empty() {
        return base;
    }
    let now_ms = if input.now_ms.is_finite() {
        input.now_ms
    } else {
        Utc::now().timestamp_millis() as f64
    };
    let cutoff_ms = now_ms - (base.lookback_minutes * 60000.0);
    let mut grant_count: i64 = 0;
    let mut granted_cells: f64 = 0.0;
    let mut latest_ts: Option<String> = None;

    for row in input.rows.iter().rev() {
        let row_type = row
            .r#type
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if row_type != "spawn_request" {
            continue;
        }
        let Some(ts_raw) = row.ts.as_deref() else {
            continue;
        };
        let Some(ts_ms) = parse_rfc3339_ts_ms(ts_raw.trim()) else {
            continue;
        };
        if (ts_ms as f64) < cutoff_ms {
            break;
        }
        let granted = row.granted_cells.unwrap_or(0.0);
        if !granted.is_finite() || granted < base.min_granted_cells {
            continue;
        }
        grant_count += 1;
        granted_cells += granted;
        if latest_ts.is_none() {
            latest_ts = Some(ts_raw.trim().to_string());
        }
    }
    SpawnCapacityBoostSnapshotOutput {
        enabled: base.enabled,
        active: grant_count > 0,
        lookback_minutes: base.lookback_minutes,
        min_granted_cells: base.min_granted_cells,
        grant_count,
        granted_cells: (granted_cells * 1000.0).round() / 1000.0,
        latest_ts,
    }
}

pub fn compute_inversion_maturity_score(
    input: &InversionMaturityScoreInput,
) -> InversionMaturityScoreOutput {
    let total = non_negative_number(Some(input.total_tests)).unwrap_or(0.0);
    let passed = non_negative_number(Some(input.passed_tests)).unwrap_or(0.0);
    let destructive = non_negative_number(Some(input.destructive_failures)).unwrap_or(0.0);
    let target_test_count = non_negative_number(Some(input.target_test_count)).unwrap_or(40.0);
    let weight_pass_rate = non_negative_number(Some(input.weight_pass_rate)).unwrap_or(0.0);
    let weight_non_destructive_rate =
        non_negative_number(Some(input.weight_non_destructive_rate)).unwrap_or(0.0);
    let weight_experience = non_negative_number(Some(input.weight_experience)).unwrap_or(0.0);
    let band_novice = non_negative_number(Some(input.band_novice)).unwrap_or(0.25);
    let band_developing = non_negative_number(Some(input.band_developing)).unwrap_or(0.45);
    let band_mature = non_negative_number(Some(input.band_mature)).unwrap_or(0.65);
    let band_seasoned = non_negative_number(Some(input.band_seasoned)).unwrap_or(0.82);

    let non_destructive_rate = if total > 0.0 {
        ((total - destructive) / total).max(0.0)
    } else {
        1.0
    };
    let pass_rate = if total > 0.0 {
        (passed / total).max(0.0)
    } else {
        0.0
    };
    let experience = (total / target_test_count.max(1.0)).min(1.0);

    let weight_total =
        (weight_pass_rate + weight_non_destructive_rate + weight_experience).max(0.0001);
    let raw_score = ((pass_rate * weight_pass_rate)
        + (non_destructive_rate * weight_non_destructive_rate)
        + (experience * weight_experience))
        / weight_total;
    let score = raw_score.clamp(0.0, 1.0);
    let band = if score < band_novice {
        "novice"
    } else if score < band_developing {
        "developing"
    } else if score < band_mature {
        "mature"
    } else if score < band_seasoned {
        "seasoned"
    } else {
        "legendary"
    };

    InversionMaturityScoreOutput {
        score: ((score * 1_000_000.0).round()) / 1_000_000.0,
        band: band.to_string(),
        pass_rate: ((pass_rate * 1_000_000.0).round()) / 1_000_000.0,
        non_destructive_rate: ((non_destructive_rate * 1_000_000.0).round()) / 1_000_000.0,
        experience: ((experience * 1_000_000.0).round()) / 1_000_000.0,
    }
}

pub fn compute_default_criteria_pattern_memory(
    _input: &DefaultCriteriaPatternMemoryInput,
) -> DefaultCriteriaPatternMemoryOutput {
    DefaultCriteriaPatternMemoryOutput {
        version: "1.0".to_string(),
        updated_at: None,
        patterns: std::collections::BTreeMap::new(),
    }
}

pub fn compute_strategy_execution_mode_effective(
    input: &StrategyExecutionModeEffectiveInput,
) -> StrategyExecutionModeEffectiveOutput {
    let mode_raw = input
        .strategy_mode
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let fallback_raw = input
        .fallback
        .as_ref()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let fallback_mode = if fallback_raw == "score_only" {
        "score_only"
    } else if fallback_raw == "canary_execute" {
        "canary_execute"
    } else {
        "execute"
    };
    let mode = if mode_raw == "score_only" {
        "score_only"
    } else if mode_raw == "canary_execute" {
        "canary_execute"
    } else if mode_raw == "execute" {
        "execute"
    } else {
        fallback_mode
    };
    StrategyExecutionModeEffectiveOutput {
        mode: mode.to_string(),
    }
}

pub fn compute_strategy_canary_exec_limit_effective(
    input: &StrategyCanaryExecLimitEffectiveInput,
) -> StrategyCanaryExecLimitEffectiveOutput {
    let from_strategy = js_like_number(input.strategy_limit.as_ref());
    let from_fallback = input.fallback;
    let choose = from_strategy.or(from_fallback).and_then(|value| {
        if !value.is_finite() || value <= 0.0 {
            None
        } else {
            Some(value.round().clamp(1.0, 20.0))
        }
    });
    StrategyCanaryExecLimitEffectiveOutput { limit: choose }
}

pub fn compute_strategy_exploration_effective(
    input: &StrategyExplorationEffectiveInput,
) -> StrategyExplorationEffectiveOutput {
    let default_fraction = input.default_fraction.unwrap_or(0.25);
    let default_every_n = input.default_every_n.unwrap_or(3.0);
    let default_min_eligible = input.default_min_eligible.unwrap_or(3.0);
    let strategy_obj = input
        .strategy_exploration
        .as_ref()
        .and_then(|value| value.as_object());
    if strategy_obj.is_none() {
        return StrategyExplorationEffectiveOutput {
            fraction: default_fraction,
            every_n: default_every_n,
            min_eligible: default_min_eligible,
        };
    }
    let strategy_obj = strategy_obj.expect("checked is_some");
    StrategyExplorationEffectiveOutput {
        fraction: js_like_number(strategy_obj.get("fraction")).unwrap_or(default_fraction),
        every_n: js_like_number(strategy_obj.get("every_n")).unwrap_or(default_every_n),
        min_eligible: js_like_number(strategy_obj.get("min_eligible"))
            .unwrap_or(default_min_eligible),
    }
}

pub fn compute_strategy_budget_effective(
    input: &StrategyBudgetEffectiveInput,
) -> StrategyBudgetEffectiveOutput {
    let mut budget = input
        .caps
        .as_ref()
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let hard_runs = input.hard_runs.filter(|v| v.is_finite() && *v > 0.0);
    let hard_tokens = input.hard_tokens.filter(|v| v.is_finite() && *v > 0.0);
    let hard_per_action = input.hard_per_action.filter(|v| v.is_finite() && *v > 0.0);

    if let Some(hard) = hard_runs {
        if let Some(current) = js_like_number(budget.get("daily_runs_cap")) {
            budget.insert(
                "daily_runs_cap".to_string(),
                serde_json::Value::from(current.min(hard)),
            );
        }
    }
    if let Some(hard) = hard_tokens {
        if let Some(current) = js_like_number(budget.get("daily_token_cap")) {
            budget.insert(
                "daily_token_cap".to_string(),
                serde_json::Value::from(current.min(hard)),
            );
        }
    }
    if let Some(hard) = hard_per_action {
        if let Some(current) = js_like_number(budget.get("max_tokens_per_action")) {
            budget.insert(
                "max_tokens_per_action".to_string(),
                serde_json::Value::from(current.min(hard)),
            );
        }
    }

    StrategyBudgetEffectiveOutput {
        budget: serde_json::Value::Object(budget),
    }
}

pub fn compute_preexec_verdict_from_signals(
    input: &PreexecVerdictFromSignalsInput,
) -> PreexecVerdictFromSignalsOutput {
    let blocker_rows = input
        .blockers
        .iter()
        .filter(|row| row.is_object())
        .collect::<Vec<_>>();
    let blocker_codes = blocker_rows
        .iter()
        .filter_map(|row| {
            row.as_object()
                .and_then(|obj| obj.get("code"))
                .map(js_like_string)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .take(16)
        .collect::<Vec<_>>();
    let manual_action_required = blocker_rows.iter().any(|row| {
        row.as_object()
            .and_then(|obj| obj.get("retryable"))
            .map(|value| value != &serde_json::Value::Bool(true))
            .unwrap_or(true)
    });
    let retryable_only = !blocker_rows.is_empty()
        && blocker_rows.iter().all(|row| {
            row.as_object()
                .and_then(|obj| obj.get("retryable"))
                .map(|value| value == &serde_json::Value::Bool(true))
                .unwrap_or(false)
        });
    let mut verdict = "proceed".to_string();
    if !blocker_rows.is_empty() {
        verdict = if manual_action_required {
            "reject".to_string()
        } else if retryable_only {
            "defer".to_string()
        } else {
            "reject".to_string()
        };
    }

    let signals = input
        .signals
        .clone()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let signal_rows = signals
        .as_object()
        .cloned()
        .unwrap_or_default()
        .into_values()
        .collect::<Vec<_>>();
    let mut fail_count = 0.0;
    let mut warn_count = 0.0;
    for row in signal_rows {
        let status = compute_normalized_signal_status(&NormalizedSignalStatusInput {
            value: row
                .as_object()
                .and_then(|obj| obj.get("status"))
                .map(js_like_string),
            fallback: Some("unknown".to_string()),
        })
        .status;
        if status == "fail" {
            fail_count += 1.0;
        } else if status == "warn" {
            warn_count += 1.0;
        }
    }
    let blocker_penalty = if blocker_rows.is_empty() {
        0.0
    } else {
        (blocker_rows.len() as f64 * 0.06).min(0.42)
    };
    let mut confidence = 1.0 - (fail_count * 0.22) - (warn_count * 0.08) - blocker_penalty;
    confidence = confidence.clamp(0.05, 1.0);
    if verdict == "reject" {
        confidence = confidence.min(0.49);
    }
    if verdict == "defer" {
        confidence = confidence.min(0.69);
    }
    let confidence = ((confidence * 1000.0).round()) / 1000.0;
    let next_runnable_at = if verdict == "proceed" {
        Some(
            compute_now_iso(&NowIsoInput {
                now_iso: input.now_iso.clone(),
            })
            .value,
        )
    } else {
        input
            .next_runnable_at
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    PreexecVerdictFromSignalsOutput {
        verdict,
        confidence,
        blocker_count: blocker_rows.len() as u32,
        blocker_codes,
        manual_action_required,
        next_runnable_at,
        signals,
    }
}

pub fn compute_score_only_proposal_churn(
    input: &ScoreOnlyProposalChurnInput,
) -> ScoreOnlyProposalChurnOutput {
    let proposal_id = input
        .proposal_id
        .as_ref()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if proposal_id.is_empty() {
        return ScoreOnlyProposalChurnOutput {
            count: 0,
            streak: 0,
            first_ts: None,
            last_ts: None,
        };
    }
    let now_ms = input
        .now_ms
        .filter(|value| value.is_finite())
        .unwrap_or_else(|| Utc::now().timestamp_millis() as f64);
    let window_ms = input
        .window_hours
        .filter(|value| value.is_finite())
        .unwrap_or(1.0)
        .max(1.0)
        * 3_600_000.0;
    let cutoff_ms = now_ms - window_ms;

    let mut matches = Vec::<(i64, serde_json::Value)>::new();
    for evt in &input.prior_runs {
        let Some(obj) = evt.as_object() else {
            continue;
        };
        let event_type = obj
            .get("type")
            .map(js_like_string)
            .unwrap_or_default()
            .trim()
            .to_string();
        if event_type != "autonomy_run" {
            continue;
        }
        let pid = obj
            .get("proposal_id")
            .map(js_like_string)
            .unwrap_or_default()
            .trim()
            .to_string();
        if pid != proposal_id {
            continue;
        }
        let ts_raw = obj
            .get("ts")
            .map(js_like_string)
            .unwrap_or_default()
            .trim()
            .to_string();
        if ts_raw.is_empty() {
            continue;
        }
        let parsed = compute_parse_iso_ts(&ParseIsoTsInput {
            ts: Some(ts_raw.clone()),
        });
        let Some(ts_ms) = parsed.timestamp_ms else {
            continue;
        };
        if ts_ms < cutoff_ms {
            continue;
        }
        let failure_like = compute_score_only_failure_like(&ScoreOnlyFailureLikeInput {
            event_type: Some(event_type),
            result: Some(obj.get("result").map(js_like_string).unwrap_or_default()),
            preview_verification_present: Some(obj.get("preview_verification").is_some()),
            preview_verification_passed: obj
                .get("preview_verification")
                .and_then(|row| row.as_object())
                .and_then(|map| map.get("passed"))
                .and_then(|value| value.as_bool()),
            preview_verification_outcome: obj
                .get("preview_verification")
                .and_then(|row| row.as_object())
                .and_then(|map| map.get("outcome"))
                .map(js_like_string),
        });
        if !failure_like.is_failure_like {
            continue;
        }
        matches.push((ts_ms as i64, evt.clone()));
    }
    matches.sort_by(|a, b| a.0.cmp(&b.0));
    let mut streak: u32 = 0;
    for (_, evt) in matches.iter().rev() {
        let Some(obj) = evt.as_object() else {
            break;
        };
        let failure_like = compute_score_only_failure_like(&ScoreOnlyFailureLikeInput {
            event_type: Some(obj.get("type").map(js_like_string).unwrap_or_default()),
            result: Some(obj.get("result").map(js_like_string).unwrap_or_default()),
            preview_verification_present: Some(obj.get("preview_verification").is_some()),
            preview_verification_passed: obj
                .get("preview_verification")
                .and_then(|row| row.as_object())
                .and_then(|map| map.get("passed"))
                .and_then(|value| value.as_bool()),
            preview_verification_outcome: obj
                .get("preview_verification")
                .and_then(|row| row.as_object())
                .and_then(|map| map.get("outcome"))
                .map(js_like_string),
        });
        if !failure_like.is_failure_like {
            break;
        }
        streak += 1;
    }
    let first_ts = matches
        .first()
        .and_then(|(ms, _)| DateTime::<Utc>::from_timestamp_millis(*ms))
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true));
    let last_ts = matches
        .last()
        .and_then(|(ms, _)| DateTime::<Utc>::from_timestamp_millis(*ms))
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true));
    ScoreOnlyProposalChurnOutput {
        count: matches.len() as u32,
        streak,
        first_ts,
        last_ts,
    }
}

pub fn compute_success_criteria_quality_audit(
    input: &SuccessCriteriaQualityAuditInput,
) -> SuccessCriteriaQualityAuditOutput {
    let base = input
        .verification
        .clone()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(base_obj) = base.as_object() else {
        return SuccessCriteriaQualityAuditOutput { verification: base };
    };
    let criteria = base_obj
        .get("success_criteria")
        .and_then(|value| value.as_object());
    if criteria.is_none() {
        let mut out = base_obj.clone();
        out.insert("criteria_quality".to_string(), serde_json::Value::Null);
        out.insert(
            "criteria_quality_insufficient".to_string(),
            serde_json::Value::Bool(false),
        );
        return SuccessCriteriaQualityAuditOutput {
            verification: serde_json::Value::Object(out),
        };
    }
    let criteria = criteria.expect("checked is_some");
    let checks = criteria
        .get("checks")
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let obj = row.as_object();
                    AssessSuccessCriteriaQualityCheckInput {
                        evaluated: obj
                            .and_then(|map| map.get("evaluated"))
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false),
                        reason: obj.and_then(|map| {
                            map.get("reason")
                                .map(js_like_string)
                                .map(|value| value.trim().to_string())
                                .filter(|value| !value.is_empty())
                        }),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let quality = compute_assess_success_criteria_quality(&AssessSuccessCriteriaQualityInput {
        checks,
        total_count: criteria
            .get("total_count")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0),
        unknown_count: criteria
            .get("unknown_count")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0),
        synthesized: criteria
            .get("synthesized")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    });
    let quality_json = serde_json::to_value(&quality).unwrap_or_else(|_| serde_json::json!({}));
    let mut out = base_obj.clone();
    out.insert("criteria_quality".to_string(), quality_json);
    out.insert(
        "criteria_quality_insufficient".to_string(),
        serde_json::Value::Bool(quality.insufficient),
    );
    SuccessCriteriaQualityAuditOutput {
        verification: serde_json::Value::Object(out),
    }
}

pub fn compute_detect_eyes_terminology_drift(
    input: &DetectEyesTerminologyDriftInput,
) -> DetectEyesTerminologyDriftOutput {
    let mut warnings = Vec::<DetectEyesTerminologyDriftWarning>::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    let eye_terms_re = Regex::new(r"\beye\b|\beyes\b").expect("valid eye regex");
    for proposal in &input.proposals {
        let proposal_obj = proposal.as_object();
        if proposal_obj.is_none() {
            continue;
        }
        let proposal_obj = proposal_obj.expect("checked is_some");
        let evidence = proposal_obj
            .get("evidence")
            .and_then(|value| value.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.as_object())
                    .map(|row| ProposalTextBlobEvidenceEntryInput {
                        evidence_ref: row.get("evidence_ref").map(js_like_string),
                        path: row.get("path").map(js_like_string),
                        title: row.get("title").map(js_like_string),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let blob = compute_proposal_text_blob(&ProposalTextBlobInput {
            title: proposal_obj.get("title").map(js_like_string),
            summary: proposal_obj.get("summary").map(js_like_string),
            suggested_next_command: proposal_obj
                .get("suggested_next_command")
                .map(js_like_string),
            suggested_command: proposal_obj.get("suggested_command").map(js_like_string),
            notes: proposal_obj.get("notes").map(js_like_string),
            evidence,
        })
        .blob;
        if blob.is_empty() || !eye_terms_re.is_match(&blob) {
            continue;
        }
        let mut matched_tools = Vec::<String>::new();
        for token in &input.tool_capability_tokens {
            let mentioned = compute_tool_token_mentioned(&ToolTokenMentionedInput {
                blob: Some(blob.clone()),
                token: Some(token.clone()),
            });
            if mentioned.mentioned {
                matched_tools.push(token.clone());
            }
        }
        if matched_tools.is_empty() {
            continue;
        }
        let proposal_id = proposal_obj
            .get("id")
            .map(js_like_string)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let dedup_key = format!(
            "{}:{}",
            proposal_id.clone().unwrap_or_else(|| "unknown".to_string()),
            matched_tools.join(",")
        );
        if !seen.insert(dedup_key) {
            continue;
        }
        let sample = proposal_obj
            .get("title")
            .map(js_like_string)
            .unwrap_or_default();
        let sample = normalize_spaces(&sample);
        let sample = sample.chars().take(140).collect::<String>();
        warnings.push(DetectEyesTerminologyDriftWarning {
            proposal_id,
            reason: "tools_labeled_as_eyes".to_string(),
            matched_tools: matched_tools.into_iter().take(5).collect(),
            sample,
        });
        if warnings.len() >= 5 {
            break;
        }
    }
    DetectEyesTerminologyDriftOutput { warnings }
}

pub fn compute_normalize_stored_proposal_row(
    input: &NormalizeStoredProposalRowInput,
) -> NormalizeStoredProposalRowOutput {
    let Some(raw) = input.proposal.as_ref() else {
        return NormalizeStoredProposalRowOutput {
            proposal: serde_json::Value::Null,
        };
    };
    let Some(raw_obj) = raw.as_object() else {
        return NormalizeStoredProposalRowOutput {
            proposal: raw.clone(),
        };
    };
    let mut next = raw_obj.clone();
    let fallback = input
        .fallback
        .as_ref()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "pending".to_string());
    let normalized_status = compute_normalize_proposal_status(&NormalizeProposalStatusInput {
        raw_status: next.get("status").map(js_like_string),
        fallback: Some(fallback),
    })
    .normalized_status;
    next.insert(
        "status".to_string(),
        serde_json::Value::String(normalized_status),
    );
    let normalized_type = input
        .proposal_type
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "local_state_fallback".to_string());
    next.insert(
        "type".to_string(),
        serde_json::Value::String(normalized_type.clone()),
    );
    let mut meta = next
        .get("meta")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    meta.insert(
        "normalized_proposal_type".to_string(),
        serde_json::Value::String(normalized_type),
    );
    meta.insert(
        "proposal_type_source".to_string(),
        serde_json::Value::String(
            input
                .proposal_type_source
                .as_ref()
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
    );
    meta.insert(
        "proposal_type_inferred".to_string(),
        serde_json::Value::Bool(input.proposal_type_inferred.unwrap_or(false)),
    );
    next.insert("meta".to_string(), serde_json::Value::Object(meta));
    NormalizeStoredProposalRowOutput {
        proposal: serde_json::Value::Object(next),
    }
}

pub fn compute_recent_proposal_key_counts(
    input: &RecentProposalKeyCountsInput,
) -> RecentProposalKeyCountsOutput {
    let cutoff_ms = input
        .cutoff_ms
        .filter(|value| value.is_finite())
        .unwrap_or(0.0);
    let mut counts = std::collections::BTreeMap::<String, f64>::new();
    for evt in &input.events {
        let key = evt
            .proposal_key
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(key) = key else {
            continue;
        };
        let ts_ms = evt.ts_ms.unwrap_or(f64::NAN);
        if !ts_ms.is_finite() || ts_ms < cutoff_ms {
            continue;
        }
        let result = evt
            .result
            .as_ref()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if result != "executed"
            && result != "score_only_preview"
            && result != "stop_repeat_gate_circuit_breaker"
            && !evt.is_attempt
        {
            continue;
        }
        let next = counts.get(&key).copied().unwrap_or(0.0) + 1.0;
        counts.insert(key, next);
    }
    RecentProposalKeyCountsOutput { counts }
}

pub fn compute_capability_attempt_count_for_date(
    input: &CapabilityAttemptCountForDateInput,
) -> CapabilityAttemptCountForDateOutput {
    let keys = input
        .keys
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    if keys.is_empty() {
        return CapabilityAttemptCountForDateOutput { count: 0.0 };
    }
    let mut count = 0.0;
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if event_type != "autonomy_run" || !evt.is_attempt {
            continue;
        }
        let key = evt
            .capability_key
            .as_ref()
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        if keys.contains(&key) {
            count += 1.0;
        }
    }
    CapabilityAttemptCountForDateOutput { count }
}

pub fn compute_capability_outcome_stats_in_window(
    input: &CapabilityOutcomeStatsInWindowInput,
) -> CapabilityOutcomeStatsInWindowOutput {
    let keys = input
        .keys
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let mut out = CapabilityOutcomeStatsInWindowOutput {
        executed: 0.0,
        shipped: 0.0,
        no_change: 0.0,
        reverted: 0.0,
    };
    if keys.is_empty() {
        return out;
    }
    for evt in &input.events {
        let event_type = evt
            .event_type
            .as_ref()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let result = evt
            .result
            .as_ref()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if event_type != "autonomy_run" || result != "executed" {
            continue;
        }
        let key = evt
            .capability_key
            .as_ref()
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if key.is_empty() || !keys.contains(&key) {
            continue;
        }
        out.executed += 1.0;
        let outcome = evt
            .outcome
            .as_ref()
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if outcome == "shipped" {
            out.shipped += 1.0;
        } else if outcome == "no_change" {
            out.no_change += 1.0;
        } else if outcome == "reverted" {
            out.reverted += 1.0;
        }
    }
    out
}

pub fn compute_execute_confidence_history(
    input: &ExecuteConfidenceHistoryInput,
) -> ExecuteConfidenceHistoryOutput {
    let mut out = ExecuteConfidenceHistoryOutput {
        window_days: input.window_days,
        proposal_type: input
            .proposal_type
            .as_ref()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty()),
        capability_key: input
            .capability_key
            .as_ref()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty()),
        matched_events: 0.0,
        confidence_fallback: 0.0,
        route_blocked: 0.0,
        executed: 0.0,
        shipped: 0.0,
        no_change: 0.0,
        reverted: 0.0,
        no_change_rate: 0.0,
        reverted_rate: 0.0,
    };
    for evt in &input.events {
        if !evt.matched {
            continue;
        }
        out.matched_events += 1.0;
        let result = evt
            .result
            .as_ref()
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        if result == "score_only_fallback_low_execution_confidence" {
            out.confidence_fallback += 1.0;
            continue;
        }
        if result == "score_only_fallback_route_block" || result == "init_gate_blocked_route" {
            out.route_blocked += 1.0;
            continue;
        }
        if result != "executed" {
            continue;
        }
        out.executed += 1.0;
        let outcome = evt
            .outcome
            .as_ref()
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if outcome == "shipped" {
            out.shipped += 1.0;
        } else if outcome == "no_change" {
            out.no_change += 1.0;
        } else if outcome == "reverted" {
            out.reverted += 1.0;
        }
    }
    if out.executed > 0.0 {
        out.no_change_rate = ((out.no_change / out.executed) * 1000.0).round() / 1000.0;
        out.reverted_rate = ((out.reverted / out.executed) * 1000.0).round() / 1000.0;
    }
    out
}

pub fn compute_execute_confidence_policy(
    input: &ExecuteConfidencePolicyInput,
) -> ExecuteConfidencePolicyOutput {
    let history_obj = input
        .history
        .as_ref()
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let history_executed = history_obj
        .get("executed")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    let history_shipped = history_obj
        .get("shipped")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    let history_reverted = history_obj
        .get("reverted")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    let history_no_change_rate = history_obj
        .get("no_change_rate")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    let history_confidence_fallback = history_obj
        .get("confidence_fallback")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);

    let mut composite_margin = input.base_composite_margin.max(0.0);
    let mut value_margin = input.base_value_margin.max(0.0);
    let mut reasons = Vec::<String>::new();

    let risk = input
        .risk
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value == "low" || value == "medium" || value == "high")
        .unwrap_or_else(|| "low".to_string());
    let execution_mode = input
        .execution_mode
        .as_ref()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    if input.adaptive_enabled && execution_mode == "canary_execute" && risk == "low" {
        composite_margin = (composite_margin - input.low_risk_relax_composite.max(0.0)).max(0.0);
        value_margin = (value_margin - input.low_risk_relax_value.max(0.0)).max(0.0);
        reasons.push("low_risk_canary_relax".to_string());
    }

    if input.adaptive_enabled
        && history_reverted <= 0.0
        && history_confidence_fallback >= input.fallback_relax_every.max(1.0)
    {
        let ship_rate = if history_executed > 0.0 {
            history_shipped / history_executed.max(1.0)
        } else {
            0.0
        };
        let relax_eligible = history_executed >= input.fallback_relax_min_executed
            && history_shipped >= input.fallback_relax_min_shipped
            && ship_rate >= input.fallback_relax_min_ship_rate;
        if relax_eligible {
            let relax_steps =
                (history_confidence_fallback / input.fallback_relax_every.max(1.0)).floor();
            let relax_raw = relax_steps * input.fallback_relax_step.max(0.0);
            let relax = relax_raw.clamp(0.0, input.fallback_relax_max.max(0.0));
            if relax > 0.0 {
                composite_margin = (composite_margin - relax).max(0.0);
                value_margin = (value_margin - relax).max(0.0);
                reasons.push("fallback_churn_relax".to_string());
            }
        } else {
            reasons.push("fallback_churn_relax_blocked_low_success".to_string());
        }
    }

    if input.adaptive_enabled
        && history_executed >= input.no_change_tighten_min_executed
        && history_no_change_rate >= input.no_change_tighten_threshold
    {
        composite_margin += input.no_change_tighten_step.max(0.0);
        value_margin += input.no_change_tighten_step.max(0.0);
        reasons.push("high_no_change_tighten".to_string());
    }

    if history_reverted > 0.0 {
        composite_margin = composite_margin.max(input.base_composite_margin.max(0.0));
        value_margin = value_margin.max(input.base_value_margin.max(0.0));
        reasons.push("reverted_restore_base".to_string());
    }

    let ship_rate = if history_executed > 0.0 {
        ((history_shipped / history_executed.max(1.0)) * 1000.0).round() / 1000.0
    } else {
        0.0
    };
    let policy = serde_json::json!({
        "adaptive_enabled": input.adaptive_enabled,
        "proposal_type": input.proposal_type.as_ref().map(|v| v.trim().to_ascii_lowercase()).filter(|v| !v.is_empty()),
        "capability_key": input.capability_key.as_ref().map(|v| v.trim().to_ascii_lowercase()).filter(|v| !v.is_empty()),
        "risk": risk,
        "execution_mode": execution_mode,
        "base": {
            "composite_margin": input.base_composite_margin.max(0.0),
            "value_margin": input.base_value_margin.max(0.0)
        },
        "applied": {
            "composite_margin": composite_margin.max(0.0),
            "value_margin": value_margin.max(0.0)
        },
        "history": history_obj,
        "fallback_relax_eligibility": {
            "min_executed": input.fallback_relax_min_executed,
            "min_shipped": input.fallback_relax_min_shipped,
            "min_ship_rate": input.fallback_relax_min_ship_rate,
            "ship_rate": ship_rate
        },
        "reasons": reasons
    });
    ExecuteConfidencePolicyOutput { policy }
}

pub fn compute_directive_fit_assessment(
    input: &DirectiveFitAssessmentInput,
) -> DirectiveFitAssessmentOutput {
    let active_directive_ids = input
        .active_directive_ids
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if !input.profile_available {
        return DirectiveFitAssessmentOutput {
            pass: true,
            score: 100.0,
            profile_available: false,
            active_directive_ids,
            reasons: vec!["directive_profile_unavailable".to_string()],
            matched_positive: Vec::new(),
            matched_negative: Vec::new(),
        };
    }

    let positive_phrase_hits = input
        .positive_phrase_hits
        .iter()
        .map(|value| normalize_spaces(value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let positive_token_hits = input
        .positive_token_hits
        .iter()
        .map(|value| normalize_spaces(value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let strategy_hits = input
        .strategy_hits
        .iter()
        .map(|value| normalize_spaces(value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let negative_phrase_hits = input
        .negative_phrase_hits
        .iter()
        .map(|value| normalize_spaces(value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let negative_token_hits = input
        .negative_token_hits
        .iter()
        .map(|value| normalize_spaces(value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    let mut score = 30.0;
    score += positive_phrase_hits.len() as f64 * 18.0;
    score += ((positive_token_hits.len() as f64) * 5.0).min(30.0);
    score += ((strategy_hits.len() as f64) * 4.0).min(12.0);
    score -= negative_phrase_hits.len() as f64 * 20.0;
    score -= ((negative_token_hits.len() as f64) * 6.0).min(24.0);

    let impact = input
        .impact
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if impact == "high" {
        score += 6.0;
    } else if impact == "medium" {
        score += 3.0;
    }

    let final_score = score.round().clamp(0.0, 100.0);
    let mut reasons = Vec::<String>::new();
    if positive_phrase_hits.is_empty() && positive_token_hits.is_empty() && strategy_hits.is_empty()
    {
        reasons.push("no_directive_alignment".to_string());
    }
    if input.strategy_token_count > 0.0 && strategy_hits.is_empty() {
        reasons.push("no_strategy_marker".to_string());
    }
    if !negative_phrase_hits.is_empty() || !negative_token_hits.is_empty() {
        reasons.push("matches_excluded_scope".to_string());
    }
    let pass = final_score >= input.min_directive_fit;
    if !pass {
        reasons.push("below_min_directive_fit".to_string());
    }

    let mut pos_set = std::collections::BTreeSet::<String>::new();
    for value in positive_phrase_hits
        .iter()
        .chain(positive_token_hits.iter())
        .chain(strategy_hits.iter())
    {
        if !value.trim().is_empty() {
            pos_set.insert(value.trim().to_string());
        }
    }
    let matched_positive = pos_set.into_iter().take(5).collect::<Vec<_>>();

    let mut neg_set = std::collections::BTreeSet::<String>::new();
    for value in negative_phrase_hits
        .iter()
        .chain(negative_token_hits.iter())
    {
        if !value.trim().is_empty() {
            neg_set.insert(value.trim().to_string());
        }
    }
    let matched_negative = neg_set.into_iter().take(5).collect::<Vec<_>>();

    DirectiveFitAssessmentOutput {
        pass,
        score: final_score,
        profile_available: true,
        active_directive_ids,
        reasons,
        matched_positive,
        matched_negative,
    }
}

pub fn compute_signal_quality_assessment(
    input: &SignalQualityAssessmentInput,
) -> SignalQualityAssessmentOutput {
    let eye_id = input
        .eye_id
        .as_ref()
        .map(|value| normalize_spaces(value))
        .unwrap_or_default();
    let score_source = input
        .score_source
        .as_ref()
        .map(|value| normalize_spaces(value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "fallback_default".to_string());
    let impact = input
        .impact
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let risk = input
        .risk
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let domain = input
        .domain
        .as_ref()
        .map(|value| normalize_spaces(value).to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let url_scheme = input
        .url_scheme
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let sensory_relevance_tier = input
        .sensory_relevance_tier
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let sensory_quality_tier = input
        .sensory_quality_tier
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let eye_status = input
        .eye_status
        .as_ref()
        .map(|value| normalize_spaces(value).to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let parser_type = input
        .parser_type
        .as_ref()
        .map(|value| normalize_spaces(value).to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let mut reasons = Vec::<String>::new();
    let mut hard_block = false;
    let mut score = 0.0;

    if let Some(raw) = input.combined_item_score {
        if raw.is_finite() {
            score += raw.clamp(0.0, 100.0);
        } else {
            score += 18.0;
            reasons.push("missing_meta_score".to_string());
        }
    } else {
        score += 18.0;
        reasons.push("missing_meta_score".to_string());
    }

    if let Some(raw) = input.sensory_relevance_score {
        if raw.is_finite() && raw < input.min_sensory_relevance {
            hard_block = true;
            reasons.push("sensory_relevance_low".to_string());
        }
    }
    if let Some(raw) = input.sensory_quality_score {
        if raw.is_finite() && raw < input.min_sensory_signal {
            hard_block = true;
            reasons.push("sensory_quality_low".to_string());
        }
    }

    if sensory_relevance_tier.as_deref() == Some("low") {
        score -= 8.0;
    }
    if sensory_quality_tier.as_deref() == Some("low") {
        score -= 8.0;
    }

    if impact == "high" {
        score += 12.0;
    } else if impact == "medium" {
        score += 6.0;
    }

    if risk == "high" {
        score -= 12.0;
    } else if risk == "medium" {
        score -= 6.0;
    }

    if url_scheme == "https" {
        score += 6.0;
    } else if url_scheme == "http" {
        score += 2.0;
    } else {
        score -= 8.0;
    }

    if input.title_has_stub {
        score -= 40.0;
        hard_block = true;
        reasons.push("stub_title".to_string());
    }

    if input.eye_known {
        if let Some(eye_score_ema) = input.eye_score_ema {
            if eye_score_ema.is_finite() {
                score += (eye_score_ema - 50.0) * 0.35;
                if eye_score_ema < input.min_eye_score_ema {
                    hard_block = true;
                    reasons.push("eye_score_ema_low".to_string());
                }
            }
        }

        if let Some(status) = eye_status.as_deref() {
            if status == "active" {
                score += 4.0;
            } else if status == "probation" {
                score -= 6.0;
            } else if status == "dormant" {
                score -= 18.0;
                hard_block = true;
                reasons.push("eye_dormant".to_string());
            }
        }

        if input.parser_disallowed {
            score -= 30.0;
            hard_block = true;
            let parser_label = parser_type.as_deref().unwrap_or("unknown");
            reasons.push(format!("parser_disallowed:{parser_label}"));
        }

        if domain.is_some() && input.domain_allowlist_enforced && !input.domain_allowed {
            score -= 3.0;
            reasons.push("domain_outside_allowlist".to_string());
        }

        let proposed_total = input.eye_proposed_total.unwrap_or(0.0);
        if proposed_total >= 3.0 {
            if let Some(yield_rate) = input.eye_yield_rate {
                if yield_rate.is_finite() {
                    score += (yield_rate * 15.0) - 5.0;
                    if yield_rate < 0.1 {
                        reasons.push("eye_yield_low".to_string());
                    }
                }
            }
        }
    } else {
        reasons.push("eye_unknown".to_string());
    }

    let total_bias = input.calibration_eye_bias + input.calibration_topic_bias;
    if total_bias.is_finite() && total_bias != 0.0 {
        score -= total_bias;
        reasons.push(if total_bias > 0.0 {
            "calibration_penalty".to_string()
        } else {
            "calibration_bonus".to_string()
        });
    }

    let final_score = score.round().clamp(0.0, 100.0);
    let pass = !hard_block && final_score >= input.min_signal_quality;
    if !pass && final_score < input.min_signal_quality {
        reasons.push("below_min_signal_quality".to_string());
    }

    SignalQualityAssessmentOutput {
        pass,
        score: final_score,
        score_source,
        eye_id,
        sensory_relevance_score: input.sensory_relevance_score,
        sensory_relevance_tier,
        sensory_quality_score: input.sensory_quality_score,
        sensory_quality_tier,
        eye_status,
        eye_score_ema: input.eye_score_ema,
        parser_type,
        domain,
        calibration_eye_bias: input.calibration_eye_bias,
        calibration_topic_bias: ((input.calibration_topic_bias * 1000.0).round()) / 1000.0,
        calibration_total_bias: ((total_bias * 1000.0).round()) / 1000.0,
        reasons,
    }
}

pub fn compute_actionability_assessment(
    input: &ActionabilityAssessmentInput,
) -> ActionabilityAssessmentOutput {
    let risk = input
        .risk
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let impact = input
        .impact
        .as_ref()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();

    let mut reasons = Vec::<String>::new();
    let mut score = 0.0;
    let mut hard_block = false;

    if impact == "high" {
        score += 24.0;
    } else if impact == "medium" {
        score += 16.0;
    } else {
        score += 8.0;
    }

    if input.specific_validation_count >= 3.0 {
        score += 18.0;
    } else if input.specific_validation_count >= 2.0 {
        score += 12.0;
    } else if input.specific_validation_count >= 1.0 {
        score += 6.0;
    } else if input.validation_count > 0.0 {
        reasons.push("generic_validation_template".to_string());
    } else {
        reasons.push("missing_validation_plan".to_string());
    }

    if input.has_next_cmd {
        if input.generic_route_task {
            score += 4.0;
            reasons.push("generic_next_command_template".to_string());
        } else {
            score += 8.0;
            if !input.next_cmd_has_dry_run {
                score += 4.0;
            } else {
                score += 2.0;
            }
        }
    } else {
        reasons.push("missing_next_command".to_string());
    }

    if input.looks_like_discovery_cmd {
        score -= 18.0;
        reasons.push("discovery_only_command".to_string());
    }

    if input.has_action_verb {
        score += 12.0;
    } else {
        reasons.push("no_action_verb".to_string());
    }

    if input.has_opportunity {
        score += 10.0;
    }

    if let Some(relevance) = input.relevance_score {
        if relevance.is_finite() {
            score += (relevance - 45.0) * 0.3;
        }
    }
    if let Some(fit_score) = input.directive_fit_score {
        if fit_score.is_finite() {
            score += (fit_score - 35.0) * 0.25;
        }
    }

    if input.criteria_requirement_applied {
        if input.measurable_criteria_count >= input.criteria_min_count {
            score += (8.0 + (input.measurable_criteria_count * 2.0)).min(14.0);
        } else {
            score -= 22.0;
            reasons.push("success_criteria_missing".to_string());
            hard_block = true;
        }
    } else if input.measurable_criteria_count > 0.0 {
        score += (input.measurable_criteria_count * 2.0).min(8.0);
    }

    if !input.has_action_verb && !input.has_opportunity && !input.has_concrete_target {
        score -= 20.0;
        reasons.push("missing_concrete_target".to_string());
    }
    if input.is_meta_coordination && !input.has_concrete_target {
        score -= 26.0;
        reasons.push("meta_coordination_without_concrete_target".to_string());
    }
    if input.mentions_proposal && !input.has_concrete_target && !input.has_opportunity {
        score -= 12.0;
        reasons.push("proposal_recursion_without_target".to_string());
    }
    if input.is_explainer && !input.has_action_verb && !input.has_opportunity {
        score -= 12.0;
        reasons.push("explainer_without_execution_path".to_string());
    }
    if input.generic_route_task
        && input.specific_validation_count <= 0.0
        && !input.has_opportunity
        && !input.has_concrete_target
    {
        score -= 18.0;
        reasons.push("boilerplate_execution_path".to_string());
    }

    if input.looks_like_discovery_cmd && impact == "low" && !input.has_action_verb {
        hard_block = true;
        reasons.push("non_actionable_discovery_item".to_string());
    }
    if input.is_meta_coordination
        && !input.has_concrete_target
        && impact == "low"
        && !input.has_opportunity
    {
        hard_block = true;
        reasons.push("non_actionable_meta_item".to_string());
    }

    if input.criteria_pattern_penalty > 0.0 {
        score -= input.criteria_pattern_penalty;
        reasons.push("criteria_pattern_penalty".to_string());
    }

    if risk == "medium" && input.is_executable_proposal && !input.has_rollback_signal {
        score -= 28.0;
        reasons.push("medium_risk_missing_rollback_path".to_string());
        hard_block = true;
    }

    if input.subdirective_required {
        if !input.subdirective_has_concrete_target {
            score -= 18.0;
            reasons.push("subdirective_v2_missing_target".to_string());
            hard_block = true;
        }
        if !input.subdirective_has_expected_delta {
            score -= 20.0;
            reasons.push("subdirective_v2_missing_expected_delta".to_string());
            hard_block = true;
        }
        if !input.subdirective_has_verification_step {
            score -= 20.0;
            reasons.push("subdirective_v2_missing_verification_step".to_string());
            hard_block = true;
        }
    }

    let final_score = score.round().clamp(0.0, 100.0);
    let pass = !hard_block && final_score >= input.min_actionability;
    if !pass && final_score < input.min_actionability {
        reasons.push("below_min_actionability".to_string());
    }

    ActionabilityAssessmentOutput {
        pass,
        score: final_score,
        reasons,
        executable: input.is_executable_proposal,
        rollback_signal: input.has_rollback_signal,
        generic_next_command_template: input.generic_route_task,
        subdirective_v2: serde_json::json!({
            "required": input.subdirective_required,
            "has_concrete_target": input.subdirective_has_concrete_target,
            "has_expected_delta": input.subdirective_has_expected_delta,
            "has_verification_step": input.subdirective_has_verification_step,
            "target_count": input.subdirective_target_count,
            "verify_count": input.subdirective_verify_count,
            "success_criteria_count": input.subdirective_success_criteria_count
        }),
        success_criteria: serde_json::json!({
            "required": input.criteria_requirement_applied,
            "exempt_type": input.criteria_exempt_type,
            "min_count": input.criteria_min_count,
            "measurable_count": input.measurable_criteria_count,
            "total_count": input.criteria_total_count,
            "pattern_penalty": input.criteria_pattern_penalty,
            "pattern_hits": input.criteria_pattern_hits.clone().unwrap_or_else(|| serde_json::json!([]))
        }),
    }
}

fn autoscale_row_id(value: &serde_json::Value) -> String {
    value
        .as_object()
        .and_then(|obj| obj.get("id"))
        .map(js_like_string)
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

fn autoscale_non_negative(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

pub fn compute_strategy_profile(input: &StrategyProfileInput) -> StrategyProfileOutput {
    let strategy = input
        .strategy
        .as_ref()
        .filter(|value| value.is_object())
        .cloned();
    StrategyProfileOutput { strategy }
}

pub fn compute_active_strategy_variants(
    input: &ActiveStrategyVariantsInput,
) -> ActiveStrategyVariantsOutput {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen = std::collections::BTreeSet::<String>::new();

    for row in &input.listed {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let status = obj
            .get("status")
            .map(js_like_string)
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if status != "active" {
            continue;
        }
        let strict_not_ok = obj
            .get("validation")
            .and_then(|v| v.as_object())
            .and_then(|v| v.get("strict_ok"))
            .and_then(|v| v.as_bool())
            == Some(false);
        if strict_not_ok {
            continue;
        }
        let id = autoscale_row_id(row);
        if id.is_empty() || !seen.insert(id) {
            continue;
        }
        out.push(serde_json::Value::Object(obj.clone()));
    }

    if let Some(primary) = input.primary.as_ref() {
        let id = autoscale_row_id(primary);
        if !id.is_empty() && !seen.contains(&id) && primary.is_object() {
            out.push(primary.clone());
        }
    }

    out.sort_by_key(autoscale_row_id);
    ActiveStrategyVariantsOutput { variants: out }
}

pub fn compute_strategy_scorecard_summaries(
    input: &StrategyScorecardSummariesInput,
) -> StrategyScorecardSummariesOutput {
    let mut by_id = std::collections::BTreeMap::<String, StrategyScorecardSummaryItemOutput>::new();
    for row in &input.summaries {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let id = obj
            .get("strategy_id")
            .map(js_like_string)
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let metrics = obj.get("metrics").and_then(|v| v.as_object());
        let score = metrics
            .and_then(|v| v.get("score"))
            .and_then(|v| js_like_number(Some(v)))
            .unwrap_or(0.0);
        let confidence = metrics
            .and_then(|v| v.get("confidence"))
            .and_then(|v| js_like_number(Some(v)))
            .unwrap_or(0.0);
        let stage = obj
            .get("stage")
            .map(js_like_string)
            .map(|v| v.trim().to_ascii_lowercase())
            .filter(|v| !v.is_empty());
        by_id.insert(
            id,
            StrategyScorecardSummaryItemOutput {
                score,
                confidence,
                stage,
            },
        );
    }

    StrategyScorecardSummariesOutput {
        path: input
            .path
            .as_ref()
            .map(|v| v.trim().to_string())
            .unwrap_or_default(),
        ts: input
            .ts
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        by_id,
    }
}

pub fn compute_outcome_fitness_policy(
    input: &OutcomeFitnessPolicyInput,
) -> OutcomeFitnessPolicyOutput {
    let policy = input
        .policy
        .as_ref()
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    OutcomeFitnessPolicyOutput { policy }
}

pub fn compute_load_eyes_map(input: &LoadEyesMapInput) -> LoadEyesMapOutput {
    let mut rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
    let mut idx_by_id = std::collections::HashMap::<String, usize>::new();

    for row in &input.cfg_eyes {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let id = row
            .as_object()
            .and_then(|m| m.get("id"))
            .map(js_like_string)
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        if let Some(index) = idx_by_id.get(&id).copied() {
            rows[index] = obj.clone();
        } else {
            idx_by_id.insert(id, rows.len());
            rows.push(obj.clone());
        }
    }

    for row in &input.state_eyes {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let id = row
            .as_object()
            .and_then(|m| m.get("id"))
            .map(js_like_string)
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        if let Some(index) = idx_by_id.get(&id).copied() {
            let merged = &mut rows[index];
            for (key, value) in obj {
                merged.insert(key.clone(), value.clone());
            }
        } else {
            idx_by_id.insert(id, rows.len());
            rows.push(obj.clone());
        }
    }

    LoadEyesMapOutput {
        eyes: rows
            .into_iter()
            .map(serde_json::Value::Object)
            .collect::<Vec<_>>(),
    }
}

pub fn compute_fallback_directive_objective_ids(
    input: &FallbackDirectiveObjectiveIdsInput,
) -> FallbackDirectiveObjectiveIdsOutput {
    let mut ids = std::collections::BTreeSet::<String>::new();
    for raw in &input.directive_ids {
        let id = sanitize_directive_objective_id(raw);
        if !id.is_empty() {
            ids.insert(id);
        }
    }
    FallbackDirectiveObjectiveIdsOutput {
        ids: ids.into_iter().collect(),
    }
}

pub fn compute_queue_pressure_snapshot(
    input: &QueuePressureSnapshotInput,
) -> QueuePressureSnapshotOutput {
    let mut total: u32 = 0;
    let mut pending: u32 = 0;
    let mut accepted: u32 = 0;
    let mut closed: u32 = 0;
    let mut rejected: u32 = 0;
    let mut parked: u32 = 0;

    for status in &input.statuses {
        total += 1;
        let normalized = status.trim().to_ascii_lowercase();
        if normalized == "pending" {
            pending += 1;
        } else if normalized == "accepted" {
            accepted += 1;
        } else if normalized == "closed" {
            closed += 1;
        } else if normalized == "rejected" {
            rejected += 1;
        } else if normalized == "parked" {
            parked += 1;
        }
    }

    let pending_ratio = if total > 0 {
        round6((pending as f64) / (total as f64))
    } else {
        0.0
    };
    let warn_ratio = round6(clamp_ratio(input.warn_ratio));
    let critical_ratio = round6(clamp_ratio(input.critical_ratio));
    let warn_count = autoscale_non_negative(input.warn_count);
    let critical_count = autoscale_non_negative(input.critical_count);

    let mut pressure = "normal".to_string();
    if (pending as f64) >= critical_count || pending_ratio >= critical_ratio {
        pressure = "critical".to_string();
    } else if (pending as f64) >= warn_count || pending_ratio >= warn_ratio {
        pressure = "warning".to_string();
    }

    QueuePressureSnapshotOutput {
        total,
        pending,
        accepted,
        closed,
        rejected,
        parked,
        pending_ratio,
        pressure,
        warn_ratio,
        critical_ratio,
        warn_count,
        critical_count,
    }
}

fn push_parse_success_criteria_text(
    rows: &mut Vec<ParseSuccessCriteriaRowOutput>,
    text: &str,
    source: &str,
    success_metric_re: &Regex,
    success_timebound_re: &Regex,
    success_relaxed_horizon_re: &Regex,
    success_comparator_re: &Regex,
) {
    let clean = normalize_spaces(text);
    if clean.is_empty() {
        return;
    }
    let has_timebound =
        success_timebound_re.is_match(&clean) || success_relaxed_horizon_re.is_match(&clean);
    let metric = success_metric_re
        .captures(&clean)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_ascii_lowercase())
        .unwrap_or_default();
    let measurable = success_metric_re.is_match(&clean)
        && (has_timebound
            || clean.chars().any(|ch| ch.is_ascii_digit())
            || success_comparator_re.is_match(&clean));
    rows.push(ParseSuccessCriteriaRowOutput {
        source: source.to_string(),
        metric,
        target: clean.chars().take(140).collect(),
        measurable,
    });
}

pub fn compute_parse_success_criteria_rows(
    input: &ParseSuccessCriteriaRowsInput,
) -> ParseSuccessCriteriaRowsOutput {
    let success_metric_re = Regex::new(
        r"(?i)\b(metric|kpi|target|rate|count|latency|error|uptime|throughput|conversion|artifact|receipt|coverage|reply|interview|pass|fail|delta|percent|%|run|runs|check|checks|items_collected)\b",
    )
    .expect("valid success metric regex");
    let success_timebound_re = Regex::new(
        r"(?i)\b(\d+\s*(h|hr|hour|hours|d|day|days|w|week|weeks|min|mins|minute|minutes)|daily|weekly|monthly|quarterly)\b",
    )
    .expect("valid success timebound regex");
    let success_relaxed_horizon_re =
        Regex::new(r"(?i)\b(next|this)\s+(run|cycle)\b").expect("valid success relaxed regex");
    let success_comparator_re =
        Regex::new(r"(?i)\b(>=|<=|>|<|at least|at most|less than|more than|within|under|over)\b")
            .expect("valid success comparator regex");

    let has_timebound = |text: &str| -> bool {
        let clean = normalize_spaces(text);
        if clean.is_empty() {
            return false;
        }
        success_timebound_re.is_match(&clean) || success_relaxed_horizon_re.is_match(&clean)
    };
    let structured_measurable = |metric: &str, target: &str, horizon: &str| -> bool {
        let m = normalize_spaces(metric);
        let t = normalize_spaces(target);
        let h = normalize_spaces(horizon);
        if m.is_empty() || t.is_empty() {
            return false;
        }
        let metric_like = success_metric_re.is_match(&m) || m.contains('_') || m.contains('-');
        let quantified_target = t.chars().any(|ch| ch.is_ascii_digit())
            || success_comparator_re.is_match(&t)
            || success_metric_re.is_match(&t);
        let timebound = has_timebound(&format!("{h} {t}"));
        metric_like && (quantified_target || timebound)
    };

    let mut rows: Vec<ParseSuccessCriteriaRowOutput> = Vec::new();

    for row in &input.action_rows {
        if let Some(raw) = row.as_str() {
            push_parse_success_criteria_text(
                &mut rows,
                raw,
                "action_spec.success_criteria",
                &success_metric_re,
                &success_timebound_re,
                &success_relaxed_horizon_re,
                &success_comparator_re,
            );
            continue;
        }
        let Some(obj) = row.as_object() else {
            continue;
        };
        let metric_raw = obj
            .get("metric")
            .or_else(|| obj.get("name"))
            .map(js_like_string)
            .unwrap_or_default();
        let target_raw = obj
            .get("target")
            .or_else(|| obj.get("threshold"))
            .or_else(|| obj.get("description"))
            .or_else(|| obj.get("goal"))
            .map(js_like_string)
            .unwrap_or_default();
        let horizon_raw = obj
            .get("horizon")
            .or_else(|| obj.get("window"))
            .or_else(|| obj.get("by"))
            .map(js_like_string)
            .unwrap_or_default();

        let metric = normalize_spaces(&metric_raw);
        let target = normalize_spaces(&target_raw);
        let horizon = normalize_spaces(&horizon_raw);
        let merged = normalize_spaces(
            &[metric.clone(), target.clone(), horizon.clone()]
                .into_iter()
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" | "),
        );
        if merged.is_empty() {
            continue;
        }
        rows.push(ParseSuccessCriteriaRowOutput {
            source: "action_spec.success_criteria".to_string(),
            metric: metric.to_ascii_lowercase(),
            target: merged.chars().take(140).collect(),
            measurable: structured_measurable(&metric, &target, &horizon),
        });
    }

    for row in &input.verify_rows {
        let text = js_like_string(row);
        push_parse_success_criteria_text(
            &mut rows,
            &text,
            "action_spec.verify",
            &success_metric_re,
            &success_timebound_re,
            &success_relaxed_horizon_re,
            &success_comparator_re,
        );
    }
    for row in &input.validation_rows {
        let text = js_like_string(row);
        push_parse_success_criteria_text(
            &mut rows,
            &text,
            "validation",
            &success_metric_re,
            &success_timebound_re,
            &success_relaxed_horizon_re,
            &success_comparator_re,
        );
    }

    let mut dedupe = std::collections::HashSet::<String>::new();
    let mut out: Vec<ParseSuccessCriteriaRowOutput> = Vec::new();
    for row in rows {
        if row.target.is_empty() {
            continue;
        }
        let key = format!("{}|{}", row.metric, row.target).to_ascii_lowercase();
        if !dedupe.insert(key) {
            continue;
        }
        out.push(row);
    }

    ParseSuccessCriteriaRowsOutput { rows: out }
}

pub fn compute_collect_outcome_stats(
    input: &CollectOutcomeStatsInput,
) -> CollectOutcomeStatsOutput {
    let normalize_bucket = |row: &CollectOutcomeStatsBucketInput| CollectOutcomeStatsBucketInput {
        shipped: autoscale_non_negative(row.shipped),
        no_change: autoscale_non_negative(row.no_change),
        reverted: autoscale_non_negative(row.reverted),
    };
    let to_bias_output = |row: &CollectOutcomeStatsBucketInput, min_total: f64| {
        let normalized = normalize_bucket(row);
        let derived = compute_derive_entity_bias(&DeriveEntityBiasInput {
            shipped: normalized.shipped,
            no_change: normalized.no_change,
            reverted: normalized.reverted,
            min_total: autoscale_non_negative(min_total),
        });
        (
            derived.bias,
            CollectOutcomeStatsBiasOutput {
                shipped: normalized.shipped,
                no_change: normalized.no_change,
                reverted: normalized.reverted,
                total: derived.total,
                bias: derived.bias,
            },
        )
    };

    let global_normalized = normalize_bucket(&input.global);
    let global_total = compute_total_outcomes(&TotalOutcomesInput {
        shipped: global_normalized.shipped,
        no_change: global_normalized.no_change,
        reverted: global_normalized.reverted,
    })
    .total;
    let global = CollectOutcomeStatsGlobalOutput {
        shipped: global_normalized.shipped,
        no_change: global_normalized.no_change,
        reverted: global_normalized.reverted,
        total: global_total,
    };

    let mut eye_biases = std::collections::BTreeMap::<String, CollectOutcomeStatsBiasOutput>::new();
    for (key, row) in &input.by_eye {
        let (bias, output) = to_bias_output(row, input.eye_min_samples);
        if bias != 0.0 {
            eye_biases.insert(key.clone(), output);
        }
    }

    let mut topic_biases =
        std::collections::BTreeMap::<String, CollectOutcomeStatsBiasOutput>::new();
    for (key, row) in &input.by_topic {
        let (bias, output) = to_bias_output(row, input.topic_min_samples);
        if bias != 0.0 {
            topic_biases.insert(key.clone(), output);
        }
    }

    CollectOutcomeStatsOutput {
        global,
        eye_biases,
        topic_biases,
    }
}

pub fn compute_subdirective_v2_signals(
    input: &SubdirectiveV2SignalsInput,
) -> SubdirectiveV2SignalsOutput {
    SubdirectiveV2SignalsOutput {
        required: input.required,
        has_concrete_target: input.has_concrete_target,
        has_expected_delta: input.has_expected_delta,
        has_verification_step: input.has_verification_step,
        target_count: autoscale_non_negative(input.target_count),
        verify_count: autoscale_non_negative(input.verify_count),
        success_criteria_count: autoscale_non_negative(input.success_criteria_count),
    }
}

pub fn run_autoscale_json(payload_json: &str) -> Result<String, String> {
    let request: AutoscaleRequest = serde_json::from_str(payload_json)
        .map_err(|e| format!("autoscale_request_parse_failed:{e}"))?;
    let mode = request.mode.to_ascii_lowercase();
    if mode == "default_criteria_pattern_memory" {
        let input = request
            .default_criteria_pattern_memory_input
            .ok_or_else(|| "autoscale_missing_default_criteria_pattern_memory_input".to_string())?;
        let out = compute_default_criteria_pattern_memory(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "default_criteria_pattern_memory",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_default_criteria_pattern_memory_encode_failed:{e}"));
    }
    if mode == "strategy_execution_mode_effective" {
        let input = request
            .strategy_execution_mode_effective_input
            .ok_or_else(|| {
                "autoscale_missing_strategy_execution_mode_effective_input".to_string()
            })?;
        let out = compute_strategy_execution_mode_effective(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_execution_mode_effective",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_execution_mode_effective_encode_failed:{e}"));
    }
    if mode == "strategy_canary_exec_limit_effective" {
        let input = request
            .strategy_canary_exec_limit_effective_input
            .ok_or_else(|| {
                "autoscale_missing_strategy_canary_exec_limit_effective_input".to_string()
            })?;
        let out = compute_strategy_canary_exec_limit_effective(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_canary_exec_limit_effective",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_canary_exec_limit_effective_encode_failed:{e}"));
    }
    if mode == "strategy_exploration_effective" {
        let input = request
            .strategy_exploration_effective_input
            .ok_or_else(|| "autoscale_missing_strategy_exploration_effective_input".to_string())?;
        let out = compute_strategy_exploration_effective(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_exploration_effective",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_exploration_effective_encode_failed:{e}"));
    }
    if mode == "strategy_budget_effective" {
        let input = request
            .strategy_budget_effective_input
            .ok_or_else(|| "autoscale_missing_strategy_budget_effective_input".to_string())?;
        let out = compute_strategy_budget_effective(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_budget_effective",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_budget_effective_encode_failed:{e}"));
    }
    if mode == "preexec_verdict_from_signals" {
        let input = request
            .preexec_verdict_from_signals_input
            .ok_or_else(|| "autoscale_missing_preexec_verdict_from_signals_input".to_string())?;
        let out = compute_preexec_verdict_from_signals(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "preexec_verdict_from_signals",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_preexec_verdict_from_signals_encode_failed:{e}"));
    }
    if mode == "score_only_proposal_churn" {
        let input = request
            .score_only_proposal_churn_input
            .ok_or_else(|| "autoscale_missing_score_only_proposal_churn_input".to_string())?;
        let out = compute_score_only_proposal_churn(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "score_only_proposal_churn",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_score_only_proposal_churn_encode_failed:{e}"));
    }
    if mode == "success_criteria_quality_audit" {
        let input = request
            .success_criteria_quality_audit_input
            .ok_or_else(|| "autoscale_missing_success_criteria_quality_audit_input".to_string())?;
        let out = compute_success_criteria_quality_audit(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "success_criteria_quality_audit",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_success_criteria_quality_audit_encode_failed:{e}"));
    }
    if mode == "detect_eyes_terminology_drift" {
        let input = request
            .detect_eyes_terminology_drift_input
            .ok_or_else(|| "autoscale_missing_detect_eyes_terminology_drift_input".to_string())?;
        let out = compute_detect_eyes_terminology_drift(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "detect_eyes_terminology_drift",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_detect_eyes_terminology_drift_encode_failed:{e}"));
    }
    if mode == "normalize_stored_proposal_row" {
        let input = request
            .normalize_stored_proposal_row_input
            .ok_or_else(|| "autoscale_missing_normalize_stored_proposal_row_input".to_string())?;
        let out = compute_normalize_stored_proposal_row(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_stored_proposal_row",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_stored_proposal_row_encode_failed:{e}"));
    }
    if mode == "default_backlog_autoscale_state" {
        let input = request
            .default_backlog_autoscale_state_input
            .ok_or_else(|| "autoscale_missing_default_backlog_autoscale_state_input".to_string())?;
        let out = compute_default_backlog_autoscale_state(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "default_backlog_autoscale_state",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_default_backlog_autoscale_state_encode_failed:{e}"));
    }
    if mode == "normalize_backlog_autoscale_state" {
        let input = request
            .normalize_backlog_autoscale_state_input
            .ok_or_else(|| {
                "autoscale_missing_normalize_backlog_autoscale_state_input".to_string()
            })?;
        let out = compute_normalize_backlog_autoscale_state(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_backlog_autoscale_state",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_backlog_autoscale_state_encode_failed:{e}"));
    }
    if mode == "spawn_allocated_cells" {
        let input = request
            .spawn_allocated_cells_input
            .ok_or_else(|| "autoscale_missing_spawn_allocated_cells_input".to_string())?;
        let out = compute_spawn_allocated_cells(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "spawn_allocated_cells",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_spawn_allocated_cells_encode_failed:{e}"));
    }
    if mode == "spawn_capacity_boost_snapshot" {
        let input = request
            .spawn_capacity_boost_snapshot_input
            .ok_or_else(|| "autoscale_missing_spawn_capacity_boost_snapshot_input".to_string())?;
        let out = compute_spawn_capacity_boost_snapshot(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "spawn_capacity_boost_snapshot",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_spawn_capacity_boost_snapshot_encode_failed:{e}"));
    }
    if mode == "inversion_maturity_score" {
        let input = request
            .inversion_maturity_score_input
            .ok_or_else(|| "autoscale_missing_inversion_maturity_score_input".to_string())?;
        let out = compute_inversion_maturity_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "inversion_maturity_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_inversion_maturity_score_encode_failed:{e}"));
    }
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
        .map_err(|e| format!("autoscale_structural_preview_criteria_failure_encode_failed:{e}"));
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
    if mode == "dod_evidence_diff" {
        let input = request
            .dod_evidence_diff_input
            .ok_or_else(|| "autoscale_missing_dod_evidence_diff_input".to_string())?;
        let out = compute_dod_evidence_diff(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "dod_evidence_diff",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_dod_evidence_diff_encode_failed:{e}"));
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
            .ok_or_else(|| {
                "autoscale_missing_capacity_counted_attempt_indices_input".to_string()
            })?;
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
        let input = request
            .proposal_remediation_depth_input
            .ok_or_else(|| "autoscale_missing_proposal_remediation_depth_input".to_string())?;
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
    if mode == "proposal_semantic_fingerprint" {
        let input = request
            .proposal_semantic_fingerprint_input
            .ok_or_else(|| "autoscale_missing_proposal_semantic_fingerprint_input".to_string())?;
        let out = compute_proposal_semantic_fingerprint(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_semantic_fingerprint",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_semantic_fingerprint_encode_failed:{e}"));
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
            .ok_or_else(|| {
                "autoscale_missing_strategy_trit_shadow_ranking_summary_input".to_string()
            })?;
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
    if mode == "normalize_value_currency_token" {
        let input = request
            .normalize_value_currency_token_input
            .ok_or_else(|| "autoscale_missing_normalize_value_currency_token_input".to_string())?;
        let out = compute_normalize_value_currency_token(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_value_currency_token",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_value_currency_token_encode_failed:{e}"));
    }
    if mode == "list_value_currencies" {
        let input = request
            .list_value_currencies_input
            .ok_or_else(|| "autoscale_missing_list_value_currencies_input".to_string())?;
        let out = compute_list_value_currencies(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "list_value_currencies",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_list_value_currencies_encode_failed:{e}"));
    }
    if mode == "infer_value_currencies_from_directive_bits" {
        let input = request
            .infer_value_currencies_from_directive_bits_input
            .ok_or_else(|| {
                "autoscale_missing_infer_value_currencies_from_directive_bits_input".to_string()
            })?;
        let out = compute_infer_value_currencies_from_directive_bits(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "infer_value_currencies_from_directive_bits",
            "payload": out
        }))
        .map_err(|e| {
            format!("autoscale_infer_value_currencies_from_directive_bits_encode_failed:{e}")
        });
    }
    if mode == "has_linked_objective_entry" {
        let input = request
            .has_linked_objective_entry_input
            .ok_or_else(|| "autoscale_missing_has_linked_objective_entry_input".to_string())?;
        let out = compute_has_linked_objective_entry(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "has_linked_objective_entry",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_has_linked_objective_entry_encode_failed:{e}"));
    }
    if mode == "verified_entry_outcome" {
        let input = request
            .verified_entry_outcome_input
            .ok_or_else(|| "autoscale_missing_verified_entry_outcome_input".to_string())?;
        let out = compute_verified_entry_outcome(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "verified_entry_outcome",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_verified_entry_outcome_encode_failed:{e}"));
    }
    if mode == "verified_revenue_action" {
        let input = request
            .verified_revenue_action_input
            .ok_or_else(|| "autoscale_missing_verified_revenue_action_input".to_string())?;
        let out = compute_verified_revenue_action(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "verified_revenue_action",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_verified_revenue_action_encode_failed:{e}"));
    }
    if mode == "minutes_until_next_utc_day" {
        let input = request
            .minutes_until_next_utc_day_input
            .ok_or_else(|| "autoscale_missing_minutes_until_next_utc_day_input".to_string())?;
        let out = compute_minutes_until_next_utc_day(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "minutes_until_next_utc_day",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_minutes_until_next_utc_day_encode_failed:{e}"));
    }
    if mode == "age_hours" {
        let input = request
            .age_hours_input
            .ok_or_else(|| "autoscale_missing_age_hours_input".to_string())?;
        let out = compute_age_hours(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "age_hours",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_age_hours_encode_failed:{e}"));
    }
    if mode == "url_domain" {
        let input = request
            .url_domain_input
            .ok_or_else(|| "autoscale_missing_url_domain_input".to_string())?;
        let out = compute_url_domain(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "url_domain",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_url_domain_encode_failed:{e}"));
    }
    if mode == "domain_allowed" {
        let input = request
            .domain_allowed_input
            .ok_or_else(|| "autoscale_missing_domain_allowed_input".to_string())?;
        let out = compute_domain_allowed(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "domain_allowed",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_domain_allowed_encode_failed:{e}"));
    }
    if mode == "is_execute_mode" {
        let input = request
            .is_execute_mode_input
            .ok_or_else(|| "autoscale_missing_is_execute_mode_input".to_string())?;
        let out = compute_is_execute_mode(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "is_execute_mode",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_is_execute_mode_encode_failed:{e}"));
    }
    if mode == "execution_allowed_by_feature_flag" {
        let input = request
            .execution_allowed_by_feature_flag_input
            .ok_or_else(|| {
                "autoscale_missing_execution_allowed_by_feature_flag_input".to_string()
            })?;
        let out = compute_execution_allowed_by_feature_flag(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "execution_allowed_by_feature_flag",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_execution_allowed_by_feature_flag_encode_failed:{e}"));
    }
    if mode == "is_tier1_objective_id" {
        let input = request
            .is_tier1_objective_id_input
            .ok_or_else(|| "autoscale_missing_is_tier1_objective_id_input".to_string())?;
        let out = compute_is_tier1_objective_id(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "is_tier1_objective_id",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_is_tier1_objective_id_encode_failed:{e}"));
    }
    if mode == "is_tier1_candidate_objective" {
        let input = request
            .is_tier1_candidate_objective_input
            .ok_or_else(|| "autoscale_missing_is_tier1_candidate_objective_input".to_string())?;
        let out = compute_is_tier1_candidate_objective(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "is_tier1_candidate_objective",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_is_tier1_candidate_objective_encode_failed:{e}"));
    }
    if mode == "needs_execution_quota" {
        let input = request
            .needs_execution_quota_input
            .ok_or_else(|| "autoscale_missing_needs_execution_quota_input".to_string())?;
        let out = compute_needs_execution_quota(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "needs_execution_quota",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_needs_execution_quota_encode_failed:{e}"));
    }
    if mode == "normalize_criteria_metric" {
        let input = request
            .normalize_criteria_metric_input
            .ok_or_else(|| "autoscale_missing_normalize_criteria_metric_input".to_string())?;
        let out = compute_normalize_criteria_metric(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_criteria_metric",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_criteria_metric_encode_failed:{e}"));
    }
    if mode == "escape_reg_exp" {
        let input = request
            .escape_reg_exp_input
            .ok_or_else(|| "autoscale_missing_escape_reg_exp_input".to_string())?;
        let out = compute_escape_reg_exp(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "escape_reg_exp",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_escape_reg_exp_encode_failed:{e}"));
    }
    if mode == "tool_token_mentioned" {
        let input = request
            .tool_token_mentioned_input
            .ok_or_else(|| "autoscale_missing_tool_token_mentioned_input".to_string())?;
        let out = compute_tool_token_mentioned(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "tool_token_mentioned",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_tool_token_mentioned_encode_failed:{e}"));
    }
    if mode == "policy_hold_reason_from_event" {
        let input = request
            .policy_hold_reason_from_event_input
            .ok_or_else(|| "autoscale_missing_policy_hold_reason_from_event_input".to_string())?;
        let out = compute_policy_hold_reason_from_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_reason_from_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_reason_from_event_encode_failed:{e}"));
    }
    if mode == "strategy_marker_tokens" {
        let input = request
            .strategy_marker_tokens_input
            .ok_or_else(|| "autoscale_missing_strategy_marker_tokens_input".to_string())?;
        let out = compute_strategy_marker_tokens(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_marker_tokens",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_marker_tokens_encode_failed:{e}"));
    }
    if mode == "capability_cooldown_key" {
        let input = request
            .capability_cooldown_key_input
            .ok_or_else(|| "autoscale_missing_capability_cooldown_key_input".to_string())?;
        let out = compute_capability_cooldown_key(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "capability_cooldown_key",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_capability_cooldown_key_encode_failed:{e}"));
    }
    if mode == "readiness_retry_cooldown_key" {
        let input = request
            .readiness_retry_cooldown_key_input
            .ok_or_else(|| "autoscale_missing_readiness_retry_cooldown_key_input".to_string())?;
        let out = compute_readiness_retry_cooldown_key(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "readiness_retry_cooldown_key",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_readiness_retry_cooldown_key_encode_failed:{e}"));
    }
    if mode == "source_eye_id" {
        let input = request
            .source_eye_id_input
            .ok_or_else(|| "autoscale_missing_source_eye_id_input".to_string())?;
        let out = compute_source_eye_id(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "source_eye_id",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_source_eye_id_encode_failed:{e}"));
    }
    if mode == "deprioritized_source_proposal" {
        let input = request
            .deprioritized_source_proposal_input
            .ok_or_else(|| "autoscale_missing_deprioritized_source_proposal_input".to_string())?;
        let out = compute_deprioritized_source_proposal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "deprioritized_source_proposal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_deprioritized_source_proposal_encode_failed:{e}"));
    }
    if mode == "composite_eligibility_min" {
        let input = request
            .composite_eligibility_min_input
            .ok_or_else(|| "autoscale_missing_composite_eligibility_min_input".to_string())?;
        let out = compute_composite_eligibility_min(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "composite_eligibility_min",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_composite_eligibility_min_encode_failed:{e}"));
    }
    if mode == "clamp_threshold" {
        let input = request
            .clamp_threshold_input
            .ok_or_else(|| "autoscale_missing_clamp_threshold_input".to_string())?;
        let out = compute_clamp_threshold(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "clamp_threshold",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_clamp_threshold_encode_failed:{e}"));
    }
    if mode == "applied_thresholds" {
        let input = request
            .applied_thresholds_input
            .ok_or_else(|| "autoscale_missing_applied_thresholds_input".to_string())?;
        let out = compute_applied_thresholds(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "applied_thresholds",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_applied_thresholds_encode_failed:{e}"));
    }
    if mode == "extract_eye_from_evidence_ref" {
        let input = request
            .extract_eye_from_evidence_ref_input
            .ok_or_else(|| "autoscale_missing_extract_eye_from_evidence_ref_input".to_string())?;
        let out = compute_extract_eye_from_evidence_ref(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "extract_eye_from_evidence_ref",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_extract_eye_from_evidence_ref_encode_failed:{e}"));
    }
    if mode == "total_outcomes" {
        let input = request
            .total_outcomes_input
            .ok_or_else(|| "autoscale_missing_total_outcomes_input".to_string())?;
        let out = compute_total_outcomes(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "total_outcomes",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_total_outcomes_encode_failed:{e}"));
    }
    if mode == "derive_entity_bias" {
        let input = request
            .derive_entity_bias_input
            .ok_or_else(|| "autoscale_missing_derive_entity_bias_input".to_string())?;
        let out = compute_derive_entity_bias(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "derive_entity_bias",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_derive_entity_bias_encode_failed:{e}"));
    }
    if mode == "strategy_profile" {
        let input = request
            .strategy_profile_input
            .ok_or_else(|| "autoscale_missing_strategy_profile_input".to_string())?;
        let out = compute_strategy_profile(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_profile",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_profile_encode_failed:{e}"));
    }
    if mode == "active_strategy_variants" {
        let input = request
            .active_strategy_variants_input
            .ok_or_else(|| "autoscale_missing_active_strategy_variants_input".to_string())?;
        let out = compute_active_strategy_variants(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "active_strategy_variants",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_active_strategy_variants_encode_failed:{e}"));
    }
    if mode == "strategy_scorecard_summaries" {
        let input = request
            .strategy_scorecard_summaries_input
            .ok_or_else(|| "autoscale_missing_strategy_scorecard_summaries_input".to_string())?;
        let out = compute_strategy_scorecard_summaries(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_scorecard_summaries",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_scorecard_summaries_encode_failed:{e}"));
    }
    if mode == "outcome_fitness_policy" {
        let input = request
            .outcome_fitness_policy_input
            .ok_or_else(|| "autoscale_missing_outcome_fitness_policy_input".to_string())?;
        let out = compute_outcome_fitness_policy(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "outcome_fitness_policy",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_outcome_fitness_policy_encode_failed:{e}"));
    }
    if mode == "load_eyes_map" {
        let input = request
            .load_eyes_map_input
            .ok_or_else(|| "autoscale_missing_load_eyes_map_input".to_string())?;
        let out = compute_load_eyes_map(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "load_eyes_map",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_load_eyes_map_encode_failed:{e}"));
    }
    if mode == "fallback_directive_objective_ids" {
        let input = request
            .fallback_directive_objective_ids_input
            .ok_or_else(|| {
                "autoscale_missing_fallback_directive_objective_ids_input".to_string()
            })?;
        let out = compute_fallback_directive_objective_ids(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "fallback_directive_objective_ids",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_fallback_directive_objective_ids_encode_failed:{e}"));
    }
    if mode == "queue_pressure_snapshot" {
        let input = request
            .queue_pressure_snapshot_input
            .ok_or_else(|| "autoscale_missing_queue_pressure_snapshot_input".to_string())?;
        let out = compute_queue_pressure_snapshot(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "queue_pressure_snapshot",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_queue_pressure_snapshot_encode_failed:{e}"));
    }
    if mode == "parse_success_criteria_rows" {
        let input = request
            .parse_success_criteria_rows_input
            .ok_or_else(|| "autoscale_missing_parse_success_criteria_rows_input".to_string())?;
        let out = compute_parse_success_criteria_rows(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_success_criteria_rows",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_success_criteria_rows_encode_failed:{e}"));
    }
    if mode == "collect_outcome_stats" {
        let input = request
            .collect_outcome_stats_input
            .ok_or_else(|| "autoscale_missing_collect_outcome_stats_input".to_string())?;
        let out = compute_collect_outcome_stats(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "collect_outcome_stats",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_collect_outcome_stats_encode_failed:{e}"));
    }
    if mode == "subdirective_v2_signals" {
        let input = request
            .subdirective_v2_signals_input
            .ok_or_else(|| "autoscale_missing_subdirective_v2_signals_input".to_string())?;
        let out = compute_subdirective_v2_signals(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "subdirective_v2_signals",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_subdirective_v2_signals_encode_failed:{e}"));
    }
    if mode == "build_overlay" {
        let input = request
            .build_overlay_input
            .ok_or_else(|| "autoscale_missing_build_overlay_input".to_string())?;
        let out = compute_build_overlay(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "build_overlay",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_build_overlay_encode_failed:{e}"));
    }
    if mode == "has_adaptive_mutation_signal" {
        let input = request
            .has_adaptive_mutation_signal_input
            .ok_or_else(|| "autoscale_missing_has_adaptive_mutation_signal_input".to_string())?;
        let out = compute_has_adaptive_mutation_signal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "has_adaptive_mutation_signal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_has_adaptive_mutation_signal_encode_failed:{e}"));
    }
    if mode == "adaptive_mutation_execution_guard" {
        let input = request
            .adaptive_mutation_execution_guard_input
            .ok_or_else(|| {
                "autoscale_missing_adaptive_mutation_execution_guard_input".to_string()
            })?;
        let out = compute_adaptive_mutation_execution_guard(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "adaptive_mutation_execution_guard",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_adaptive_mutation_execution_guard_encode_failed:{e}"));
    }
    if mode == "strategy_selection" {
        let input = request
            .strategy_selection_input
            .ok_or_else(|| "autoscale_missing_strategy_selection_input".to_string())?;
        let out = compute_strategy_selection(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_selection",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_selection_encode_failed:{e}"));
    }
    if mode == "calibration_deltas" {
        let input = request
            .calibration_deltas_input
            .ok_or_else(|| "autoscale_missing_calibration_deltas_input".to_string())?;
        let out = compute_calibration_deltas(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "calibration_deltas",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_calibration_deltas_encode_failed:{e}"));
    }
    if mode == "strategy_admission_decision" {
        let input = request
            .strategy_admission_decision_input
            .ok_or_else(|| "autoscale_missing_strategy_admission_decision_input".to_string())?;
        let out = compute_strategy_admission_decision(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_admission_decision",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_admission_decision_encode_failed:{e}"));
    }
    if mode == "expected_value_score" {
        let input = request
            .expected_value_score_input
            .ok_or_else(|| "autoscale_missing_expected_value_score_input".to_string())?;
        let out = compute_expected_value_score(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "expected_value_score",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_expected_value_score_encode_failed:{e}"));
    }
    if mode == "suggest_run_batch_max" {
        let input = request
            .suggest_run_batch_max_input
            .ok_or_else(|| "autoscale_missing_suggest_run_batch_max_input".to_string())?;
        let out = compute_suggest_run_batch_max(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "suggest_run_batch_max",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_suggest_run_batch_max_encode_failed:{e}"));
    }
    if mode == "backlog_autoscale_snapshot" {
        let input = request
            .backlog_autoscale_snapshot_input
            .ok_or_else(|| "autoscale_missing_backlog_autoscale_snapshot_input".to_string())?;
        let out = compute_backlog_autoscale_snapshot(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "backlog_autoscale_snapshot",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_backlog_autoscale_snapshot_encode_failed:{e}"));
    }
    if mode == "admission_summary" {
        let input = request
            .admission_summary_input
            .ok_or_else(|| "autoscale_missing_admission_summary_input".to_string())?;
        let out = compute_admission_summary(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "admission_summary",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_admission_summary_encode_failed:{e}"));
    }
    if mode == "unknown_type_quarantine_decision" {
        let input = request
            .unknown_type_quarantine_decision_input
            .ok_or_else(|| {
                "autoscale_missing_unknown_type_quarantine_decision_input".to_string()
            })?;
        let out = compute_unknown_type_quarantine_decision(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "unknown_type_quarantine_decision",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_unknown_type_quarantine_decision_encode_failed:{e}"));
    }
    if mode == "infer_optimization_delta" {
        let input = request
            .infer_optimization_delta_input
            .ok_or_else(|| "autoscale_missing_infer_optimization_delta_input".to_string())?;
        let out = compute_infer_optimization_delta(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "infer_optimization_delta",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_infer_optimization_delta_encode_failed:{e}"));
    }
    if mode == "optimization_intent_proposal" {
        let input = request
            .optimization_intent_proposal_input
            .ok_or_else(|| "autoscale_missing_optimization_intent_proposal_input".to_string())?;
        let out = compute_optimization_intent_proposal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "optimization_intent_proposal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_optimization_intent_proposal_encode_failed:{e}"));
    }
    if mode == "unlinked_optimization_admission" {
        let input = request
            .unlinked_optimization_admission_input
            .ok_or_else(|| "autoscale_missing_unlinked_optimization_admission_input".to_string())?;
        let out = compute_unlinked_optimization_admission(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "unlinked_optimization_admission",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_unlinked_optimization_admission_encode_failed:{e}"));
    }
    if mode == "optimization_good_enough" {
        let input = request
            .optimization_good_enough_input
            .ok_or_else(|| "autoscale_missing_optimization_good_enough_input".to_string())?;
        let out = compute_optimization_good_enough(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "optimization_good_enough",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_optimization_good_enough_encode_failed:{e}"));
    }
    if mode == "proposal_dependency_summary" {
        let input = request
            .proposal_dependency_summary_input
            .ok_or_else(|| "autoscale_missing_proposal_dependency_summary_input".to_string())?;
        let out = compute_proposal_dependency_summary(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_dependency_summary",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_dependency_summary_encode_failed:{e}"));
    }
    if mode == "choose_selection_mode" {
        let input = request
            .choose_selection_mode_input
            .ok_or_else(|| "autoscale_missing_choose_selection_mode_input".to_string())?;
        let out = compute_choose_selection_mode(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "choose_selection_mode",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_choose_selection_mode_encode_failed:{e}"));
    }
    if mode == "explore_quota_for_day" {
        let input = request
            .explore_quota_for_day_input
            .ok_or_else(|| "autoscale_missing_explore_quota_for_day_input".to_string())?;
        let out = compute_explore_quota_for_day(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "explore_quota_for_day",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_explore_quota_for_day_encode_failed:{e}"));
    }
    if mode == "medium_risk_thresholds" {
        let input = request
            .medium_risk_thresholds_input
            .ok_or_else(|| "autoscale_missing_medium_risk_thresholds_input".to_string())?;
        let out = compute_medium_risk_thresholds(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "medium_risk_thresholds",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_medium_risk_thresholds_encode_failed:{e}"));
    }
    if mode == "medium_risk_gate_decision" {
        let input = request
            .medium_risk_gate_decision_input
            .ok_or_else(|| "autoscale_missing_medium_risk_gate_decision_input".to_string())?;
        let out = compute_medium_risk_gate_decision(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "medium_risk_gate_decision",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_medium_risk_gate_decision_encode_failed:{e}"));
    }
    if mode == "route_block_prefilter" {
        let input = request
            .route_block_prefilter_input
            .ok_or_else(|| "autoscale_missing_route_block_prefilter_input".to_string())?;
        let out = compute_route_block_prefilter(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "route_block_prefilter",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_route_block_prefilter_encode_failed:{e}"));
    }
    if mode == "route_execution_sample_event" {
        let input = request
            .route_execution_sample_event_input
            .ok_or_else(|| "autoscale_missing_route_execution_sample_event_input".to_string())?;
        let out = compute_route_execution_sample_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "route_execution_sample_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_route_execution_sample_event_encode_failed:{e}"));
    }
    if mode == "route_block_telemetry_summary" {
        let input = request
            .route_block_telemetry_summary_input
            .ok_or_else(|| "autoscale_missing_route_block_telemetry_summary_input".to_string())?;
        let out = compute_route_block_telemetry_summary(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "route_block_telemetry_summary",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_route_block_telemetry_summary_encode_failed:{e}"));
    }
    if mode == "is_stub_proposal" {
        let input = request
            .is_stub_proposal_input
            .ok_or_else(|| "autoscale_missing_is_stub_proposal_input".to_string())?;
        let out = compute_is_stub_proposal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "is_stub_proposal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_is_stub_proposal_encode_failed:{e}"));
    }
    if mode == "recent_autonomy_run_events" {
        let input = request
            .recent_autonomy_run_events_input
            .ok_or_else(|| "autoscale_missing_recent_autonomy_run_events_input".to_string())?;
        let out = compute_recent_autonomy_run_events(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "recent_autonomy_run_events",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_recent_autonomy_run_events_encode_failed:{e}"));
    }
    if mode == "proposal_meta_index" {
        let input = request
            .proposal_meta_index_input
            .ok_or_else(|| "autoscale_missing_proposal_meta_index_input".to_string())?;
        let out = compute_proposal_meta_index(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_meta_index",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_meta_index_encode_failed:{e}"));
    }
    if mode == "new_log_events" {
        let input = request
            .new_log_events_input
            .ok_or_else(|| "autoscale_missing_new_log_events_input".to_string())?;
        let out = compute_new_log_events(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "new_log_events",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_new_log_events_encode_failed:{e}"));
    }
    if mode == "outcome_buckets" {
        let input = request
            .outcome_buckets_input
            .unwrap_or(OutcomeBucketsInput {});
        let out = compute_outcome_buckets(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "outcome_buckets",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_outcome_buckets_encode_failed:{e}"));
    }
    if mode == "recent_run_events" {
        let input = request
            .recent_run_events_input
            .ok_or_else(|| "autoscale_missing_recent_run_events_input".to_string())?;
        let out = compute_recent_run_events(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "recent_run_events",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_recent_run_events_encode_failed:{e}"));
    }
    if mode == "all_decision_events" {
        let input = request
            .all_decision_events_input
            .ok_or_else(|| "autoscale_missing_all_decision_events_input".to_string())?;
        let out = compute_all_decision_events(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "all_decision_events",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_all_decision_events_encode_failed:{e}"));
    }
    if mode == "cooldown_active_state" {
        let input = request
            .cooldown_active_state_input
            .ok_or_else(|| "autoscale_missing_cooldown_active_state_input".to_string())?;
        let out = compute_cooldown_active_state(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "cooldown_active_state",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_cooldown_active_state_encode_failed:{e}"));
    }
    if mode == "bump_count" {
        let input = request
            .bump_count_input
            .ok_or_else(|| "autoscale_missing_bump_count_input".to_string())?;
        let out = compute_bump_count(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "bump_count",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_bump_count_encode_failed:{e}"));
    }
    if mode == "lock_age_minutes" {
        let input = request
            .lock_age_minutes_input
            .ok_or_else(|| "autoscale_missing_lock_age_minutes_input".to_string())?;
        let out = compute_lock_age_minutes(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "lock_age_minutes",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_lock_age_minutes_encode_failed:{e}"));
    }
    if mode == "hash_obj" {
        let input = request
            .hash_obj_input
            .ok_or_else(|| "autoscale_missing_hash_obj_input".to_string())?;
        let out = compute_hash_obj(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "hash_obj",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_hash_obj_encode_failed:{e}"));
    }
    if mode == "assess_success_criteria_quality" {
        let input = request
            .assess_success_criteria_quality_input
            .ok_or_else(|| "autoscale_missing_assess_success_criteria_quality_input".to_string())?;
        let out = compute_assess_success_criteria_quality(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "assess_success_criteria_quality",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_assess_success_criteria_quality_encode_failed:{e}"));
    }
    if mode == "manual_gate_prefilter" {
        let input = request
            .manual_gate_prefilter_input
            .ok_or_else(|| "autoscale_missing_manual_gate_prefilter_input".to_string())?;
        let out = compute_manual_gate_prefilter(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "manual_gate_prefilter",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_manual_gate_prefilter_encode_failed:{e}"));
    }
    if mode == "execute_confidence_cooldown_active" {
        let input = request
            .execute_confidence_cooldown_active_input
            .ok_or_else(|| {
                "autoscale_missing_execute_confidence_cooldown_active_input".to_string()
            })?;
        let out = compute_execute_confidence_cooldown_active(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "execute_confidence_cooldown_active",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_execute_confidence_cooldown_active_encode_failed:{e}"));
    }
    if mode == "top_biases_summary" {
        let input = request
            .top_biases_summary_input
            .ok_or_else(|| "autoscale_missing_top_biases_summary_input".to_string())?;
        let out = compute_top_biases_summary(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "top_biases_summary",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_top_biases_summary_encode_failed:{e}"));
    }
    if mode == "criteria_pattern_penalty" {
        let input = request
            .criteria_pattern_penalty_input
            .ok_or_else(|| "autoscale_missing_criteria_pattern_penalty_input".to_string())?;
        let out = compute_criteria_pattern_penalty(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "criteria_pattern_penalty",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_criteria_pattern_penalty_encode_failed:{e}"));
    }
    if mode == "strategy_threshold_overrides" {
        let input = request
            .strategy_threshold_overrides_input
            .ok_or_else(|| "autoscale_missing_strategy_threshold_overrides_input".to_string())?;
        let out = compute_strategy_threshold_overrides(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "strategy_threshold_overrides",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_strategy_threshold_overrides_encode_failed:{e}"));
    }
    if mode == "effective_allowed_risks" {
        let input = request
            .effective_allowed_risks_input
            .ok_or_else(|| "autoscale_missing_effective_allowed_risks_input".to_string())?;
        let out = compute_effective_allowed_risks(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "effective_allowed_risks",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_effective_allowed_risks_encode_failed:{e}"));
    }
    if mode == "directive_pulse_stats" {
        let input = request
            .directive_pulse_stats_input
            .ok_or_else(|| "autoscale_missing_directive_pulse_stats_input".to_string())?;
        let out = compute_directive_pulse_stats(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_pulse_stats",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_pulse_stats_encode_failed:{e}"));
    }
    if mode == "compile_directive_pulse_objectives" {
        let input = request
            .compile_directive_pulse_objectives_input
            .ok_or_else(|| {
                "autoscale_missing_compile_directive_pulse_objectives_input".to_string()
            })?;
        let out = compute_compile_directive_pulse_objectives(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "compile_directive_pulse_objectives",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_compile_directive_pulse_objectives_encode_failed:{e}"));
    }
    if mode == "directive_pulse_objectives_profile" {
        let input = request
            .directive_pulse_objectives_profile_input
            .ok_or_else(|| {
                "autoscale_missing_directive_pulse_objectives_profile_input".to_string()
            })?;
        let out = compute_directive_pulse_objectives_profile(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_pulse_objectives_profile",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_pulse_objectives_profile_encode_failed:{e}"));
    }
    if mode == "recent_directive_pulse_cooldown_count" {
        let input = request
            .recent_directive_pulse_cooldown_count_input
            .ok_or_else(|| {
                "autoscale_missing_recent_directive_pulse_cooldown_count_input".to_string()
            })?;
        let out = compute_recent_directive_pulse_cooldown_count(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "recent_directive_pulse_cooldown_count",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_recent_directive_pulse_cooldown_count_encode_failed:{e}"));
    }
    if mode == "proposal_directive_text" {
        let input = request
            .proposal_directive_text_input
            .ok_or_else(|| "autoscale_missing_proposal_directive_text_input".to_string())?;
        let out = compute_proposal_directive_text(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_directive_text",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_directive_text_encode_failed:{e}"));
    }
    if mode == "objective_ids_from_pulse_context" {
        let input = request
            .objective_ids_from_pulse_context_input
            .ok_or_else(|| {
                "autoscale_missing_objective_ids_from_pulse_context_input".to_string()
            })?;
        let out = compute_objective_ids_from_pulse_context(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "objective_ids_from_pulse_context",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_objective_ids_from_pulse_context_encode_failed:{e}"));
    }
    if mode == "policy_hold_objective_context" {
        let input = request
            .policy_hold_objective_context_input
            .ok_or_else(|| "autoscale_missing_policy_hold_objective_context_input".to_string())?;
        let out = compute_policy_hold_objective_context(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "policy_hold_objective_context",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_policy_hold_objective_context_encode_failed:{e}"));
    }
    if mode == "proposal_semantic_objective_id" {
        let input = request
            .proposal_semantic_objective_id_input
            .ok_or_else(|| "autoscale_missing_proposal_semantic_objective_id_input".to_string())?;
        let out = compute_proposal_semantic_objective_id(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "proposal_semantic_objective_id",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_proposal_semantic_objective_id_encode_failed:{e}"));
    }
    if mode == "criteria_pattern_keys" {
        let input = request
            .criteria_pattern_keys_input
            .ok_or_else(|| "autoscale_missing_criteria_pattern_keys_input".to_string())?;
        let out = compute_criteria_pattern_keys(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "criteria_pattern_keys",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_criteria_pattern_keys_encode_failed:{e}"));
    }
    if mode == "success_criteria_requirement" {
        let input = request
            .success_criteria_requirement_input
            .ok_or_else(|| "autoscale_missing_success_criteria_requirement_input".to_string())?;
        let out = compute_success_criteria_requirement(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "success_criteria_requirement",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_success_criteria_requirement_encode_failed:{e}"));
    }
    if mode == "success_criteria_policy_for_proposal" {
        let input = request
            .success_criteria_policy_for_proposal_input
            .ok_or_else(|| {
                "autoscale_missing_success_criteria_policy_for_proposal_input".to_string()
            })?;
        let out = compute_success_criteria_policy_for_proposal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "success_criteria_policy_for_proposal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_success_criteria_policy_for_proposal_encode_failed:{e}"));
    }
    if mode == "capability_descriptor" {
        let input = request
            .capability_descriptor_input
            .ok_or_else(|| "autoscale_missing_capability_descriptor_input".to_string())?;
        let out = compute_capability_descriptor(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "capability_descriptor",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_capability_descriptor_encode_failed:{e}"));
    }
    if mode == "normalize_token_usage_shape" {
        let input = request
            .normalize_token_usage_shape_input
            .ok_or_else(|| "autoscale_missing_normalize_token_usage_shape_input".to_string())?;
        let out = compute_normalize_token_usage_shape(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_token_usage_shape",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_token_usage_shape_encode_failed:{e}"));
    }
    if mode == "directive_pulse_context" {
        let input = request
            .directive_pulse_context_input
            .ok_or_else(|| "autoscale_missing_directive_pulse_context_input".to_string())?;
        let out = compute_directive_pulse_context(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_pulse_context",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_pulse_context_encode_failed:{e}"));
    }
    if mode == "is_directive_clarification_proposal" {
        let input = request
            .is_directive_clarification_proposal_input
            .ok_or_else(|| {
                "autoscale_missing_is_directive_clarification_proposal_input".to_string()
            })?;
        let out = compute_is_directive_clarification_proposal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "is_directive_clarification_proposal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_is_directive_clarification_proposal_encode_failed:{e}"));
    }
    if mode == "is_directive_decomposition_proposal" {
        let input = request
            .is_directive_decomposition_proposal_input
            .ok_or_else(|| {
                "autoscale_missing_is_directive_decomposition_proposal_input".to_string()
            })?;
        let out = compute_is_directive_decomposition_proposal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "is_directive_decomposition_proposal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_is_directive_decomposition_proposal_encode_failed:{e}"));
    }
    if mode == "sanitize_directive_objective_id" {
        let input = request
            .sanitize_directive_objective_id_input
            .ok_or_else(|| "autoscale_missing_sanitize_directive_objective_id_input".to_string())?;
        let out = compute_sanitize_directive_objective_id(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "sanitize_directive_objective_id",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_sanitize_directive_objective_id_encode_failed:{e}"));
    }
    if mode == "sanitized_directive_id_list" {
        let input = request
            .sanitized_directive_id_list_input
            .ok_or_else(|| "autoscale_missing_sanitized_directive_id_list_input".to_string())?;
        let out = compute_sanitized_directive_id_list(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "sanitized_directive_id_list",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_sanitized_directive_id_list_encode_failed:{e}"));
    }
    if mode == "parse_first_json_line" {
        let input = request
            .parse_first_json_line_input
            .ok_or_else(|| "autoscale_missing_parse_first_json_line_input".to_string())?;
        let out = compute_parse_first_json_line(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_first_json_line",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_first_json_line_encode_failed:{e}"));
    }
    if mode == "parse_json_objects_from_text" {
        let input = request
            .parse_json_objects_from_text_input
            .ok_or_else(|| "autoscale_missing_parse_json_objects_from_text_input".to_string())?;
        let out = compute_parse_json_objects_from_text(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_json_objects_from_text",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_json_objects_from_text_encode_failed:{e}"));
    }
    if mode == "read_path_value" {
        let input = request
            .read_path_value_input
            .ok_or_else(|| "autoscale_missing_read_path_value_input".to_string())?;
        let out = compute_read_path_value(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "read_path_value",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_read_path_value_encode_failed:{e}"));
    }
    if mode == "number_or_null" {
        let input = request
            .number_or_null_input
            .ok_or_else(|| "autoscale_missing_number_or_null_input".to_string())?;
        let out = compute_number_or_null(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "number_or_null",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_number_or_null_encode_failed:{e}"));
    }
    if mode == "choose_evidence_selection_mode" {
        let input = request
            .choose_evidence_selection_mode_input
            .ok_or_else(|| "autoscale_missing_choose_evidence_selection_mode_input".to_string())?;
        let out = compute_choose_evidence_selection_mode(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "choose_evidence_selection_mode",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_choose_evidence_selection_mode_encode_failed:{e}"));
    }
    if mode == "truthy_flag" {
        let input = request
            .truthy_flag_input
            .ok_or_else(|| "autoscale_missing_truthy_flag_input".to_string())?;
        let out = compute_truthy_flag(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "truthy_flag",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_truthy_flag_encode_failed:{e}"));
    }
    if mode == "falsey_flag" {
        let input = request
            .falsey_flag_input
            .ok_or_else(|| "autoscale_missing_falsey_flag_input".to_string())?;
        let out = compute_falsey_flag(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "falsey_flag",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_falsey_flag_encode_failed:{e}"));
    }
    if mode == "stable_selection_index" {
        let input = request
            .stable_selection_index_input
            .ok_or_else(|| "autoscale_missing_stable_selection_index_input".to_string())?;
        let out = compute_stable_selection_index(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "stable_selection_index",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_stable_selection_index_encode_failed:{e}"));
    }
    if mode == "as_string_array" {
        let input = request
            .as_string_array_input
            .ok_or_else(|| "autoscale_missing_as_string_array_input".to_string())?;
        let out = compute_as_string_array(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "as_string_array",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_as_string_array_encode_failed:{e}"));
    }
    if mode == "uniq_sorted" {
        let input = request
            .uniq_sorted_input
            .ok_or_else(|| "autoscale_missing_uniq_sorted_input".to_string())?;
        let out = compute_uniq_sorted(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "uniq_sorted",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_uniq_sorted_encode_failed:{e}"));
    }
    if mode == "normalize_model_ids" {
        let input = request
            .normalize_model_ids_input
            .ok_or_else(|| "autoscale_missing_normalize_model_ids_input".to_string())?;
        let out = compute_normalize_model_ids(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalize_model_ids",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalize_model_ids_encode_failed:{e}"));
    }
    if mode == "selected_model_from_run_event" {
        let input = request
            .selected_model_from_run_event_input
            .ok_or_else(|| "autoscale_missing_selected_model_from_run_event_input".to_string())?;
        let out = compute_selected_model_from_run_event(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "selected_model_from_run_event",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_selected_model_from_run_event_encode_failed:{e}"));
    }
    if mode == "read_first_numeric_metric" {
        let input = request
            .read_first_numeric_metric_input
            .ok_or_else(|| "autoscale_missing_read_first_numeric_metric_input".to_string())?;
        let out = compute_read_first_numeric_metric(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "read_first_numeric_metric",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_read_first_numeric_metric_encode_failed:{e}"));
    }
    if mode == "parse_arg" {
        let input = request
            .parse_arg_input
            .ok_or_else(|| "autoscale_missing_parse_arg_input".to_string())?;
        let out = compute_parse_arg(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_arg",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_arg_encode_failed:{e}"));
    }
    if mode == "date_arg_or_today" {
        let input = request
            .date_arg_or_today_input
            .ok_or_else(|| "autoscale_missing_date_arg_or_today_input".to_string())?;
        let out = compute_date_arg_or_today(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "date_arg_or_today",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_date_arg_or_today_encode_failed:{e}"));
    }
    if mode == "has_env_numeric_override" {
        let input = request
            .has_env_numeric_override_input
            .ok_or_else(|| "autoscale_missing_has_env_numeric_override_input".to_string())?;
        let out = compute_has_env_numeric_override(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "has_env_numeric_override",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_has_env_numeric_override_encode_failed:{e}"));
    }
    if mode == "coalesce_numeric" {
        let input = request
            .coalesce_numeric_input
            .ok_or_else(|| "autoscale_missing_coalesce_numeric_input".to_string())?;
        let out = compute_coalesce_numeric(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "coalesce_numeric",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_coalesce_numeric_encode_failed:{e}"));
    }
    if mode == "clamp_number" {
        let input = request
            .clamp_number_input
            .ok_or_else(|| "autoscale_missing_clamp_number_input".to_string())?;
        let out = compute_clamp_number(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "clamp_number",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_clamp_number_encode_failed:{e}"));
    }
    if mode == "list_proposal_files" {
        let input = request
            .list_proposal_files_input
            .ok_or_else(|| "autoscale_missing_list_proposal_files_input".to_string())?;
        let out = compute_list_proposal_files(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "list_proposal_files",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_list_proposal_files_encode_failed:{e}"));
    }
    if mode == "latest_proposal_date" {
        let input = request
            .latest_proposal_date_input
            .ok_or_else(|| "autoscale_missing_latest_proposal_date_input".to_string())?;
        let out = compute_latest_proposal_date(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "latest_proposal_date",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_latest_proposal_date_encode_failed:{e}"));
    }
    if mode == "now_iso" {
        let input = request
            .now_iso_input
            .ok_or_else(|| "autoscale_missing_now_iso_input".to_string())?;
        let out = compute_now_iso(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "now_iso",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_now_iso_encode_failed:{e}"));
    }
    if mode == "today_str" {
        let input = request
            .today_str_input
            .ok_or_else(|| "autoscale_missing_today_str_input".to_string())?;
        let out = compute_today_str(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "today_str",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_today_str_encode_failed:{e}"));
    }
    if mode == "human_canary_override_approval_phrase" {
        let input = request
            .human_canary_override_approval_phrase_input
            .ok_or_else(|| {
                "autoscale_missing_human_canary_override_approval_phrase_input".to_string()
            })?;
        let out = compute_human_canary_override_approval_phrase(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "human_canary_override_approval_phrase",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_human_canary_override_approval_phrase_encode_failed:{e}"));
    }
    if mode == "parse_human_canary_override_state" {
        let input = request
            .parse_human_canary_override_state_input
            .ok_or_else(|| {
                "autoscale_missing_parse_human_canary_override_state_input".to_string()
            })?;
        let out = compute_parse_human_canary_override_state(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_human_canary_override_state",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_human_canary_override_state_encode_failed:{e}"));
    }
    if mode == "daily_budget_path" {
        let input = request
            .daily_budget_path_input
            .ok_or_else(|| "autoscale_missing_daily_budget_path_input".to_string())?;
        let out = compute_daily_budget_path(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "daily_budget_path",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_daily_budget_path_encode_failed:{e}"));
    }
    if mode == "runs_path_for" {
        let input = request
            .runs_path_for_input
            .ok_or_else(|| "autoscale_missing_runs_path_for_input".to_string())?;
        let out = compute_runs_path_for(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "runs_path_for",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_runs_path_for_encode_failed:{e}"));
    }
    if mode == "effective_tier1_policy" {
        let input = request
            .effective_tier1_policy_input
            .ok_or_else(|| "autoscale_missing_effective_tier1_policy_input".to_string())?;
        let out = compute_effective_tier1_policy(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "effective_tier1_policy",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_effective_tier1_policy_encode_failed:{e}"));
    }
    if mode == "compact_tier1_exception" {
        let input = request
            .compact_tier1_exception_input
            .ok_or_else(|| "autoscale_missing_compact_tier1_exception_input".to_string())?;
        let out = compute_compact_tier1_exception(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "compact_tier1_exception",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_compact_tier1_exception_encode_failed:{e}"));
    }
    if mode == "next_human_escalation_clear_at" {
        let input = request
            .next_human_escalation_clear_at_input
            .ok_or_else(|| "autoscale_missing_next_human_escalation_clear_at_input".to_string())?;
        let out = compute_next_human_escalation_clear_at(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "next_human_escalation_clear_at",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_next_human_escalation_clear_at_encode_failed:{e}"));
    }
    if mode == "model_catalog_canary_thresholds" {
        let input = request
            .model_catalog_canary_thresholds_input
            .ok_or_else(|| "autoscale_missing_model_catalog_canary_thresholds_input".to_string())?;
        let out = compute_model_catalog_canary_thresholds(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "model_catalog_canary_thresholds",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_model_catalog_canary_thresholds_encode_failed:{e}"));
    }
    if mode == "parse_directive_file_arg" {
        let input = request
            .parse_directive_file_arg_input
            .ok_or_else(|| "autoscale_missing_parse_directive_file_arg_input".to_string())?;
        let out = compute_parse_directive_file_arg(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_directive_file_arg",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_directive_file_arg_encode_failed:{e}"));
    }
    if mode == "parse_directive_objective_arg" {
        let input = request
            .parse_directive_objective_arg_input
            .ok_or_else(|| "autoscale_missing_parse_directive_objective_arg_input".to_string())?;
        let out = compute_parse_directive_objective_arg(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_directive_objective_arg",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_directive_objective_arg_encode_failed:{e}"));
    }
    if mode == "directive_clarification_exec_spec" {
        let input = request
            .directive_clarification_exec_spec_input
            .ok_or_else(|| {
                "autoscale_missing_directive_clarification_exec_spec_input".to_string()
            })?;
        let out = compute_directive_clarification_exec_spec(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_clarification_exec_spec",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_clarification_exec_spec_encode_failed:{e}"));
    }
    if mode == "directive_decomposition_exec_spec" {
        let input = request
            .directive_decomposition_exec_spec_input
            .ok_or_else(|| {
                "autoscale_missing_directive_decomposition_exec_spec_input".to_string()
            })?;
        let out = compute_directive_decomposition_exec_spec(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_decomposition_exec_spec",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_decomposition_exec_spec_encode_failed:{e}"));
    }
    if mode == "parse_actuation_spec" {
        let input = request
            .parse_actuation_spec_input
            .ok_or_else(|| "autoscale_missing_parse_actuation_spec_input".to_string())?;
        let out = compute_parse_actuation_spec(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_actuation_spec",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_actuation_spec_encode_failed:{e}"));
    }
    if mode == "task_from_proposal" {
        let input = request
            .task_from_proposal_input
            .ok_or_else(|| "autoscale_missing_task_from_proposal_input".to_string())?;
        let out = compute_task_from_proposal(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "task_from_proposal",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_task_from_proposal_encode_failed:{e}"));
    }
    if mode == "parse_objective_id_from_evidence_refs" {
        let input = request
            .parse_objective_id_from_evidence_refs_input
            .ok_or_else(|| {
                "autoscale_missing_parse_objective_id_from_evidence_refs_input".to_string()
            })?;
        let out = compute_parse_objective_id_from_evidence_refs(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_objective_id_from_evidence_refs",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_objective_id_from_evidence_refs_encode_failed:{e}"));
    }
    if mode == "parse_objective_id_from_command" {
        let input = request
            .parse_objective_id_from_command_input
            .ok_or_else(|| "autoscale_missing_parse_objective_id_from_command_input".to_string())?;
        let out = compute_parse_objective_id_from_command(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "parse_objective_id_from_command",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_parse_objective_id_from_command_encode_failed:{e}"));
    }
    if mode == "objective_id_for_execution" {
        let input = request
            .objective_id_for_execution_input
            .ok_or_else(|| "autoscale_missing_objective_id_for_execution_input".to_string())?;
        let out = compute_objective_id_for_execution(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "objective_id_for_execution",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_objective_id_for_execution_encode_failed:{e}"));
    }
    if mode == "short_text" {
        let input = request
            .short_text_input
            .ok_or_else(|| "autoscale_missing_short_text_input".to_string())?;
        let out = compute_short_text(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "short_text",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_short_text_encode_failed:{e}"));
    }
    if mode == "normalized_signal_status" {
        let input = request
            .normalized_signal_status_input
            .ok_or_else(|| "autoscale_missing_normalized_signal_status_input".to_string())?;
        let out = compute_normalized_signal_status(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "normalized_signal_status",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_normalized_signal_status_encode_failed:{e}"));
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
        let input = request
            .proposal_status_for_queue_pressure_input
            .ok_or_else(|| {
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
    if mode == "exec_window_match" {
        let input = request
            .exec_window_match_input
            .ok_or_else(|| "autoscale_missing_exec_window_match_input".to_string())?;
        let out = compute_exec_window_match(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "exec_window_match",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_exec_window_match_encode_failed:{e}"));
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
            .ok_or_else(|| {
                "autoscale_missing_execute_confidence_history_match_input".to_string()
            })?;
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
    if mode == "recent_proposal_key_counts" {
        let input = request
            .recent_proposal_key_counts_input
            .ok_or_else(|| "autoscale_missing_recent_proposal_key_counts_input".to_string())?;
        let out = compute_recent_proposal_key_counts(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "recent_proposal_key_counts",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_recent_proposal_key_counts_encode_failed:{e}"));
    }
    if mode == "capability_attempt_count_for_date" {
        let input = request
            .capability_attempt_count_for_date_input
            .ok_or_else(|| {
                "autoscale_missing_capability_attempt_count_for_date_input".to_string()
            })?;
        let out = compute_capability_attempt_count_for_date(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "capability_attempt_count_for_date",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_capability_attempt_count_for_date_encode_failed:{e}"));
    }
    if mode == "capability_outcome_stats_in_window" {
        let input = request
            .capability_outcome_stats_in_window_input
            .ok_or_else(|| {
                "autoscale_missing_capability_outcome_stats_in_window_input".to_string()
            })?;
        let out = compute_capability_outcome_stats_in_window(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "capability_outcome_stats_in_window",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_capability_outcome_stats_in_window_encode_failed:{e}"));
    }
    if mode == "execute_confidence_history" {
        let input = request
            .execute_confidence_history_input
            .ok_or_else(|| "autoscale_missing_execute_confidence_history_input".to_string())?;
        let out = compute_execute_confidence_history(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "execute_confidence_history",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_execute_confidence_history_encode_failed:{e}"));
    }
    if mode == "execute_confidence_policy" {
        let input = request
            .execute_confidence_policy_input
            .ok_or_else(|| "autoscale_missing_execute_confidence_policy_input".to_string())?;
        let out = compute_execute_confidence_policy(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "execute_confidence_policy",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_execute_confidence_policy_encode_failed:{e}"));
    }
    if mode == "directive_fit_assessment" {
        let input = request
            .directive_fit_assessment_input
            .ok_or_else(|| "autoscale_missing_directive_fit_assessment_input".to_string())?;
        let out = compute_directive_fit_assessment(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "directive_fit_assessment",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_directive_fit_assessment_encode_failed:{e}"));
    }
    if mode == "signal_quality_assessment" {
        let input = request
            .signal_quality_assessment_input
            .ok_or_else(|| "autoscale_missing_signal_quality_assessment_input".to_string())?;
        let out = compute_signal_quality_assessment(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "signal_quality_assessment",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_signal_quality_assessment_encode_failed:{e}"));
    }
    if mode == "actionability_assessment" {
        let input = request
            .actionability_assessment_input
            .ok_or_else(|| "autoscale_missing_actionability_assessment_input".to_string())?;
        let out = compute_actionability_assessment(&input);
        return serde_json::to_string(&serde_json::json!({
            "ok": true,
            "mode": "actionability_assessment",
            "payload": out
        }))
        .map_err(|e| format!("autoscale_actionability_assessment_encode_failed:{e}"));
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
        let primary =
            compute_structural_preview_criteria_failure(&StructuralPreviewCriteriaFailureInput {
                primary_failure: Some("metric_not_allowed_for_capability".to_string()),
                contract_not_allowed_count: Some(0.0),
                unsupported_count: Some(0.0),
                total_count: Some(0.0),
            });
        assert!(primary.has_failure);

        let unsupported =
            compute_structural_preview_criteria_failure(&StructuralPreviewCriteriaFailureInput {
                primary_failure: Some(String::new()),
                contract_not_allowed_count: Some(0.0),
                unsupported_count: Some(2.0),
                total_count: Some(3.0),
            });
        assert!(unsupported.has_failure);

        let pass =
            compute_structural_preview_criteria_failure(&StructuralPreviewCriteriaFailureInput {
                primary_failure: Some(String::new()),
                contract_not_allowed_count: Some(0.0),
                unsupported_count: Some(1.0),
                total_count: Some(4.0),
            });
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
    fn dod_evidence_diff_computes_expected_deltas() {
        let out = compute_dod_evidence_diff(&DodEvidenceDiffInput {
            before_artifacts: Some(4.0),
            before_entries: Some(10.0),
            before_revenue_actions: Some(2.0),
            before_registry_total: Some(8.0),
            before_registry_active: Some(5.0),
            before_registry_candidate: Some(3.0),
            before_habit_runs: Some(12.0),
            before_habit_errors: Some(1.0),
            after_artifacts: Some(7.0),
            after_entries: Some(14.0),
            after_revenue_actions: Some(2.0),
            after_registry_total: Some(9.0),
            after_registry_active: Some(6.0),
            after_registry_candidate: Some(3.0),
            after_habit_runs: Some(15.0),
            after_habit_errors: Some(2.0),
        });
        assert_eq!(out.artifacts_delta, 3.0);
        assert_eq!(out.entries_delta, 4.0);
        assert_eq!(out.revenue_actions_delta, 0.0);
        assert_eq!(out.registry_total_delta, 1.0);
        assert_eq!(out.registry_active_delta, 1.0);
        assert_eq!(out.registry_candidate_delta, 0.0);
        assert_eq!(out.habit_runs_delta, 3.0);
        assert_eq!(out.habit_errors_delta, 1.0);
    }

    #[test]
    fn autoscale_json_dod_evidence_diff_path_works() {
        let payload = serde_json::json!({
            "mode": "dod_evidence_diff",
            "dod_evidence_diff_input": {
                "before_artifacts": 1,
                "before_entries": 2,
                "before_revenue_actions": 0,
                "before_registry_total": 3,
                "before_registry_active": 2,
                "before_registry_candidate": 1,
                "before_habit_runs": 5,
                "before_habit_errors": 1,
                "after_artifacts": 3,
                "after_entries": 3,
                "after_revenue_actions": 1,
                "after_registry_total": 4,
                "after_registry_active": 2,
                "after_registry_candidate": 2,
                "after_habit_runs": 9,
                "after_habit_errors": 2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale dod_evidence_diff");
        assert!(out.contains("\"mode\":\"dod_evidence_diff\""));
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
        let out =
            compute_consecutive_gate_exhausted_attempts(&ConsecutiveGateExhaustedAttemptsInput {
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
        let out =
            run_autoscale_json(&payload).expect("autoscale consecutive_gate_exhausted_attempts");
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
            out.counts
                .get("stop_repeat_gate_no_progress")
                .copied()
                .unwrap_or(0),
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
    fn list_proposal_files_filters_and_sorts() {
        let out = compute_list_proposal_files(&ListProposalFilesInput {
            entries: vec![
                "README.md".to_string(),
                "2026-03-02.json".to_string(),
                "2026-03-01.json".to_string(),
                "2026-03-01.jsonl".to_string(),
            ],
        });
        assert_eq!(
            out.files,
            vec!["2026-03-01.json".to_string(), "2026-03-02.json".to_string()]
        );
    }

    #[test]
    fn autoscale_json_list_proposal_files_path_works() {
        let payload = serde_json::json!({
            "mode": "list_proposal_files",
            "list_proposal_files_input": {
                "entries": ["2026-03-02.json", "bad.txt", "2026-03-01.json"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale list_proposal_files");
        assert!(out.contains("\"mode\":\"list_proposal_files\""));
        assert!(out.contains("\"files\":[\"2026-03-01.json\",\"2026-03-02.json\"]"));
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
    fn proposal_semantic_fingerprint_builds_unique_sorted_stems() {
        let out = compute_proposal_semantic_fingerprint(&ProposalSemanticFingerprintInput {
            proposal_id: Some("p-1".to_string()),
            proposal_type: Some("ops_remediation".to_string()),
            source_eye: Some("GitHub_Release".to_string()),
            objective_id: Some("T1_Objective".to_string()),
            text_blob: Some("Rust bridge parity tests for transport fixes".to_string()),
            stopwords: vec!["for".to_string()],
            min_tokens: Some(3.0),
        });
        assert_eq!(out.proposal_id, Some("p-1".to_string()));
        assert_eq!(out.proposal_type, "ops_remediation".to_string());
        assert_eq!(out.source_eye, Some("github_release".to_string()));
        assert_eq!(out.objective_id, Some("T1_Objective".to_string()));
        assert!(out.token_stems.windows(2).all(|w| w[0] <= w[1]));
        assert!(out.token_count >= 3);
        assert!(out.eligible);
    }

    #[test]
    fn autoscale_json_proposal_semantic_fingerprint_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_semantic_fingerprint",
            "proposal_semantic_fingerprint_input": {
                "proposal_id": "p-1",
                "proposal_type": "ops_remediation",
                "source_eye": "github_release",
                "objective_id": "T1_Objective",
                "text_blob": "Rust bridge parity tests",
                "min_tokens": 2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_semantic_fingerprint");
        assert!(out.contains("\"mode\":\"proposal_semantic_fingerprint\""));
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
        assert!(
            (out.similarity - 0.5).abs() < 1e-6,
            "similarity={}",
            out.similarity
        );

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
        assert!(
            (out.similarity - 1.0).abs() < 1e-6,
            "similarity={}",
            out.similarity
        );
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
            bonus_raw: std::f64::consts::E,
            max_penalty: 12.0,
            max_bonus: 6.0,
        });
        assert!((out.penalty - 12.0).abs() < 0.000001);
        let expected_bonus = (std::f64::consts::E * 1000.0).round() / 1000.0;
        assert!((out.bonus - expected_bonus).abs() < 0.000001);
    }

    #[test]
    fn autoscale_json_collective_shadow_adjustments_path_works() {
        let payload = serde_json::json!({
                "mode": "collective_shadow_adjustments",
                "collective_shadow_adjustments_input": {
                    "penalty_raw": 18.4,
                    "bonus_raw": std::f64::consts::E,
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
        let out =
            compute_strategy_trit_shadow_ranking_summary(&StrategyTritShadowRankingSummaryInput {
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
        assert_eq!(
            out.top.first().map(|row| row.proposal_id.as_str()),
            Some("b")
        );
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

        let inactive =
            compute_pulse_objective_cooldown_active(&PulseObjectiveCooldownActiveInput {
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
        assert_eq!(out.hits, vec!["memory".to_string(), "memorize".to_string()]);
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
            allowed_checks: vec![
                "lint".to_string(),
                "format".to_string(),
                "typecheck".to_string(),
            ],
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
        assert_eq!(
            out.reason.as_deref(),
            Some("budget_pacing_high_token_low_value")
        );
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
    fn exec_window_match_checks_numeric_boundaries() {
        let inside = compute_exec_window_match(&ExecWindowMatchInput {
            ts_ms: Some(1_772_581_500_000.0),
            start_ms: Some(1_772_581_200_000.0),
            end_ms: Some(1_772_582_200_000.0),
        });
        assert!(inside.in_window);

        let outside = compute_exec_window_match(&ExecWindowMatchInput {
            ts_ms: Some(1_772_580_000_000.0),
            start_ms: Some(1_772_581_200_000.0),
            end_ms: Some(1_772_582_200_000.0),
        });
        assert!(!outside.in_window);
    }

    #[test]
    fn autoscale_json_exec_window_match_path_works() {
        let payload = serde_json::json!({
            "mode": "exec_window_match",
            "exec_window_match_input": {
                "ts_ms": 1772581500000.0,
                "start_ms": 1772581200000.0,
                "end_ms": 1772582200000.0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale exec_window_match");
        assert!(out.contains("\"mode\":\"exec_window_match\""));
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
        let cap_match =
            compute_execute_confidence_history_match(&ExecuteConfidenceHistoryMatchInput {
                event_type: Some("autonomy_run".to_string()),
                event_capability_key: Some("deploy".to_string()),
                event_proposal_type: Some("run".to_string()),
                proposal_type: Some("other".to_string()),
                capability_key: Some("deploy".to_string()),
            });
        assert!(cap_match.matched);

        let type_match =
            compute_execute_confidence_history_match(&ExecuteConfidenceHistoryMatchInput {
                event_type: Some("autonomy_run".to_string()),
                event_capability_key: Some(String::new()),
                event_proposal_type: Some("ops".to_string()),
                proposal_type: Some("ops".to_string()),
                capability_key: Some(String::new()),
            });
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
        let out = run_autoscale_json(&payload).expect("autoscale execute_confidence_history_match");
        assert!(out.contains("\"mode\":\"execute_confidence_history_match\""));
    }

    #[test]
    fn execute_confidence_cooldown_key_prefers_objective_then_capability_then_type() {
        let objective =
            compute_execute_confidence_cooldown_key(&ExecuteConfidenceCooldownKeyInput {
                capability_key: Some("system_exec".to_string()),
                objective_id: Some("T1_Objective".to_string()),
                proposal_type: Some("ops_remediation".to_string()),
            });
        assert_eq!(
            objective.cooldown_key,
            "exec_confidence:objective:t1_objective"
        );

        let capability =
            compute_execute_confidence_cooldown_key(&ExecuteConfidenceCooldownKeyInput {
                capability_key: Some("System Exec".to_string()),
                objective_id: Some("T12_Objective".to_string()),
                proposal_type: Some("ops_remediation".to_string()),
            });
        assert_eq!(
            capability.cooldown_key,
            "exec_confidence:capability:system_exec"
        );

        let by_type = compute_execute_confidence_cooldown_key(&ExecuteConfidenceCooldownKeyInput {
            capability_key: Some(String::new()),
            objective_id: Some(String::new()),
            proposal_type: Some("Directive Decomposition".to_string()),
        });
        assert_eq!(
            by_type.cooldown_key,
            "exec_confidence:type:directive_decomposition"
        );
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
        let out = run_autoscale_json(&payload).expect("autoscale execute_confidence_cooldown_key");
        assert!(out.contains("\"mode\":\"execute_confidence_cooldown_key\""));
    }

    #[test]
    fn recent_proposal_key_counts_counts_recent_attempts() {
        let out = compute_recent_proposal_key_counts(&RecentProposalKeyCountsInput {
            cutoff_ms: Some(1000.0),
            events: vec![
                RecentProposalKeyCountEventInput {
                    proposal_key: Some("proposal:a".to_string()),
                    ts_ms: Some(1500.0),
                    result: Some("executed".to_string()),
                    is_attempt: false,
                },
                RecentProposalKeyCountEventInput {
                    proposal_key: Some("proposal:a".to_string()),
                    ts_ms: Some(1600.0),
                    result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
                    is_attempt: true,
                },
                RecentProposalKeyCountEventInput {
                    proposal_key: Some("proposal:b".to_string()),
                    ts_ms: Some(900.0),
                    result: Some("executed".to_string()),
                    is_attempt: true,
                },
            ],
        });
        assert_eq!(out.counts.get("proposal:a").copied().unwrap_or(0.0), 2.0);
        assert_eq!(out.counts.get("proposal:b").copied().unwrap_or(0.0), 0.0);
    }

    #[test]
    fn autoscale_json_recent_proposal_key_counts_path_works() {
        let payload = serde_json::json!({
            "mode": "recent_proposal_key_counts",
            "recent_proposal_key_counts_input": {
                "cutoff_ms": 1000.0,
                "events": [
                    { "proposal_key": "proposal:a", "ts_ms": 1200.0, "result": "executed", "is_attempt": false }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale recent_proposal_key_counts");
        assert!(out.contains("\"mode\":\"recent_proposal_key_counts\""));
    }

    #[test]
    fn autoscale_json_capability_attempt_count_for_date_path_works() {
        let payload = serde_json::json!({
            "mode": "capability_attempt_count_for_date",
            "capability_attempt_count_for_date_input": {
                "keys": ["proposal:deploy"],
                "events": [
                    { "event_type": "autonomy_run", "capability_key": "proposal:deploy", "is_attempt": true },
                    { "event_type": "autonomy_run", "capability_key": "proposal:deploy", "is_attempt": false }
                ]
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale capability_attempt_count_for_date");
        assert!(out.contains("\"mode\":\"capability_attempt_count_for_date\""));
    }

    #[test]
    fn autoscale_json_capability_outcome_stats_in_window_path_works() {
        let payload = serde_json::json!({
            "mode": "capability_outcome_stats_in_window",
            "capability_outcome_stats_in_window_input": {
                "keys": ["proposal:deploy"],
                "events": [
                    { "event_type": "autonomy_run", "result": "executed", "capability_key": "proposal:deploy", "outcome": "shipped" }
                ]
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale capability_outcome_stats_in_window");
        assert!(out.contains("\"mode\":\"capability_outcome_stats_in_window\""));
    }

    #[test]
    fn autoscale_json_execute_confidence_history_path_works() {
        let payload = serde_json::json!({
            "mode": "execute_confidence_history",
            "execute_confidence_history_input": {
                "window_days": 7,
                "proposal_type": "deploy",
                "capability_key": "proposal:deploy",
                "events": [
                    { "matched": true, "result": "executed", "outcome": "no_change" }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale execute_confidence_history");
        assert!(out.contains("\"mode\":\"execute_confidence_history\""));
    }

    #[test]
    fn autoscale_json_execute_confidence_policy_path_works() {
        let payload = serde_json::json!({
            "mode": "execute_confidence_policy",
            "execute_confidence_policy_input": {
                "proposal_type": "deploy",
                "capability_key": "proposal:deploy",
                "risk": "low",
                "execution_mode": "canary_execute",
                "adaptive_enabled": true,
                "base_composite_margin": 12,
                "base_value_margin": 8,
                "low_risk_relax_composite": 2,
                "low_risk_relax_value": 1,
                "fallback_relax_every": 2,
                "fallback_relax_step": 1,
                "fallback_relax_max": 3,
                "fallback_relax_min_executed": 2,
                "fallback_relax_min_shipped": 1,
                "fallback_relax_min_ship_rate": 0.5,
                "no_change_tighten_min_executed": 3,
                "no_change_tighten_threshold": 0.5,
                "no_change_tighten_step": 1,
                "history": {
                    "executed": 4,
                    "shipped": 3,
                    "reverted": 0,
                    "no_change_rate": 0.25,
                    "confidence_fallback": 2
                }
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale execute_confidence_policy");
        assert!(out.contains("\"mode\":\"execute_confidence_policy\""));
    }

    #[test]
    fn directive_fit_assessment_scores_alignment() {
        let out = compute_directive_fit_assessment(&DirectiveFitAssessmentInput {
            min_directive_fit: 45.0,
            profile_available: true,
            active_directive_ids: vec!["T1_growth".to_string()],
            positive_phrase_hits: vec!["raise revenue".to_string()],
            positive_token_hits: vec!["growth".to_string(), "sales".to_string()],
            strategy_hits: vec!["scale".to_string()],
            negative_phrase_hits: Vec::new(),
            negative_token_hits: Vec::new(),
            strategy_token_count: 3.0,
            impact: Some("high".to_string()),
        });
        assert!(out.pass);
        assert!(out.score >= 45.0);
        assert!(out.matched_positive.contains(&"growth".to_string()));
        assert!(out.reasons.iter().all(|r| r != "below_min_directive_fit"));
    }

    #[test]
    fn autoscale_json_directive_fit_assessment_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_fit_assessment",
            "directive_fit_assessment_input": {
                "min_directive_fit": 50,
                "profile_available": true,
                "active_directive_ids": ["T1_growth"],
                "positive_phrase_hits": ["raise revenue"],
                "positive_token_hits": ["growth"],
                "strategy_hits": ["scale"],
                "negative_phrase_hits": [],
                "negative_token_hits": [],
                "strategy_token_count": 2,
                "impact": "high"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_fit_assessment");
        assert!(out.contains("\"mode\":\"directive_fit_assessment\""));
    }

    #[test]
    fn signal_quality_assessment_scores_expected_fields() {
        let out = compute_signal_quality_assessment(&SignalQualityAssessmentInput {
            min_signal_quality: 45.0,
            min_sensory_signal: 40.0,
            min_sensory_relevance: 42.0,
            min_eye_score_ema: 45.0,
            eye_id: Some("eye_revenue".to_string()),
            score_source: Some("sensory_relevance_score".to_string()),
            impact: Some("high".to_string()),
            risk: Some("low".to_string()),
            domain: Some("example.com".to_string()),
            url_scheme: Some("https".to_string()),
            title_has_stub: false,
            combined_item_score: Some(70.0),
            sensory_relevance_score: Some(72.0),
            sensory_relevance_tier: Some("high".to_string()),
            sensory_quality_score: Some(68.0),
            sensory_quality_tier: Some("high".to_string()),
            eye_known: true,
            eye_status: Some("active".to_string()),
            eye_score_ema: Some(64.0),
            parser_type: Some("rss".to_string()),
            parser_disallowed: false,
            domain_allowlist_enforced: true,
            domain_allowed: true,
            eye_proposed_total: Some(8.0),
            eye_yield_rate: Some(0.35),
            calibration_eye_bias: 1.5,
            calibration_topic_bias: 0.5,
        });
        assert!(out.pass);
        assert!(out.score >= 45.0);
        assert_eq!(out.eye_id, "eye_revenue");
        assert_eq!(out.score_source, "sensory_relevance_score");
    }

    #[test]
    fn autoscale_json_signal_quality_assessment_path_works() {
        let payload = serde_json::json!({
            "mode": "signal_quality_assessment",
            "signal_quality_assessment_input": {
                "min_signal_quality": 45,
                "min_sensory_signal": 40,
                "min_sensory_relevance": 42,
                "min_eye_score_ema": 45,
                "eye_id": "eye_revenue",
                "score_source": "sensory_relevance_score",
                "impact": "high",
                "risk": "low",
                "domain": "example.com",
                "url_scheme": "https",
                "title_has_stub": false,
                "combined_item_score": 70,
                "sensory_relevance_score": 72,
                "sensory_relevance_tier": "high",
                "sensory_quality_score": 68,
                "sensory_quality_tier": "high",
                "eye_known": true,
                "eye_status": "active",
                "eye_score_ema": 64,
                "parser_type": "rss",
                "parser_disallowed": false,
                "domain_allowlist_enforced": true,
                "domain_allowed": true,
                "eye_proposed_total": 8,
                "eye_yield_rate": 0.35,
                "calibration_eye_bias": 1.5,
                "calibration_topic_bias": 0.5
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale signal_quality_assessment");
        assert!(out.contains("\"mode\":\"signal_quality_assessment\""));
    }

    #[test]
    fn actionability_assessment_scores_actionable_candidate() {
        let out = compute_actionability_assessment(&ActionabilityAssessmentInput {
            min_actionability: 45.0,
            risk: Some("low".to_string()),
            impact: Some("high".to_string()),
            validation_count: 2.0,
            specific_validation_count: 2.0,
            has_next_cmd: true,
            generic_route_task: false,
            next_cmd_has_dry_run: false,
            looks_like_discovery_cmd: false,
            has_action_verb: true,
            has_opportunity: true,
            has_concrete_target: true,
            is_meta_coordination: false,
            is_explainer: false,
            mentions_proposal: false,
            relevance_score: Some(70.0),
            directive_fit_score: Some(72.0),
            criteria_requirement_applied: true,
            criteria_exempt_type: false,
            criteria_min_count: 1.0,
            measurable_criteria_count: 2.0,
            criteria_total_count: 2.0,
            criteria_pattern_penalty: 0.0,
            criteria_pattern_hits: Some(serde_json::json!([])),
            is_executable_proposal: true,
            has_rollback_signal: true,
            subdirective_required: false,
            subdirective_has_concrete_target: true,
            subdirective_has_expected_delta: true,
            subdirective_has_verification_step: true,
            subdirective_target_count: 1.0,
            subdirective_verify_count: 1.0,
            subdirective_success_criteria_count: 2.0,
        });
        assert!(out.pass);
        assert!(out.score >= 45.0);
    }

    #[test]
    fn autoscale_json_actionability_assessment_path_works() {
        let payload = serde_json::json!({
            "mode": "actionability_assessment",
            "actionability_assessment_input": {
                "min_actionability": 45,
                "risk": "low",
                "impact": "high",
                "validation_count": 2,
                "specific_validation_count": 2,
                "has_next_cmd": true,
                "generic_route_task": false,
                "next_cmd_has_dry_run": false,
                "looks_like_discovery_cmd": false,
                "has_action_verb": true,
                "has_opportunity": true,
                "has_concrete_target": true,
                "is_meta_coordination": false,
                "is_explainer": false,
                "mentions_proposal": false,
                "relevance_score": 70,
                "directive_fit_score": 72,
                "criteria_requirement_applied": true,
                "criteria_exempt_type": false,
                "criteria_min_count": 1,
                "measurable_criteria_count": 2,
                "criteria_total_count": 2,
                "criteria_pattern_penalty": 0,
                "criteria_pattern_hits": [],
                "is_executable_proposal": true,
                "has_rollback_signal": true,
                "subdirective_required": false,
                "subdirective_has_concrete_target": true,
                "subdirective_has_expected_delta": true,
                "subdirective_has_verification_step": true,
                "subdirective_target_count": 1,
                "subdirective_verify_count": 1,
                "subdirective_success_criteria_count": 2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale actionability_assessment");
        assert!(out.contains("\"mode\":\"actionability_assessment\""));
    }

    #[test]
    fn proposal_status_for_queue_pressure_prefers_overlay_then_explicit_status() {
        let out =
            compute_proposal_status_for_queue_pressure(&ProposalStatusForQueuePressureInput {
                overlay_decision: Some("accept".to_string()),
                proposal_status: Some("rejected".to_string()),
            });
        assert_eq!(out.status, "accepted");

        let out2 =
            compute_proposal_status_for_queue_pressure(&ProposalStatusForQueuePressureInput {
                overlay_decision: None,
                proposal_status: Some("closed_won".to_string()),
            });
        assert_eq!(out2.status, "closed");

        let out3 =
            compute_proposal_status_for_queue_pressure(&ProposalStatusForQueuePressureInput {
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

        let policy_hold =
            compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
                event_type: Some("autonomy_run".to_string()),
                result: Some("stop_init_gate_readiness".to_string()),
                policy_hold: Some(false),
                proposal_id: Some("p-001".to_string()),
            });
        assert!(!policy_hold.capacity_counted);

        let attempt_with_proposal =
            compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
                event_type: Some("autonomy_run".to_string()),
                result: Some("stop_repeat_gate_candidate_exhausted".to_string()),
                policy_hold: Some(false),
                proposal_id: Some("p-001".to_string()),
            });
        assert!(attempt_with_proposal.capacity_counted);

        let attempt_without_proposal =
            compute_capacity_counted_attempt_event(&CapacityCountedAttemptEventInput {
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

    #[test]
    fn build_overlay_keeps_latest_decision_and_outcome() {
        let out = compute_build_overlay(&BuildOverlayInput {
            events: vec![
                BuildOverlayEventInput {
                    proposal_id: Some("p-1".to_string()),
                    event_type: Some("decision".to_string()),
                    decision: Some("accept".to_string()),
                    ts: Some("2026-03-04T00:00:00.000Z".to_string()),
                    reason: Some("first".to_string()),
                    outcome: None,
                    evidence_ref: None,
                },
                BuildOverlayEventInput {
                    proposal_id: Some("p-1".to_string()),
                    event_type: Some("outcome".to_string()),
                    decision: None,
                    ts: Some("2026-03-04T00:05:00.000Z".to_string()),
                    reason: None,
                    outcome: Some("shipped".to_string()),
                    evidence_ref: Some("eye:test".to_string()),
                },
                BuildOverlayEventInput {
                    proposal_id: Some("p-1".to_string()),
                    event_type: Some("decision".to_string()),
                    decision: Some("reject".to_string()),
                    ts: Some("2026-03-04T00:10:00.000Z".to_string()),
                    reason: Some("latest".to_string()),
                    outcome: None,
                    evidence_ref: None,
                },
            ],
        });
        assert_eq!(out.entries.len(), 1);
        let row = &out.entries[0];
        assert_eq!(row.proposal_id, "p-1");
        assert_eq!(row.decision.as_deref(), Some("reject"));
        assert_eq!(row.decision_reason.as_deref(), Some("latest"));
        assert_eq!(row.last_outcome.as_deref(), Some("shipped"));
        assert_eq!(row.outcomes.shipped, 1);
    }

    #[test]
    fn has_adaptive_mutation_signal_detects_blob_markers() {
        let out = compute_has_adaptive_mutation_signal(&HasAdaptiveMutationSignalInput {
            proposal_type: Some("improvement".to_string()),
            adaptive_mutation: false,
            mutation_proposal: false,
            topology_mutation: false,
            self_improvement_change: false,
            signal_blob: Some("run mutation_guard with rollback receipt".to_string()),
        });
        assert!(out.has_signal);
    }

    #[test]
    fn adaptive_mutation_execution_guard_requires_receipts() {
        let out = compute_adaptive_mutation_execution_guard(&AdaptiveMutationExecutionGuardInput {
            guard_required: true,
            applies: true,
            metadata_applies: true,
            guard_pass: true,
            guard_reason: None,
            safety_attestation: None,
            rollback_receipt: None,
            guard_receipt_id: None,
            mutation_kernel_applies: false,
            mutation_kernel_pass: true,
        });
        assert!(!out.pass);
        assert!(out
            .reasons
            .contains(&"adaptive_mutation_missing_safety_attestation".to_string()));
    }

    #[test]
    fn autoscale_json_adaptive_mutation_guard_path_works() {
        let payload = serde_json::json!({
            "mode": "adaptive_mutation_execution_guard",
            "adaptive_mutation_execution_guard_input": {
                "guard_required": true,
                "applies": true,
                "metadata_applies": false,
                "guard_pass": false,
                "guard_reason": "failed",
                "safety_attestation": "safe-1",
                "rollback_receipt": "roll-1",
                "guard_receipt_id": "guard-1",
                "mutation_kernel_applies": true,
                "mutation_kernel_pass": false
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale adaptive_mutation_execution_guard");
        assert!(out.contains("\"mode\":\"adaptive_mutation_execution_guard\""));
    }

    #[test]
    fn strategy_selection_chooses_primary_when_canary_not_due() {
        let out = compute_strategy_selection(&StrategySelectionInput {
            date_str: Some("2026-03-04".to_string()),
            attempt_index: 1.0,
            canary_enabled: true,
            canary_allow_execute: false,
            canary_fraction: 0.25,
            max_active: 3.0,
            fallback_strategy_id: Some("fallback".to_string()),
            variants: vec![
                StrategySelectionVariantInput {
                    strategy_id: Some("s-main".to_string()),
                    score: 0.9,
                    confidence: 0.8,
                    stage: Some("stable".to_string()),
                    execution_mode: Some("execute".to_string()),
                },
                StrategySelectionVariantInput {
                    strategy_id: Some("s-canary".to_string()),
                    score: 0.8,
                    confidence: 0.7,
                    stage: Some("trial".to_string()),
                    execution_mode: Some("score_only".to_string()),
                },
            ],
        });
        assert_eq!(out.mode, "primary_best");
        assert_eq!(out.selected_strategy_id.as_deref(), Some("s-main"));
        assert_eq!(out.active_count, 2);
    }

    #[test]
    fn autoscale_json_strategy_selection_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_selection",
            "strategy_selection_input": {
                "date_str": "2026-03-04",
                "attempt_index": 4,
                "canary_enabled": true,
                "canary_allow_execute": false,
                "canary_fraction": 0.25,
                "max_active": 3,
                "fallback_strategy_id": "fallback",
                "variants": [
                    {
                        "strategy_id": "s-main",
                        "score": 0.9,
                        "confidence": 0.8,
                        "stage": "stable",
                        "execution_mode": "execute"
                    },
                    {
                        "strategy_id": "s-canary",
                        "score": 0.8,
                        "confidence": 0.7,
                        "stage": "trial",
                        "execution_mode": "score_only"
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale strategy_selection");
        assert!(out.contains("\"mode\":\"strategy_selection\""));
    }

    #[test]
    fn calibration_deltas_loosen_when_exhausted_and_low_ship_rate() {
        let out = compute_calibration_deltas(&CalibrationDeltasInput {
            executed_count: 8.0,
            shipped_rate: 0.05,
            no_change_rate: 0.7,
            reverted_rate: 0.1,
            exhausted: 4.0,
            min_executed: 6.0,
            tighten_min_executed: 10.0,
            loosen_low_shipped_rate: 0.2,
            loosen_exhausted_threshold: 3.0,
            tighten_min_shipped_rate: 0.2,
            max_delta: 6.0,
        });
        assert_eq!(out.min_signal_quality, -3.0);
        assert_eq!(out.min_directive_fit, -3.0);
        assert_eq!(out.min_actionability_score, -2.0);
        assert_eq!(out.min_sensory_relevance_score, -1.0);
    }

    #[test]
    fn autoscale_json_calibration_deltas_path_works() {
        let payload = serde_json::json!({
            "mode": "calibration_deltas",
            "calibration_deltas_input": {
                "executed_count": 12,
                "shipped_rate": 0.5,
                "no_change_rate": 0.65,
                "reverted_rate": 0.2,
                "exhausted": 3,
                "min_executed": 6,
                "tighten_min_executed": 10,
                "loosen_low_shipped_rate": 0.2,
                "loosen_exhausted_threshold": 3,
                "tighten_min_shipped_rate": 0.2,
                "max_delta": 6
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale calibration_deltas");
        assert!(out.contains("\"mode\":\"calibration_deltas\""));
    }

    #[test]
    fn strategy_admission_decision_blocks_duplicate_window() {
        let out = compute_strategy_admission_decision(&StrategyAdmissionDecisionInput {
            require_admission_preview: false,
            preview_eligible: true,
            preview_blocked_by: vec![],
            mutation_guard: None,
            strategy_type_allowed: true,
            max_risk_per_action: Some(0.8),
            strategy_max_risk_per_action: Some(0.8),
            hard_max_risk_per_action: None,
            risk_score: Some(0.2),
            remediation_check_required: false,
            remediation_depth: None,
            remediation_max_depth: None,
            dedup_key: Some("proposal:key".to_string()),
            duplicate_window_hours: Some(24.0),
            recent_count: Some(2.0),
        });
        assert!(!out.allow);
        assert_eq!(out.reason.as_deref(), Some("strategy_duplicate_window"));
        assert_eq!(out.recent_count, Some(2.0));
    }

    #[test]
    fn autoscale_json_strategy_admission_decision_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_admission_decision",
            "strategy_admission_decision_input": {
                "require_admission_preview": true,
                "preview_eligible": false,
                "preview_blocked_by": ["preview_gate"],
                "mutation_guard": {
                    "applies": false,
                    "pass": true,
                    "reason": null,
                    "reasons": [],
                    "controls": {}
                },
                "strategy_type_allowed": true
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale strategy_admission_decision");
        assert!(out.contains("\"mode\":\"strategy_admission_decision\""));
    }

    #[test]
    fn expected_value_score_returns_input_score() {
        let out = compute_expected_value_score(&ExpectedValueScoreInput { score: 42.5 });
        assert_eq!(out.score, 42.5);
    }

    #[test]
    fn autoscale_json_expected_value_score_path_works() {
        let payload = serde_json::json!({
            "mode": "expected_value_score",
            "expected_value_score_input": {
                "score": 77.0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale expected_value_score");
        assert!(out.contains("\"mode\":\"expected_value_score\""));
    }

    #[test]
    fn suggest_run_batch_max_normalizes_values() {
        let out = compute_suggest_run_batch_max(&SuggestRunBatchMaxInput {
            enabled: true,
            batch_max: 3.8,
            batch_reason: Some(" backlog_autoscale ".to_string()),
            daily_remaining: 4.2,
            autoscale_hint: serde_json::json!({"current_cells": 2}),
        });
        assert!(out.enabled);
        assert_eq!(out.max, 3.0);
        assert_eq!(out.reason, "backlog_autoscale");
        assert_eq!(out.daily_remaining, 4.0);
    }

    #[test]
    fn autoscale_json_suggest_run_batch_max_path_works() {
        let payload = serde_json::json!({
            "mode": "suggest_run_batch_max",
            "suggest_run_batch_max_input": {
                "enabled": true,
                "batch_max": 2,
                "batch_reason": "no_pressure",
                "daily_remaining": 6,
                "autoscale_hint": {"state": {"current_cells": 1}}
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale suggest_run_batch_max");
        assert!(out.contains("\"mode\":\"suggest_run_batch_max\""));
    }

    #[test]
    fn backlog_autoscale_snapshot_normalizes_payload() {
        let out = compute_backlog_autoscale_snapshot(&BacklogAutoscaleSnapshotInput {
            enabled: true,
            module: Some(" autonomy_backlog_autoscale ".to_string()),
            state: serde_json::json!({"current_cells": 2}),
            queue: serde_json::json!({"pressure": "warning"}),
            current_cells: 3.8,
            plan: serde_json::json!({"action": "scale_up"}),
            trit_productivity: serde_json::json!({"hold": false}),
        });
        assert!(out.enabled);
        assert_eq!(out.module, "autonomy_backlog_autoscale");
        assert_eq!(out.current_cells, 3.8);
    }

    #[test]
    fn autoscale_json_backlog_autoscale_snapshot_path_works() {
        let payload = serde_json::json!({
            "mode": "backlog_autoscale_snapshot",
            "backlog_autoscale_snapshot_input": {
                "enabled": true,
                "module": "autonomy_backlog_autoscale",
                "state": {"current_cells": 1},
                "queue": {"pressure": "normal"},
                "current_cells": 1,
                "plan": {"action": "hold"},
                "trit_productivity": {"hold": false}
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale backlog_autoscale_snapshot");
        assert!(out.contains("\"mode\":\"backlog_autoscale_snapshot\""));
    }

    #[test]
    fn admission_summary_tallies_blocked_reasons() {
        let out = compute_admission_summary(&AdmissionSummaryInput {
            proposals: vec![
                AdmissionSummaryProposalInput {
                    preview_eligible: Some(true),
                    blocked_by: vec![],
                },
                AdmissionSummaryProposalInput {
                    preview_eligible: Some(false),
                    blocked_by: vec!["policy_hold".to_string(), "risk".to_string()],
                },
                AdmissionSummaryProposalInput {
                    preview_eligible: Some(false),
                    blocked_by: vec![],
                },
            ],
        });
        assert_eq!(out.total, 3);
        assert_eq!(out.eligible, 1);
        assert_eq!(out.blocked, 2);
        assert_eq!(out.blocked_by_reason.get("policy_hold"), Some(&1));
        assert_eq!(out.blocked_by_reason.get("risk"), Some(&1));
        assert_eq!(out.blocked_by_reason.get("unknown"), Some(&1));
    }

    #[test]
    fn autoscale_json_admission_summary_path_works() {
        let payload = serde_json::json!({
            "mode": "admission_summary",
            "admission_summary_input": {
                "proposals": [
                    {"preview_eligible": true, "blocked_by": []},
                    {"preview_eligible": false, "blocked_by": ["manual_gate"]}
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale admission_summary");
        assert!(out.contains("\"mode\":\"admission_summary\""));
    }

    #[test]
    fn unknown_type_quarantine_decision_blocks_unknown_type() {
        let out = compute_unknown_type_quarantine_decision(&UnknownTypeQuarantineDecisionInput {
            enabled: true,
            proposal_type: Some("unknown_type".to_string()),
            type_in_quarantine_set: true,
            allow_directive: true,
            allow_tier1: true,
            objective_id: Some("T1_OBJ".to_string()),
            tier1_objective: false,
        });
        assert!(out.block);
        assert_eq!(out.reason.as_deref(), Some("unknown_type_quarantine"));
        assert_eq!(out.proposal_type.as_deref(), Some("unknown_type"));
    }

    #[test]
    fn autoscale_json_unknown_type_quarantine_decision_path_works() {
        let payload = serde_json::json!({
            "mode": "unknown_type_quarantine_decision",
            "unknown_type_quarantine_decision_input": {
                "enabled": true,
                "proposal_type": "directive_decomposition",
                "type_in_quarantine_set": true,
                "allow_directive": true,
                "allow_tier1": true,
                "objective_id": "T1_demo",
                "tier1_objective": false
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale unknown_type_quarantine_decision");
        assert!(out.contains("\"mode\":\"unknown_type_quarantine_decision\""));
    }

    #[test]
    fn infer_optimization_delta_prefers_direct_meta_field() {
        let out = compute_infer_optimization_delta(&InferOptimizationDeltaInput {
            optimization_delta_percent: None,
            expected_optimization_percent: Some(12.75),
            expected_delta_percent: Some(9.0),
            estimated_improvement_percent: None,
            target_improvement_percent: None,
            performance_gain_percent: None,
            text_blob: Some("fallback 30%".to_string()),
        });
        assert_eq!(out.delta_percent, Some(12.75));
        assert_eq!(
            out.delta_source.as_deref(),
            Some("meta:expected_optimization_percent")
        );
    }

    #[test]
    fn autoscale_json_infer_optimization_delta_path_works() {
        let payload = serde_json::json!({
            "mode": "infer_optimization_delta",
            "infer_optimization_delta_input": {
                "optimization_delta_percent": null,
                "expected_optimization_percent": null,
                "expected_delta_percent": null,
                "estimated_improvement_percent": null,
                "target_improvement_percent": null,
                "performance_gain_percent": null,
                "text_blob": "target +18% reduction"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale infer_optimization_delta");
        assert!(out.contains("\"mode\":\"infer_optimization_delta\""));
    }

    #[test]
    fn optimization_intent_proposal_detects_expected_terms() {
        let out = compute_optimization_intent_proposal(&OptimizationIntentProposalInput {
            proposal_type: Some("automation".to_string()),
            blob: Some("optimize latency and throughput".to_string()),
            has_actuation_meta: false,
        });
        assert!(out.intent);
    }

    #[test]
    fn autoscale_json_optimization_intent_proposal_path_works() {
        let payload = serde_json::json!({
            "mode": "optimization_intent_proposal",
            "optimization_intent_proposal_input": {
                "proposal_type": "actuation",
                "blob": "canary smoke test rollout",
                "has_actuation_meta": true
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale optimization_intent_proposal");
        assert!(out.contains("\"mode\":\"optimization_intent_proposal\""));
    }

    #[test]
    fn unlinked_optimization_admission_blocks_high_risk_when_unlinked() {
        let out = compute_unlinked_optimization_admission(&UnlinkedOptimizationAdmissionInput {
            optimization_intent: true,
            proposal_type: Some("optimization".to_string()),
            exempt_types: vec!["directive_clarification".to_string()],
            linked: false,
            normalized_risk: Some("high".to_string()),
            hard_block_high_risk: true,
            penalty: 8.0,
        });
        assert!(out.applies);
        assert!(!out.linked);
        assert!(out.block);
        assert_eq!(
            out.reason.as_deref(),
            Some("optimization_unlinked_objective_high_risk_block")
        );
    }

    #[test]
    fn autoscale_json_unlinked_optimization_admission_path_works() {
        let payload = serde_json::json!({
            "mode": "unlinked_optimization_admission",
            "unlinked_optimization_admission_input": {
                "optimization_intent": true,
                "proposal_type": "optimization",
                "exempt_types": ["directive_clarification"],
                "linked": false,
                "normalized_risk": "low",
                "hard_block_high_risk": true,
                "penalty": 12
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale unlinked_optimization_admission");
        assert!(out.contains("\"mode\":\"unlinked_optimization_admission\""));
    }

    #[test]
    fn optimization_good_enough_fails_when_delta_below_min() {
        let out = compute_optimization_good_enough(&OptimizationGoodEnoughInput {
            applies: true,
            min_delta_percent: 10.0,
            require_delta: true,
            high_accuracy_mode: false,
            normalized_risk: Some("medium".to_string()),
            delta_percent: Some(4.0),
            delta_source: Some("text:%".to_string()),
        });
        assert!(out.applies);
        assert!(!out.pass);
        assert_eq!(out.reason.as_deref(), Some("optimization_good_enough"));
    }

    #[test]
    fn autoscale_json_optimization_good_enough_path_works() {
        let payload = serde_json::json!({
            "mode": "optimization_good_enough",
            "optimization_good_enough_input": {
                "applies": true,
                "min_delta_percent": 8,
                "require_delta": true,
                "high_accuracy_mode": false,
                "normalized_risk": "low",
                "delta_percent": 12,
                "delta_source": "meta:expected_delta_percent"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale optimization_good_enough");
        assert!(out.contains("\"mode\":\"optimization_good_enough\""));
    }

    #[test]
    fn proposal_dependency_summary_builds_chain_and_edges() {
        let out = compute_proposal_dependency_summary(&ProposalDependencySummaryInput {
            proposal_id: Some("p-1".to_string()),
            decision: Some("accept".to_string()),
            source: Some("directive_decomposition".to_string()),
            parent_objective_id: Some("T1_parent".to_string()),
            created_ids: vec!["T1_child_a".to_string(), "T1_child_b".to_string()],
            dry_run: false,
            created_count: Some(2.0),
            quality_ok: true,
            reason: None,
        });
        assert_eq!(out.decision, "ACCEPT");
        assert_eq!(out.edge_count, 2);
        assert_eq!(out.chain.len(), 3);
        assert_eq!(out.child_objective_ids.len(), 2);
    }

    #[test]
    fn autoscale_json_proposal_dependency_summary_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_dependency_summary",
            "proposal_dependency_summary_input": {
                "proposal_id": "p-2",
                "decision": "accept",
                "source": "directive_decomposition",
                "parent_objective_id": "T1_parent",
                "created_ids": ["T1_child_a"],
                "dry_run": false,
                "created_count": 1,
                "quality_ok": true,
                "reason": null
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_dependency_summary");
        assert!(out.contains("\"mode\":\"proposal_dependency_summary\""));
    }

    #[test]
    fn choose_selection_mode_switches_to_explore_on_cadence() {
        let out = compute_choose_selection_mode(&ChooseSelectionModeInput {
            eligible_len: 6,
            executed_count: 4,
            explore_used: 1,
            exploit_used: 3,
            explore_quota: 5,
            every_n: 2,
            min_eligible: 2,
        });
        assert_eq!(out.mode, "explore");
        assert!(out.index >= 1);
    }

    #[test]
    fn autoscale_json_choose_selection_mode_path_works() {
        let payload = serde_json::json!({
            "mode": "choose_selection_mode",
            "choose_selection_mode_input": {
                "eligible_len": 3,
                "executed_count": 1,
                "explore_used": 0,
                "exploit_used": 1,
                "explore_quota": 2,
                "every_n": 1,
                "min_eligible": 2
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale choose_selection_mode");
        assert!(out.contains("\"mode\":\"choose_selection_mode\""));
    }

    #[test]
    fn explore_quota_for_day_clamps_fraction_and_floor() {
        let out = compute_explore_quota_for_day(&ExploreQuotaForDayInput {
            daily_runs_cap: Some(12.0),
            explore_fraction: Some(0.25),
            default_max_runs: 8.0,
        });
        assert_eq!(out.quota, 3);
    }

    #[test]
    fn autoscale_json_explore_quota_for_day_path_works() {
        let payload = serde_json::json!({
            "mode": "explore_quota_for_day",
            "explore_quota_for_day_input": {
                "daily_runs_cap": 10,
                "explore_fraction": 0.2,
                "default_max_runs": 8
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale explore_quota_for_day");
        assert!(out.contains("\"mode\":\"explore_quota_for_day\""));
    }

    #[test]
    fn medium_risk_thresholds_derives_bounds() {
        let out = compute_medium_risk_thresholds(&MediumRiskThresholdsInput {
            base_min_directive_fit: 40.0,
            base_min_actionability_score: 45.0,
            medium_risk_min_composite_eligibility: 70.0,
            min_composite_eligibility: 68.0,
            medium_risk_min_directive_fit: 50.0,
            default_min_directive_fit: 45.0,
            medium_risk_min_actionability: 52.0,
            default_min_actionability: 46.0,
        });
        assert_eq!(out.composite_min, 74.0);
        assert_eq!(out.directive_fit_min, 50.0);
        assert_eq!(out.actionability_min, 52.0);
    }

    #[test]
    fn autoscale_json_medium_risk_thresholds_path_works() {
        let payload = serde_json::json!({
            "mode": "medium_risk_thresholds",
            "medium_risk_thresholds_input": {
                "base_min_directive_fit": 40,
                "base_min_actionability_score": 45,
                "medium_risk_min_composite_eligibility": 70,
                "min_composite_eligibility": 68,
                "medium_risk_min_directive_fit": 50,
                "default_min_directive_fit": 45,
                "medium_risk_min_actionability": 52,
                "default_min_actionability": 46
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale medium_risk_thresholds");
        assert!(out.contains("\"mode\":\"medium_risk_thresholds\""));
    }

    #[test]
    fn medium_risk_gate_decision_flags_low_scores() {
        let out = compute_medium_risk_gate_decision(&MediumRiskGateDecisionInput {
            risk: Some("medium".to_string()),
            composite_score: 60.0,
            directive_fit_score: 55.0,
            actionability_score: 54.0,
            composite_min: 70.0,
            directive_fit_min: 60.0,
            actionability_min: 62.0,
        });
        assert!(!out.pass);
        assert_eq!(out.risk, "medium");
        assert!(out.reasons.contains(&"medium_composite_low".to_string()));
        assert!(out.required.is_some());
    }

    #[test]
    fn autoscale_json_medium_risk_gate_decision_path_works() {
        let payload = serde_json::json!({
            "mode": "medium_risk_gate_decision",
            "medium_risk_gate_decision_input": {
                "risk": "medium",
                "composite_score": 72,
                "directive_fit_score": 68,
                "actionability_score": 66,
                "composite_min": 70,
                "directive_fit_min": 60,
                "actionability_min": 62
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale medium_risk_gate_decision");
        assert!(out.contains("\"mode\":\"medium_risk_gate_decision\""));
    }

    #[test]
    fn route_block_prefilter_blocks_when_rate_exceeded() {
        let out = compute_route_block_prefilter(&RouteBlockPrefilterInput {
            enabled: true,
            capability_key: Some("deploy".to_string()),
            window_hours: 24.0,
            min_observations: 3.0,
            max_block_rate: 0.5,
            row_present: true,
            attempts: 10.0,
            route_blocked: 6.0,
            route_block_rate: 0.6,
        });
        assert!(out.applicable);
        assert!(!out.pass);
        assert_eq!(out.reason, "route_block_rate_exceeded");
    }

    #[test]
    fn autoscale_json_route_block_prefilter_path_works() {
        let payload = serde_json::json!({
            "mode": "route_block_prefilter",
            "route_block_prefilter_input": {
                "enabled": true,
                "capability_key": "deploy",
                "window_hours": 24,
                "min_observations": 3,
                "max_block_rate": 0.5,
                "row_present": true,
                "attempts": 4,
                "route_blocked": 1,
                "route_block_rate": 0.25
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale route_block_prefilter");
        assert!(out.contains("\"mode\":\"route_block_prefilter\""));
    }

    #[test]
    fn route_execution_sample_event_matches_route_logic() {
        let blocked = compute_route_execution_sample_event(&RouteExecutionSampleEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("score_only_fallback_route_block".to_string()),
            execution_target: Some("cell".to_string()),
            route_summary_present: false,
        });
        assert!(blocked.is_sample_event);

        let route_exec = compute_route_execution_sample_event(&RouteExecutionSampleEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("executed".to_string()),
            execution_target: Some("route".to_string()),
            route_summary_present: false,
        });
        assert!(route_exec.is_sample_event);

        let non_sample = compute_route_execution_sample_event(&RouteExecutionSampleEventInput {
            event_type: Some("autonomy_run".to_string()),
            result: Some("no_change".to_string()),
            execution_target: Some("route".to_string()),
            route_summary_present: true,
        });
        assert!(!non_sample.is_sample_event);
    }

    #[test]
    fn autoscale_json_route_execution_sample_event_path_works() {
        let payload = serde_json::json!({
            "mode": "route_execution_sample_event",
            "route_execution_sample_event_input": {
                "event_type": "autonomy_run",
                "result": "executed",
                "execution_target": "route",
                "route_summary_present": false
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale route_execution_sample_event");
        assert!(out.contains("\"mode\":\"route_execution_sample_event\""));
        assert!(out.contains("\"is_sample_event\":true"));
    }

    #[test]
    fn route_block_telemetry_summary_aggregates_by_capability() {
        let out = compute_route_block_telemetry_summary(&RouteBlockTelemetrySummaryInput {
            events: vec![
                RouteBlockTelemetryEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    execution_target: Some("route".to_string()),
                    route_summary_present: false,
                    capability_key: Some("deploy".to_string()),
                },
                RouteBlockTelemetryEventInput {
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("score_only_fallback_route_block".to_string()),
                    execution_target: Some("cell".to_string()),
                    route_summary_present: false,
                    capability_key: Some("deploy".to_string()),
                },
            ],
            window_hours: 12.0,
        });
        assert_eq!(out.sample_events, 2.0);
        assert_eq!(out.by_capability.len(), 1);
        assert_eq!(out.by_capability[0].key, "deploy");
        assert_eq!(out.by_capability[0].attempts, 2.0);
        assert_eq!(out.by_capability[0].route_blocked, 1.0);
        assert!((out.by_capability[0].route_block_rate - 0.5).abs() < 1e-6);
    }

    #[test]
    fn autoscale_json_route_block_telemetry_summary_path_works() {
        let payload = serde_json::json!({
            "mode": "route_block_telemetry_summary",
            "route_block_telemetry_summary_input": {
                "events": [
                    {
                        "event_type": "autonomy_run",
                        "result": "executed",
                        "execution_target": "route",
                        "route_summary_present": false,
                        "capability_key": "deploy"
                    }
                ],
                "window_hours": 6
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale route_block_telemetry_summary");
        assert!(out.contains("\"mode\":\"route_block_telemetry_summary\""));
        assert!(out.contains("\"sample_events\":1"));
    }

    #[test]
    fn is_stub_proposal_matches_title_marker() {
        let yes = compute_is_stub_proposal(&IsStubProposalInput {
            title: Some("[STUB] backlog".to_string()),
        });
        assert!(yes.is_stub);
        let no = compute_is_stub_proposal(&IsStubProposalInput {
            title: Some("shippable task".to_string()),
        });
        assert!(!no.is_stub);
    }

    #[test]
    fn autoscale_json_is_stub_proposal_path_works() {
        let payload = serde_json::json!({
            "mode": "is_stub_proposal",
            "is_stub_proposal_input": {
                "title": "[STUB] investigate"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale is_stub_proposal");
        assert!(out.contains("\"mode\":\"is_stub_proposal\""));
        assert!(out.contains("\"is_stub\":true"));
    }

    #[test]
    fn recent_autonomy_run_events_filters_by_type_time_and_cap() {
        let now = Utc::now().timestamp_millis();
        let recent = chrono::DateTime::from_timestamp_millis(now - 30 * 60 * 1000)
            .expect("recent dt")
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let old = chrono::DateTime::from_timestamp_millis(now - 5 * 60 * 60 * 1000)
            .expect("old dt")
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let out = compute_recent_autonomy_run_events(&RecentAutonomyRunEventsInput {
            events: vec![
                serde_json::json!({"type":"autonomy_run","ts":recent}),
                serde_json::json!({"type":"heartbeat","ts":recent}),
                serde_json::json!({"type":"autonomy_run","ts":old}),
            ],
            cutoff_ms: (now - 2 * 60 * 60 * 1000) as f64,
            cap: 50.0,
        });
        assert_eq!(out.events.len(), 1);
        assert_eq!(
            out.events[0]
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "autonomy_run"
        );
    }

    #[test]
    fn autoscale_json_recent_autonomy_run_events_path_works() {
        let now = Utc::now().timestamp_millis();
        let recent = chrono::DateTime::from_timestamp_millis(now - 30 * 60 * 1000)
            .expect("recent dt")
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let payload = serde_json::json!({
            "mode": "recent_autonomy_run_events",
            "recent_autonomy_run_events_input": {
                "events": [
                    {"type":"autonomy_run","ts": recent},
                    {"type":"heartbeat","ts": recent}
                ],
                "cutoff_ms": now - 2 * 60 * 60 * 1000,
                "cap": 50
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale recent_autonomy_run_events");
        assert!(out.contains("\"mode\":\"recent_autonomy_run_events\""));
    }

    #[test]
    fn proposal_meta_index_dedupes_first_seen_rows() {
        let out = compute_proposal_meta_index(&ProposalMetaIndexInput {
            entries: vec![
                ProposalMetaIndexEntryInput {
                    proposal_id: Some("p1".to_string()),
                    eye_id: Some("eye_a".to_string()),
                    topics: vec!["A".to_string(), "b".to_string()],
                },
                ProposalMetaIndexEntryInput {
                    proposal_id: Some("p1".to_string()),
                    eye_id: Some("eye_b".to_string()),
                    topics: vec!["c".to_string()],
                },
                ProposalMetaIndexEntryInput {
                    proposal_id: Some("p2".to_string()),
                    eye_id: Some("eye_c".to_string()),
                    topics: vec!["X".to_string()],
                },
            ],
        });
        assert_eq!(out.entries.len(), 2);
        assert_eq!(out.entries[0].proposal_id, "p1");
        assert_eq!(out.entries[0].eye_id, "eye_a");
        assert_eq!(
            out.entries[0].topics,
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(out.entries[1].proposal_id, "p2");
    }

    #[test]
    fn autoscale_json_proposal_meta_index_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_meta_index",
            "proposal_meta_index_input": {
                "entries": [
                    { "proposal_id": "p1", "eye_id": "eye_a", "topics": ["One"] },
                    { "proposal_id": "p1", "eye_id": "eye_b", "topics": ["Two"] }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_meta_index");
        assert!(out.contains("\"mode\":\"proposal_meta_index\""));
        assert!(out.contains("\"proposal_id\":\"p1\""));
    }

    #[test]
    fn new_log_events_slices_runs_and_errors_from_before_lengths() {
        let out = compute_new_log_events(&NewLogEventsInput {
            before_run_len: Some(1.0),
            before_error_len: Some(2.0),
            after_runs: vec![
                serde_json::json!({"id":"r1"}),
                serde_json::json!({"id":"r2"}),
            ],
            after_errors: vec![
                serde_json::json!("e1"),
                serde_json::json!("e2"),
                serde_json::json!("e3"),
            ],
        });
        assert_eq!(out.runs.len(), 1);
        assert_eq!(
            out.runs[0].get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "r2"
        );
        assert_eq!(out.errors.len(), 1);
        assert_eq!(out.errors[0].as_str().unwrap_or(""), "e3");
    }

    #[test]
    fn autoscale_json_new_log_events_path_works() {
        let payload = serde_json::json!({
            "mode": "new_log_events",
            "new_log_events_input": {
                "before_run_len": 1,
                "before_error_len": 0,
                "after_runs": [{"id":"r1"},{"id":"r2"}],
                "after_errors": ["e1"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale new_log_events");
        assert!(out.contains("\"mode\":\"new_log_events\""));
        assert!(out.contains("\"runs\":[{\"id\":\"r2\"}]"));
    }

    #[test]
    fn outcome_buckets_returns_zeroed_counts() {
        let out = compute_outcome_buckets(&OutcomeBucketsInput {});
        assert_eq!(out.shipped, 0.0);
        assert_eq!(out.no_change, 0.0);
        assert_eq!(out.reverted, 0.0);
    }

    #[test]
    fn autoscale_json_outcome_buckets_path_works() {
        let payload = serde_json::json!({
            "mode": "outcome_buckets",
            "outcome_buckets_input": {}
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale outcome_buckets");
        assert!(out.contains("\"mode\":\"outcome_buckets\""));
        assert!(out.contains("\"shipped\":0.0"));
    }

    #[test]
    fn recent_run_events_flattens_day_buckets_in_order() {
        let out = compute_recent_run_events(&RecentRunEventsInput {
            day_events: vec![
                vec![serde_json::json!({"id":"a"}), serde_json::json!({"id":"b"})],
                vec![serde_json::json!({"id":"c"})],
            ],
        });
        assert_eq!(out.events.len(), 3);
        assert_eq!(
            out.events[0]
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "a"
        );
        assert_eq!(
            out.events[2]
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "c"
        );
    }

    #[test]
    fn autoscale_json_recent_run_events_path_works() {
        let payload = serde_json::json!({
            "mode": "recent_run_events",
            "recent_run_events_input": {
                "day_events": [
                    [{"id":"a"}],
                    [{"id":"b"}]
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale recent_run_events");
        assert!(out.contains("\"mode\":\"recent_run_events\""));
        assert!(out.contains("\"id\":\"a\""));
        assert!(out.contains("\"id\":\"b\""));
    }

    #[test]
    fn all_decision_events_flattens_day_buckets_in_order() {
        let out = compute_all_decision_events(&AllDecisionEventsInput {
            day_events: vec![
                vec![serde_json::json!({"proposal_id":"p1"})],
                vec![serde_json::json!({"proposal_id":"p2"})],
            ],
        });
        assert_eq!(out.events.len(), 2);
        assert_eq!(
            out.events[0]
                .get("proposal_id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "p1"
        );
        assert_eq!(
            out.events[1]
                .get("proposal_id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "p2"
        );
    }

    #[test]
    fn autoscale_json_all_decision_events_path_works() {
        let payload = serde_json::json!({
            "mode": "all_decision_events",
            "all_decision_events_input": {
                "day_events": [
                    [{"proposal_id":"p1"}],
                    [{"proposal_id":"p2"}]
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale all_decision_events");
        assert!(out.contains("\"mode\":\"all_decision_events\""));
        assert!(out.contains("\"proposal_id\":\"p1\""));
        assert!(out.contains("\"proposal_id\":\"p2\""));
    }

    #[test]
    fn cooldown_active_state_matches_threshold_behavior() {
        let active = compute_cooldown_active_state(&CooldownActiveStateInput {
            until_ms: Some(1100.0),
            now_ms: Some(1000.0),
        });
        assert!(active.active);
        assert!(!active.expired);

        let boundary = compute_cooldown_active_state(&CooldownActiveStateInput {
            until_ms: Some(1000.0),
            now_ms: Some(1000.0),
        });
        assert!(boundary.active);
        assert!(!boundary.expired);

        let expired = compute_cooldown_active_state(&CooldownActiveStateInput {
            until_ms: Some(999.0),
            now_ms: Some(1000.0),
        });
        assert!(!expired.active);
        assert!(expired.expired);
    }

    #[test]
    fn autoscale_json_cooldown_active_state_path_works() {
        let payload = serde_json::json!({
            "mode": "cooldown_active_state",
            "cooldown_active_state_input": {
                "until_ms": 1200,
                "now_ms": 1000
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale cooldown_active_state");
        assert!(out.contains("\"mode\":\"cooldown_active_state\""));
        assert!(out.contains("\"active\":true"));
    }

    #[test]
    fn bump_count_increments_from_current() {
        let out = compute_bump_count(&BumpCountInput {
            current_count: Some(3.0),
        });
        assert_eq!(out.count, 4.0);
    }

    #[test]
    fn autoscale_json_bump_count_path_works() {
        let payload = serde_json::json!({
            "mode": "bump_count",
            "bump_count_input": {
                "current_count": 7
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale bump_count");
        assert!(out.contains("\"mode\":\"bump_count\""));
        assert!(out.contains("\"count\":8.0"));
    }

    #[test]
    fn lock_age_minutes_returns_none_for_invalid_and_minutes_for_valid_ts() {
        let invalid = compute_lock_age_minutes(&LockAgeMinutesInput {
            lock_ts: Some("bad-ts".to_string()),
            now_ms: Some(1_000_000.0),
        });
        assert!(invalid.age_minutes.is_none());

        let valid = compute_lock_age_minutes(&LockAgeMinutesInput {
            lock_ts: Some("2026-03-04T00:00:00.000Z".to_string()),
            now_ms: Some(
                chrono::DateTime::parse_from_rfc3339("2026-03-04T01:00:00.000Z")
                    .unwrap()
                    .timestamp_millis() as f64,
            ),
        });
        assert!(valid.age_minutes.is_some());
        assert!((valid.age_minutes.unwrap_or(0.0) - 60.0).abs() < 1e-6);
    }

    #[test]
    fn autoscale_json_lock_age_minutes_path_works() {
        let payload = serde_json::json!({
            "mode": "lock_age_minutes",
            "lock_age_minutes_input": {
                "lock_ts": "2026-03-04T00:00:00.000Z",
                "now_ms": chrono::DateTime::parse_from_rfc3339("2026-03-04T00:30:00.000Z").unwrap().timestamp_millis()
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale lock_age_minutes");
        assert!(out.contains("\"mode\":\"lock_age_minutes\""));
        assert!(out.contains("\"age_minutes\":30.0"));
    }

    #[test]
    fn hash_obj_hashes_json_payload_and_returns_none_when_missing() {
        let missing = compute_hash_obj(&HashObjInput { json: None });
        assert!(missing.hash.is_none());

        let out = compute_hash_obj(&HashObjInput {
            json: Some("{\"a\":1}".to_string()),
        });
        assert!(out.hash.is_some());
        assert_eq!(
            out.hash.unwrap_or_default(),
            "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
        );
    }

    #[test]
    fn autoscale_json_hash_obj_path_works() {
        let payload = serde_json::json!({
            "mode": "hash_obj",
            "hash_obj_input": {
                "json": "{\"x\":2}"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale hash_obj");
        assert!(out.contains("\"mode\":\"hash_obj\""));
        assert!(out.contains("\"hash\":\""));
    }

    #[test]
    fn assess_success_criteria_quality_flags_unknown_and_unsupported() {
        let out = compute_assess_success_criteria_quality(&AssessSuccessCriteriaQualityInput {
            checks: vec![
                AssessSuccessCriteriaQualityCheckInput {
                    evaluated: false,
                    reason: Some("unsupported_metric".to_string()),
                },
                AssessSuccessCriteriaQualityCheckInput {
                    evaluated: false,
                    reason: Some("artifact_delta_unavailable".to_string()),
                },
                AssessSuccessCriteriaQualityCheckInput {
                    evaluated: true,
                    reason: Some("ok".to_string()),
                },
            ],
            total_count: 3.0,
            unknown_count: 2.0,
            synthesized: true,
        });
        assert!(out.insufficient);
        assert!(out.reasons.contains(&"synthesized_criteria".to_string()));
        assert_eq!(out.unknown_exempt_count, 1.0);
        assert_eq!(out.unknown_count, 1.0);
        assert_eq!(out.unsupported_count, 1.0);
    }

    #[test]
    fn autoscale_json_assess_success_criteria_quality_path_works() {
        let payload = serde_json::json!({
            "mode": "assess_success_criteria_quality",
            "assess_success_criteria_quality_input": {
                "checks": [
                    {"evaluated": false, "reason": "unsupported_metric"},
                    {"evaluated": true, "reason": "ok"}
                ],
                "total_count": 2,
                "unknown_count": 1,
                "synthesized": false
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale assess_success_criteria_quality");
        assert!(out.contains("\"mode\":\"assess_success_criteria_quality\""));
        assert!(out.contains("\"insufficient\":false") || out.contains("\"insufficient\":true"));
    }

    #[test]
    fn manual_gate_prefilter_blocks_when_rate_exceeded() {
        let out = compute_manual_gate_prefilter(&ManualGatePrefilterInput {
            enabled: true,
            capability_key: Some("deploy".to_string()),
            window_hours: 24.0,
            min_observations: 3.0,
            max_manual_block_rate: 0.4,
            row_present: true,
            attempts: 10.0,
            manual_blocked: 5.0,
            manual_block_rate: 0.5,
        });
        assert!(out.applicable);
        assert!(!out.pass);
        assert_eq!(out.reason, "manual_gate_rate_exceeded");
    }

    #[test]
    fn autoscale_json_manual_gate_prefilter_path_works() {
        let payload = serde_json::json!({
            "mode": "manual_gate_prefilter",
            "manual_gate_prefilter_input": {
                "enabled": true,
                "capability_key": "deploy",
                "window_hours": 24,
                "min_observations": 3,
                "max_manual_block_rate": 0.4,
                "row_present": true,
                "attempts": 4,
                "manual_blocked": 1,
                "manual_block_rate": 0.25
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale manual_gate_prefilter");
        assert!(out.contains("\"mode\":\"manual_gate_prefilter\""));
    }

    #[test]
    fn execute_confidence_cooldown_active_requires_key_and_active_state() {
        let out =
            compute_execute_confidence_cooldown_active(&ExecuteConfidenceCooldownActiveInput {
                cooldown_key: Some("exec:cooldown:key".to_string()),
                cooldown_active: true,
            });
        assert!(out.active);
        let out =
            compute_execute_confidence_cooldown_active(&ExecuteConfidenceCooldownActiveInput {
                cooldown_key: Some("".to_string()),
                cooldown_active: true,
            });
        assert!(!out.active);
    }

    #[test]
    fn autoscale_json_execute_confidence_cooldown_active_path_works() {
        let payload = serde_json::json!({
            "mode": "execute_confidence_cooldown_active",
            "execute_confidence_cooldown_active_input": {
                "cooldown_key": "exec:cooldown:key",
                "cooldown_active": true
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale execute_confidence_cooldown_active");
        assert!(out.contains("\"mode\":\"execute_confidence_cooldown_active\""));
    }

    #[test]
    fn top_biases_summary_sorts_by_abs_bias_then_total() {
        let out = compute_top_biases_summary(&TopBiasesSummaryInput {
            entries: vec![
                TopBiasSummaryEntryInput {
                    key: Some("a".to_string()),
                    bias: 2.0,
                    total: 10.0,
                    shipped: 3.0,
                    no_change: 4.0,
                    reverted: 3.0,
                },
                TopBiasSummaryEntryInput {
                    key: Some("b".to_string()),
                    bias: -5.0,
                    total: 2.0,
                    shipped: 1.0,
                    no_change: 1.0,
                    reverted: 0.0,
                },
            ],
            limit: 2,
        });
        assert_eq!(out.rows.len(), 2);
        assert_eq!(out.rows[0].key, "b");
    }

    #[test]
    fn autoscale_json_top_biases_summary_path_works() {
        let payload = serde_json::json!({
            "mode": "top_biases_summary",
            "top_biases_summary_input": {
                "entries": [
                    {"key":"x","bias":3,"total":5,"shipped":2,"no_change":2,"reverted":1},
                    {"key":"y","bias":1,"total":8,"shipped":4,"no_change":3,"reverted":1}
                ],
                "limit": 1
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale top_biases_summary");
        assert!(out.contains("\"mode\":\"top_biases_summary\""));
    }

    #[test]
    fn criteria_pattern_penalty_accumulates_hits() {
        let out = compute_criteria_pattern_penalty(&CriteriaPatternPenaltyInput {
            keys: vec!["cap|metric".to_string()],
            patterns: vec![CriteriaPatternPenaltyPatternInput {
                key: "cap|metric".to_string(),
                failures: 4.0,
                passes: 0.0,
                last_failure_ts: Some("2026-03-04T00:00:00.000Z".to_string()),
            }],
            fail_threshold: 2.0,
            penalty_per_hit: 3.0,
            max_penalty: 20.0,
            window_days: 365.0,
            now_ms: chrono::DateTime::parse_from_rfc3339("2026-03-04T06:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc)
                .timestamp_millis() as f64,
        });
        assert_eq!(out.penalty, 9.0);
        assert_eq!(out.hit_patterns.len(), 1);
    }

    #[test]
    fn autoscale_json_criteria_pattern_penalty_path_works() {
        let payload = serde_json::json!({
            "mode": "criteria_pattern_penalty",
            "criteria_pattern_penalty_input": {
                "keys": ["cap|metric"],
                "patterns": [{"key":"cap|metric","failures":4,"passes":1,"last_failure_ts":"2026-03-04T00:00:00.000Z"}],
                "fail_threshold": 2,
                "penalty_per_hit": 3,
                "max_penalty": 20,
                "window_days": 365,
                "now_ms": 1772600000000.0
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale criteria_pattern_penalty");
        assert!(out.contains("\"mode\":\"criteria_pattern_penalty\""));
    }

    #[test]
    fn strategy_threshold_overrides_prefers_override_values() {
        let out = compute_strategy_threshold_overrides(&StrategyThresholdOverridesInput {
            min_signal_quality: Some(55.0),
            min_sensory_signal_score: Some(60.0),
            min_sensory_relevance_score: Some(62.0),
            min_directive_fit: Some(45.0),
            min_actionability_score: Some(50.0),
            min_eye_score_ema: Some(48.0),
            override_min_signal_quality: Some(70.0),
            override_min_sensory_signal_score: None,
            override_min_sensory_relevance_score: None,
            override_min_directive_fit: Some(52.0),
            override_min_actionability_score: None,
            override_min_eye_score_ema: None,
        });
        assert_eq!(out.min_signal_quality, 70.0);
        assert_eq!(out.min_directive_fit, 52.0);
        assert_eq!(out.min_sensory_signal_score, 60.0);
    }

    #[test]
    fn autoscale_json_strategy_threshold_overrides_path_works() {
        let payload = serde_json::json!({
            "mode": "strategy_threshold_overrides",
            "strategy_threshold_overrides_input": {
                "min_signal_quality": 55,
                "min_sensory_signal_score": 60,
                "min_sensory_relevance_score": 62,
                "min_directive_fit": 45,
                "min_actionability_score": 50,
                "min_eye_score_ema": 48,
                "override_min_signal_quality": 70
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale strategy_threshold_overrides");
        assert!(out.contains("\"mode\":\"strategy_threshold_overrides\""));
    }

    #[test]
    fn effective_allowed_risks_prefers_strategy_list() {
        let out = compute_effective_allowed_risks(&EffectiveAllowedRisksInput {
            default_risks: vec!["low".to_string(), "medium".to_string()],
            strategy_allowed_risks: vec!["high".to_string()],
        });
        assert_eq!(out.risks, vec!["high".to_string()]);
    }

    #[test]
    fn autoscale_json_effective_allowed_risks_path_works() {
        let payload = serde_json::json!({
            "mode": "effective_allowed_risks",
            "effective_allowed_risks_input": {
                "default_risks": ["low","medium"],
                "strategy_allowed_risks": ["high"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale effective_allowed_risks");
        assert!(out.contains("\"mode\":\"effective_allowed_risks\""));
    }

    #[test]
    fn directive_pulse_context_clamps_and_normalizes_fields() {
        let out = compute_directive_pulse_context(&DirectivePulseContextInput {
            enabled: true,
            available: true,
            objectives: vec![serde_json::json!({"id":"t1","tier":1})],
            error: Some("  ".to_string()),
            window_days: 99.0,
            urgency_hours: -1.0,
            no_progress_limit: 0.0,
            cooldown_hours: 300.0,
            tier_attempts_today: std::collections::BTreeMap::from([
                ("1".to_string(), 2.0),
                ("2".to_string(), -1.0),
            ]),
            attempts_today: 4.2,
            objective_stats: vec![DirectivePulseContextObjectiveStatInput {
                objective_id: Some(" obj_a ".to_string()),
                tier: Some(1.0),
                attempts: Some(3.0),
                shipped: Some(1.0),
                no_change: Some(1.0),
                reverted: Some(1.0),
                no_progress_streak: Some(2.0),
                last_attempt_ts: Some(" 2026-03-04T00:00:00.000Z ".to_string()),
                last_shipped_ts: Some("".to_string()),
            }],
        });
        assert_eq!(out.window_days, 60.0);
        assert_eq!(out.urgency_hours, 1.0);
        assert_eq!(out.no_progress_limit, 1.0);
        assert_eq!(out.cooldown_hours, 168.0);
        assert_eq!(out.attempts_today, 4.0);
        assert_eq!(
            out.tier_attempts_today.get("1").copied().unwrap_or(0.0),
            2.0
        );
        assert_eq!(
            out.tier_attempts_today.get("2").copied().unwrap_or(0.0),
            0.0
        );
        assert!(out.error.is_none());
        assert_eq!(out.objective_stats.len(), 1);
        assert_eq!(out.objective_stats[0].objective_id, "obj_a");
        assert_eq!(
            out.objective_stats[0].last_attempt_ts.as_deref(),
            Some("2026-03-04T00:00:00.000Z")
        );
        assert_eq!(out.objective_stats[0].last_shipped_ts, None);
    }

    #[test]
    fn autoscale_json_directive_pulse_context_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_pulse_context",
            "directive_pulse_context_input": {
                "enabled": true,
                "available": true,
                "objectives": [{"id":"t1","tier":1}],
                "window_days": 14,
                "urgency_hours": 24,
                "no_progress_limit": 3,
                "cooldown_hours": 6,
                "tier_attempts_today": {"1": 1},
                "attempts_today": 1,
                "objective_stats": [
                    {
                        "objective_id": "obj_a",
                        "tier": 1,
                        "attempts": 1,
                        "shipped": 1,
                        "no_change": 0,
                        "reverted": 0,
                        "no_progress_streak": 0
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_pulse_context");
        assert!(out.contains("\"mode\":\"directive_pulse_context\""));
    }

    #[test]
    fn directive_pulse_stats_aggregates_attempts_and_outcomes() {
        let out = compute_directive_pulse_stats(&DirectivePulseStatsInput {
            date_str: Some("2026-03-04".to_string()),
            window_days: Some(14.0),
            events: vec![
                DirectivePulseStatsEventInput {
                    day: Some("2026-03-04".to_string()),
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("shipped".to_string()),
                    objective_id: Some("obj_a".to_string()),
                    tier: Some(1.0),
                    ts: Some("2026-03-04T01:00:00.000Z".to_string()),
                },
                DirectivePulseStatsEventInput {
                    day: Some("2026-03-04".to_string()),
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("no_change".to_string()),
                    objective_id: Some("obj_a".to_string()),
                    tier: Some(1.0),
                    ts: Some("2026-03-04T02:00:00.000Z".to_string()),
                },
                DirectivePulseStatsEventInput {
                    day: Some("2026-03-03".to_string()),
                    event_type: Some("autonomy_run".to_string()),
                    result: Some("executed".to_string()),
                    outcome: Some("reverted".to_string()),
                    objective_id: Some("obj_b".to_string()),
                    tier: Some(2.0),
                    ts: Some("2026-03-03T03:00:00.000Z".to_string()),
                },
            ],
        });
        assert_eq!(out.attempts_today, 2.0);
        assert_eq!(
            out.tier_attempts_today.get("1").copied().unwrap_or(0.0),
            2.0
        );
        assert_eq!(out.objective_stats.len(), 2);
        let a = out
            .objective_stats
            .iter()
            .find(|row| row.objective_id == "obj_a")
            .expect("obj_a");
        assert_eq!(a.attempts, 2);
        assert_eq!(a.shipped, 1);
        assert_eq!(a.no_change, 1);
        assert_eq!(a.reverted, 0);
    }

    #[test]
    fn autoscale_json_directive_pulse_stats_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_pulse_stats",
            "directive_pulse_stats_input": {
                "date_str": "2026-03-04",
                "window_days": 14,
                "events": [
                    {
                        "day": "2026-03-04",
                        "event_type": "autonomy_run",
                        "result": "executed",
                        "outcome": "shipped",
                        "objective_id": "obj_a",
                        "tier": 1,
                        "ts": "2026-03-04T01:00:00.000Z"
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale directive_pulse_stats");
        assert!(out.contains("\"mode\":\"directive_pulse_stats\""));
    }

    #[test]
    fn compile_directive_pulse_objectives_filters_and_derives_rows() {
        let out = compute_compile_directive_pulse_objectives(
            &CompileDirectivePulseObjectivesInput {
                directives: vec![
                    serde_json::json!({
                        "id": "T0_FOUNDATION",
                        "data": {
                            "metadata": { "id": "T0_FOUNDATION", "description": "ignore me", "tier": 1 }
                        }
                    }),
                    serde_json::json!({
                        "id": "T1_MEMORY",
                        "tier": 1,
                        "data": {
                            "metadata": {
                                "id": "T1_MEMORY",
                                "description": "Improve memory durability and recall quality",
                                "value_currency": "quality"
                            },
                            "intent": {
                                "primary": "Improve memory durability",
                                "value_currency": "time_savings"
                            },
                            "scope": {
                                "included": ["durability guardrails", "recall quality"]
                            },
                            "success_metrics": {
                                "leading": ["reduced regressions"],
                                "lagging": ["higher recall score"]
                            }
                        }
                    }),
                ],
                stopwords: vec!["the".to_string(), "and".to_string()],
                allowed_value_keys: vec![
                    "revenue".to_string(),
                    "delivery".to_string(),
                    "user_value".to_string(),
                    "quality".to_string(),
                    "time_savings".to_string(),
                    "learning".to_string(),
                ],
                t1_min_share: Some(0.5),
                t2_min_share: Some(0.25),
            },
        );
        assert_eq!(out.objectives.len(), 1);
        let row = &out.objectives[0];
        assert_eq!(row.id, "T1_MEMORY");
        assert_eq!(row.tier, 1);
        assert!(!row.phrases.is_empty());
        assert!(!row.tokens.is_empty());
        assert_eq!(row.primary_currency.as_deref(), Some("quality"));
    }

    #[test]
    fn autoscale_json_compile_directive_pulse_objectives_path_works() {
        let payload = serde_json::json!({
            "mode": "compile_directive_pulse_objectives",
            "compile_directive_pulse_objectives_input": {
                "directives": [
                    {
                        "id": "T1_MEMORY",
                        "tier": 1,
                        "data": {
                            "metadata": { "id": "T1_MEMORY", "description": "memory durability" },
                            "intent": { "primary": "Improve memory durability" }
                        }
                    }
                ],
                "stopwords": ["the", "and"],
                "allowed_value_keys": ["quality", "time_savings", "learning", "user_value", "delivery", "revenue"],
                "t1_min_share": 0.5,
                "t2_min_share": 0.25
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale compile_directive_pulse_objectives");
        assert!(out.contains("\"mode\":\"compile_directive_pulse_objectives\""));
    }

    #[test]
    fn directive_pulse_objectives_profile_handles_disabled_and_error() {
        let disabled =
            compute_directive_pulse_objectives_profile(&DirectivePulseObjectivesProfileInput {
                enabled: false,
                load_error: None,
                objectives: vec![],
            });
        assert!(!disabled.enabled);
        assert!(!disabled.available);
        assert_eq!(disabled.error.as_deref(), Some("directive_pulse_disabled"));

        let errored =
            compute_directive_pulse_objectives_profile(&DirectivePulseObjectivesProfileInput {
                enabled: true,
                load_error: Some(" boom ".to_string()),
                objectives: vec![serde_json::json!({"id":"T1"})],
            });
        assert!(errored.enabled);
        assert!(!errored.available);
        assert_eq!(errored.objectives.len(), 0);
        assert_eq!(errored.error.as_deref(), Some("boom"));
    }

    #[test]
    fn autoscale_json_directive_pulse_objectives_profile_path_works() {
        let payload = serde_json::json!({
            "mode": "directive_pulse_objectives_profile",
            "directive_pulse_objectives_profile_input": {
                "enabled": true,
                "load_error": null,
                "objectives": [{"id":"T1_MEMORY"}]
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale directive_pulse_objectives_profile");
        assert!(out.contains("\"mode\":\"directive_pulse_objectives_profile\""));
    }

    #[test]
    fn recent_directive_pulse_cooldown_count_matches_objective_and_window() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-03-04T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc)
            .timestamp_millis() as f64;
        let out = compute_recent_directive_pulse_cooldown_count(
            &RecentDirectivePulseCooldownCountInput {
                objective_id: Some("OBJ-1".to_string()),
                hours: Some(24.0),
                now_ms: Some(now_ms),
                events: vec![
                    RecentDirectivePulseCooldownEventInput {
                        event_type: Some("autonomy_run".to_string()),
                        result: Some("stop_repeat_gate_directive_pulse_cooldown".to_string()),
                        ts: Some("2026-03-04T10:00:00.000Z".to_string()),
                        objective_id: Some("OBJ-1".to_string()),
                        sample_objective_id: None,
                    },
                    RecentDirectivePulseCooldownEventInput {
                        event_type: Some("autonomy_run".to_string()),
                        result: Some("stop_repeat_gate_directive_pulse_cooldown".to_string()),
                        ts: Some("2026-03-03T08:00:00.000Z".to_string()),
                        objective_id: Some("OBJ-1".to_string()),
                        sample_objective_id: None,
                    },
                    RecentDirectivePulseCooldownEventInput {
                        event_type: Some("autonomy_run".to_string()),
                        result: Some("stop_repeat_gate_directive_pulse_cooldown".to_string()),
                        ts: Some("2026-03-04T11:00:00.000Z".to_string()),
                        objective_id: Some("OBJ-2".to_string()),
                        sample_objective_id: None,
                    },
                ],
            },
        );
        assert_eq!(out.count, 1);
    }

    #[test]
    fn autoscale_json_recent_directive_pulse_cooldown_count_path_works() {
        let payload = serde_json::json!({
            "mode": "recent_directive_pulse_cooldown_count",
            "recent_directive_pulse_cooldown_count_input": {
                "objective_id": "OBJ-1",
                "hours": 24,
                "now_ms": 1772625600000.0,
                "events": [
                    {
                        "event_type": "autonomy_run",
                        "result": "stop_repeat_gate_directive_pulse_cooldown",
                        "ts": "2026-03-04T10:00:00.000Z",
                        "objective_id": "OBJ-1"
                    }
                ]
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale recent_directive_pulse_cooldown_count");
        assert!(out.contains("\"mode\":\"recent_directive_pulse_cooldown_count\""));
    }

    #[test]
    fn proposal_directive_text_matches_expected_normalization() {
        let out = compute_proposal_directive_text(&ProposalDirectiveTextInput {
            proposal: Some(serde_json::json!({
                "title": "Directive fit improve",
                "type": "directive_clarification",
                "summary": "Improve objective focus",
                "meta": {
                    "normalized_hint_tokens": ["memory", "durability"],
                    "topics": ["alignment", "metrics"]
                },
                "validation": ["one metric"],
                "evidence": [{"match":"directive", "evidence_ref":"eye:directive/1"}]
            })),
        });
        assert!(out.text.contains("directive"));
        assert!(out.text.contains("memory"));
        assert!(out.text.contains("alignment"));
    }

    #[test]
    fn autoscale_json_proposal_directive_text_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_directive_text",
            "proposal_directive_text_input": {
                "proposal": {
                    "title": "Directive fit improve",
                    "type": "directive_clarification",
                    "summary": "Improve objective focus"
                }
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_directive_text");
        assert!(out.contains("\"mode\":\"proposal_directive_text\""));
    }

    #[test]
    fn objective_ids_from_pulse_context_prefers_objectives_then_fallback() {
        let out = compute_objective_ids_from_pulse_context(&ObjectiveIdsFromPulseContextInput {
            objectives: vec![
                serde_json::json!({"id":"OBJ-A"}),
                serde_json::json!({"id":"OBJ-B"}),
                serde_json::json!({"id":"OBJ-A"}),
            ],
            fallback_enabled: true,
            fallback_ids: vec!["OBJ-C".to_string()],
        });
        assert_eq!(out.ids, vec!["OBJ-A".to_string(), "OBJ-B".to_string()]);

        let fallback =
            compute_objective_ids_from_pulse_context(&ObjectiveIdsFromPulseContextInput {
                objectives: vec![],
                fallback_enabled: true,
                fallback_ids: vec![
                    "OBJ-C".to_string(),
                    "OBJ-C".to_string(),
                    "OBJ-D".to_string(),
                ],
            });
        assert_eq!(fallback.ids, vec!["OBJ-C".to_string(), "OBJ-D".to_string()]);
    }

    #[test]
    fn autoscale_json_objective_ids_from_pulse_context_path_works() {
        let payload = serde_json::json!({
            "mode": "objective_ids_from_pulse_context",
            "objective_ids_from_pulse_context_input": {
                "objectives": [{"id":"OBJ-A"}, {"id":"OBJ-B"}],
                "fallback_enabled": true,
                "fallback_ids": ["OBJ-C"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale objective_ids_from_pulse_context");
        assert!(out.contains("\"mode\":\"objective_ids_from_pulse_context\""));
    }

    #[test]
    fn policy_hold_objective_context_prefers_candidate_then_dominant() {
        let out = compute_policy_hold_objective_context(&PolicyHoldObjectiveContextInput {
            candidate_objective_ids: vec![
                "T1_OBJ_A".to_string(),
                " T1_OBJ_A ".to_string(),
                "T2_OBJ_B".to_string(),
            ],
            pool_objective_ids: vec!["T3_OBJ_C".to_string()],
            dominant_objective_id: Some("T4_OBJ_Z".to_string()),
        });
        assert_eq!(out.objective_id.as_deref(), Some("T4_OBJ_Z"));
        assert_eq!(
            out.objective_source.as_deref(),
            Some("directive_pulse_dominant")
        );
        assert_eq!(
            out.objective_ids.unwrap_or_default(),
            vec!["T1_OBJ_A".to_string(), "T2_OBJ_B".to_string()]
        );
    }

    #[test]
    fn autoscale_json_policy_hold_objective_context_path_works() {
        let payload = serde_json::json!({
            "mode": "policy_hold_objective_context",
            "policy_hold_objective_context_input": {
                "candidate_objective_ids": ["OBJ_A"],
                "pool_objective_ids": ["OBJ_B"],
                "dominant_objective_id": "OBJ_A"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale policy_hold_objective_context");
        assert!(out.contains("\"mode\":\"policy_hold_objective_context\""));
    }

    #[test]
    fn proposal_semantic_objective_id_prefers_meta_then_command() {
        let out = compute_proposal_semantic_objective_id(&ProposalSemanticObjectiveIdInput {
            proposal: Some(serde_json::json!({
                "meta": {
                    "objective_id": "",
                    "directive_objective_id": "T1_PRIMARY",
                    "linked_objective_id": "T2_SECONDARY"
                },
                "suggested_next_command": "node x --id=T3_CMD"
            })),
        });
        assert_eq!(out.objective_id, "T1_PRIMARY");
    }

    #[test]
    fn autoscale_json_proposal_semantic_objective_id_path_works() {
        let payload = serde_json::json!({
            "mode": "proposal_semantic_objective_id",
            "proposal_semantic_objective_id_input": {
                "proposal": {
                    "meta": { "objective_id": "T1_OBJ" }
                }
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale proposal_semantic_objective_id");
        assert!(out.contains("\"mode\":\"proposal_semantic_objective_id\""));
    }

    #[test]
    fn criteria_pattern_keys_normalizes_and_sorts_unique() {
        let out = compute_criteria_pattern_keys(&CriteriaPatternKeysInput {
            capability_key_hint: Some("".to_string()),
            capability_descriptor_key: Some("actuation:run".to_string()),
            rows: vec![
                CriteriaPatternKeysRowInput {
                    metric: Some("latency_ms".to_string()),
                },
                CriteriaPatternKeysRowInput {
                    metric: Some("Latency Ms".to_string()),
                },
                CriteriaPatternKeysRowInput { metric: None },
            ],
        });
        assert_eq!(out.keys, vec!["actuation:run|latency_ms".to_string()]);
    }

    #[test]
    fn autoscale_json_criteria_pattern_keys_path_works() {
        let payload = serde_json::json!({
            "mode": "criteria_pattern_keys",
            "criteria_pattern_keys_input": {
                "capability_key_hint": "actuation:run",
                "rows": [{"metric":"latency_ms"}]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale criteria_pattern_keys");
        assert!(out.contains("\"mode\":\"criteria_pattern_keys\""));
    }

    #[test]
    fn success_criteria_requirement_merges_exempt_types() {
        let out = compute_success_criteria_requirement(&SuccessCriteriaRequirementInput {
            require_success_criteria: Some(true),
            min_success_criteria_count: Some(2.0),
            policy_exempt_types: vec!["directive_clarification".to_string()],
            env_exempt_types: vec![
                "directive_clarification".to_string(),
                "remediation".to_string(),
            ],
        });
        assert!(out.required);
        assert_eq!(out.min_count, 2.0);
        assert_eq!(
            out.exempt_types,
            vec![
                "directive_clarification".to_string(),
                "remediation".to_string()
            ]
        );
    }

    #[test]
    fn autoscale_json_success_criteria_requirement_path_works() {
        let payload = serde_json::json!({
            "mode": "success_criteria_requirement",
            "success_criteria_requirement_input": {
                "require_success_criteria": true,
                "min_success_criteria_count": 1,
                "policy_exempt_types": ["directive_clarification"],
                "env_exempt_types": ["remediation"]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale success_criteria_requirement");
        assert!(out.contains("\"mode\":\"success_criteria_requirement\""));
    }

    #[test]
    fn success_criteria_policy_for_proposal_applies_exemptions() {
        let out =
            compute_success_criteria_policy_for_proposal(&SuccessCriteriaPolicyForProposalInput {
                base_required: true,
                base_min_count: 1.0,
                base_exempt_types: vec!["directive_clarification".to_string()],
                proposal_type: Some("directive_clarification".to_string()),
            });
        assert!(!out.required);
        assert!(out.exempt);
        assert_eq!(out.min_count, 1.0);
    }

    #[test]
    fn autoscale_json_success_criteria_policy_for_proposal_path_works() {
        let payload = serde_json::json!({
            "mode": "success_criteria_policy_for_proposal",
            "success_criteria_policy_for_proposal_input": {
                "base_required": true,
                "base_min_count": 1,
                "base_exempt_types": ["directive_clarification"],
                "proposal_type": "directive_clarification"
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale success_criteria_policy_for_proposal");
        assert!(out.contains("\"mode\":\"success_criteria_policy_for_proposal\""));
    }

    #[test]
    fn capability_descriptor_prefers_actuation_kind() {
        let out = compute_capability_descriptor(&CapabilityDescriptorInput {
            actuation_kind: Some("route_execute".to_string()),
            proposal_type: Some("optimization".to_string()),
        });
        assert_eq!(out.key, "actuation:route_execute");
        assert_eq!(out.aliases, vec!["actuation".to_string()]);
    }

    #[test]
    fn autoscale_json_capability_descriptor_path_works() {
        let payload = serde_json::json!({
            "mode": "capability_descriptor",
            "capability_descriptor_input": {
                "actuation_kind": null,
                "proposal_type": "optimization"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale capability_descriptor");
        assert!(out.contains("\"mode\":\"capability_descriptor\""));
    }

    #[test]
    fn normalize_token_usage_shape_uses_fallback_fields() {
        let out = compute_normalize_token_usage_shape(&NormalizeTokenUsageShapeInput {
            prompt_tokens: None,
            input_tokens: Some(11.0),
            completion_tokens: None,
            output_tokens: Some(5.0),
            total_tokens: None,
            tokens_used: None,
            source: Some("route_execute_metrics".to_string()),
        });
        assert!(out.has_value);
        let usage = out.usage.expect("usage");
        assert_eq!(usage.prompt_tokens, Some(11.0));
        assert_eq!(usage.completion_tokens, Some(5.0));
        assert_eq!(usage.total_tokens, Some(16.0));
    }

    #[test]
    fn autoscale_json_normalize_token_usage_shape_path_works() {
        let payload = serde_json::json!({
            "mode": "normalize_token_usage_shape",
            "normalize_token_usage_shape_input": {
                "prompt_tokens": 10,
                "completion_tokens": 4,
                "source": "route_execute_metrics"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale normalize_token_usage_shape");
        assert!(out.contains("\"mode\":\"normalize_token_usage_shape\""));
    }

    #[test]
    fn default_backlog_autoscale_state_uses_input_module() {
        let out = compute_default_backlog_autoscale_state(&DefaultBacklogAutoscaleStateInput {
            module: "autonomy_spawn".to_string(),
        });
        assert_eq!(out.schema_id, "autonomy_backlog_autoscale");
        assert_eq!(out.schema_version, "1.0.0");
        assert_eq!(out.module, "autonomy_spawn");
        assert_eq!(out.current_cells, 0.0);
        assert_eq!(out.target_cells, 0.0);
        assert_eq!(out.last_run_ts, None);
    }

    #[test]
    fn autoscale_json_default_backlog_autoscale_state_path_works() {
        let payload = serde_json::json!({
            "mode": "default_backlog_autoscale_state",
            "default_backlog_autoscale_state_input": {
                "module": "autonomy_backlog_autoscale"
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale default_backlog_autoscale_state");
        assert!(out.contains("\"mode\":\"default_backlog_autoscale_state\""));
    }

    #[test]
    fn normalize_backlog_autoscale_state_normalizes_cells_and_strings() {
        let out = compute_normalize_backlog_autoscale_state(&NormalizeBacklogAutoscaleStateInput {
            module: "autonomy_backlog_autoscale".to_string(),
            src: Some(serde_json::json!({
                "module": " autonomy_backlog_autoscale ",
                "current_cells": 2.8,
                "target_cells": "5",
                "last_run_ts": " 2026-03-04T00:00:00.000Z ",
                "last_high_pressure_ts": "",
                "last_action": " scale_up ",
                "updated_at": null
            })),
        });
        assert_eq!(out.module, "autonomy_backlog_autoscale");
        assert_eq!(out.current_cells, 2.8);
        assert_eq!(out.target_cells, 5.0);
        assert_eq!(
            out.last_run_ts,
            Some("2026-03-04T00:00:00.000Z".to_string())
        );
        assert_eq!(out.last_high_pressure_ts, None);
        assert_eq!(out.last_action, Some("scale_up".to_string()));
        assert_eq!(out.updated_at, None);
    }

    #[test]
    fn autoscale_json_normalize_backlog_autoscale_state_path_works() {
        let payload = serde_json::json!({
            "mode": "normalize_backlog_autoscale_state",
            "normalize_backlog_autoscale_state_input": {
                "module": "autonomy_backlog_autoscale",
                "src": {
                    "current_cells": 1,
                    "target_cells": 3
                }
            }
        })
        .to_string();
        let out =
            run_autoscale_json(&payload).expect("autoscale normalize_backlog_autoscale_state");
        assert!(out.contains("\"mode\":\"normalize_backlog_autoscale_state\""));
    }

    #[test]
    fn spawn_allocated_cells_prefers_active_then_current_then_allocated() {
        let out = compute_spawn_allocated_cells(&SpawnAllocatedCellsInput {
            active_cells: Some(4.2),
            current_cells: Some(7.0),
            allocated_cells: Some(9.0),
        });
        assert_eq!(out.active_cells, Some(4));
        let out = compute_spawn_allocated_cells(&SpawnAllocatedCellsInput {
            active_cells: None,
            current_cells: Some(7.8),
            allocated_cells: Some(9.0),
        });
        assert_eq!(out.active_cells, Some(7));
        let out = compute_spawn_allocated_cells(&SpawnAllocatedCellsInput {
            active_cells: None,
            current_cells: None,
            allocated_cells: Some(2.0),
        });
        assert_eq!(out.active_cells, Some(2));
    }

    #[test]
    fn autoscale_json_spawn_allocated_cells_path_works() {
        let payload = serde_json::json!({
            "mode": "spawn_allocated_cells",
            "spawn_allocated_cells_input": {
                "active_cells": null,
                "current_cells": 3.4,
                "allocated_cells": 8
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale spawn_allocated_cells");
        assert!(out.contains("\"mode\":\"spawn_allocated_cells\""));
    }

    #[test]
    fn spawn_capacity_boost_snapshot_counts_recent_spawn_grants() {
        let out = compute_spawn_capacity_boost_snapshot(&SpawnCapacityBoostSnapshotInput {
            enabled: true,
            lookback_minutes: 30.0,
            min_granted_cells: 1.0,
            now_ms: 1_700_000_000_000.0,
            rows: vec![
                SpawnCapacityBoostRowInput {
                    r#type: Some("spawn_request".to_string()),
                    ts: Some("2023-11-14T22:13:20.000Z".to_string()),
                    granted_cells: Some(2.0),
                },
                SpawnCapacityBoostRowInput {
                    r#type: Some("spawn_request".to_string()),
                    ts: Some("2023-11-14T22:12:20.000Z".to_string()),
                    granted_cells: Some(1.0),
                },
            ],
        });
        assert!(out.active);
        assert_eq!(out.grant_count, 2);
        assert_eq!(out.granted_cells, 3.0);
        assert_eq!(out.latest_ts, Some("2023-11-14T22:12:20.000Z".to_string()));
    }

    #[test]
    fn autoscale_json_spawn_capacity_boost_snapshot_path_works() {
        let payload = serde_json::json!({
            "mode": "spawn_capacity_boost_snapshot",
            "spawn_capacity_boost_snapshot_input": {
                "enabled": true,
                "lookback_minutes": 30,
                "min_granted_cells": 1,
                "now_ms": 1700000000000i64,
                "rows": [
                    {
                        "type": "spawn_request",
                        "ts": "2023-11-14T22:13:20.000Z",
                        "granted_cells": 1
                    }
                ]
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale spawn_capacity_boost_snapshot");
        assert!(out.contains("\"mode\":\"spawn_capacity_boost_snapshot\""));
    }

    #[test]
    fn inversion_maturity_score_matches_expected_banding() {
        let out = compute_inversion_maturity_score(&InversionMaturityScoreInput {
            total_tests: 40.0,
            passed_tests: 32.0,
            destructive_failures: 1.0,
            target_test_count: 40.0,
            weight_pass_rate: 0.5,
            weight_non_destructive_rate: 0.3,
            weight_experience: 0.2,
            band_novice: 0.25,
            band_developing: 0.45,
            band_mature: 0.65,
            band_seasoned: 0.82,
        });
        assert_eq!(out.band, "legendary");
        assert!(out.score >= 0.82);
        assert!(out.pass_rate >= 0.8 && out.pass_rate <= 0.81);
        assert!(out.non_destructive_rate >= 0.97 && out.non_destructive_rate <= 0.98);
    }

    #[test]
    fn autoscale_json_inversion_maturity_score_path_works() {
        let payload = serde_json::json!({
            "mode": "inversion_maturity_score",
            "inversion_maturity_score_input": {
                "total_tests": 10,
                "passed_tests": 6,
                "destructive_failures": 1,
                "target_test_count": 40,
                "weight_pass_rate": 0.5,
                "weight_non_destructive_rate": 0.3,
                "weight_experience": 0.2,
                "band_novice": 0.25,
                "band_developing": 0.45,
                "band_mature": 0.65,
                "band_seasoned": 0.82
            }
        })
        .to_string();
        let out = run_autoscale_json(&payload).expect("autoscale inversion_maturity_score");
        assert!(out.contains("\"mode\":\"inversion_maturity_score\""));
    }

    fn extract_mode_literals(text: &str, call_name: &str) -> std::collections::BTreeSet<String> {
        let pattern = format!(
            r#"{}\s*\(\s*['"`]([^'"`]+)['"`]"#,
            regex::escape(call_name)
        );
        let re = Regex::new(&pattern).expect("valid call regex");
        let static_mode_re =
            Regex::new(r"^[a-zA-Z0-9_-]+$").expect("valid static mode token regex");
        let block_comment_re = Regex::new(r"(?s)/\*.*?\*/").expect("valid block comment regex");
        let line_comment_re = Regex::new(r"(?m)//.*$").expect("valid line comment regex");
        let without_block = block_comment_re.replace_all(text, "");
        let cleaned = line_comment_re.replace_all(&without_block, "");
        re.captures_iter(cleaned.as_ref())
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string()))
            .filter(|mode| !mode.is_empty() && static_mode_re.is_match(mode))
            .collect()
    }

    fn extract_bridge_modes(text: &str, fn_name: &str) -> std::collections::BTreeSet<String> {
        let section_re = Regex::new(&format!(
            r#"(?s)function {}\s*\([^)]*\)\s*\{{.*?const fieldByMode:\s*AnyObj\s*=\s*\{{(.*?)\}}\s*(?:;|\r?\n)?"#,
            regex::escape(fn_name)
        ))
        .expect("valid section regex");
        let keys_re = Regex::new(r#"(?m)^\s*(?:([a-zA-Z0-9_]+)|['"]([^'"]+)['"])\s*:"#)
            .expect("valid key regex");
        let Some(section) = section_re
            .captures(text)
            .and_then(|cap| cap.get(1).map(|m| m.as_str()))
        else {
            return std::collections::BTreeSet::new();
        };
        keys_re
            .captures_iter(section)
            .filter_map(|cap| {
                cap.get(1)
                    .or_else(|| cap.get(2))
                    .map(|m| m.as_str().trim().to_string())
            })
            .filter(|key| !key.is_empty())
            .collect()
    }

    fn extract_dispatch_modes(text: &str) -> std::collections::BTreeSet<String> {
        let re =
            Regex::new(r#"(?m)^\s*(?:if|else if) mode == "([^"]+)""#).expect("valid dispatch regex");
        let block_comment_re = Regex::new(r"(?s)/\*.*?\*/").expect("valid block comment regex");
        let line_comment_re = Regex::new(r"(?m)//.*$").expect("valid line comment regex");
        let without_block = block_comment_re.replace_all(text, "");
        let cleaned = line_comment_re.replace_all(&without_block, "");
        re.captures_iter(cleaned.as_ref())
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string()))
            .filter(|mode| !mode.is_empty())
            .collect()
    }

    #[test]
    fn extract_mode_literals_accepts_all_quote_styles() {
        let text = r#"
const a = runBacklogAutoscalePrimitive("alpha", {});
const b = runBacklogAutoscalePrimitive('beta', {});
const c = runBacklogAutoscalePrimitive(`gamma`, {});
"#;
        let parsed = extract_mode_literals(text, "runBacklogAutoscalePrimitive");
        let expected = ["alpha", "beta", "gamma"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_bridge_modes_accepts_quoted_and_unquoted_keys() {
        let bridge = r#"
function runBacklogAutoscalePrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const fieldByMode: AnyObj = {
    alpha: "payload_alpha",
    "beta-mode": "payload_beta",
    'gamma_mode': "payload_gamma"
  };
}
"#;
        let parsed = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        let expected = ["alpha", "beta-mode", "gamma_mode"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_bridge_modes_allows_non_string_values() {
        let bridge = r#"
function runBacklogAutoscalePrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const fieldByMode: AnyObj = {
    alpha: payloadAlpha,
    "beta-mode": payloadBeta,
    'gamma_mode': payloadGamma
  };
}
"#;
        let parsed = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        let expected = ["alpha", "beta-mode", "gamma_mode"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_bridge_modes_selects_requested_function_section() {
        let bridge = r#"
function runBacklogAutoscalePrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const fieldByMode: AnyObj = {
    alpha: "payload_alpha"
  };
}
function runOtherPrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const fieldByMode: AnyObj = {
    rogue: "payload_rogue"
  };
}
"#;
        let parsed_backlog = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        let expected_backlog = ["alpha"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed_backlog, expected_backlog);

        let parsed_other = extract_bridge_modes(bridge, "runOtherPrimitive");
        let expected_other = ["rogue"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed_other, expected_other);
    }

    #[test]
    fn extract_bridge_modes_allows_missing_trailing_semicolon() {
        let bridge = r#"
function runBacklogAutoscalePrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const fieldByMode: AnyObj = {
    alpha: "payload_alpha",
    beta: "payload_beta"
  }
}
"#;
        let parsed = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        let expected = ["alpha", "beta"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_bridge_modes_returns_empty_when_function_missing() {
        let bridge = r#"
function runOtherPrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {
  const fieldByMode: AnyObj = {
    rogue: "payload_rogue"
  };
}
"#;
        let parsed = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        assert!(parsed.is_empty());
    }

    #[test]
    fn extract_bridge_modes_supports_crlf_lines() {
        let bridge = "function runBacklogAutoscalePrimitive(mode: string, data: AnyObj = {}, opts: AnyObj = {}) {\r\n  const fieldByMode: AnyObj = {\r\n    alpha: \"payload_alpha\",\r\n    beta: \"payload_beta\"\r\n  }\r\n}\r\n";
        let parsed = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        let expected = ["alpha", "beta"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_mode_literals_ignores_dynamic_template_modes() {
        let text = r#"
const a = runBacklogAutoscalePrimitive("alpha", {});
const b = runBacklogAutoscalePrimitive(`beta_${suffix}`, {});
const c = runBacklogAutoscalePrimitive(modeName, {});
"#;
        let parsed = extract_mode_literals(text, "runBacklogAutoscalePrimitive");
        let expected = ["alpha"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_mode_literals_ignores_commented_calls() {
        let text = r#"
// runBacklogAutoscalePrimitive("ignored_line", {});
/* runBacklogAutoscalePrimitive("ignored_block", {}); */
const a = runBacklogAutoscalePrimitive(
  "alpha",
  {}
);
"#;
        let parsed = extract_mode_literals(text, "runBacklogAutoscalePrimitive");
        let expected = ["alpha"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_dispatch_modes_accepts_if_and_else_if() {
        let text = r#"
if mode == "alpha" {
}
else if mode == "beta" {
}
if another == "gamma" {
}
"#;
        let parsed = extract_dispatch_modes(text);
        let expected = ["alpha", "beta"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn extract_dispatch_modes_ignores_commented_branches() {
        let text = r#"
// if mode == "ignored_line" {
// }
/* else if mode == "ignored_block" {
} */
if mode == "alpha" {
}
"#;
        let parsed = extract_dispatch_modes(text);
        let expected = ["alpha"]
            .iter()
            .map(|value| value.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn bridge_maps_all_backlog_primitive_callsite_modes() {
        let ts_autonomy = include_str!("../../../systems/autonomy/autonomy_controller.ts");
        let ts_inversion = include_str!("../../../systems/autonomy/inversion_controller.ts");
        let bridge = include_str!("../../../systems/autonomy/backlog_autoscale_rust_bridge.ts");
        let mut called = extract_mode_literals(ts_autonomy, "runBacklogAutoscalePrimitive");
        called.extend(extract_mode_literals(
            ts_inversion,
            "runBacklogAutoscalePrimitive",
        ));
        assert!(
            !called.is_empty(),
            "expected runBacklogAutoscalePrimitive mode calls in controller TS sources"
        );
        let mapped = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        assert!(!mapped.is_empty(), "expected fieldByMode map in backlog_autoscale_rust_bridge.ts");

        let missing = called
            .difference(&mapped)
            .cloned()
            .collect::<Vec<_>>();
        assert!(
            missing.is_empty(),
            "controller TS sources use autoscale modes missing from Rust bridge map: {:?}",
            missing
        );
    }

    #[test]
    fn controller_callsite_modes_are_dispatched_by_rust_autoscale_json() {
        let ts_autonomy = include_str!("../../../systems/autonomy/autonomy_controller.ts");
        let ts_inversion = include_str!("../../../systems/autonomy/inversion_controller.ts");
        let rust_src = include_str!("autoscale.rs");
        let mut called = extract_mode_literals(ts_autonomy, "runBacklogAutoscalePrimitive");
        called.extend(extract_mode_literals(
            ts_inversion,
            "runBacklogAutoscalePrimitive",
        ));
        let dispatched = extract_dispatch_modes(rust_src);
        let missing = called
            .difference(&dispatched)
            .cloned()
            .collect::<Vec<_>>();
        assert!(
            missing.is_empty(),
            "controller TS sources use autoscale modes not dispatched by Rust autoscale_json: {:?}",
            missing
        );
    }

    #[test]
    fn rust_dispatch_covers_all_backlog_bridge_modes() {
        let bridge = include_str!("../../../systems/autonomy/backlog_autoscale_rust_bridge.ts");
        let rust_src = include_str!("autoscale.rs");
        let mapped = extract_bridge_modes(bridge, "runBacklogAutoscalePrimitive");
        let dispatched = extract_dispatch_modes(rust_src);
        let missing = mapped
            .difference(&dispatched)
            .cloned()
            .collect::<Vec<_>>();
        assert!(
            missing.is_empty(),
            "backlog bridge maps modes not dispatched by Rust autoscale_json: {:?}",
            missing
        );
    }
}
