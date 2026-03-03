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
pub struct AutoscaleRequest {
    pub mode: String,
    #[serde(default)]
    pub plan_input: Option<PlanInput>,
    #[serde(default)]
    pub batch_input: Option<BatchMaxInput>,
    #[serde(default)]
    pub dynamic_caps_input: Option<DynamicCapsInput>,
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
}
