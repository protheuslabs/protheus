use crate::legacy_bridge::{resolve_script_path, run_legacy_script_compat};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

const LEGACY_SCRIPT_ENV: &str = "PROTHEUS_MODEL_ROUTER_LEGACY_SCRIPT";
const LEGACY_SCRIPT_DEFAULT: &str = "systems/routing/model_router_legacy.js";

pub fn run(root: &Path, args: &[String]) -> i32 {
    let script = resolve_script_path(root, LEGACY_SCRIPT_ENV, LEGACY_SCRIPT_DEFAULT);
    run_legacy_script_compat(root, "model_router", &script, args, false)
}

fn normalize_key(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

pub fn is_local_ollama_model(model_id: &str) -> bool {
    let model = model_id.trim();
    !model.is_empty() && model.starts_with("ollama/") && !model.contains(":cloud")
}

pub fn is_cloud_model(model_id: &str) -> bool {
    let model = model_id.trim();
    !model.is_empty() && (model.contains(":cloud") || !model.starts_with("ollama/"))
}

pub fn ollama_model_name(model_id: &str) -> String {
    model_id.trim_start_matches("ollama/").to_string()
}

pub fn infer_tier(risk: &str, complexity: &str) -> u8 {
    let risk_norm = normalize_key(risk);
    let complexity_norm = normalize_key(complexity);
    if risk_norm == "high" || complexity_norm == "high" {
        return 3;
    }
    if risk_norm == "medium" || complexity_norm == "medium" {
        return 2;
    }
    1
}

fn tokenize(text: &str) -> HashSet<String> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_')
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

fn has_any_exact(tokens: &HashSet<String>, words: &[&str]) -> bool {
    words
        .iter()
        .any(|w| tokens.contains(&w.to_ascii_lowercase()))
}

fn has_prefix(tokens: &HashSet<String>, prefix: &str) -> bool {
    let p = prefix.to_ascii_lowercase();
    tokens.iter().any(|t| t.starts_with(&p))
}

pub fn infer_role(intent: &str, task: &str) -> String {
    let combined = format!("{} {}", intent, task);
    let tokens = tokenize(&combined);

    if has_any_exact(
        &tokens,
        &[
            "code",
            "refactor",
            "patch",
            "bug",
            "test",
            "typescript",
            "javascript",
            "python",
            "node",
            "compile",
        ],
    ) {
        return "coding".to_string();
    }

    if has_any_exact(
        &tokens,
        &[
            "tool",
            "api",
            "curl",
            "exec",
            "command",
            "shell",
            "cli",
            "automation",
        ],
    ) || has_prefix(&tokens, "integrat")
    {
        return "tools".to_string();
    }

    let has_parallel_agent = tokens.contains("parallel") && tokens.contains("agent");
    if has_any_exact(&tokens, &["swarm", "multi-agent", "handoff", "delegate"])
        || has_parallel_agent
    {
        return "swarm".to_string();
    }

    if has_any_exact(&tokens, &["plan", "roadmap", "strategy", "backlog", "roi"])
        || has_prefix(&tokens, "priorit")
    {
        return "planning".to_string();
    }

    if has_any_exact(
        &tokens,
        &["prove", "formal", "derive", "reason", "logic", "constraint"],
    ) {
        return "logic".to_string();
    }

    if has_any_exact(
        &tokens,
        &[
            "chat", "reply", "post", "comment", "write", "summar", "explain",
        ],
    ) {
        return "chat".to_string();
    }

    "general".to_string()
}

pub fn normalize_capability_key(value: &str) -> String {
    let src = normalize_key(value);
    if src.is_empty() {
        return String::new();
    }

    let mut sanitized = String::with_capacity(src.len());
    for ch in src.chars() {
        let out = if ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || ch == ':'
            || ch == '_'
            || ch == '-'
        {
            ch
        } else {
            '_'
        };
        sanitized.push(out);
    }

    let mut collapsed = String::with_capacity(sanitized.len());
    let mut prev_underscore = false;
    for ch in sanitized.chars() {
        if ch == '_' {
            if prev_underscore {
                continue;
            }
            prev_underscore = true;
        } else {
            prev_underscore = false;
        }
        collapsed.push(ch);
    }

    collapsed
        .trim_matches('_')
        .chars()
        .take(72)
        .collect::<String>()
}

pub fn infer_capability(intent: &str, task: &str, role: &str) -> String {
    let combined = format!("{} {}", intent, task);
    let tokens = tokenize(&combined);

    if has_any_exact(
        &tokens,
        &["edit", "patch", "refactor", "rewrite", "modify", "fix"],
    ) {
        return "file_edit".to_string();
    }
    if has_any_exact(&tokens, &["read", "list", "show", "inspect", "cat"]) {
        return "file_read".to_string();
    }
    if has_any_exact(
        &tokens,
        &[
            "tool",
            "api",
            "curl",
            "exec",
            "command",
            "shell",
            "cli",
            "automation",
        ],
    ) {
        return "tool_use".to_string();
    }
    if has_any_exact(&tokens, &["plan", "roadmap", "strategy", "backlog", "roi"])
        || has_prefix(&tokens, "priorit")
    {
        return "planning".to_string();
    }
    if has_any_exact(
        &tokens,
        &["reply", "respond", "chat", "comment", "summar", "explain"],
    ) {
        return "chat".to_string();
    }

    let role_key = normalize_key(role);
    if role_key.is_empty() {
        "general".to_string()
    } else {
        format!("role:{role_key}")
    }
}

pub fn capability_family_key(capability: &str) -> String {
    let cap = normalize_capability_key(capability);
    if cap.is_empty() {
        return String::new();
    }

    let parts = cap
        .split(':')
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return String::new();
    }
    if parts[0] == "proposal" {
        return if parts.len() >= 2 {
            format!("proposal_{}", parts[1])
        } else {
            "proposal".to_string()
        };
    }
    if parts.len() >= 2 {
        return format!("{}_{}", parts[0], parts[1]);
    }
    parts[0].to_string()
}

pub fn task_type_key_from_route(route_class: &str, capability: &str, role: &str) -> String {
    let route_class_key = normalize_key(route_class);
    if !route_class_key.is_empty() && route_class_key != "default" {
        return format!("class:{route_class_key}");
    }

    let capability_family = capability_family_key(capability);
    if !capability_family.is_empty() {
        return format!("cap:{capability_family}");
    }

    let role_key = normalize_key(role);
    if !role_key.is_empty() {
        return format!("role:{role_key}");
    }
    "general".to_string()
}

pub fn normalize_risk_level(value: &str) -> String {
    let risk = normalize_key(value);
    match risk.as_str() {
        "low" | "medium" | "high" => risk,
        _ => "medium".to_string(),
    }
}

pub fn normalize_complexity_level(value: &str) -> String {
    let complexity = normalize_key(value);
    match complexity.as_str() {
        "low" | "medium" | "high" => complexity,
        _ => "medium".to_string(),
    }
}

pub fn pressure_order(value: &str) -> u8 {
    match normalize_key(value).as_str() {
        "critical" => 4,
        "hard" | "high" => 3,
        "soft" | "medium" => 2,
        "low" => 1,
        _ => 0,
    }
}

pub fn normalize_router_pressure(value: &str) -> String {
    match normalize_key(value).as_str() {
        "critical" | "hard" | "high" => "hard".to_string(),
        "soft" | "medium" => "soft".to_string(),
        _ => "none".to_string(),
    }
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    let raw = value?;
    match raw {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
        Value::Bool(true) => Some(1.0),
        Value::Bool(false) => Some(0.0),
        _ => None,
    }
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) | None => false,
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn js_number_from_truthy_or(default: f64, value: Option<&Value>) -> f64 {
    if !js_truthy(value) {
        return default;
    }
    finite_number(value).unwrap_or(default)
}

fn object_field<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    obj.get(key)
}

fn string_or_null(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .map(|v| Value::String(v.to_string()))
        .unwrap_or(Value::Null)
}

pub fn build_handoff_packet(decision: &Value) -> Value {
    let Some(obj) = decision.as_object() else {
        return json!({
            "selected_model": null,
            "previous_model": null,
            "model_changed": false,
            "reason": null,
            "tier": 2,
            "role": null,
            "route_class": "default",
            "mode": null,
            "slot": null,
            "escalation_chain": []
        });
    };

    // Keep JS `Number(d.tier || 2)` behavior: numeric zero defaults to 2.
    let tier_num = js_number_from_truthy_or(2.0, object_field(obj, "tier"));
    let tier = if tier_num.is_finite() {
        tier_num.round() as i64
    } else {
        2
    };
    let role = normalize_key(
        object_field(obj, "role")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );

    let escalation_limit = (tier + 1).clamp(2, 4) as usize;
    let escalation_chain = object_field(obj, "escalation_chain")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .take(escalation_limit)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut out = json!({
        "selected_model": string_or_null(object_field(obj, "selected_model")),
        "previous_model": string_or_null(object_field(obj, "previous_model")),
        "model_changed": object_field(obj, "model_changed").and_then(Value::as_bool).unwrap_or(false),
        "reason": string_or_null(object_field(obj, "reason")),
        "tier": tier,
        "role": if role.is_empty() { Value::Null } else { Value::String(role.clone()) },
        "route_class": object_field(obj, "route_class").and_then(Value::as_str).unwrap_or("default"),
        "mode": string_or_null(object_field(obj, "mode")),
        "slot": string_or_null(object_field(obj, "slot")),
        "escalation_chain": escalation_chain
    });

    let out_obj = out
        .as_object_mut()
        .expect("handoff packet root should always be an object");

    if object_field(obj, "fast_path")
        .and_then(Value::as_object)
        .and_then(|v| v.get("matched"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        out_obj.insert(
            "fast_path".to_string(),
            Value::String("communication".to_string()),
        );
    }

    if let Some(budget) = object_field(obj, "budget").and_then(Value::as_object) {
        let pressure = budget
            .get("pressure")
            .and_then(Value::as_str)
            .unwrap_or("none");
        let projected_pressure = budget
            .get("projected_pressure")
            .and_then(Value::as_str)
            .or_else(|| budget.get("pressure").and_then(Value::as_str))
            .unwrap_or("none");
        let request_tokens_est = finite_number(budget.get("request_tokens_est"))
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null);

        out_obj.insert(
            "budget".to_string(),
            json!({
                "pressure": pressure,
                "projected_pressure": projected_pressure,
                "request_tokens_est": request_tokens_est
            }),
        );
    }

    let role_with_capability = matches!(
        role.as_str(),
        "coding" | "tools" | "swarm" | "planning" | "logic"
    );
    if tier >= 2 || role_with_capability {
        out_obj.insert(
            "capability".to_string(),
            string_or_null(object_field(obj, "capability")),
        );
        out_obj.insert(
            "fallback_slot".to_string(),
            string_or_null(object_field(obj, "fallback_slot")),
        );
    }

    if tier >= 3 {
        out_obj.insert(
            "guardrails".to_string(),
            json!({
                "deep_thinker": js_truthy(object_field(obj, "deep_thinker")),
                "verification_required": true
            }),
        );
        if js_truthy(object_field(obj, "post_task_return_model")) {
            out_obj.insert(
                "post_task_return_model".to_string(),
                object_field(obj, "post_task_return_model")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
        }
    }

    if let Some(budget_enforcement) =
        object_field(obj, "budget_enforcement").and_then(Value::as_object)
    {
        out_obj.insert(
            "budget_enforcement".to_string(),
            json!({
                "action": string_or_null(budget_enforcement.get("action")),
                "reason": string_or_null(budget_enforcement.get("reason")),
                "blocked": matches!(budget_enforcement.get("blocked"), Some(Value::Bool(true)))
            }),
        );
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(out_truthy_non_numeric["budget"]["request_tokens_est"], Value::Null);
        assert_eq!(out_truthy_non_numeric["budget"]["projected_pressure"], "hard");

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
        assert_eq!(
            infer_role("prioritize candidate fixes", ""),
            "planning"
        );
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
        assert_eq!(high["escalation_chain"].as_array().map(|v| v.len()), Some(4));
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
}
