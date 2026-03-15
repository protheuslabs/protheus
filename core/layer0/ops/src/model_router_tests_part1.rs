// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::path::Path;

#[test]
fn local_ollama_model_detection_is_strict() {
    assert!(is_local_ollama_model("ollama/llama3"));
    assert!(!is_local_ollama_model("ollama/llama3:cloud"));
    assert!(!is_local_ollama_model("openai/gpt-4.1"));
    assert!(is_cloud_model("openai/gpt-4.1"));
    assert!(is_cloud_model("ollama/llama3:cloud"));
    assert!(!is_cloud_model(""));
    assert_eq!(ollama_model_name("ollama/llama3"), "llama3");
    assert_eq!(ollama_model_name("openai/gpt-4.1"), "openai/gpt-4.1");
}

#[test]
fn tier_inference_matches_risk_complexity_contract() {
    assert_eq!(infer_tier("high", "low"), 3);
    assert_eq!(infer_tier("low", "high"), 3);
    assert_eq!(infer_tier("medium", "low"), 2);
    assert_eq!(infer_tier("low", "medium"), 2);
    assert_eq!(infer_tier("low", "low"), 1);
    assert_eq!(normalize_risk_level("unknown"), "medium");
    assert_eq!(normalize_complexity_level("bad"), "medium");
    assert_eq!(normalize_risk_level("HIGH"), "high");
    assert_eq!(normalize_complexity_level(" LOW "), "low");
}

#[test]
fn role_inference_preserves_persona_lens_priority() {
    assert_eq!(
        infer_role("fix compile issue", "patch node script"),
        "coding"
    );
    assert_eq!(infer_role("integrate with api", "cli automation"), "tools");
    assert_eq!(
        infer_role("plan next sprint", "roadmap prioritization"),
        "planning"
    );
    assert_eq!(infer_role("derive proof", "logic constraints"), "logic");
    assert_eq!(infer_role("write summary", "explain status"), "chat");
    assert_eq!(infer_role("random", "unclassified"), "general");
}

#[test]
fn capability_and_route_helpers_match_contract() {
    assert_eq!(
        normalize_capability_key("  Proposal:Decision@Tier!Alpha  "),
        "proposal:decision_tier_alpha"
    );
    assert_eq!(infer_capability("patch node script", "", ""), "file_edit");
    assert_eq!(infer_capability("please read config", "", ""), "file_read");
    assert_eq!(infer_capability("use cli automation", "", ""), "tool_use");
    assert_eq!(infer_capability("summar report", "", ""), "chat");
    assert_eq!(infer_capability("", "", "coding"), "role:coding");
    assert_eq!(infer_capability("", "", ""), "general");

    assert_eq!(
        capability_family_key("proposal:doctor:repair"),
        "proposal_doctor"
    );
    assert_eq!(capability_family_key("file_edit"), "file_edit");
    assert_eq!(
        task_type_key_from_route("reflex", "proposal:doctor", "logic"),
        "class:reflex"
    );
    assert_eq!(
        task_type_key_from_route("default", "proposal:doctor", "logic"),
        "cap:proposal_doctor"
    );
    assert_eq!(
        task_type_key_from_route("default", "", "planning"),
        "role:planning"
    );
}

#[test]
fn pressure_helpers_match_contract() {
    assert_eq!(pressure_order("critical"), 4);
    assert_eq!(pressure_order("high"), 3);
    assert_eq!(pressure_order("soft"), 2);
    assert_eq!(pressure_order("low"), 1);
    assert_eq!(pressure_order("none"), 0);

    assert_eq!(normalize_router_pressure("critical"), "hard");
    assert_eq!(normalize_router_pressure("high"), "hard");
    assert_eq!(normalize_router_pressure("medium"), "soft");
    assert_eq!(normalize_router_pressure("unknown"), "none");
}

#[test]
fn request_token_estimation_matches_contract() {
    assert_eq!(estimate_request_tokens(Some(42.2), "", ""), 120);
    assert_eq!(estimate_request_tokens(Some(130.6), "", ""), 131);
    assert_eq!(estimate_request_tokens(Some(14_000.0), "", ""), 12_000);
    assert_eq!(estimate_request_tokens(None, "", ""), 120);

    let text = "x".repeat(1_000);
    assert_eq!(estimate_request_tokens(None, "", &text), 359);
}

#[test]
fn model_multiplier_resolution_matches_contract() {
    let policy = json!({
        "model_token_multipliers": {
            "OpenAI/GPT-4.1": "1.8"
        },
        "class_token_multipliers": {
            "cheap_local": 0.42,
            "local": 0.5,
            "cloud": 1.4,
            "default": 1.1
        }
    });

    let by_model = resolve_model_token_multiplier("openai/gpt-4.1", "cheap_local", &policy);
    assert_eq!(by_model.source, "model");
    assert!((by_model.multiplier - 1.8).abs() < 1e-9);

    let by_class = resolve_model_token_multiplier("ollama/llama3", "cheap_local", &policy);
    assert_eq!(by_class.source, "class");
    assert!((by_class.multiplier - 0.42).abs() < 1e-9);

    let cloud_class = resolve_model_token_multiplier("anthropic/claude-3-5", "", &policy);
    assert_eq!(cloud_class.source, "class");
    assert!((cloud_class.multiplier - 1.4).abs() < 1e-9);
}

#[test]
fn model_multiplier_uses_js_truthy_fallback_chain() {
    let policy = json!({
        "class_token_multipliers": {
            "cheap_local": 0,
            "local": 0.5
        }
    });
    let detail = resolve_model_token_multiplier("ollama/llama3", "cheap_local", &policy);
    assert_eq!(detail.source, "class");
    assert!((detail.multiplier - 0.5).abs() < 1e-9);
}

#[test]
fn model_request_token_estimate_matches_contract() {
    let policy = json!({
        "model_token_multipliers": {
            "openai/gpt-4.1": 1.23456
        }
    });
    let out = estimate_model_request_tokens("openai/gpt-4.1", Some(1_000.0), "", &policy);
    assert_eq!(out.source, "model");
    assert_eq!(out.tokens_est, Some(1_235));
    assert_eq!(out.multiplier, Some(1.2346));

    let none = estimate_model_request_tokens("openai/gpt-4.1", Some(0.0), "", &policy);
    assert_eq!(none.source, "none");
    assert_eq!(none.tokens_est, None);
    assert_eq!(none.multiplier, None);
}

#[test]
fn communication_fast_path_policy_matches_defaults_and_overrides() {
    let defaults = communication_fast_path_policy(&json!({}));
    assert!(defaults.enabled);
    assert_eq!(defaults.match_mode, "heuristic");
    assert_eq!(defaults.max_chars, 48);
    assert_eq!(defaults.max_words, 8);
    assert_eq!(defaults.max_newlines, 0);
    assert!(defaults.patterns.is_empty());
    assert_eq!(
        defaults.disallow_regexes,
        DEFAULT_FAST_PATH_DISALLOW_REGEXES
            .iter()
            .map(|row| row.to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(defaults.slot, "grunt");
    assert_eq!(defaults.prefer_model, "ollama/smallthinker");
    assert_eq!(defaults.fallback_slot, "fallback");
    assert!(defaults.skip_outcome_scan);

    let cfg = json!({
        "routing": {
            "communication_fast_path": {
                "enabled": "off",
                "match_mode": "patterns",
                "max_chars": 999,
                "max_words": "3",
                "max_newlines": -5,
                "patterns": ["status", 7],
                "disallow_regexes": ["foo", "bar"],
                "slot": "smalltalk",
                "prefer_model": "openai/gpt-4.1-mini",
                "fallback_slot": "default",
                "skip_outcome_scan": "no"
            }
        }
    });
    let overridden = communication_fast_path_policy(&cfg);
    assert!(!overridden.enabled);
    assert_eq!(overridden.match_mode, "patterns");
    assert_eq!(overridden.max_chars, 220);
    assert_eq!(overridden.max_words, 3);
    assert_eq!(overridden.max_newlines, 0);
    assert_eq!(
        overridden.patterns,
        vec!["status".to_string(), "7".to_string()]
    );
    assert_eq!(
        overridden.disallow_regexes,
        vec!["foo".to_string(), "bar".to_string()]
    );
    assert_eq!(overridden.slot, "smalltalk");
    assert_eq!(overridden.prefer_model, "openai/gpt-4.1-mini");
    assert_eq!(overridden.fallback_slot, "default");
    assert!(!overridden.skip_outcome_scan);
}

#[test]
fn communication_fast_path_detection_rejects_structured_or_disallowed_modes() {
    let empty = json!({});
    let mode_blocked =
        detect_communication_fast_path(&empty, "low", "low", "hello", "", "deep-thinker", false);
    assert!(!mode_blocked.matched);
    assert_eq!(mode_blocked.reason, "mode_disallowed");
    assert!(mode_blocked.blocked_pattern.is_none());

    let structured =
        detect_communication_fast_path(&empty, "low", "low", "", "run git status", "normal", false);
    assert!(!structured.matched);
    assert_eq!(structured.reason, "contains_structured_intent");
    assert_eq!(
        structured.blocked_pattern.as_deref(),
        Some("\\b(node|npm|pnpm|yarn|git|curl|python|bash|zsh|ollama)\\b")
    );

    let risk_blocked =
        detect_communication_fast_path(&empty, "medium", "low", "hello there", "", "normal", false);
    assert!(!risk_blocked.matched);
    assert_eq!(risk_blocked.reason, "risk_not_low");
}

#[test]
fn communication_fast_path_detection_matches_pattern_and_heuristic_paths() {
    let pattern_cfg = json!({
        "routing": {
            "communication_fast_path": {
                "match_mode": "patterns",
                "patterns": ["status"],
                "disallow_regexes": [],
                "slot": "grunt",
                "prefer_model": "ollama/smallthinker",
                "fallback_slot": "fallback",
                "skip_outcome_scan": true
            }
        }
    });
    let by_pattern = detect_communication_fast_path(
        &pattern_cfg,
        "low",
        "medium",
        "status",
        "",
        "normal",
        false,
    );
    assert!(by_pattern.matched);
    assert_eq!(by_pattern.reason, "communication_fast_path_pattern");
    assert_eq!(by_pattern.matched_pattern.as_deref(), Some("status"));
    assert_eq!(by_pattern.text.as_deref(), Some("status"));
    assert_eq!(by_pattern.slot.as_deref(), Some("grunt"));
    assert_eq!(
        by_pattern.prefer_model.as_deref(),
        Some("ollama/smallthinker")
    );
    assert_eq!(by_pattern.fallback_slot.as_deref(), Some("fallback"));
    assert_eq!(by_pattern.skip_outcome_scan, Some(true));

    let no_pattern = detect_communication_fast_path(
        &pattern_cfg,
        "low",
        "medium",
        "hello there",
        "",
        "normal",
        false,
    );
    assert!(!no_pattern.matched);
    assert_eq!(no_pattern.reason, "no_pattern_match");

    let heuristic = detect_communication_fast_path(
        &json!({}),
        "medium",
        "high",
        "how are you",
        "",
        "normal",
        true,
    );
    assert!(heuristic.matched);
    assert_eq!(heuristic.reason, "communication_fast_path_heuristic");
    assert_eq!(heuristic.text.as_deref(), Some("how are you"));
    assert_eq!(heuristic.slot.as_deref(), Some("grunt"));
    assert_eq!(heuristic.skip_outcome_scan, Some(true));
}

#[test]
fn fallback_classification_policy_matches_defaults_and_bounds() {
    let defaults = fallback_classification_policy(&json!({}));
    assert!(defaults.enabled);
    assert!(defaults.only_when_medium_medium);
    assert!(defaults.prefer_chat_fast_path);
    assert!((defaults.low_chars_max - 220.0).abs() < 1e-9);
    assert!((defaults.low_newlines_max - 1.0).abs() < 1e-9);
    assert!((defaults.high_chars_min - 1200.0).abs() < 1e-9);
    assert!((defaults.high_newlines_min - 8.0).abs() < 1e-9);
    assert!((defaults.high_tokens_min - 2200.0).abs() < 1e-9);

    let cfg = json!({
        "routing": {
            "fallback_classification_policy": {
                "enabled": "off",
                "only_when_medium_medium": "0",
                "prefer_chat_fast_path": "false",
                "low_chars_max": 9999,
                "low_newlines_max": -4,
                "high_chars_min": 9,
                "high_newlines_min": 222,
                "high_tokens_min": "30123"
            }
        }
    });
    let overridden = fallback_classification_policy(&cfg);
    assert!(!overridden.enabled);
    assert!(!overridden.only_when_medium_medium);
    assert!(!overridden.prefer_chat_fast_path);
    assert!((overridden.low_chars_max - 600.0).abs() < 1e-9);
    assert!((overridden.low_newlines_max - 0.0).abs() < 1e-9);
    assert!((overridden.high_chars_min - 240.0).abs() < 1e-9);
    assert!((overridden.high_newlines_min - 80.0).abs() < 1e-9);
    assert!((overridden.high_tokens_min - 30000.0).abs() < 1e-9);
}

#[test]
fn fallback_route_classification_respects_disable_force_and_generic_medium_gate() {
    let disabled_cfg = json!({
        "routing": {
            "fallback_classification_policy": {
                "enabled": false
            }
        }
    });
    let disabled = fallback_route_classification(FallbackRouteClassificationInput {
        cfg: &disabled_cfg,
        requested_risk: "unknown",
        requested_complexity: "unknown",
        intent: "hello",
        task: "",
        mode: "normal",
        role: "",
        tokens_est: None,
        class_policy: None,
    });
    assert!(!disabled.enabled);
    assert!(!disabled.applied);
    assert_eq!(disabled.reason, "disabled");
    assert_eq!(disabled.risk, "medium");
    assert_eq!(disabled.complexity, "medium");
    assert_eq!(disabled.role, "general");

    let forced_class = route_class_policy(&json!({}), "reflex");
    let forced = fallback_route_classification(FallbackRouteClassificationInput {
        cfg: &json!({}),
        requested_risk: "medium",
        requested_complexity: "medium",
        intent: "hello",
        task: "",
        mode: "normal",
        role: "general",
        tokens_est: None,
        class_policy: Some(&forced_class),
    });
    assert!(forced.enabled);
    assert!(!forced.applied);
    assert_eq!(forced.reason, "route_class_forced");

    let not_generic = fallback_route_classification(FallbackRouteClassificationInput {
        cfg: &json!({}),
        requested_risk: "low",
        requested_complexity: "medium",
        intent: "hello",
        task: "",
        mode: "normal",
        role: "general",
        tokens_est: None,
        class_policy: None,
    });
    assert!(not_generic.enabled);
    assert!(!not_generic.applied);
    assert_eq!(not_generic.reason, "not_generic_medium");
}

#[test]
fn fallback_route_classification_matches_fast_path_escalation_and_short_text_paths() {
    let fast_path = fallback_route_classification(FallbackRouteClassificationInput {
        cfg: &json!({}),
        requested_risk: "medium",
        requested_complexity: "medium",
        intent: "quick status",
        task: "",
        mode: "normal",
        role: "general",
        tokens_est: None,
        class_policy: None,
    });
    assert!(fast_path.applied);
    assert_eq!(fast_path.reason, "generic_medium_fast_path");
    assert_eq!(fast_path.risk, "low");
    assert_eq!(fast_path.complexity, "low");
    assert_eq!(fast_path.role, "chat");

    let escalation_cfg = json!({
        "routing": {
            "fallback_classification_policy": {
                "prefer_chat_fast_path": false,
                "high_chars_min": 30,
                "high_newlines_min": 5,
                "high_tokens_min": 1000
            }
        }
    });
    let escalated = fallback_route_classification(FallbackRouteClassificationInput {
        cfg: &escalation_cfg,
        requested_risk: "medium",
        requested_complexity: "medium",
        intent: "a fairly long request body that should escalate by character count",
        task: "",
        mode: "normal",
        role: "chat",
        tokens_est: Some(1200.0),
        class_policy: None,
    });
    assert!(escalated.applied);
    assert_eq!(escalated.reason, "generic_medium_complexity_escalation");
    assert_eq!(escalated.risk, "medium");
    assert_eq!(escalated.complexity, "high");
    assert_eq!(escalated.role, "general");

    let short_cfg = json!({
        "routing": {
            "fallback_classification_policy": {
                "prefer_chat_fast_path": false,
                "high_chars_min": 5000,
                "high_newlines_min": 99,
                "high_tokens_min": 5000
            }
        }
    });
    let short = fallback_route_classification(FallbackRouteClassificationInput {
        cfg: &short_cfg,
        requested_risk: "medium",
        requested_complexity: "medium",
        intent: "thanks",
        task: "",
        mode: "normal",
        role: "general",
        tokens_est: None,
        class_policy: None,
    });
    assert!(short.applied);
    assert_eq!(short.reason, "generic_medium_short_text");
    assert_eq!(short.risk, "low");
    assert_eq!(short.complexity, "low");
    assert_eq!(short.role, "chat");

    let no_override = fallback_route_classification(FallbackRouteClassificationInput {
        cfg: &short_cfg,
        requested_risk: "medium",
        requested_complexity: "medium",
        intent: "",
        task: "git status",
        mode: "normal",
        role: "general",
        tokens_est: None,
        class_policy: None,
    });
    assert!(!no_override.applied);
    assert_eq!(no_override.reason, "no_override");
    assert_eq!(no_override.risk, "medium");
    assert_eq!(no_override.complexity, "medium");
    assert_eq!(no_override.role, "general");
}

#[test]
fn router_budget_policy_matches_defaults_and_overrides() {
    let defaults = router_budget_policy(&json!({}), Path::new("/repo"), ROUTER_BUDGET_DIR_DEFAULT);
    assert!(defaults.enabled);
    assert!(defaults.allow_strategy_override);
    assert!((defaults.soft_ratio - 0.75).abs() < 1e-9);
    assert!((defaults.hard_ratio - 0.92).abs() < 1e-9);
    assert!(defaults.enforce_hard_cap);
    assert!(defaults.escalate_on_no_local_fallback);
    assert!((defaults.cloud_penalty_soft - 4.0).abs() < 1e-9);
    assert!((defaults.cloud_penalty_hard - 10.0).abs() < 1e-9);
    assert!(defaults
        .state_dir
        .ends_with("local/state/autonomy/daily_budget"));
    assert_eq!(
        defaults
            .class_token_multipliers
            .get("cheap_local")
            .and_then(Value::as_f64),
        Some(0.42)
    );
    assert_eq!(
        defaults
            .class_token_multipliers
            .get("default")
            .and_then(Value::as_f64),
        Some(1.0)
    );

    let cfg = json!({
        "routing": {
            "router_budget_policy": {
                "enabled": "off",
                "state_dir": "tmp/router_budget",
                "allow_strategy_override": "0",
                "soft_ratio": 1.5,
                "hard_ratio": 0.1,
                "enforce_hard_cap": "false",
                "escalate_on_no_local_fallback": "no",
                "cloud_penalty_soft": 99,
                "cloud_penalty_hard": -10,
                "cheap_local_bonus_soft": 77,
                "cheap_local_bonus_hard": 88,
                "model_token_multipliers": {
                    "openai/gpt-4.1": "1.8"
                },
                "class_token_multipliers": {
                    "cloud": 2.5,
                    "local": 0
                }
            }
        }
    });
    let overridden = router_budget_policy(&cfg, Path::new("/repo"), ROUTER_BUDGET_DIR_DEFAULT);
    assert!(!overridden.enabled);
    assert!(!overridden.allow_strategy_override);
    assert!((overridden.soft_ratio - 0.98).abs() < 1e-9);
    assert!((overridden.hard_ratio - 0.3).abs() < 1e-9);
    assert!(!overridden.enforce_hard_cap);
    assert!(!overridden.escalate_on_no_local_fallback);
    assert!((overridden.cloud_penalty_soft - 40.0).abs() < 1e-9);
    assert!((overridden.cloud_penalty_hard - 0.0).abs() < 1e-9);
    assert!((overridden.cheap_local_bonus_soft - 40.0).abs() < 1e-9);
    assert!((overridden.cheap_local_bonus_hard - 60.0).abs() < 1e-9);
    assert!(overridden.state_dir.ends_with("tmp/router_budget"));
    assert_eq!(
        overridden
            .model_token_multipliers
            .get("openai/gpt-4.1")
            .and_then(Value::as_str),
        Some("1.8")
    );
    assert_eq!(
        overridden
            .class_token_multipliers
            .get("cloud")
            .and_then(Value::as_f64),
        Some(2.5)
    );
    assert_eq!(
        overridden
            .class_token_multipliers
            .get("local")
            .and_then(Value::as_i64),
        Some(0)
    );
}

#[test]
fn budget_date_str_prefers_valid_override() {
    assert_eq!(
        budget_date_str("2026-03-01", "2020-01-01T00:00:00.000Z"),
        "2026-03-01"
    );
    assert_eq!(
        budget_date_str("bad-date", "2026-03-05T12:34:56.000Z"),
        "2026-03-05"
    );
    assert_eq!(budget_date_str("", "short"), "short");
}

#[test]
fn router_burn_oracle_signal_normalizes_pressure_and_limits_reason_codes() {
    let signal = router_burn_oracle_signal(
        Some(&json!({
            "available": true,
            "pressure": "CRITICAL",
            "projected_runway_days": "1.5",
            "projected_days_to_reset": 3,
            "reason_codes": ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
            "latest_path_rel": "local/state/ops/dynamic_burn_budget_oracle/latest.json"
        })),
        ROUTER_BURN_ORACLE_LATEST_PATH_REL_DEFAULT,
    );
    assert_eq!(signal["available"], true);
    assert_eq!(signal["pressure"], "hard");
    assert_eq!(signal["pressure_rank"], 4);
    assert_eq!(signal["projected_runway_days"], 1.5);
    assert_eq!(signal["projected_days_to_reset"], 3.0);
    assert_eq!(
        signal["source_path"],
        "local/state/ops/dynamic_burn_budget_oracle/latest.json"
    );
    assert_eq!(
        signal["reason_codes"].as_array().map(|rows| rows.len()),
        Some(10)
    );

    let fallback = router_burn_oracle_signal(None, "local/state/default/latest.json");
    assert_eq!(fallback["available"], false);
    assert_eq!(fallback["pressure"], "none");
    assert_eq!(fallback["pressure_rank"], 0);
    assert_eq!(fallback["source_path"], "local/state/default/latest.json");
    assert_eq!(
        fallback["reason_codes"].as_array().map(|rows| rows.len()),
        Some(0)
    );
}

#[test]
fn router_budget_state_matches_disabled_unavailable_and_oracle_override_paths() {
    let disabled = router_budget_state(RouterBudgetStateInput {
        cfg: &json!({
            "routing": {
                "router_budget_policy": {
                    "enabled": false
                }
            }
        }),
        repo_root: Path::new("/repo"),
        default_state_dir: ROUTER_BUDGET_DIR_DEFAULT,
        today_override: "2026-03-05",
        now_iso: "2026-03-05T00:00:00.000Z",
        budget_state: None,
        oracle_signal: None,
        default_oracle_source_path: ROUTER_BURN_ORACLE_LATEST_PATH_REL_DEFAULT,
    });
    assert_eq!(disabled["enabled"], false);
    assert_eq!(disabled["available"], false);
    assert_eq!(disabled["path"], Value::Null);

    let unavailable = router_budget_state(RouterBudgetStateInput {
        cfg: &json!({}),
        repo_root: Path::new("/repo"),
        default_state_dir: ROUTER_BUDGET_DIR_DEFAULT,
        today_override: "2026-03-06",
        now_iso: "2026-03-05T00:00:00.000Z",
        budget_state: None,
        oracle_signal: Some(&json!({
            "available": true,
            "pressure": "soft"
        })),
        default_oracle_source_path: ROUTER_BURN_ORACLE_LATEST_PATH_REL_DEFAULT,
    });
    assert_eq!(unavailable["enabled"], true);
    assert_eq!(unavailable["available"], false);
    assert_eq!(
        unavailable["path"],
        "/repo/local/state/autonomy/daily_budget/2026-03-06.json"
    );
    assert_eq!(unavailable["pressure"], "none");
    assert_eq!(unavailable["oracle"]["pressure"], "soft");

    let overridden = router_budget_state(RouterBudgetStateInput {
        cfg: &json!({}),
        repo_root: Path::new("/repo"),
        default_state_dir: ROUTER_BUDGET_DIR_DEFAULT,
        today_override: "2026-03-07",
        now_iso: "2026-03-05T00:00:00.000Z",
        budget_state: Some(&json!({
            "available": true,
            "path": "/tmp/router-budget.json",
            "token_cap": 1000,
            "used_est": 760,
            "strategy_id": "strat-1"
        })),
        oracle_signal: Some(&json!({
            "available": true,
            "pressure": "hard"
        })),
        default_oracle_source_path: ROUTER_BURN_ORACLE_LATEST_PATH_REL_DEFAULT,
    });
    assert_eq!(overridden["available"], true);
    assert_eq!(overridden["path"], "/tmp/router-budget.json");
    assert_eq!(overridden["ratio"], 0.76);
    assert_eq!(overridden["token_cap"], 1000.0);
    assert_eq!(overridden["used_est"], 760.0);
    assert_eq!(overridden["pressure"], "hard");
    assert_eq!(overridden["strategy_id"], "strat-1");
}

#[test]
fn evaluate_router_global_budget_gate_matches_bypass_oracle_and_autopause_paths() {
    let bypass = evaluate_router_global_budget_gate(RouterGlobalBudgetGateInput {
        request_tokens_est: Some(800.0),
        dry_run: Some(&json!(false)),
        execution_intent: Some(&json!(false)),
        enforce_execution_only: true,
        nonexec_max_tokens: 900,
        autopause: Some(&json!({"active": true, "source": "operator", "reason": "manual"})),
        oracle: None,
        guard: None,
    });
    assert!(bypass.enabled);
    assert!(!bypass.blocked);
    assert!(!bypass.deferred);
    assert!(bypass.bypassed);
    assert_eq!(
        bypass.reason.as_deref(),
        Some("budget_guard_nonexecute_bypass")
    );
    assert!(bypass.autopause_active);

    let oracle_block = evaluate_router_global_budget_gate(RouterGlobalBudgetGateInput {
        request_tokens_est: Some(1200.0),
        dry_run: Some(&json!(false)),
        execution_intent: Some(&json!(true)),
        enforce_execution_only: true,
        nonexec_max_tokens: 900,
        autopause: Some(&json!({"active": false})),
        oracle: Some(&json!({"available": true, "pressure": "hard"})),
        guard: None,
    });
    assert!(oracle_block.enabled);
    assert!(oracle_block.blocked);
    assert!(!oracle_block.deferred);
    assert_eq!(
        oracle_block.reason.as_deref(),
        Some("budget_oracle_runway_critical")
    );
    assert_eq!(
        oracle_block.oracle.as_ref().map(|v| v["pressure"].clone()),
        Some(json!("hard"))
    );

    let recovered_autopause = evaluate_router_global_budget_gate(RouterGlobalBudgetGateInput {
        request_tokens_est: Some(1000.0),
        dry_run: Some(&json!(false)),
        execution_intent: Some(&json!(true)),
        enforce_execution_only: true,
        nonexec_max_tokens: 900,
        autopause: Some(
            &json!({"active": true, "source": "model_router", "reason": "prior_hard_stop", "until": "2026-03-05T10:00:00.000Z"}),
        ),
        oracle: Some(&json!({"available": false})),
        guard: Some(&json!({"hard_stop": false, "pressure": "none"})),
    });
    assert!(recovered_autopause.enabled);
    assert!(!recovered_autopause.blocked);
    assert!(!recovered_autopause.deferred);
    assert!(!recovered_autopause.autopause_active);
    assert!(recovered_autopause.reason.is_none());
}
