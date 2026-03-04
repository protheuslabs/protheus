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
    pub no_progress_result_input: Option<NoProgressResultInput>,
    #[serde(default)]
    pub attempt_run_event_input: Option<AttemptRunEventInput>,
    #[serde(default)]
    pub safety_stop_run_event_input: Option<SafetyStopRunEventInput>,
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
