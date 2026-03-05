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

pub const ROUTER_MIN_REQUEST_TOKENS: i64 = 120;
pub const ROUTER_MAX_REQUEST_TOKENS: i64 = 12_000;
pub const ROUTER_PROBE_SUPPRESSION_TIMEOUT_STREAK_DEFAULT: i64 = 3;
pub const ROUTER_PROBE_SUPPRESSION_MINUTES_DEFAULT: i64 = 45;
pub const ROUTER_PROBE_REHAB_SUCCESS_THRESHOLD_DEFAULT: i64 = 2;
pub const DEFAULT_FAST_PATH_DISALLOW_REGEXES: [&str; 5] = [
    "https?:\\/\\/",
    "(^|\\s)--?[a-z0-9][a-z0-9_-]*\\b",
    "\\b(node|npm|pnpm|yarn|git|curl|python|bash|zsh|ollama)\\b",
    "[`{}\\[\\]<>$;=]",
    "(^|\\s)(~\\/|\\.\\.?\\/|\\/users\\/|[a-z]:\\\\)",
];

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

pub fn is_env_probe_blocked_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    (lower.contains("operation not permitted") && lower.contains("11434"))
        || (lower.contains("permission denied") && lower.contains("11434"))
        || (lower.contains("sandbox") && lower.contains("11434"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeBlockedNormalization {
    pub rec: Option<Value>,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeHealthStabilizerPolicy {
    pub suppression_enabled: bool,
    pub suppression_timeout_streak: i64,
    pub suppression_minutes: i64,
    pub rehab_success_threshold: i64,
}

impl Default for ProbeHealthStabilizerPolicy {
    fn default() -> Self {
        Self {
            suppression_enabled: true,
            suppression_timeout_streak: ROUTER_PROBE_SUPPRESSION_TIMEOUT_STREAK_DEFAULT,
            suppression_minutes: ROUTER_PROBE_SUPPRESSION_MINUTES_DEFAULT,
            rehab_success_threshold: ROUTER_PROBE_REHAB_SUCCESS_THRESHOLD_DEFAULT,
        }
    }
}

fn clamp_request_tokens(value: i64) -> i64 {
    value.clamp(ROUTER_MIN_REQUEST_TOKENS, ROUTER_MAX_REQUEST_TOKENS)
}

fn to_bool_like_value(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Null) | None => fallback,
        Some(Value::String(raw)) => match normalize_key(raw).as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        _ => fallback,
    }
}

fn to_bounded_number_like(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    let number = finite_number(value).unwrap_or(fallback as f64);
    let clamped = number.clamp(min as f64, max as f64);
    clamped as i64
}

fn to_bounded_number_like_f64(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    finite_number(value).unwrap_or(fallback).clamp(min, max)
}

fn string_or(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn value_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_str()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| row.to_string().trim_matches('"').to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn contains_cli_flag(raw_text: &str) -> bool {
    raw_text.split_whitespace().any(|token| {
        let tok = token.trim();
        if tok.len() < 2 || !tok.starts_with('-') {
            return false;
        }
        let tail = tok.trim_start_matches('-');
        if tail.is_empty() {
            return false;
        }
        let mut chars = tail.chars();
        let first = chars.next().unwrap_or_default();
        if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
            return false;
        }
        chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
    })
}

fn contains_shell_or_path_marker(raw_text: &str) -> bool {
    let lower = raw_text.to_ascii_lowercase();
    if lower.contains("~/") || lower.contains("../") || lower.contains("./") || lower.contains("/users/") {
        return true;
    }
    lower
        .as_bytes()
        .windows(3)
        .any(|w| w[0].is_ascii_lowercase() && w[1] == b':' && w[2] == b'\\')
}

fn pattern_match_ci(pattern: &str, text: &str, raw_text: &str) -> bool {
    let pattern_key = pattern.trim().to_ascii_lowercase();
    let raw_lower = raw_text.to_ascii_lowercase();
    match pattern_key.as_str() {
        "https?:\\/\\/" => raw_lower.contains("http://") || raw_lower.contains("https://"),
        "(^|\\s)--?[a-z0-9][a-z0-9_-]*\\b" => contains_cli_flag(raw_text),
        "\\b(node|npm|pnpm|yarn|git|curl|python|bash|zsh|ollama)\\b" => {
            let tokens = tokenize(raw_text);
            [
                "node", "npm", "pnpm", "yarn", "git", "curl", "python", "bash", "zsh", "ollama",
            ]
            .iter()
            .any(|token| tokens.contains(*token))
        }
        "[`{}\\[\\]<>$;=]" => raw_text
            .chars()
            .any(|ch| matches!(ch, '`' | '{' | '}' | '[' | ']' | '<' | '>' | '$' | ';' | '=')),
        "(^|\\s)(~\\/|\\.\\.?\\/|\\/users\\/|[a-z]:\\\\)" => contains_shell_or_path_marker(raw_text),
        _ => {
            let simplified = pattern_key
                .replace("\\b", "")
                .replace("\\s", " ")
                .replace("\\/", "/")
                .replace("\\\\", "\\");
            let needle = simplified.trim_matches(|ch| ch == '^' || ch == '$' || ch == '(' || ch == ')' || ch == '?');
            !needle.is_empty() && text.to_ascii_lowercase().contains(needle)
        }
    }
}

pub fn estimate_request_tokens(tokens_est: Option<f64>, intent: &str, task: &str) -> i64 {
    if let Some(direct) = tokens_est {
        if direct.is_finite() && direct > 0.0 {
            return clamp_request_tokens(direct.round() as i64);
        }
    }

    let text = format!("{intent} {task}");
    let text = text.trim();
    let chars = text.chars().count() as f64;
    let words = if text.is_empty() {
        0.0
    } else {
        text.split_whitespace().count() as f64
    };
    let heuristic = ((chars / 3.6) + (words * 1.6) + 80.0).round() as i64;
    clamp_request_tokens(heuristic)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelTokenMultiplier {
    pub multiplier: f64,
    pub source: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelTokenEstimate {
    pub tokens_est: Option<i64>,
    pub multiplier: Option<f64>,
    pub source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteClassPolicy {
    pub id: String,
    pub force_risk: Option<String>,
    pub force_complexity: Option<String>,
    pub force_role: String,
    pub prefer_slot: Option<String>,
    pub prefer_model: Option<String>,
    pub fallback_slot: Option<String>,
    pub disable_fast_path: bool,
    pub max_tokens_est: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeAdjustmentInput {
    pub risk: String,
    pub complexity: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeAdjustment {
    pub risk: String,
    pub complexity: String,
    pub role: String,
    pub mode: String,
    pub mode_adjusted: bool,
    pub mode_reason: Option<String>,
    pub mode_policy_source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommunicationFastPathPolicy {
    pub enabled: bool,
    pub match_mode: String,
    pub max_chars: i64,
    pub max_words: i64,
    pub max_newlines: i64,
    pub patterns: Vec<String>,
    pub disallow_regexes: Vec<String>,
    pub slot: String,
    pub prefer_model: String,
    pub fallback_slot: String,
    pub skip_outcome_scan: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommunicationFastPathResult {
    pub matched: bool,
    pub reason: String,
    pub policy: CommunicationFastPathPolicy,
    pub blocked_pattern: Option<String>,
    pub matched_pattern: Option<String>,
    pub text: Option<String>,
    pub slot: Option<String>,
    pub prefer_model: Option<String>,
    pub fallback_slot: Option<String>,
    pub skip_outcome_scan: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FallbackClassificationPolicy {
    pub enabled: bool,
    pub only_when_medium_medium: bool,
    pub prefer_chat_fast_path: bool,
    pub low_chars_max: f64,
    pub low_newlines_max: f64,
    pub high_chars_min: f64,
    pub high_newlines_min: f64,
    pub high_tokens_min: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FallbackRouteClassification {
    pub enabled: bool,
    pub applied: bool,
    pub reason: String,
    pub risk: String,
    pub complexity: String,
    pub role: String,
}

#[derive(Debug, Clone, Copy)]
pub struct FallbackRouteClassificationInput<'a> {
    pub cfg: &'a Value,
    pub requested_risk: &'a str,
    pub requested_complexity: &'a str,
    pub intent: &'a str,
    pub task: &'a str,
    pub mode: &'a str,
    pub role: &'a str,
    pub tokens_est: Option<f64>,
    pub class_policy: Option<&'a RouteClassPolicy>,
}

fn js_truthy_value(value: &Value) -> bool {
    js_truthy(Some(value))
}

fn first_truthy_value<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a Value> {
    candidates
        .iter()
        .flatten()
        .copied()
        .find(|value| js_truthy_value(value))
}

fn object_or_empty(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new)
}

fn number_or_default(value: Option<&Value>, fallback: i64) -> i64 {
    finite_number(value).map_or(fallback, |v| v as i64)
}

fn js_number_with_or_zero(value: Option<&Value>) -> f64 {
    if !js_truthy(value) {
        return 0.0;
    }
    finite_number(value).unwrap_or(f64::NAN)
}

pub fn resolve_model_token_multiplier(
    model_id: &str,
    profile_class: &str,
    policy: &Value,
) -> ModelTokenMultiplier {
    let key = normalize_key(model_id);
    let by_model = policy
        .as_object()
        .and_then(|obj| obj.get("model_token_multipliers"))
        .and_then(Value::as_object);

    if let Some(by_model_map) = by_model {
        for (model, raw_multiplier) in by_model_map {
            if normalize_key(model) != key {
                continue;
            }
            let multiplier = finite_number(Some(raw_multiplier)).unwrap_or(f64::NAN);
            if multiplier.is_finite() && multiplier > 0.0 {
                return ModelTokenMultiplier {
                    multiplier,
                    source: "model",
                };
            }
        }
    }

    let class_multipliers = policy
        .as_object()
        .and_then(|obj| obj.get("class_token_multipliers"))
        .and_then(Value::as_object);
    let class_key = normalize_key(profile_class);
    let fallback_class = if is_local_ollama_model(model_id) {
        "local"
    } else {
        "cloud"
    };
    let selected = class_multipliers.and_then(|map| {
        first_truthy_value(&[
            map.get(&class_key),
            map.get(fallback_class),
            map.get("default"),
        ])
    });
    let class_value = finite_number(selected).unwrap_or(1.0);
    if class_value.is_finite() && class_value > 0.0 {
        return ModelTokenMultiplier {
            multiplier: class_value,
            source: "class",
        };
    }

    ModelTokenMultiplier {
        multiplier: 1.0,
        source: "default",
    }
}

pub fn estimate_model_request_tokens(
    model_id: &str,
    request_tokens: Option<f64>,
    profile_class: &str,
    policy: &Value,
) -> ModelTokenEstimate {
    let req = request_tokens.unwrap_or(f64::NAN);
    if !req.is_finite() || req <= 0.0 {
        return ModelTokenEstimate {
            tokens_est: None,
            multiplier: None,
            source: "none",
        };
    }

    let detail = resolve_model_token_multiplier(model_id, profile_class, policy);
    let est = clamp_request_tokens((req * detail.multiplier).round() as i64);
    let rounded_multiplier = ((detail.multiplier * 10_000.0).round()) / 10_000.0;
    ModelTokenEstimate {
        tokens_est: Some(est),
        multiplier: Some(rounded_multiplier),
        source: detail.source,
    }
}

pub fn normalize_probe_blocked_record(rec: Option<&Value>) -> ProbeBlockedNormalization {
    let mut row = match rec.and_then(Value::as_object).cloned() {
        Some(value) => value,
        None => {
            return ProbeBlockedNormalization {
                rec: None,
                changed: false,
            };
        }
    };

    let txt = format!(
        "{} {}",
        row.get("reason").and_then(Value::as_str).unwrap_or_default(),
        row.get("stderr").and_then(Value::as_str).unwrap_or_default()
    );
    let blocked = matches!(row.get("probe_blocked"), Some(Value::Bool(true)))
        || is_env_probe_blocked_text(&txt);
    if !blocked {
        return ProbeBlockedNormalization {
            rec: Some(Value::Object(row)),
            changed: false,
        };
    }

    let mut changed = false;
    if !matches!(row.get("probe_blocked"), Some(Value::Bool(true))) {
        row.insert("probe_blocked".to_string(), Value::Bool(true));
        changed = true;
    }
    if !matches!(row.get("reason"), Some(Value::String(reason)) if reason == "env_probe_blocked") {
        row.insert(
            "reason".to_string(),
            Value::String("env_probe_blocked".to_string()),
        );
        changed = true;
    }
    if !matches!(row.get("available"), Some(Value::Null)) {
        row.insert("available".to_string(), Value::Null);
        changed = true;
    }

    ProbeBlockedNormalization {
        rec: Some(Value::Object(row)),
        changed,
    }
}

pub fn suppression_active(rec: Option<&Value>, now_ms: i64) -> bool {
    let until = js_number_with_or_zero(
        rec.and_then(Value::as_object)
            .and_then(|row| row.get("suppressed_until_ms")),
    );
    until.is_finite() && until > now_ms as f64
}

pub fn apply_probe_health_stabilizer(
    previous: Option<&Value>,
    current: Option<&Value>,
    now_ms: i64,
    policy: &ProbeHealthStabilizerPolicy,
) -> Value {
    let prev = object_or_empty(previous);
    let mut rec = object_or_empty(current);

    let prev_timeout_streak = number_or_default(prev.get("timeout_streak"), 0);
    let timeout_streak = if matches!(rec.get("timeout"), Some(Value::Bool(true))) {
        prev_timeout_streak + 1
    } else {
        0
    };
    rec.insert(
        "timeout_streak".to_string(),
        Value::Number(serde_json::Number::from(timeout_streak)),
    );

    let prev_rehab_success = number_or_default(prev.get("rehab_success_streak"), 0).max(0);
    let rehab_success_streak = if matches!(rec.get("timeout"), Some(Value::Bool(true))) {
        0
    } else if matches!(rec.get("available"), Some(Value::Bool(true))) {
        prev_rehab_success + 1
    } else {
        prev_rehab_success
    };
    rec.insert(
        "rehab_success_streak".to_string(),
        Value::Number(serde_json::Number::from(rehab_success_streak)),
    );

    if policy.suppression_enabled
        && matches!(rec.get("timeout"), Some(Value::Bool(true)))
        && timeout_streak >= policy.suppression_timeout_streak
    {
        let until = now_ms + (policy.suppression_minutes * 60 * 1000);
        rec.insert(
            "suppressed_until_ms".to_string(),
            Value::Number(serde_json::Number::from(until)),
        );
        rec.insert(
            "suppressed_reason".to_string(),
            Value::String("timeout_streak".to_string()),
        );
        rec.insert("available".to_string(), Value::Bool(false));
    }

    if matches!(rec.get("available"), Some(Value::Bool(true))) {
        let prev_suppressed_until = js_number_with_or_zero(prev.get("suppressed_until_ms"));
        if rehab_success_streak >= policy.rehab_success_threshold
            || (prev_suppressed_until > 0.0 && prev_suppressed_until <= now_ms as f64)
        {
            rec.remove("suppressed_until_ms");
            rec.remove("suppressed_reason");
            rec.remove("suppressed_at_ms");
        }
    }

    if suppression_active(Some(&Value::Object(rec.clone())), now_ms) {
        let existing = rec.get("suppressed_at_ms");
        let suppressed_at = if js_truthy(existing) {
            finite_number(existing).unwrap_or(now_ms as f64)
        } else {
            now_ms as f64
        };
        let suppressed_at_number = serde_json::Number::from_f64(suppressed_at)
            .unwrap_or_else(|| serde_json::Number::from(now_ms));
        rec.insert("suppressed_at_ms".to_string(), Value::Number(suppressed_at_number));
        rec.insert(
            "reason".to_string(),
            Value::String("probe_suppressed_timeout_rehab".to_string()),
        );
        rec.insert("available".to_string(), Value::Bool(false));
    }

    Value::Object(rec)
}

pub fn communication_fast_path_policy(cfg: &Value) -> CommunicationFastPathPolicy {
    let src = cfg
        .as_object()
        .and_then(|v| v.get("routing"))
        .and_then(Value::as_object)
        .and_then(|v| v.get("communication_fast_path"))
        .and_then(Value::as_object);

    let patterns = value_string_array(src.and_then(|v| v.get("patterns")));
    let disallow_regexes = value_string_array(src.and_then(|v| v.get("disallow_regexes")));
    let disallow_regexes = if disallow_regexes.is_empty() {
        DEFAULT_FAST_PATH_DISALLOW_REGEXES
            .iter()
            .map(|row| row.to_string())
            .collect::<Vec<_>>()
    } else {
        disallow_regexes
    };

    CommunicationFastPathPolicy {
        enabled: to_bool_like_value(src.and_then(|v| v.get("enabled")), true),
        match_mode: string_or(src.and_then(|v| v.get("match_mode")), "heuristic"),
        max_chars: to_bounded_number_like(src.and_then(|v| v.get("max_chars")), 48, 8, 220),
        max_words: to_bounded_number_like(src.and_then(|v| v.get("max_words")), 8, 1, 32),
        max_newlines: to_bounded_number_like(src.and_then(|v| v.get("max_newlines")), 0, 0, 8),
        patterns,
        disallow_regexes,
        slot: string_or(src.and_then(|v| v.get("slot")), "grunt"),
        prefer_model: string_or(
            src.and_then(|v| v.get("prefer_model")),
            "ollama/smallthinker",
        ),
        fallback_slot: string_or(src.and_then(|v| v.get("fallback_slot")), "fallback"),
        skip_outcome_scan: to_bool_like_value(src.and_then(|v| v.get("skip_outcome_scan")), true),
    }
}

pub fn detect_communication_fast_path(
    cfg: &Value,
    risk: &str,
    complexity: &str,
    intent: &str,
    task: &str,
    mode: &str,
    allow_generic_medium: bool,
) -> CommunicationFastPathResult {
    let policy = communication_fast_path_policy(cfg);

    let make_nomatch = |reason: &str, blocked_pattern: Option<String>| CommunicationFastPathResult {
        matched: false,
        reason: reason.to_string(),
        policy: policy.clone(),
        blocked_pattern,
        matched_pattern: None,
        text: None,
        slot: None,
        prefer_model: None,
        fallback_slot: None,
        skip_outcome_scan: None,
    };

    if !policy.enabled {
        return make_nomatch("disabled", None);
    }

    let m = normalize_key(if mode.is_empty() { "normal" } else { mode });
    if m == "deep-thinker" || m == "deep_thinker" || m == "hyper-creative" || m == "hyper_creative" {
        return make_nomatch("mode_disallowed", None);
    }

    if !allow_generic_medium {
        if normalize_key(risk) != "low" {
            return make_nomatch("risk_not_low", None);
        }
        let cx = normalize_key(if complexity.is_empty() {
            "medium"
        } else {
            complexity
        });
        if !(cx == "low" || cx == "medium") {
            return make_nomatch("complexity_not_eligible", None);
        }
    }

    let raw_text = if !task.is_empty() { task } else { intent }.to_string();
    let newline_count = raw_text.matches('\n').count() as i64;
    if newline_count > policy.max_newlines {
        return make_nomatch("too_many_newlines", None);
    }

    let text = raw_text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return make_nomatch("empty_text", None);
    }

    let words = text.split(' ').filter(|row| !row.is_empty()).count() as i64;
    if text.len() as i64 > policy.max_chars {
        return make_nomatch("text_too_long", None);
    }
    if words > policy.max_words {
        return make_nomatch("word_count_too_high", None);
    }

    for raw in &policy.disallow_regexes {
        if pattern_match_ci(raw, &text, &raw_text) {
            return make_nomatch("contains_structured_intent", Some(raw.clone()));
        }
    }

    let structural_role = infer_role(&text, &text);
    if matches!(
        normalize_key(&structural_role).as_str(),
        "coding" | "tools" | "swarm" | "planning" | "logic"
    ) {
        return make_nomatch("role_not_chat_like", None);
    }

    let match_mode = normalize_key(&policy.match_mode);
    if match_mode == "patterns" {
        for raw in &policy.patterns {
            if pattern_match_ci(raw, &text, &raw_text) {
                return CommunicationFastPathResult {
                    matched: true,
                    reason: "communication_fast_path_pattern".to_string(),
                    policy: policy.clone(),
                    blocked_pattern: None,
                    matched_pattern: Some(raw.clone()),
                    text: Some(text),
                    slot: Some(policy.slot.clone()),
                    prefer_model: Some(policy.prefer_model.clone()),
                    fallback_slot: Some(policy.fallback_slot.clone()),
                    skip_outcome_scan: Some(policy.skip_outcome_scan),
                };
            }
        }
        return make_nomatch("no_pattern_match", None);
    }

    CommunicationFastPathResult {
        matched: true,
        reason: "communication_fast_path_heuristic".to_string(),
        policy: policy.clone(),
        blocked_pattern: None,
        matched_pattern: None,
        text: Some(text),
        slot: Some(policy.slot.clone()),
        prefer_model: Some(policy.prefer_model.clone()),
        fallback_slot: Some(policy.fallback_slot.clone()),
        skip_outcome_scan: Some(policy.skip_outcome_scan),
    }
}

fn normalized_optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn contains_code_like_markers(raw_text: &str) -> bool {
    if raw_text.contains("```") {
        return true;
    }
    if raw_text
        .chars()
        .any(|ch| matches!(ch, '`' | '{' | '}' | '[' | ']' | '<' | '>' | '$' | ';' | '='))
    {
        return true;
    }
    if contains_cli_flag(raw_text) {
        return true;
    }
    let tokens = tokenize(raw_text);
    [
        "node", "npm", "pnpm", "yarn", "git", "curl", "python", "bash", "zsh", "ollama",
    ]
    .iter()
    .any(|token| tokens.contains(*token))
}

pub fn fallback_classification_policy(cfg: &Value) -> FallbackClassificationPolicy {
    let src = cfg
        .as_object()
        .and_then(|v| v.get("routing"))
        .and_then(Value::as_object)
        .and_then(|v| v.get("fallback_classification_policy"))
        .and_then(Value::as_object);

    FallbackClassificationPolicy {
        enabled: to_bool_like_value(src.and_then(|v| v.get("enabled")), true),
        only_when_medium_medium: to_bool_like_value(
            src.and_then(|v| v.get("only_when_medium_medium")),
            true,
        ),
        prefer_chat_fast_path: to_bool_like_value(
            src.and_then(|v| v.get("prefer_chat_fast_path")),
            true,
        ),
        low_chars_max: to_bounded_number_like_f64(
            src.and_then(|v| v.get("low_chars_max")),
            220.0,
            32.0,
            600.0,
        ),
        low_newlines_max: to_bounded_number_like_f64(
            src.and_then(|v| v.get("low_newlines_max")),
            1.0,
            0.0,
            6.0,
        ),
        high_chars_min: to_bounded_number_like_f64(
            src.and_then(|v| v.get("high_chars_min")),
            1200.0,
            240.0,
            12_000.0,
        ),
        high_newlines_min: to_bounded_number_like_f64(
            src.and_then(|v| v.get("high_newlines_min")),
            8.0,
            1.0,
            80.0,
        ),
        high_tokens_min: to_bounded_number_like_f64(
            src.and_then(|v| v.get("high_tokens_min")),
            2200.0,
            200.0,
            30_000.0,
        ),
    }
}

pub fn fallback_route_classification(
    input: FallbackRouteClassificationInput<'_>,
) -> FallbackRouteClassification {
    let policy = fallback_classification_policy(input.cfg);
    let base_risk = normalize_risk_level(input.requested_risk);
    let base_complexity = normalize_complexity_level(input.requested_complexity);
    let fallback = FallbackRouteClassification {
        enabled: policy.enabled,
        applied: false,
        reason: "disabled".to_string(),
        risk: base_risk.clone(),
        complexity: base_complexity.clone(),
        role: {
            let role_key = normalize_key(if input.role.is_empty() {
                "general"
            } else {
                input.role
            });
            if role_key.is_empty() {
                "general".to_string()
            } else {
                role_key
            }
        },
    };
    if !policy.enabled {
        return fallback;
    }
    if let Some(class_policy) = input.class_policy {
        if class_policy.force_risk.is_some()
            || class_policy.force_complexity.is_some()
            || !class_policy.force_role.is_empty()
        {
            return FallbackRouteClassification {
                reason: "route_class_forced".to_string(),
                ..fallback
            };
        }
    }
    if policy.only_when_medium_medium && !(base_risk == "medium" && base_complexity == "medium") {
        return FallbackRouteClassification {
            reason: "not_generic_medium".to_string(),
            ..fallback
        };
    }

    let inferred_role = {
        let candidate = if input.role.is_empty() {
            infer_role(input.intent, input.task)
        } else {
            input.role.to_string()
        };
        let normalized = normalize_key(&candidate);
        if normalized.is_empty() {
            "general".to_string()
        } else {
            normalized
        }
    };

    let raw_text = format!("{} {}", input.intent, input.task);
    let raw_text = raw_text.trim().to_string();
    let char_count = raw_text.chars().count() as f64;
    let newline_count = input.task.matches('\n').count() as f64;
    let code_like = contains_code_like_markers(&raw_text);
    let token_count = input.tokens_est.filter(|value| value.is_finite());

    if policy.prefer_chat_fast_path {
        let candidate = detect_communication_fast_path(
            input.cfg,
            &base_risk,
            &base_complexity,
            input.intent,
            input.task,
            input.mode,
            true,
        );
        if candidate.matched {
            return FallbackRouteClassification {
                enabled: fallback.enabled,
                applied: true,
                reason: "generic_medium_fast_path".to_string(),
                risk: "low".to_string(),
                complexity: "low".to_string(),
                role: "chat".to_string(),
            };
        }
    }

    if token_count
        .map(|value| value >= policy.high_tokens_min)
        .unwrap_or(false)
        || char_count >= policy.high_chars_min
        || newline_count >= policy.high_newlines_min
    {
        return FallbackRouteClassification {
            enabled: fallback.enabled,
            applied: true,
            reason: "generic_medium_complexity_escalation".to_string(),
            risk: "medium".to_string(),
            complexity: "high".to_string(),
            role: if inferred_role == "chat" {
                "general".to_string()
            } else {
                inferred_role
            },
        };
    }

    if !code_like
        && char_count <= policy.low_chars_max
        && newline_count <= policy.low_newlines_max
        && (inferred_role == "chat" || inferred_role == "general")
    {
        return FallbackRouteClassification {
            enabled: fallback.enabled,
            applied: true,
            reason: "generic_medium_short_text".to_string(),
            risk: "low".to_string(),
            complexity: "low".to_string(),
            role: "chat".to_string(),
        };
    }

    FallbackRouteClassification {
        reason: "no_override".to_string(),
        ..fallback
    }
}

pub fn route_class_policy(cfg: &Value, route_class_raw: &str) -> RouteClassPolicy {
    let id = {
        let normalized = normalize_key(if route_class_raw.is_empty() {
            "default"
        } else {
            route_class_raw
        });
        if normalized.is_empty() {
            "default".to_string()
        } else {
            normalized
        }
    };

    let classes = cfg
        .as_object()
        .and_then(|v| v.get("routing"))
        .and_then(Value::as_object)
        .and_then(|v| v.get("route_classes"))
        .and_then(Value::as_object);
    let src = classes
        .and_then(|map| map.get(&id))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut merged = Map::<String, Value>::new();
    if id == "reflex" {
        merged.insert("force_risk".to_string(), Value::String("low".to_string()));
        merged.insert(
            "force_complexity".to_string(),
            Value::String("low".to_string()),
        );
        merged.insert("force_role".to_string(), Value::String("reflex".to_string()));
        merged.insert("prefer_slot".to_string(), Value::String("grunt".to_string()));
        merged.insert(
            "prefer_model".to_string(),
            Value::String("ollama/smallthinker".to_string()),
        );
        merged.insert(
            "fallback_slot".to_string(),
            Value::String("fallback".to_string()),
        );
        merged.insert("disable_fast_path".to_string(), Value::Bool(true));
        merged.insert(
            "max_tokens_est".to_string(),
            Value::Number(serde_json::Number::from(420)),
        );
    }
    for (k, v) in src {
        merged.insert(k, v);
    }

    let force_risk_raw = normalize_key(
        merged
            .get("force_risk")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let force_complexity_raw = normalize_key(
        merged
            .get("force_complexity")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );

    let max_tokens = finite_number(merged.get("max_tokens_est"));
    RouteClassPolicy {
        id,
        force_risk: match force_risk_raw.as_str() {
            "low" | "medium" | "high" => Some(force_risk_raw),
            _ => None,
        },
        force_complexity: match force_complexity_raw.as_str() {
            "low" | "medium" | "high" => Some(force_complexity_raw),
            _ => None,
        },
        force_role: normalize_key(
            merged
                .get("force_role")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        prefer_slot: normalized_optional_string(merged.get("prefer_slot")),
        prefer_model: normalized_optional_string(merged.get("prefer_model")),
        fallback_slot: normalized_optional_string(merged.get("fallback_slot")),
        disable_fast_path: to_bool_like_value(merged.get("disable_fast_path"), false),
        max_tokens_est: max_tokens.and_then(|value| {
            if value.is_finite() && value > 0.0 {
                Some((value.round() as i64).clamp(50, 12_000))
            } else {
                None
            }
        }),
    }
}

pub fn prompt_cache_lane_for_route(route_class_id: &str, mode: &str, execution_intent: bool) -> String {
    let route_class = normalize_key(route_class_id);
    let mode_key = normalize_key(mode);
    if route_class == "reflex" {
        return "reflex".to_string();
    }
    if mode_key.contains("dream") {
        return "dream".to_string();
    }
    if execution_intent {
        return "autonomy".to_string();
    }
    "autonomy".to_string()
}

fn tier_alias_to_adjustment(tier_alias: &str, base: &ModeAdjustment) -> ModeAdjustment {
    let key = normalize_key(tier_alias);
    if key == "tier1_governance" {
        return ModeAdjustment {
            risk: "high".to_string(),
            complexity: "high".to_string(),
            role: "logic".to_string(),
            mode_adjusted: true,
            mode_reason: Some("tier1_governance".to_string()),
            ..base.clone()
        };
    }
    if key == "tier2_build" {
        return ModeAdjustment {
            risk: "medium".to_string(),
            complexity: "medium".to_string(),
            role: "coding".to_string(),
            mode_adjusted: true,
            mode_reason: Some("tier2_build".to_string()),
            ..base.clone()
        };
    }
    if key == "tier3_grunt" {
        return ModeAdjustment {
            risk: "low".to_string(),
            complexity: "low".to_string(),
            role: "chat".to_string(),
            mode_adjusted: true,
            mode_reason: Some("tier3_grunt".to_string()),
            ..base.clone()
        };
    }
    ModeAdjustment {
        mode_adjusted: false,
        mode_reason: None,
        ..base.clone()
    }
}

pub fn apply_mode_adjustments(mode: &str, base: &ModeAdjustmentInput, adapters: &Value) -> ModeAdjustment {
    let m = normalize_key(if mode.is_empty() { "normal" } else { mode });
    let out = ModeAdjustment {
        risk: base.risk.clone(),
        complexity: base.complexity.clone(),
        role: base.role.clone(),
        mode: m.clone(),
        mode_adjusted: false,
        mode_reason: None,
        mode_policy_source: "fallback".to_string(),
    };

    let mode_routing = adapters
        .as_object()
        .and_then(|v| v.get("mode_routing"))
        .and_then(Value::as_object);
    if let Some(routing) = mode_routing {
        let has_explicit = routing.contains_key(&m);
        let allow_default = !(m == "normal" || m == "default");
        let alias = if has_explicit {
            routing.get(&m).and_then(Value::as_str)
        } else if allow_default {
            routing.get("default").and_then(Value::as_str)
        } else {
            None
        };
        if let Some(alias) = alias {
            let mut mapped = tier_alias_to_adjustment(alias, &out);
            mapped.mode = m.clone();
            mapped.mode_policy_source = "config/model_adapters.json".to_string();
            if m == "deep-thinker" || m == "deep_thinker" {
                mapped.risk = "high".to_string();
                mapped.complexity = "high".to_string();
                mapped.role = "logic".to_string();
                mapped.mode_adjusted = true;
                mapped.mode_reason = Some("deep_thinker_forces_high_logic".to_string());
            }
            return mapped;
        }
    }

    if m == "deep-thinker" || m == "deep_thinker" {
        return ModeAdjustment {
            risk: "high".to_string(),
            complexity: "high".to_string(),
            role: "logic".to_string(),
            mode_adjusted: true,
            mode_reason: Some("deep_thinker_forces_high_logic".to_string()),
            ..out
        };
    }
    if m == "hyper-creative" || m == "hyper_creative" {
        let next_complexity = if out.complexity == "low" {
            "medium".to_string()
        } else {
            out.complexity.clone()
        };
        return ModeAdjustment {
            complexity: next_complexity,
            role: "planning".to_string(),
            mode_adjusted: true,
            mode_reason: Some("hyper_creative_bias_planning".to_string()),
            ..out
        };
    }
    if m == "creative" || m == "narrative" {
        return ModeAdjustment {
            role: "chat".to_string(),
            mode_adjusted: true,
            mode_reason: Some(format!("{m}_bias_chat")),
            ..out
        };
    }
    out
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
        let mode_blocked = detect_communication_fast_path(
            &empty,
            "low",
            "low",
            "hello",
            "",
            "deep-thinker",
            false,
        );
        assert!(!mode_blocked.matched);
        assert_eq!(mode_blocked.reason, "mode_disallowed");
        assert!(mode_blocked.blocked_pattern.is_none());

        let structured = detect_communication_fast_path(
            &empty,
            "low",
            "low",
            "",
            "run git status",
            "normal",
            false,
        );
        assert!(!structured.matched);
        assert_eq!(structured.reason, "contains_structured_intent");
        assert_eq!(
            structured.blocked_pattern.as_deref(),
            Some("\\b(node|npm|pnpm|yarn|git|curl|python|bash|zsh|ollama)\\b")
        );

        let risk_blocked = detect_communication_fast_path(
            &empty,
            "medium",
            "low",
            "hello there",
            "",
            "normal",
            false,
        );
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
        assert_eq!(prompt_cache_lane_for_route("reflex", "normal", false), "reflex");
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
        assert_eq!(mapped.mode_policy_source, "config/model_adapters.json");

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
        assert!(!is_env_probe_blocked_text("timeout while probing localhost"));

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
}
