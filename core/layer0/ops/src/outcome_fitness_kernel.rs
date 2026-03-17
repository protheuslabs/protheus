// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Number, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso, parse_args};

const THRESHOLD_KEYS: &[&str] = &[
    "min_signal_quality",
    "min_sensory_signal_score",
    "min_sensory_relevance_score",
    "min_directive_fit",
    "min_actionability_score",
    "min_eye_score_ema",
    "min_composite_eligibility",
];

const RANKING_WEIGHT_KEYS: &[&str] = &[
    "composite",
    "actionability",
    "directive_fit",
    "signal_quality",
    "expected_value",
    "time_to_value",
    "risk_penalty",
];

const VALUE_CURRENCY_KEYS: &[&str] = &[
    "revenue",
    "delivery",
    "user_value",
    "quality",
    "time_savings",
    "learning",
];

fn usage() {
    println!("outcome-fitness-kernel commands:");
    println!("  protheus-ops outcome-fitness-kernel load-policy --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel normalize-threshold-overrides --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel normalize-ranking-weights --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel normalize-proposal-type-threshold-offsets --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel normalize-promotion-policy-overrides --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel normalize-value-currency-policy-overrides --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel normalize-proposal-type-key --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel normalize-value-currency-token --payload-base64=<json>");
    println!("  protheus-ops outcome-fitness-kernel proposal-type-threshold-offsets-for --payload-base64=<json>");
}

fn cli_receipt(kind: &str, payload: Value) -> Value {
    let ts = now_iso();
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let mut out = json!({
        "ok": ok,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "payload": payload,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error(kind: &str, error: &str) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "fail_closed": true,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    if let Some(raw) = lane_utils::parse_flag(argv, "payload", false) {
        return serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("outcome_fitness_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("outcome_fitness_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("outcome_fitness_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("outcome_fitness_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn clean_text(value: impl ToString, max_len: usize) -> String {
    let mut out = value.to_string().trim().to_string();
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn as_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn to_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(v)) => v.trim().parse::<f64>().ok(),
        Some(Value::Bool(v)) => Some(if *v { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn clamp_number(value: Option<&Value>, lo: f64, hi: f64, fallback: f64) -> f64 {
    let Some(mut n) = to_number(value) else {
        return fallback;
    };
    if !n.is_finite() {
        return fallback;
    }
    if n < lo {
        n = lo;
    }
    if n > hi {
        n = hi;
    }
    n
}

fn clamp_int(value: Option<&Value>, lo: i64, hi: i64, fallback: i64) -> i64 {
    let Some(mut n) = to_number(value).map(|v| v.floor() as i64) else {
        return fallback;
    };
    if n < lo {
        n = lo;
    }
    if n > hi {
        n = hi;
    }
    n
}

fn json_number(value: f64) -> Value {
    Value::Number(Number::from_f64(value).unwrap_or_else(|| Number::from(0)))
}

fn round_to_places(value: f64, places: u32) -> f64 {
    let factor = 10f64.powi(places as i32);
    (value * factor).round() / factor
}

fn normalize_key(raw: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut previous_underscore = false;
    for ch in raw.trim().to_ascii_lowercase().chars() {
        let normalized = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-') {
            previous_underscore = false;
            ch
        } else {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
            '_'
        };
        out.push(normalized);
        if out.len() >= max_len {
            break;
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.to_string()
    }
}

fn normalize_proposal_type_key(raw: &str) -> String {
    normalize_key(raw, 64)
}

fn normalize_value_currency_token(raw: &str) -> String {
    let token = normalize_key(raw, 64);
    if VALUE_CURRENCY_KEYS.contains(&token.as_str()) {
        token
    } else {
        String::new()
    }
}

fn normalize_threshold_overrides(value: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = value.and_then(Value::as_object) else {
        return out;
    };
    for key in THRESHOLD_KEYS {
        if let Some(v) = obj.get(*key).and_then(|row| to_number(Some(row))) {
            if v.is_finite() {
                out.insert((*key).to_string(), json_number(v));
            }
        }
    }
    out
}

fn normalize_ranking_weights(value: Option<&Value>) -> Option<Map<String, Value>> {
    let obj = value.and_then(Value::as_object)?;
    let mut rows = Vec::<(&str, f64)>::new();
    let mut total = 0.0;
    for key in RANKING_WEIGHT_KEYS {
        let Some(weight) = obj.get(*key).and_then(|row| to_number(Some(row))) else {
            continue;
        };
        if !weight.is_finite() || weight < 0.0 {
            continue;
        }
        total += weight;
        rows.push((key, weight));
    }
    if total <= 0.0 {
        return None;
    }
    let mut out = Map::new();
    for (key, weight) in rows {
        out.insert(key.to_string(), json_number(round_to_places(weight / total, 6)));
    }
    Some(out)
}

fn normalize_proposal_type_threshold_offsets(value: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = value.and_then(Value::as_object) else {
        return out;
    };
    for (raw_key, row) in obj {
        let key = normalize_proposal_type_key(raw_key);
        if key.is_empty() {
            continue;
        }
        let normalized = normalize_threshold_overrides(Some(row));
        if normalized.is_empty() {
            continue;
        }
        out.insert(key, Value::Object(normalized));
    }
    out
}

fn normalize_promotion_policy_overrides(value: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = value.and_then(Value::as_object) else {
        return out;
    };
    if obj.contains_key("disable_legacy_fallback_after_quality_receipts") {
        out.insert(
            "disable_legacy_fallback_after_quality_receipts".to_string(),
            Value::from(clamp_int(
                obj.get("disable_legacy_fallback_after_quality_receipts"),
                0,
                10_000,
                10,
            )),
        );
    }
    if obj.contains_key("max_success_criteria_quality_insufficient_rate") {
        out.insert(
            "max_success_criteria_quality_insufficient_rate".to_string(),
            json_number(round_to_places(
                clamp_number(
                    obj.get("max_success_criteria_quality_insufficient_rate"),
                    0.0,
                    1.0,
                    0.4,
                ),
                3,
            )),
        );
    }
    out
}

fn normalize_promotion_policy_audit(value: Option<&Value>) -> Value {
    let empty = json!({});
    let src = value.unwrap_or(&empty);
    let quality_lock = src
        .get("quality_lock")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    json!({
        "quality_lock": {
            "active": quality_lock.get("active").and_then(Value::as_bool).unwrap_or(false),
            "was_locked": quality_lock.get("was_locked").and_then(Value::as_bool).unwrap_or(false),
            "stable_window_streak": clamp_int(quality_lock.get("stable_window_streak"), 0, 10_000, 0),
            "unstable_window_streak": clamp_int(quality_lock.get("unstable_window_streak"), 0, 10_000, 0),
            "min_stable_windows": clamp_int(quality_lock.get("min_stable_windows"), 0, 10_000, 0),
            "release_unstable_windows": clamp_int(quality_lock.get("release_unstable_windows"), 0, 10_000, 0),
            "min_realized_score": clamp_number(quality_lock.get("min_realized_score"), 0.0, 100.0, 0.0),
            "min_quality_receipts": clamp_int(quality_lock.get("min_quality_receipts"), 0, 10_000, 0),
            "max_insufficient_rate": round_to_places(clamp_number(quality_lock.get("max_insufficient_rate"), 0.0, 1.0, 1.0), 3),
        }
    })
}

fn normalize_value_currency_policy_overrides(value: Option<&Value>) -> Value {
    let Some(obj) = value.and_then(Value::as_object) else {
        return json!({
            "default_currency": Value::Null,
            "currency_overrides": {},
            "objective_overrides": {}
        });
    };
    let default_currency = normalize_value_currency_token(&as_text(obj.get("default_currency")));
    let currency_src = obj
        .get("currency_overrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let objective_src = obj
        .get("objective_overrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut currency_overrides = Map::new();
    for (raw_key, row) in currency_src {
        let currency = normalize_value_currency_token(&raw_key);
        if currency.is_empty() {
            continue;
        }
        let row_obj = row.as_object().cloned().unwrap_or_default();
        let ranking = normalize_ranking_weights(
            row_obj
                .get("ranking_weights")
                .map(|v| v as &Value)
                .or(Some(&row)),
        );
        let Some(weights) = ranking else {
            continue;
        };
        currency_overrides.insert(currency, json!({ "ranking_weights": weights }));
    }

    let mut objective_overrides = Map::new();
    for (raw_key, row) in objective_src {
        let objective_id = clean_text(raw_key, 200);
        if objective_id.is_empty() {
            continue;
        }
        let row_obj = row.as_object().cloned().unwrap_or_default();
        let ranking = normalize_ranking_weights(
            row_obj
                .get("ranking_weights")
                .map(|v| v as &Value)
                .or(Some(&row)),
        );
        let primary_currency =
            normalize_value_currency_token(&as_text(row_obj.get("primary_currency")));
        if ranking.is_none() && primary_currency.is_empty() {
            continue;
        }
        objective_overrides.insert(
            objective_id,
            json!({
                "primary_currency": if primary_currency.is_empty() { Value::Null } else { Value::String(primary_currency) },
                "ranking_weights": ranking.map(Value::Object).unwrap_or(Value::Null)
            }),
        );
    }

    json!({
        "default_currency": if default_currency.is_empty() { Value::Null } else { Value::String(default_currency) },
        "currency_overrides": currency_overrides,
        "objective_overrides": objective_overrides,
    })
}

fn read_json_safe(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn default_policy() -> Value {
    json!({
        "version": "1.0",
        "schema": {
            "id": "protheus_outcome_fitness_policy",
            "version": "1.0.0"
        },
        "strategy_policy": {
            "strategy_id": Value::Null,
            "threshold_overrides": {},
            "ranking_weights_override": Value::Null,
            "proposal_type_threshold_offsets": {},
            "promotion_policy_overrides": {},
            "promotion_policy_audit": {
                "quality_lock": {
                    "active": false,
                    "was_locked": false,
                    "stable_window_streak": 0,
                    "unstable_window_streak": 0,
                    "min_stable_windows": 0,
                    "release_unstable_windows": 0,
                    "min_realized_score": 0.0,
                    "min_quality_receipts": 0,
                    "max_insufficient_rate": 1.0
                }
            },
            "value_currency_policy_overrides": {
                "default_currency": Value::Null,
                "currency_overrides": {},
                "objective_overrides": {}
            }
        },
        "focus_policy": {
            "min_focus_score_delta": 0
        },
        "proposal_filter_policy": {
            "require_success_criteria": true,
            "min_success_criteria_count": 1
        }
    })
}

fn default_policy_path(repo_root: &Path, payload: &Map<String, Value>) -> PathBuf {
    let root_dir = clean_text(as_text(payload.get("root_dir")), 400);
    let base_root = if root_dir.is_empty() {
        repo_root.to_path_buf()
    } else if Path::new(&root_dir).is_absolute() {
        PathBuf::from(root_dir)
    } else {
        repo_root.join(root_dir)
    };

    let override_path = clean_text(as_text(payload.get("override_path")), 400);
    if !override_path.is_empty() {
        if Path::new(&override_path).is_absolute() {
            return PathBuf::from(override_path);
        }
        return repo_root.join(override_path);
    }

    if let Ok(env_override) = std::env::var("OUTCOME_FITNESS_POLICY_PATH") {
        let env_override = clean_text(env_override, 400);
        if !env_override.is_empty() {
            if Path::new(&env_override).is_absolute() {
                return PathBuf::from(env_override);
            }
            return repo_root.join(env_override);
        }
    }

    base_root
        .join("local")
        .join("state")
        .join("adaptive")
        .join("strategy")
        .join("outcome_fitness.json")
}

fn load_outcome_fitness_policy(repo_root: &Path, payload: &Map<String, Value>) -> Value {
    let path = default_policy_path(repo_root, payload);
    let raw = read_json_safe(&path);
    let base = default_policy();
    let src = raw.as_ref().and_then(Value::as_object).cloned().unwrap_or_default();
    let schema = src
        .get("schema")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let strategy_policy = src
        .get("strategy_policy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let focus_policy = src
        .get("focus_policy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let filter_policy = src
        .get("proposal_filter_policy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let ts_value = src
        .get("ts")
        .map(|v| clean_text(as_text(Some(v)), 120))
        .filter(|v| !v.is_empty())
        .map(Value::String)
        .unwrap_or(Value::Null);
    let realized_outcome_score = to_number(src.get("realized_outcome_score"))
        .map(|v| clamp_number(Some(&json_number(v)), 0.0, 100.0, 0.0))
        .map(json_number)
        .unwrap_or(Value::Null);
    let strategy_id = {
        let value = clean_text(as_text(strategy_policy.get("strategy_id")), 160);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let schema_id = clean_text(as_text(schema.get("id")), 120);
    let schema_version = clean_text(as_text(schema.get("version")), 40);
    let default_version = base.get("version").and_then(Value::as_str).unwrap_or("1.0");
    let version = {
        let value = clean_text(as_text(src.get("version")), 40);
        if value.is_empty() {
            default_version.to_string()
        } else {
            value
        }
    };

    json!({
        "found": raw.is_some(),
        "path": path.to_string_lossy(),
        "ts": ts_value,
        "realized_outcome_score": realized_outcome_score,
        "strategy_policy": {
            "strategy_id": strategy_id,
            "threshold_overrides": normalize_threshold_overrides(strategy_policy.get("threshold_overrides")),
            "ranking_weights_override": normalize_ranking_weights(strategy_policy.get("ranking_weights_override")).map(Value::Object).unwrap_or(Value::Null),
            "proposal_type_threshold_offsets": normalize_proposal_type_threshold_offsets(strategy_policy.get("proposal_type_threshold_offsets")),
            "promotion_policy_overrides": normalize_promotion_policy_overrides(strategy_policy.get("promotion_policy_overrides")),
            "promotion_policy_audit": normalize_promotion_policy_audit(strategy_policy.get("promotion_policy_audit")),
            "value_currency_policy_overrides": normalize_value_currency_policy_overrides(strategy_policy.get("value_currency_policy_overrides"))
        },
        "focus_policy": {
            "min_focus_score_delta": clamp_int(focus_policy.get("min_focus_score_delta"), -20, 20, 0)
        },
        "proposal_filter_policy": {
            "require_success_criteria": filter_policy.get("require_success_criteria").and_then(Value::as_bool).unwrap_or(true),
            "min_success_criteria_count": clamp_int(filter_policy.get("min_success_criteria_count"), 0, 5, 1)
        },
        "schema": {
            "id": schema_id,
            "version": schema_version
        },
        "version": version
    })
}

fn proposal_type_threshold_offsets_for(policy: &Value, proposal_type: &str) -> Map<String, Value> {
    let type_key = normalize_proposal_type_key(proposal_type);
    if type_key.is_empty() {
        return Map::new();
    }
    let strategy_policy = policy
        .get("strategy_policy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let table = strategy_policy
        .get("proposal_type_threshold_offsets")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let normalized_table =
        normalize_proposal_type_threshold_offsets(Some(&Value::Object(table.clone())));
    let row = normalized_table
        .get(&type_key)
        .cloned()
        .unwrap_or_else(|| json!({}));
    normalize_threshold_overrides(Some(&row))
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());

    match cmd.as_str() {
        "help" | "--help" | "-h" => {
            usage();
            0
        }
        "load-policy" => match payload_json(argv) {
            Ok(payload) => {
                let payload = load_outcome_fitness_policy(root, payload_obj(&payload));
                print_json_line(&cli_receipt("outcome_fitness_kernel_load_policy", payload));
                0
            }
            Err(err) => {
                print_json_line(&cli_error("outcome_fitness_kernel_load_policy", &err));
                1
            }
        },
        "normalize-threshold-overrides" => match payload_json(argv) {
            Ok(payload) => {
                let result = Value::Object(normalize_threshold_overrides(Some(&payload)));
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_normalize_threshold_overrides",
                    json!({ "normalized": result }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_normalize_threshold_overrides",
                    &err,
                ));
                1
            }
        },
        "normalize-ranking-weights" => match payload_json(argv) {
            Ok(payload) => {
                let result = normalize_ranking_weights(Some(&payload))
                    .map(Value::Object)
                    .unwrap_or(Value::Null);
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_normalize_ranking_weights",
                    json!({ "normalized": result }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_normalize_ranking_weights",
                    &err,
                ));
                1
            }
        },
        "normalize-proposal-type-threshold-offsets" => match payload_json(argv) {
            Ok(payload) => {
                let result = Value::Object(normalize_proposal_type_threshold_offsets(Some(&payload)));
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_normalize_proposal_type_threshold_offsets",
                    json!({ "normalized": result }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_normalize_proposal_type_threshold_offsets",
                    &err,
                ));
                1
            }
        },
        "normalize-promotion-policy-overrides" => match payload_json(argv) {
            Ok(payload) => {
                let result = Value::Object(normalize_promotion_policy_overrides(Some(&payload)));
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_normalize_promotion_policy_overrides",
                    json!({ "normalized": result }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_normalize_promotion_policy_overrides",
                    &err,
                ));
                1
            }
        },
        "normalize-value-currency-policy-overrides" => match payload_json(argv) {
            Ok(payload) => {
                let result = normalize_value_currency_policy_overrides(Some(&payload));
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_normalize_value_currency_policy_overrides",
                    json!({ "normalized": result }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_normalize_value_currency_policy_overrides",
                    &err,
                ));
                1
            }
        },
        "normalize-proposal-type-key" => match payload_json(argv) {
            Ok(payload) => {
                let normalized = normalize_proposal_type_key(&as_text(payload_obj(&payload).get("value")));
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_normalize_proposal_type_key",
                    json!({ "normalized": normalized }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_normalize_proposal_type_key",
                    &err,
                ));
                1
            }
        },
        "normalize-value-currency-token" => match payload_json(argv) {
            Ok(payload) => {
                let normalized =
                    normalize_value_currency_token(&as_text(payload_obj(&payload).get("value")));
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_normalize_value_currency_token",
                    json!({ "normalized": normalized }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_normalize_value_currency_token",
                    &err,
                ));
                1
            }
        },
        "proposal-type-threshold-offsets-for" => match payload_json(argv) {
            Ok(payload) => {
                let obj = payload_obj(&payload);
                let empty = json!({});
                let policy = obj.get("policy").unwrap_or(&empty);
                let offsets = proposal_type_threshold_offsets_for(
                    policy,
                    &as_text(obj.get("proposal_type")),
                );
                print_json_line(&cli_receipt(
                    "outcome_fitness_kernel_proposal_type_threshold_offsets_for",
                    json!({ "offsets": offsets }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "outcome_fitness_kernel_proposal_type_threshold_offsets_for",
                    &err,
                ));
                1
            }
        },
        _ => {
            usage();
            print_json_line(&cli_error("outcome_fitness_kernel", "unknown_command"));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_ranking_weights_scales_to_unit_sum() {
        let payload = json!({
            "composite": 2,
            "actionability": 1,
            "directive_fit": 1
        });
        let out = normalize_ranking_weights(Some(&payload)).expect("weights");
        let sum = out
            .values()
            .filter_map(|v| v.as_f64())
            .fold(0.0, |acc, v| acc + v);
        assert!((sum - 1.0).abs() < 0.00001);
        assert_eq!(
            out.get("composite").and_then(Value::as_f64).unwrap_or_default(),
            0.5
        );
    }

    #[test]
    fn load_policy_normalizes_thresholds_and_offsets() {
        let repo_root = PathBuf::from("/tmp/fake-repo");
        let payload = json!({
            "root_dir": "/tmp/fake-repo/client",
            "override_path": "/tmp/fake-repo/client/local/state/adaptive/strategy/outcome_fitness.json"
        });
        let path = default_policy_path(&repo_root, payload_obj(&payload));
        assert!(path.ends_with("client/local/state/adaptive/strategy/outcome_fitness.json"));
        let normalized = proposal_type_threshold_offsets_for(
            &json!({
                "strategy_policy": {
                    "proposal_type_threshold_offsets": {
                        "Code Change!!": {
                            "min_signal_quality": 0.8
                        }
                    }
                }
            }),
            "Code Change!!",
        );
        assert_eq!(
            normalized
                .get("min_signal_quality")
                .and_then(Value::as_f64)
                .unwrap_or_default(),
            0.8
        );
    }
}
