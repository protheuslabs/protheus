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
                let lowered_pool =
                    ((input.candidate_pool_size as f64) * factor).floor() as u32;
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
        if !out
            .reasons
            .iter()
            .any(|r| r == "reset_caps_spawn_capacity")
        {
            out.reasons.push("reset_caps_spawn_capacity".to_string());
        }
    }

    if !out.low_yield {
        out.high_yield =
            input.shipped_today > 0.0 && input.no_progress_streak <= 0.0 && input.gate_exhaustion_streak <= 0.0;
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
        if pending >= input.critical_pending_count
            || pending_ratio >= input.critical_pending_ratio
        {
            pressure = "critical".to_string();
        } else if pending >= input.warn_pending_count
            || pending_ratio >= input.warn_pending_ratio
        {
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

pub fn run_autoscale_json(payload_json: &str) -> Result<String, String> {
    let request: AutoscaleRequest =
        serde_json::from_str(payload_json).map_err(|e| format!("autoscale_request_parse_failed:{e}"))?;
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
}
