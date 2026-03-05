mod autoscale;
mod blob;
mod decompose;
mod inversion;
mod sprint_contract;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub use autoscale::{
    compute_attempt_run_event, compute_batch_max, compute_capacity_counted_attempt_event,
    compute_attempt_event_indices,
    compute_capacity_counted_attempt_indices,
    compute_consecutive_no_progress_runs,
    compute_consecutive_gate_exhausted_attempts,
    compute_executed_count_by_risk,
    compute_run_result_tally,
    compute_qos_lane_weights,
    compute_qos_lane_usage,
    compute_eye_outcome_count_window,
    compute_eye_outcome_count_last_hours,
    compute_sorted_counts,
    compute_normalize_proposal_status,
    compute_proposal_status,
    compute_proposal_outcome_status,
    compute_queue_underflow_backfill,
    compute_proposal_risk_score,
    compute_proposal_score,
    compute_impact_weight,
    compute_risk_penalty,
    compute_estimate_tokens,
    compute_proposal_remediation_depth,
    compute_proposal_dedup_key,
    compute_strategy_rank_score,
    compute_strategy_rank_adjusted,
    compute_trit_shadow_rank_score,
    compute_strategy_circuit_cooldown,
    compute_strategy_trit_shadow_adjusted,
    compute_non_yield_penalty_score,
    compute_collective_shadow_adjustments,
    compute_strategy_trit_shadow_ranking_summary,
    compute_shadow_scope_matches,
    compute_collective_shadow_aggregate,
    compute_value_signal_score,
    compute_composite_eligibility_score,
    compute_time_to_value_score,
    compute_value_density_score,
    compute_execution_reserve_snapshot,
    compute_qos_lane_share_cap_exceeded,
    compute_qos_lane_from_candidate,
    compute_estimate_tokens_for_candidate,
    compute_proposal_status_for_queue_pressure,
    compute_minutes_since_ts,
    compute_date_window,
    compute_in_window,
    compute_start_of_next_utc_day,
    compute_iso_after_minutes,
    compute_execute_confidence_history_match,
    compute_shipped_count,
    compute_criteria_gate, compute_dynamic_caps,
    compute_gate_exhausted_attempt,
    compute_no_progress_result, compute_non_yield_category, compute_normalize_queue, compute_plan,
    compute_policy_hold, compute_policy_hold_cooldown, compute_policy_hold_latest_event,
    compute_policy_hold_run_event,
    compute_non_yield_reason, compute_policy_hold_pattern, compute_policy_hold_pressure,
    compute_proposal_type_from_run_event,
    compute_repeat_gate_anchor,
    compute_score_only_failure_like,
    compute_score_only_result,
    compute_runs_since_reset_index,
    compute_run_event_objective_id,
    compute_run_event_proposal_id,
    compute_policy_hold_result, compute_receipt_verdict, compute_route_execution_policy_hold,
    compute_safety_stop_run_event, compute_token_usage, run_autoscale_json,
    AttemptEventIndexEventInput, AttemptEventIndicesInput, AttemptEventIndicesOutput,
    AttemptRunEventInput, AttemptRunEventOutput, BatchMaxInput, BatchMaxOutput,
    CapacityCountedAttemptIndexEventInput, CapacityCountedAttemptIndicesInput,
    CapacityCountedAttemptIndicesOutput,
    ConsecutiveNoProgressEventInput, ConsecutiveNoProgressRunsInput,
    ConsecutiveNoProgressRunsOutput,
    ShippedCountEventInput, ShippedCountInput, ShippedCountOutput,
    ExecutedCountByRiskEventInput, ExecutedCountByRiskInput, ExecutedCountByRiskOutput,
    RunResultTallyEventInput, RunResultTallyInput, RunResultTallyOutput,
    QosLaneWeightsInput, QosLaneWeightsOutput,
    QosLaneUsageEventInput, QosLaneUsageInput, QosLaneUsageOutput,
    EyeOutcomeEventInput, EyeOutcomeWindowCountInput, EyeOutcomeWindowCountOutput,
    EyeOutcomeLastHoursCountInput, EyeOutcomeLastHoursCountOutput,
    SortedCountItem, SortedCountsInput, SortedCountsOutput,
    NormalizeProposalStatusInput, NormalizeProposalStatusOutput,
    ProposalStatusInput, ProposalStatusOutput,
    ProposalOutcomeStatusInput, ProposalOutcomeStatusOutput,
    QueueUnderflowBackfillInput, QueueUnderflowBackfillOutput,
    ProposalRiskScoreInput, ProposalRiskScoreOutput,
    ProposalScoreInput, ProposalScoreOutput,
    ImpactWeightInput, ImpactWeightOutput,
    RiskPenaltyInput, RiskPenaltyOutput,
    EstimateTokensInput, EstimateTokensOutput,
    ProposalRemediationDepthInput, ProposalRemediationDepthOutput,
    ProposalDedupKeyInput, ProposalDedupKeyOutput,
    StrategyRankScoreInput, StrategyRankScoreOutput,
    StrategyRankAdjustedInput, StrategyRankAdjustedBonus, StrategyRankAdjustedOutput,
    TritShadowRankScoreInput, TritShadowRankScoreOutput,
    StrategyCircuitCooldownInput, StrategyCircuitCooldownOutput,
    StrategyTritShadowAdjustedInput, StrategyTritShadowAdjustedOutput,
    NonYieldPenaltyScoreInput, NonYieldPenaltyScoreOutput,
    CollectiveShadowAdjustmentsInput, CollectiveShadowAdjustmentsOutput,
    StrategyTritShadowRankRowInput, StrategyTritShadowRankingSummaryInput,
    StrategyTritShadowRankingSummaryOutput,
    ShadowScopeMatchesInput, ShadowScopeMatchesOutput,
    CollectiveShadowAggregateEntryInput, CollectiveShadowAggregateInput,
    CollectiveShadowAggregateOutput,
    ValueSignalScoreInput, ValueSignalScoreOutput,
    CompositeEligibilityScoreInput, CompositeEligibilityScoreOutput,
    TimeToValueScoreInput, TimeToValueScoreOutput,
    ValueDensityScoreInput, ValueDensityScoreOutput,
    ExecutionReserveSnapshotInput, ExecutionReserveSnapshotOutput,
    QosLaneShareCapExceededInput, QosLaneShareCapExceededOutput,
    QosLaneFromCandidateInput, QosLaneFromCandidateOutput,
    EstimateTokensForCandidateInput, EstimateTokensForCandidateOutput,
    ProposalStatusForQueuePressureInput, ProposalStatusForQueuePressureOutput,
    MinutesSinceTsInput, MinutesSinceTsOutput,
    DateWindowInput, DateWindowOutput,
    InWindowInput, InWindowOutput,
    StartOfNextUtcDayInput, StartOfNextUtcDayOutput,
    IsoAfterMinutesInput, IsoAfterMinutesOutput,
    ExecuteConfidenceHistoryMatchInput, ExecuteConfidenceHistoryMatchOutput,
    CapacityCountedAttemptEventInput, CapacityCountedAttemptEventOutput, CriteriaGateInput,
    ConsecutiveGateExhaustedAttemptEventInput, ConsecutiveGateExhaustedAttemptsInput,
    ConsecutiveGateExhaustedAttemptsOutput, CriteriaGateOutput, DynamicCapsInput,
    DynamicCapsOutput, NoProgressResultInput,
    NoProgressResultOutput, GateExhaustedAttemptInput, GateExhaustedAttemptOutput,
    NonYieldCategoryInput, NonYieldCategoryOutput, NonYieldReasonInput,
    NonYieldReasonOutput, NormalizeQueueInput, NormalizeQueueOutput, PlanInput, PlanOutput,
    ProposalTypeFromRunEventInput, ProposalTypeFromRunEventOutput,
    RepeatGateAnchorBindingOutput, RepeatGateAnchorInput, RepeatGateAnchorOutput,
    ScoreOnlyFailureLikeInput, ScoreOnlyFailureLikeOutput,
    ScoreOnlyResultInput, ScoreOnlyResultOutput,
    RunsSinceResetEventInput, RunsSinceResetIndexInput, RunsSinceResetIndexOutput,
    RunEventObjectiveIdInput, RunEventObjectiveIdOutput,
    RunEventProposalIdInput, RunEventProposalIdOutput,
    PolicyHoldCooldownInput, PolicyHoldCooldownOutput, PolicyHoldInput,
    PolicyHoldLatestEventEntryInput, PolicyHoldLatestEventInput, PolicyHoldLatestEventOutput,
    PolicyHoldOutput, PolicyHoldPatternEventInput, PolicyHoldPatternInput,
    PolicyHoldPatternOutput, PolicyHoldPressureEventInput, PolicyHoldPressureInput,
    PolicyHoldPressureOutput, PolicyHoldResultInput, PolicyHoldResultOutput,
    PolicyHoldRunEventInput, PolicyHoldRunEventOutput, QueuePressure,
    ReceiptCheck, ReceiptVerdictInput, ReceiptVerdictOutput, RouteExecutionPolicyHoldInput,
    SafetyStopRunEventInput, SafetyStopRunEventOutput, TokenUsageInput, TokenUsageOutput,
};
pub use blob::{
    decode_manifest, fold_blob, load_embedded_execution_profile, unfold_blob, BlobError,
    ExecutionRuntimeProfile, EXECUTION_PROFILE_BLOB_ID,
};
pub use decompose::{
    apply_governance, apply_governance_json, build_dispatch_rows, build_queue_rows,
    compose_micro_tasks, compose_micro_tasks_json, decompose_goal, decompose_goal_json,
    dispatch_rows_json, evaluate_directive_gate, evaluate_directive_gate_json,
    evaluate_heroic_gate, evaluate_heroic_gate_json, evaluate_route, evaluate_route_complexity,
    evaluate_route_complexity_json, evaluate_route_decision, evaluate_route_decision_json,
    evaluate_route_habit_readiness, evaluate_route_habit_readiness_json, evaluate_route_json,
    evaluate_route_match, evaluate_route_match_json, evaluate_route_primitives,
    evaluate_route_primitives_json, evaluate_route_reflex_match, evaluate_route_reflex_match_json,
    queue_rows_json, summarize_dispatch, summarize_dispatch_json, summarize_tasks,
    summarize_tasks_json, BaseTask, Capability, ComposePolicy, ComposeRequest, ComposeResponse,
    DecomposePolicy, DecomposeRequest, DecomposeResponse, DirectiveGateRequest,
    DirectiveGateResponse, DispatchRowsRequest, DispatchRowsResponse, DispatchSummaryRequest,
    DispatchSummaryResponse, GovernanceApplyPolicy, GovernanceApplyRequest,
    GovernanceApplyResponse, HeroicGateRequest, HeroicGateResponse, QueueRowsRequest,
    QueueRowsResponse, RouteComplexityRequest, RouteComplexityResponse, RouteDecisionRequest,
    RouteDecisionResponse, RouteEvaluateRequest, RouteEvaluateResponse, RouteHabitReadinessRequest,
    RouteHabitReadinessResponse, RouteMatchRequest, RouteMatchResponse, RoutePrimitivesRequest,
    RoutePrimitivesResponse, RouteReflexMatchRequest, RouteReflexMatchResponse, RouteReflexRoutine,
    TaskSummaryRequest, TaskSummaryResponse,
};
pub use inversion::run_inversion_json;
pub use sprint_contract::run_sprint_contract_json;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowStep {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub pause_after: bool,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionState {
    #[serde(default)]
    pub cursor: u32,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    pub last_step_id: Option<String>,
    #[serde(default)]
    pub processed_step_ids: Vec<String>,
    #[serde(default)]
    pub processed_events: u32,
    #[serde(default)]
    pub digest: String,
}

impl Default for ExecutionState {
    fn default() -> Self {
        Self {
            cursor: 0,
            paused: false,
            completed: false,
            last_step_id: None,
            processed_step_ids: Vec::new(),
            processed_events: 0,
            digest: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct WorkflowDefinition {
    #[serde(default)]
    pub workflow_id: String,
    #[serde(default)]
    pub deterministic_seed: String,
    #[serde(default)]
    pub pause_after_step: Option<String>,
    #[serde(default)]
    pub resume: Option<ExecutionState>,
    #[serde(default)]
    pub steps: Vec<WorkflowStep>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionReceipt {
    pub workflow_id: String,
    pub status: String,
    pub deterministic: bool,
    pub replayable: bool,
    pub processed_steps: u32,
    pub pause_reason: Option<String>,
    pub event_digest: String,
    pub events: Vec<String>,
    pub state: ExecutionState,
    pub metadata: BTreeMap<String, String>,
    pub warnings: Vec<String>,
}

fn normalize_step_id(step: &WorkflowStep, idx: usize) -> String {
    let candidate = step.id.trim();
    if candidate.is_empty() {
        format!("step_{:03}", idx + 1)
    } else {
        candidate.to_string()
    }
}

fn stable_hash(lines: &[String]) -> String {
    let mut hasher = Sha256::new();
    for (idx, line) in lines.iter().enumerate() {
        hasher.update(format!("{}:{}|", idx, line).as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn step_fingerprint(
    workflow_id: &str,
    seed: &str,
    idx: usize,
    step_id: &str,
    step: &WorkflowStep,
) -> String {
    let mut parts = vec![
        workflow_id.to_string(),
        seed.to_string(),
        idx.to_string(),
        step_id.to_string(),
        step.kind.clone(),
        step.action.clone(),
        step.command.clone(),
    ];
    for (k, v) in &step.params {
        parts.push(format!("{}={}", k, v));
    }
    stable_hash(&parts)
}

fn failure_receipt(workflow_id: &str, reason: &str) -> ExecutionReceipt {
    let mut lines = vec![
        workflow_id.to_string(),
        reason.to_string(),
        "failed".to_string(),
    ];
    let digest = stable_hash(&lines);
    lines.push(digest.clone());
    ExecutionReceipt {
        workflow_id: workflow_id.to_string(),
        status: "failed".to_string(),
        deterministic: true,
        replayable: false,
        processed_steps: 0,
        pause_reason: Some(reason.to_string()),
        event_digest: digest.clone(),
        events: vec![format!("error:{}", reason)],
        state: ExecutionState {
            digest,
            ..ExecutionState::default()
        },
        metadata: BTreeMap::new(),
        warnings: vec![reason.to_string()],
    }
}

fn run_workflow_definition(def: WorkflowDefinition) -> ExecutionReceipt {
    let profile = load_embedded_execution_profile().ok();
    let workflow_id = if def.workflow_id.trim().is_empty() {
        format!(
            "wf_{}",
            stable_hash(&vec![
                def.steps.len().to_string(),
                def.deterministic_seed.clone(),
                serde_json::to_string(&def.metadata).unwrap_or_else(|_| "{}".to_string())
            ])
            .chars()
            .take(12)
            .collect::<String>()
        )
    } else {
        def.workflow_id.trim().to_string()
    };

    let mut warnings: Vec<String> = Vec::new();
    if let Some(profile) = &profile {
        if def.steps.len() > profile.max_steps {
            warnings.push("execution_profile_max_steps_exceeded".to_string());
        }
    } else {
        warnings.push("execution_profile_unavailable".to_string());
    }

    let mut state = def.resume.unwrap_or_default();
    let step_count = def.steps.len() as u32;
    if state.cursor > step_count {
        warnings.push("resume_cursor_clamped".to_string());
        state.cursor = step_count;
    }

    let mut events = Vec::new();
    if state.cursor > 0 {
        events.push(format!("resume:{}", state.cursor));
    }

    let mut pause_reason = None;
    let start = state.cursor as usize;
    for idx in start..def.steps.len() {
        let step = &def.steps[idx];
        let step_id = normalize_step_id(step, idx);
        let fingerprint =
            step_fingerprint(&workflow_id, &def.deterministic_seed, idx, &step_id, step);
        events.push(format!("exec:{}:{}", step_id, fingerprint));

        state.cursor = (idx + 1) as u32;
        state.last_step_id = Some(step_id.clone());
        state.processed_step_ids.push(step_id.clone());

        let should_pause = step.pause_after
            || def
                .pause_after_step
                .as_ref()
                .map(|v| v == &step_id)
                .unwrap_or(false);
        if should_pause {
            state.paused = true;
            state.completed = false;
            pause_reason = Some(format!("paused_after:{}", step_id));
            break;
        }
    }

    if state.cursor >= step_count {
        state.completed = true;
        state.paused = false;
        pause_reason = None;
    }

    let mut digest_input = vec![
        workflow_id.clone(),
        def.deterministic_seed.clone(),
        state.cursor.to_string(),
        state.paused.to_string(),
        state.completed.to_string(),
    ];
    digest_input.extend(events.iter().cloned());
    for (k, v) in &def.metadata {
        digest_input.push(format!("{}={}", k, v));
    }
    let digest = stable_hash(&digest_input);

    state.processed_events = events.len() as u32;
    state.digest = digest.clone();

    ExecutionReceipt {
        workflow_id,
        status: if state.paused {
            "paused".to_string()
        } else if state.completed {
            "completed".to_string()
        } else {
            "running".to_string()
        },
        deterministic: true,
        replayable: true,
        processed_steps: state.cursor,
        pause_reason,
        event_digest: digest,
        events,
        state,
        metadata: def.metadata,
        warnings,
    }
}

pub fn run_workflow(yaml: &str) -> ExecutionReceipt {
    match serde_yaml::from_str::<WorkflowDefinition>(yaml) {
        Ok(def) => run_workflow_definition(def),
        Err(err) => failure_receipt("invalid_workflow", &format!("yaml_parse_failed:{}", err)),
    }
}

fn run_workflow_json_internal(yaml: &str) -> String {
    serde_json::to_string(&run_workflow(yaml)).unwrap_or_else(|err| {
        format!(
            "{{\"workflow_id\":\"invalid_workflow\",\"status\":\"failed\",\"deterministic\":true,\"replayable\":false,\"processed_steps\":0,\"pause_reason\":\"json_serialize_failed:{}\",\"event_digest\":\"\",\"events\":[],\"state\":{{\"cursor\":0,\"paused\":false,\"completed\":false,\"last_step_id\":null,\"processed_step_ids\":[],\"processed_events\":0,\"digest\":\"\"}},\"metadata\":{{}},\"warnings\":[\"json_serialize_failed\"]}}",
            err
        )
    })
}

pub fn run_workflow_json(yaml: &str) -> String {
    run_workflow_json_internal(yaml)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn run_workflow_wasm(yaml: &str) -> String {
    run_workflow_json_internal(yaml)
}

#[no_mangle]
pub extern "C" fn run_workflow_ffi(yaml_ptr: *const c_char) -> *mut c_char {
    let payload = if yaml_ptr.is_null() {
        run_workflow_json_internal("workflow_id: [invalid")
    } else {
        let yaml_text = unsafe { CStr::from_ptr(yaml_ptr) }.to_str().unwrap_or("{}");
        run_workflow_json_internal(yaml_text)
    };
    match CString::new(payload) {
        Ok(v) => v.into_raw(),
        Err(_) => CString::new(
            "{\"workflow_id\":\"invalid_workflow\",\"status\":\"failed\",\"deterministic\":true,\"replayable\":false,\"processed_steps\":0,\"pause_reason\":\"ffi_payload_contains_nul\",\"event_digest\":\"\",\"events\":[],\"state\":{\"cursor\":0,\"paused\":false,\"completed\":false,\"last_step_id\":null,\"processed_step_ids\":[],\"processed_events\":0,\"digest\":\"\"},\"metadata\":{},\"warnings\":[\"ffi_payload_contains_nul\"]}"
        ).map(|v| v.into_raw()).unwrap_or(std::ptr::null_mut()),
    }
}

#[no_mangle]
pub extern "C" fn execution_core_string_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_yaml() -> String {
        serde_json::json!({
            "workflow_id": "phase2_parity_demo",
            "deterministic_seed": "seed_a",
            "steps": [
                { "id": "collect", "kind": "task", "action": "collect_data", "command": "collect --source=eyes" },
                { "id": "score", "kind": "task", "action": "score", "command": "score --strategy=deterministic" },
                { "id": "ship", "kind": "task", "action": "ship", "command": "ship --mode=canary" }
            ]
        })
        .to_string()
    }

    #[test]
    fn deterministic_replay_is_stable() {
        let yaml = sample_yaml();
        let a = run_workflow(&yaml);
        let b = run_workflow(&yaml);
        assert_eq!(a, b);
        assert_eq!(a.status, "completed");
    }

    #[test]
    fn pause_and_resume_cycle() {
        let paused_yaml = serde_json::json!({
            "workflow_id": "pause_resume_demo",
            "deterministic_seed": "seed_b",
            "pause_after_step": "score",
            "steps": [
                { "id": "collect", "kind": "task", "action": "collect_data", "command": "collect --source=eyes" },
                { "id": "score", "kind": "task", "action": "score", "command": "score --strategy=deterministic" },
                { "id": "ship", "kind": "task", "action": "ship", "command": "ship --mode=canary" }
            ]
        })
        .to_string();
        let paused = run_workflow(&paused_yaml);
        assert_eq!(paused.status, "paused");
        assert_eq!(paused.state.cursor, 2);

        let resumed_yaml = serde_json::json!({
            "workflow_id": "pause_resume_demo",
            "deterministic_seed": "seed_b",
            "resume": paused.state,
            "steps": [
                { "id": "collect", "kind": "task", "action": "collect_data", "command": "collect --source=eyes" },
                { "id": "score", "kind": "task", "action": "score", "command": "score --strategy=deterministic" },
                { "id": "ship", "kind": "task", "action": "ship", "command": "ship --mode=canary" }
            ]
        })
        .to_string();
        let resumed = run_workflow(&resumed_yaml);
        assert_eq!(resumed.status, "completed");
        assert_eq!(resumed.state.cursor, 3);
    }

    #[test]
    fn parse_failure_returns_failed_receipt() {
        let receipt = run_workflow("workflow_id: [invalid");
        assert_eq!(receipt.status, "failed");
        assert_eq!(receipt.workflow_id, "invalid_workflow");
    }

    #[test]
    fn ffi_roundtrip_returns_json_receipt() {
        let yaml = CString::new(sample_yaml()).unwrap();
        let out_ptr = run_workflow_ffi(yaml.as_ptr());
        assert!(!out_ptr.is_null());
        let text = unsafe { CStr::from_ptr(out_ptr) }
            .to_str()
            .unwrap()
            .to_string();
        execution_core_string_free(out_ptr);
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["status"], "completed");
        assert_eq!(parsed["workflow_id"], "phase2_parity_demo");
    }

    #[test]
    fn ffi_null_pointer_returns_failed_payload() {
        let out_ptr = run_workflow_ffi(std::ptr::null());
        assert!(!out_ptr.is_null());
        let text = unsafe { CStr::from_ptr(out_ptr) }
            .to_str()
            .unwrap()
            .to_string();
        execution_core_string_free(out_ptr);
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["status"], "failed");
    }
}
