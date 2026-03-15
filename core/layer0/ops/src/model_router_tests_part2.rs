// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn evaluate_router_global_budget_gate_matches_hard_stop_dry_run_and_enforced_paths() {
    let hard_guard = json!({
        "hard_stop": true,
        "hard_stop_reasons": ["daily_usd_cap_exceeded"]
    });
    let dry_run = evaluate_router_global_budget_gate(RouterGlobalBudgetGateInput {
        request_tokens_est: Some(1300.0),
        dry_run: Some(&json!("1")),
        execution_intent: Some(&json!(true)),
        enforce_execution_only: true,
        nonexec_max_tokens: 900,
        autopause: Some(&json!({"active": false})),
        oracle: Some(&json!({"available": false})),
        guard: Some(&hard_guard),
    });
    assert!(dry_run.enabled);
    assert!(!dry_run.blocked);
    assert!(dry_run.deferred);
    assert_eq!(
        dry_run.reason.as_deref(),
        Some("daily_usd_cap_exceeded_dry_run")
    );
    assert!(!dry_run.autopause_active);

    let enforced = evaluate_router_global_budget_gate(RouterGlobalBudgetGateInput {
        request_tokens_est: Some(1300.0),
        dry_run: Some(&json!(false)),
        execution_intent: Some(&json!(true)),
        enforce_execution_only: true,
        nonexec_max_tokens: 900,
        autopause: Some(&json!({"active": false})),
        oracle: Some(&json!({"available": false})),
        guard: Some(&hard_guard),
    });
    assert!(enforced.enabled);
    assert!(enforced.blocked);
    assert!(!enforced.deferred);
    assert_eq!(enforced.reason.as_deref(), Some("daily_usd_cap_exceeded"));
    assert!(enforced.autopause_active);
    assert_eq!(enforced.autopause.source.as_deref(), Some("model_router"));
    assert_eq!(
        enforced.autopause.reason.as_deref(),
        Some("daily_usd_cap_exceeded")
    );
}

#[test]
fn project_budget_state_matches_unavailable_and_projection_contracts() {
    let unavailable = project_budget_state(
        Some(&json!({"enabled": true, "available": false, "pressure": "soft"})),
        Some(120.6),
    );
    assert_eq!(unavailable["request_tokens_est"], 121);
    assert_eq!(unavailable["projected_used_est"], Value::Null);
    assert_eq!(unavailable["projected_ratio"], Value::Null);
    assert_eq!(unavailable["projected_pressure"], "soft");

    let projected = project_budget_state(
        Some(&json!({
            "enabled": true,
            "available": true,
            "pressure": "none",
            "token_cap": 1000,
            "used_est": 850,
            "policy": { "soft_ratio": 0.75, "hard_ratio": 0.92 }
        })),
        Some(100.4),
    );
    assert_eq!(projected["request_tokens_est"], 100);
    assert_eq!(projected["projected_used_est"], 950.0);
    assert_eq!(projected["projected_ratio"], 0.95);
    assert_eq!(projected["projected_pressure"], "hard");

    let invalid_cap = project_budget_state(
        Some(&json!({
            "enabled": true,
            "available": true,
            "pressure": "hard",
            "token_cap": 0,
            "used_est": 850
        })),
        Some(80.0),
    );
    assert_eq!(invalid_cap["request_tokens_est"], 80);
    assert_eq!(invalid_cap["projected_used_est"], Value::Null);
    assert_eq!(invalid_cap["projected_ratio"], Value::Null);
    assert_eq!(invalid_cap["projected_pressure"], "none");
}

#[test]
fn route_class_policy_matches_reflex_defaults_and_overrides() {
    let empty = json!({});
    let reflex = route_class_policy(&empty, "reflex");
    assert_eq!(reflex.id, "reflex");
    assert_eq!(reflex.force_risk.as_deref(), Some("low"));
    assert_eq!(reflex.force_complexity.as_deref(), Some("low"));
    assert_eq!(reflex.force_role, "reflex");
    assert_eq!(reflex.prefer_slot.as_deref(), Some("grunt"));
    assert_eq!(reflex.prefer_model.as_deref(), Some("ollama/smallthinker"));
    assert_eq!(reflex.fallback_slot.as_deref(), Some("fallback"));
    assert!(reflex.disable_fast_path);
    assert_eq!(reflex.max_tokens_est, Some(420));

    let cfg = json!({
        "routing": {
            "route_classes": {
                "reflex": {
                    "prefer_model": "openai/gpt-4.1-mini",
                    "disable_fast_path": "off",
                    "max_tokens_est": 777
                },
                "focus": {
                    "force_risk": "HIGH",
                    "force_complexity": "medium",
                    "force_role": " Planning ",
                    "prefer_slot": "  specialist ",
                    "max_tokens_est": 0
                }
            }
        }
    });
    let reflex_override = route_class_policy(&cfg, "reflex");
    assert_eq!(
        reflex_override.prefer_model.as_deref(),
        Some("openai/gpt-4.1-mini")
    );
    assert!(!reflex_override.disable_fast_path);
    assert_eq!(reflex_override.max_tokens_est, Some(777));

    let focus = route_class_policy(&cfg, "focus");
    assert_eq!(focus.id, "focus");
    assert_eq!(focus.force_risk.as_deref(), Some("high"));
    assert_eq!(focus.force_complexity.as_deref(), Some("medium"));
    assert_eq!(focus.force_role, "planning");
    assert_eq!(focus.prefer_slot.as_deref(), Some("specialist"));
    assert_eq!(focus.max_tokens_est, None);
}

#[test]
fn prompt_cache_lane_for_route_matches_contract() {
    assert_eq!(
        prompt_cache_lane_for_route("reflex", "normal", false),
        "reflex"
    );
    assert_eq!(
        prompt_cache_lane_for_route("default", "dream-weave", false),
        "dream"
    );
    assert_eq!(
        prompt_cache_lane_for_route("default", "normal", true),
        "autonomy"
    );
    assert_eq!(
        prompt_cache_lane_for_route("default", "normal", false),
        "autonomy"
    );
}

#[test]
fn mode_adjustments_match_config_and_fallback_contracts() {
    let base = ModeAdjustmentInput {
        risk: "medium".to_string(),
        complexity: "low".to_string(),
        role: "general".to_string(),
    };
    let adapters = json!({
        "mode_routing": {
            "autonomy": "tier2_build",
            "default": "tier3_grunt"
        }
    });
    let mapped = apply_mode_adjustments("autonomy", &base, &adapters);
    assert_eq!(mapped.risk, "medium");
    assert_eq!(mapped.complexity, "medium");
    assert_eq!(mapped.role, "coding");
    assert!(mapped.mode_adjusted);
    assert_eq!(mapped.mode_reason.as_deref(), Some("tier2_build"));
    assert_eq!(
        mapped.mode_policy_source,
        "client/runtime/config/model_adapters.json"
    );

    let deep = apply_mode_adjustments("deep-thinker", &base, &adapters);
    assert_eq!(deep.risk, "high");
    assert_eq!(deep.complexity, "high");
    assert_eq!(deep.role, "logic");
    assert!(deep.mode_adjusted);
    assert_eq!(
        deep.mode_reason.as_deref(),
        Some("deep_thinker_forces_high_logic")
    );

    let hyper = apply_mode_adjustments("hyper-creative", &base, &json!({}));
    assert_eq!(hyper.risk, "medium");
    assert_eq!(hyper.complexity, "medium");
    assert_eq!(hyper.role, "planning");
    assert_eq!(
        hyper.mode_reason.as_deref(),
        Some("hyper_creative_bias_planning")
    );

    let creative = apply_mode_adjustments("creative", &base, &json!({}));
    assert_eq!(creative.role, "chat");
    assert_eq!(creative.mode_reason.as_deref(), Some("creative_bias_chat"));
}

#[test]
fn env_probe_blocked_text_and_normalization_match_contract() {
    assert!(is_env_probe_blocked_text(
        "operation not permitted while probing 127.0.0.1:11434"
    ));
    assert!(is_env_probe_blocked_text(
        "sandbox denied outbound connect 11434"
    ));
    assert!(!is_env_probe_blocked_text(
        "timeout while probing localhost"
    ));

    let raw = json!({
        "reason": "Permission denied on socket 11434",
        "stderr": "sandbox restrictions",
        "probe_blocked": false
    });
    let normalized = normalize_probe_blocked_record(Some(&raw));
    assert!(normalized.changed);
    let rec = normalized
        .rec
        .expect("record should be present after normalization");
    assert_eq!(rec["probe_blocked"], true);
    assert_eq!(rec["reason"], "env_probe_blocked");
    assert_eq!(rec["available"], Value::Null);

    let passthrough = normalize_probe_blocked_record(Some(&json!({
        "reason": "timeout",
        "stderr": "no response",
        "probe_blocked": false,
        "available": true
    })));
    assert!(!passthrough.changed);
}

#[test]
fn suppression_active_matches_contract() {
    assert!(suppression_active(
        Some(&json!({"suppressed_until_ms": 2000})),
        1_000
    ));
    assert!(!suppression_active(
        Some(&json!({"suppressed_until_ms": 500})),
        1_000
    ));
    assert!(!suppression_active(None, 1_000));
}

#[test]
fn probe_health_stabilizer_applies_timeout_suppression_and_rehab_clearance() {
    let policy = ProbeHealthStabilizerPolicy::default();
    let now_ms = 1_000_000_i64;

    let suppressed = apply_probe_health_stabilizer(
        Some(&json!({"timeout_streak": 2, "rehab_success_streak": 5})),
        Some(&json!({"timeout": true, "available": true})),
        now_ms,
        &policy,
    );
    assert_eq!(suppressed["timeout_streak"], 3);
    assert_eq!(suppressed["rehab_success_streak"], 0);
    assert_eq!(suppressed["suppressed_reason"], "timeout_streak");
    assert_eq!(
        suppressed["suppressed_until_ms"],
        json!(now_ms + (ROUTER_PROBE_SUPPRESSION_MINUTES_DEFAULT * 60 * 1000))
    );
    assert_eq!(suppressed["reason"], "probe_suppressed_timeout_rehab");
    assert_eq!(suppressed["available"], false);
    assert_eq!(suppressed["suppressed_at_ms"].as_f64(), Some(now_ms as f64));

    let cleared = apply_probe_health_stabilizer(
        Some(&json!({"suppressed_until_ms": 900, "rehab_success_streak": 1})),
        Some(&json!({
            "timeout": false,
            "available": true,
            "suppressed_until_ms": 2_000,
            "suppressed_reason": "timeout_streak",
            "suppressed_at_ms": 111
        })),
        1_000,
        &policy,
    );
    assert_eq!(cleared["rehab_success_streak"], 2);
    assert!(cleared.get("suppressed_until_ms").is_none());
    assert!(cleared.get("suppressed_reason").is_none());
    assert!(cleared.get("suppressed_at_ms").is_none());
    assert_eq!(cleared["available"], true);
}

#[test]
fn handoff_packet_tier_and_budget_behavior_matches_contract() {
    let tier2 = json!({
        "selected_model": "ollama/smallthinker",
        "previous_model": "openai/gpt-4.1",
        "model_changed": true,
        "reason": "communication_fast_path_heuristic",
        "tier": 2,
        "role": "Coding",
        "route_class": "default",
        "mode": "normal",
        "slot": "grunt",
        "escalation_chain": ["a", "b", "c", "d"],
        "fast_path": { "matched": true },
        "budget": { "pressure": "soft", "request_tokens_est": 320 },
        "capability": "file_edit",
        "fallback_slot": "fallback",
        "budget_enforcement": { "action": "allow", "reason": "ok", "blocked": false }
    });
    let out2 = build_handoff_packet(&tier2);
    assert_eq!(out2["tier"], 2);
    assert_eq!(out2["role"], "coding");
    assert_eq!(out2["fast_path"], "communication");
    assert_eq!(out2["budget"]["pressure"], "soft");
    assert_eq!(out2["budget"]["projected_pressure"], "soft");
    assert_eq!(out2["budget"]["request_tokens_est"], 320.0);
    assert_eq!(out2["capability"], "file_edit");
    assert_eq!(out2["fallback_slot"], "fallback");
    assert_eq!(
        out2["escalation_chain"].as_array().map(|v| v.len()),
        Some(3)
    );
    assert!(out2.get("guardrails").is_none());

    let tier3 = json!({
        "tier": 3,
        "role": "logic",
        "escalation_chain": ["a", "b", "c", "d", "e"],
        "deep_thinker": 1,
        "post_task_return_model": "ollama/smallthinker",
        "budget_enforcement": { "action": "block", "reason": "hard_pressure", "blocked": true }
    });
    let out3 = build_handoff_packet(&tier3);
    assert_eq!(out3["tier"], 3);
    assert_eq!(
        out3["escalation_chain"].as_array().map(|v| v.len()),
        Some(4)
    );
    assert_eq!(out3["guardrails"]["deep_thinker"], true);
    assert_eq!(out3["guardrails"]["verification_required"], true);
    assert_eq!(out3["post_task_return_model"], "ollama/smallthinker");
    assert_eq!(out3["budget_enforcement"]["blocked"], true);
}

#[test]
fn handoff_packet_defaults_match_js_truthy_semantics_for_tier_zero() {
    let payload = json!({
        "tier": 0,
        "role": "general",
        "escalation_chain": ["a", "b", "c", "d"],
        "capability": "chat",
        "fallback_slot": "fallback"
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["tier"], 2);
    assert_eq!(out["escalation_chain"].as_array().map(|v| v.len()), Some(3));
    assert_eq!(out["capability"], "chat");
    assert_eq!(out["fallback_slot"], "fallback");
}

#[test]
fn handoff_packet_default_shape_is_fail_closed_for_non_object_input() {
    let out = build_handoff_packet(&json!(null));
    assert_eq!(out["selected_model"], Value::Null);
    assert_eq!(out["previous_model"], Value::Null);
    assert_eq!(out["model_changed"], false);
    assert_eq!(out["reason"], Value::Null);
    assert_eq!(out["tier"], 2);
    assert_eq!(out["role"], Value::Null);
    assert_eq!(out["route_class"], "default");
    assert_eq!(out["mode"], Value::Null);
    assert_eq!(out["slot"], Value::Null);
    assert_eq!(out["escalation_chain"], json!([]));
}

#[test]
fn handoff_packet_budget_tokens_require_numeric_conversion() {
    let falsey_tokens = json!({
        "tier": 2,
        "budget": {
            "pressure": "soft",
            "request_tokens_est": ""
        }
    });
    let out_falsey = build_handoff_packet(&falsey_tokens);
    assert_eq!(out_falsey["budget"]["request_tokens_est"], Value::Null);

    let truthy_non_numeric_tokens = json!({
        "tier": 2,
        "budget": {
            "pressure": "hard",
            "request_tokens_est": "not-a-number"
        }
    });
    let out_truthy_non_numeric = build_handoff_packet(&truthy_non_numeric_tokens);
    assert_eq!(
        out_truthy_non_numeric["budget"]["request_tokens_est"],
        Value::Null
    );
    assert_eq!(
        out_truthy_non_numeric["budget"]["projected_pressure"],
        "hard"
    );

    let bool_numeric_tokens = json!({
        "tier": 2,
        "budget": {
            "pressure": "soft",
            "request_tokens_est": true
        }
    });
    let out_bool_numeric = build_handoff_packet(&bool_numeric_tokens);
    assert_eq!(out_bool_numeric["budget"]["request_tokens_est"], 1.0);
}

#[test]
fn handoff_packet_tier_one_general_omits_capability_fields() {
    let payload = json!({
        "tier": 1,
        "role": "general",
        "capability": "file_edit",
        "fallback_slot": "fallback"
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["tier"], 1);
    assert!(out.get("capability").is_none());
    assert!(out.get("fallback_slot").is_none());
}

#[test]
fn handoff_packet_tier_one_coding_keeps_capability_fields() {
    let payload = json!({
        "tier": 1,
        "role": "coding",
        "capability": "file_edit",
        "fallback_slot": "fallback"
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["tier"], 1);
    assert_eq!(out["capability"], "file_edit");
    assert_eq!(out["fallback_slot"], "fallback");
}

#[test]
fn handoff_packet_budget_projected_pressure_falls_back_to_pressure() {
    let payload = json!({
        "tier": 2,
        "budget": {
            "pressure": "hard",
            "request_tokens_est": 250
        }
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["budget"]["pressure"], "hard");
    assert_eq!(out["budget"]["projected_pressure"], "hard");
    assert_eq!(out["budget"]["request_tokens_est"], 250.0);
}

#[test]
fn handoff_packet_budget_enforcement_blocked_requires_true_bool() {
    let payload = json!({
        "tier": 2,
        "budget_enforcement": {
            "action": "allow",
            "reason": "string-flag",
            "blocked": "true"
        }
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["budget_enforcement"]["action"], "allow");
    assert_eq!(out["budget_enforcement"]["reason"], "string-flag");
    assert_eq!(out["budget_enforcement"]["blocked"], false);
}

#[test]
fn handoff_packet_fast_path_and_model_changed_require_true_bools() {
    let payload = json!({
        "tier": 2,
        "fast_path": {
            "matched": "true"
        },
        "model_changed": "true"
    });
    let out = build_handoff_packet(&payload);
    assert!(out.get("fast_path").is_none());
    assert_eq!(out["model_changed"], false);
}

#[test]
fn handoff_packet_post_task_return_model_requires_truthy_value() {
    let payload = json!({
        "tier": 3,
        "deep_thinker": 1,
        "post_task_return_model": 0
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["guardrails"]["deep_thinker"], true);
    assert_eq!(out["guardrails"]["verification_required"], true);
    assert!(out.get("post_task_return_model").is_none());
}

#[test]
fn helper_fallbacks_cover_general_task_type_and_proposal_capability_family() {
    assert_eq!(infer_role("prioritize candidate fixes", ""), "planning");
    assert_eq!(capability_family_key("proposal"), "proposal");
    assert_eq!(task_type_key_from_route("default", "", ""), "general");
}

#[test]
fn normalize_capability_key_collapses_and_truncates_deterministically() {
    assert_eq!(
        normalize_capability_key("  __Proposal@@@Doctor:::Repair__  "),
        "proposal_doctor:::repair"
    );

    let long_input = "A".repeat(120);
    let normalized = normalize_capability_key(&long_input);
    assert_eq!(normalized.len(), 72);
    assert!(normalized.chars().all(|ch| ch == 'a'));
}
