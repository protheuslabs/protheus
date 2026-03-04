use chrono::{DateTime, Duration, NaiveDate, Utc};
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
