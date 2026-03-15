// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn handoff_packet_tier_three_truthy_guardrails_match_js_for_mixed_types() {
    let payload = json!({
        "tier": 3,
        "deep_thinker": "",
        "post_task_return_model": {}
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["guardrails"]["deep_thinker"], false);
    assert_eq!(out["guardrails"]["verification_required"], true);
    assert_eq!(out["post_task_return_model"], json!({}));
}

#[test]
fn handoff_packet_blank_role_normalizes_to_null_and_omits_capability_for_tier_one() {
    let payload = json!({
        "tier": 1,
        "role": "   ",
        "capability": "file_edit",
        "fallback_slot": "fallback"
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["role"], Value::Null);
    assert!(out.get("capability").is_none());
    assert!(out.get("fallback_slot").is_none());
}

#[test]
fn handoff_packet_tier_chain_limits_clamp_to_js_bounds() {
    let low_payload = json!({
        "tier": -1,
        "role": "general",
        "escalation_chain": ["a", "b", "c", "d"]
    });
    let low = build_handoff_packet(&low_payload);
    assert_eq!(low["tier"], -1);
    assert_eq!(low["escalation_chain"].as_array().map(|v| v.len()), Some(2));
    assert!(low.get("capability").is_none());

    let high_payload = json!({
        "tier": 99,
        "role": "general",
        "escalation_chain": ["a", "b", "c", "d", "e", "f"]
    });
    let high = build_handoff_packet(&high_payload);
    assert_eq!(high["tier"], 99);
    assert_eq!(
        high["escalation_chain"].as_array().map(|v| v.len()),
        Some(4)
    );
    assert_eq!(high["guardrails"]["verification_required"], true);
}

#[test]
fn role_and_capability_inference_cover_parallel_agent_and_role_fallback_paths() {
    assert_eq!(infer_role("parallel agent coordination", "sync"), "swarm");
    assert_eq!(
        infer_capability("unknown action", "no keyword", "  Coding Lead  "),
        "role:coding lead"
    );
}

#[test]
fn prefix_inference_paths_match_tools_and_planning_contracts() {
    assert_eq!(infer_role("integrating services", "sync adapters"), "tools");
    assert_eq!(infer_capability("prioritization sweep", "", ""), "planning");
}

#[test]
fn handoff_packet_tier_one_planning_keeps_capability_fields() {
    let payload = json!({
        "tier": 1,
        "role": "Planning",
        "capability": "planning",
        "fallback_slot": "fallback"
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["tier"], 1);
    assert_eq!(out["role"], "planning");
    assert_eq!(out["capability"], "planning");
    assert_eq!(out["fallback_slot"], "fallback");
}

#[test]
fn handoff_packet_budget_enforcement_non_string_fields_map_to_null() {
    let payload = json!({
        "tier": 2,
        "budget_enforcement": {
            "action": 42,
            "reason": true,
            "blocked": true
        }
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["budget_enforcement"]["action"], Value::Null);
    assert_eq!(out["budget_enforcement"]["reason"], Value::Null);
    assert_eq!(out["budget_enforcement"]["blocked"], true);
}

#[test]
fn inference_precedence_prefers_coding_and_file_edit_over_tool_and_read_keywords() {
    assert_eq!(
        infer_role("patch automation cli workflow", "read files"),
        "coding"
    );
    assert_eq!(
        infer_capability("patch read cli workflow", "inspect file", ""),
        "file_edit"
    );
}

#[test]
fn handoff_packet_tier_three_keeps_truthy_numeric_post_task_return_model() {
    let payload = json!({
        "tier": 3,
        "deep_thinker": -1,
        "post_task_return_model": 7
    });
    let out = build_handoff_packet(&payload);
    assert_eq!(out["guardrails"]["deep_thinker"], true);
    assert_eq!(out["guardrails"]["verification_required"], true);
    assert_eq!(out["post_task_return_model"], 7);
}

#[test]
fn optimize_receipt_emits_cost_savings_plan() {
    let root = tempfile::tempdir().expect("tempdir");
    let out = optimize_cheapest_receipt(
        root.path(),
        &[
            "optimize".to_string(),
            "minimax".to_string(),
            "--target-cost=0.3".to_string(),
            "--baseline-cost=5.0".to_string(),
        ],
    );
    assert_eq!(
        out.get("type").and_then(Value::as_str),
        Some("model_router_optimize_cheap")
    );
    assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
    assert!(
        out.pointer("/plan/estimated_savings_pct")
            .and_then(Value::as_f64)
            .unwrap_or_default()
            > 90.0
    );
    assert!(out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MODEL-003.5")));
}

#[test]
fn reset_agent_receipt_preserves_identity_by_default() {
    let root = tempfile::tempdir().expect("tempdir");
    let out = reset_agent_receipt(root.path(), &["reset-agent".to_string()]);
    assert_eq!(
        out.get("type").and_then(Value::as_str),
        Some("model_router_agent_reset")
    );
    assert_eq!(
        out.get("preserve_identity").and_then(Value::as_bool),
        Some(true)
    );
    assert!(out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MODEL-003.4")));
}

#[test]
fn night_scheduler_receipt_contains_window_and_model() {
    let root = tempfile::tempdir().expect("tempdir");
    let out = night_scheduler_receipt(
        root.path(),
        &[
            "night-schedule".to_string(),
            "--start-hour=1".to_string(),
            "--end-hour=5".to_string(),
            "--cheap-model=minimax/m2.5".to_string(),
        ],
    );
    assert_eq!(
        out.get("type").and_then(Value::as_str),
        Some("model_router_night_schedule")
    );
    assert_eq!(
        out.pointer("/schedule/start_hour").and_then(Value::as_i64),
        Some(1)
    );
    assert_eq!(
        out.pointer("/schedule/cheap_model").and_then(Value::as_str),
        Some("minimax/m2.5")
    );
    assert!(out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MODEL-003.6")));
}

#[test]
fn compact_context_receipt_contains_selected_lines() {
    let root = tempfile::tempdir().expect("tempdir");
    let out = compact_context_receipt(
        root.path(),
        &[
            "compact-context".to_string(),
            "--max-lines=12".to_string(),
            "--context=soul,memory,task,signals,signals".to_string(),
        ],
    );
    assert_eq!(
        out.get("type").and_then(Value::as_str),
        Some("model_router_compact_context")
    );
    assert_eq!(out.get("max_lines").and_then(Value::as_i64), Some(12));
    assert!(out
        .get("compaction_ratio")
        .and_then(Value::as_f64)
        .map(|v| v > 0.0 && v <= 1.0)
        .unwrap_or(false));
    assert!(out
        .get("compacted_text")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));
    assert!(out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MODEL-003.1")));
}

#[test]
fn decompose_task_receipt_emits_three_phases() {
    let root = tempfile::tempdir().expect("tempdir");
    let out = decompose_task_receipt(
        root.path(),
        &[
            "decompose-task".to_string(),
            "--task=launch cheap mode, validate receipts, publish summary".to_string(),
        ],
    );
    assert_eq!(
        out.get("type").and_then(Value::as_str),
        Some("model_router_decompose_task")
    );
    assert_eq!(
        out.get("phases").and_then(Value::as_array).map(|v| v.len()),
        Some(3)
    );
    assert!(out
        .get("subtasks")
        .and_then(Value::as_array)
        .map(|rows| rows.len() >= 2)
        .unwrap_or(false));
    assert!(out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MODEL-003.2")));
}

#[test]
fn adapt_repo_receipt_contains_repo_and_strategy() {
    let root = tempfile::tempdir().expect("tempdir");
    let out = adapt_repo_receipt(
        root.path(),
        &[
            "adapt-repo".to_string(),
            "--repo=https://github.com/example/repo".to_string(),
            "--strategy=reuse-first".to_string(),
        ],
    );
    assert_eq!(
        out.get("type").and_then(Value::as_str),
        Some("model_router_adapt_repo")
    );
    assert_eq!(
        out.get("strategy").and_then(Value::as_str),
        Some("reuse-first")
    );
    assert!(out
        .pointer("/adaptation_plan/plan_digest")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));
    assert!(out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MODEL-003.3")));
}

#[test]
fn conduit_enforcement_rejects_bypass_for_strict_model_commands() {
    let out = model_router_conduit_enforcement(
        &[
            "optimize".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
        "optimize",
        true,
    );
    assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        out.get("errors")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(Value::as_str),
        Some("conduit_bypass_rejected")
    );
    assert!(out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MODEL-003.5")));
}

#[test]
fn parse_bool_flag_matches_truthy_and_falsey_contract() {
    assert!(parse_bool_flag(Some("1".to_string()), false));
    assert!(!parse_bool_flag(Some("off".to_string()), true));
    assert!(parse_bool_flag(Some("unexpected".to_string()), true));
}

#[test]
fn select_route_model_applies_fallback_when_provider_offline() {
    let (preferred, used_fallback_preferred) =
        select_route_model(true, "ollama/llama3.2:latest", "ollama/kimi-k2.5:cloud");
    assert_eq!(preferred, "ollama/llama3.2:latest");
    assert!(!used_fallback_preferred);

    let (fallback, used_fallback) =
        select_route_model(false, "ollama/llama3.2:latest", "ollama/kimi-k2.5:cloud");
    assert_eq!(fallback, "ollama/kimi-k2.5:cloud");
    assert!(used_fallback);
}
