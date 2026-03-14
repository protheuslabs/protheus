// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/execution (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::{clean, deterministic_receipt_hash, now_iso};

const DEFAULT_STRATEGY_DIR_REL: &str = "client/runtime/config/strategies";
const DEFAULT_WEAVER_OVERLAY_REL: &str =
    "client/runtime/local/state/autonomy/weaver/strategy_overlay.json";

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let long = format!("--{key}");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(v) = token.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if token == long && idx + 1 < argv.len() {
            return Some(argv[idx + 1].clone());
        }
        idx += 1;
    }
    None
}

fn load_payload(argv: &[String]) -> Result<Value, String> {
    if let Some(payload) = parse_flag(argv, "payload") {
        return serde_json::from_str::<Value>(&payload)
            .map_err(|err| format!("strategy_resolver_payload_decode_failed:{err}"));
    }
    if let Some(payload_b64) = parse_flag(argv, "payload-base64") {
        let bytes = BASE64_STANDARD
            .decode(payload_b64.as_bytes())
            .map_err(|err| format!("strategy_resolver_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("strategy_resolver_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("strategy_resolver_payload_decode_failed:{err}"));
    }
    if let Some(path) = parse_flag(argv, "payload-file") {
        let text = fs::read_to_string(path.trim())
            .map_err(|err| format!("strategy_resolver_payload_file_read_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("strategy_resolver_payload_decode_failed:{err}"));
    }
    Err("strategy_resolver_missing_payload".to_string())
}

fn as_str(value: Option<&Value>) -> String {
    value
        .map(|v| match v {
            Value::String(s) => s.trim().to_string(),
            Value::Null => String::new(),
            _ => v.to_string().trim_matches('"').trim().to_string(),
        })
        .unwrap_or_default()
}

fn as_bool(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64().map(|v| v != 0).unwrap_or(fallback),
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        _ => fallback,
    }
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn as_string_array(value: Option<&Value>) -> Vec<String> {
    let mut out = Vec::<String>::new();
    let mut seen = BTreeSet::<String>::new();
    if let Some(Value::Array(rows)) = value {
        for row in rows {
            let token = as_str(Some(row));
            if token.is_empty() {
                continue;
            }
            if seen.insert(token.clone()) {
                out.push(token);
            }
        }
    }
    out
}

fn normalize_status(raw: Option<&Value>) -> String {
    match as_str(raw).to_ascii_lowercase().as_str() {
        "disabled" | "off" | "paused" => "disabled".to_string(),
        _ => "active".to_string(),
    }
}

fn clamp_i64(v: i64, lo: i64, hi: i64) -> i64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

fn clamp_f64(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

fn normalize_ranking_weights(raw: Option<&Value>) -> Value {
    let mut defaults = Map::new();
    defaults.insert("composite".to_string(), json!(0.35));
    defaults.insert("actionability".to_string(), json!(0.2));
    defaults.insert("directive_fit".to_string(), json!(0.15));
    defaults.insert("signal_quality".to_string(), json!(0.15));
    defaults.insert("expected_value".to_string(), json!(0.1));
    defaults.insert("time_to_value".to_string(), json!(0.0));
    defaults.insert("risk_penalty".to_string(), json!(0.05));

    if let Some(Value::Object(obj)) = raw {
        for (key, value) in obj {
            if !defaults.contains_key(key) {
                continue;
            }
            if let Some(n) = as_f64(Some(value)) {
                if n.is_finite() && n >= 0.0 {
                    defaults.insert(key.clone(), json!(n));
                }
            }
        }
    }

    let total = defaults
        .values()
        .map(|v| as_f64(Some(v)).unwrap_or(0.0))
        .sum::<f64>();

    if total <= 0.0 {
        return Value::Object(defaults);
    }

    let mut normalized = Map::new();
    for (key, value) in defaults {
        let v = as_f64(Some(&value)).unwrap_or(0.0) / total;
        normalized.insert(key, json!((v * 1_000_000.0).round() / 1_000_000.0));
    }
    Value::Object(normalized)
}

fn normalize_campaigns(raw: Option<&Value>, active_only: bool) -> Value {
    let mut out = Vec::<Value>::new();
    if let Some(Value::Array(rows)) = raw {
        for row in rows {
            let Some(obj) = row.as_object() else {
                continue;
            };
            let id = as_str(obj.get("id")).to_ascii_lowercase();
            if id.is_empty() {
                continue;
            }
            let status = normalize_status(obj.get("status"));
            if active_only && status != "active" {
                continue;
            }
            let objective_id = {
                let primary = as_str(obj.get("objective_id"));
                if primary.is_empty() {
                    let fallback = as_str(obj.get("directive_ref"));
                    if fallback.is_empty() {
                        Value::Null
                    } else {
                        Value::String(fallback)
                    }
                } else {
                    Value::String(primary)
                }
            };

            let mut next = obj.clone();
            next.insert("id".to_string(), Value::String(id));
            next.insert("status".to_string(), Value::String(status));
            next.insert("objective_id".to_string(), objective_id);
            out.push(Value::Object(next));
        }
    }
    Value::Array(out)
}

fn normalize_promotion_policy(raw: Option<&Value>) -> Value {
    let src = raw.and_then(Value::as_object).cloned().unwrap_or_default();
    let min_days = clamp_i64(as_i64(src.get("min_days")).unwrap_or(7), 1, 90);
    let min_attempted = clamp_i64(as_i64(src.get("min_attempted")).unwrap_or(12), 0, 10000);
    let min_verified_rate = clamp_f64(
        as_f64(src.get("min_verified_rate")).unwrap_or(0.5),
        0.0,
        1.0,
    );
    let min_success_criteria_receipts = clamp_i64(
        as_i64(src.get("min_success_criteria_receipts")).unwrap_or(2),
        0,
        10000,
    );
    let min_success_criteria_pass_rate = clamp_f64(
        as_f64(src.get("min_success_criteria_pass_rate")).unwrap_or(0.6),
        0.0,
        1.0,
    );
    let min_objective_coverage = clamp_f64(
        as_f64(src.get("min_objective_coverage")).unwrap_or(0.25),
        0.0,
        1.0,
    );
    let max_objective_no_progress_rate = clamp_f64(
        as_f64(src.get("max_objective_no_progress_rate")).unwrap_or(0.9),
        0.0,
        1.0,
    );
    let max_reverted_rate = clamp_f64(
        as_f64(src.get("max_reverted_rate")).unwrap_or(0.35),
        0.0,
        1.0,
    );
    let max_stop_ratio = clamp_f64(as_f64(src.get("max_stop_ratio")).unwrap_or(0.75), 0.0, 1.0);
    let min_shipped = clamp_i64(as_i64(src.get("min_shipped")).unwrap_or(1), 0, 10000);
    let disable_legacy_fallback_after_quality_receipts = clamp_i64(
        as_i64(src.get("disable_legacy_fallback_after_quality_receipts")).unwrap_or(10),
        0,
        10000,
    );
    let max_success_criteria_quality_insufficient_rate = clamp_f64(
        as_f64(src.get("max_success_criteria_quality_insufficient_rate")).unwrap_or(0.4),
        0.0,
        1.0,
    );

    json!({
        "min_days": min_days,
        "min_attempted": min_attempted,
        "min_verified_rate": ((min_verified_rate * 1000.0).round() / 1000.0),
        "min_success_criteria_receipts": min_success_criteria_receipts,
        "min_success_criteria_pass_rate": ((min_success_criteria_pass_rate * 1000.0).round() / 1000.0),
        "min_objective_coverage": ((min_objective_coverage * 1000.0).round() / 1000.0),
        "max_objective_no_progress_rate": ((max_objective_no_progress_rate * 1000.0).round() / 1000.0),
        "max_reverted_rate": ((max_reverted_rate * 1000.0).round() / 1000.0),
        "max_stop_ratio": ((max_stop_ratio * 1000.0).round() / 1000.0),
        "min_shipped": min_shipped,
        "disable_legacy_fallback_after_quality_receipts": disable_legacy_fallback_after_quality_receipts,
        "max_success_criteria_quality_insufficient_rate": ((max_success_criteria_quality_insufficient_rate * 1000.0).round() / 1000.0)
    })
}

fn normalize_strategy(root: &Path, strategy_path: &Path, raw: &Value) -> Value {
    let src = raw.as_object().cloned().unwrap_or_default();
    let file_stem = strategy_path
        .file_stem()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "default".to_string());
    let id = {
        let token = as_str(src.get("id"));
        if token.is_empty() {
            file_stem
        } else {
            token
        }
    };
    let name = {
        let token = as_str(src.get("name"));
        if token.is_empty() {
            id.clone()
        } else {
            token
        }
    };

    let mut allowed = as_string_array(src.get("allowed_risks"))
        .into_iter()
        .map(|v| v.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if let Some(Value::Object(risk_obj)) = src.get("risk_policy") {
        for row in as_string_array(risk_obj.get("allowed_risks")) {
            let token = row.to_ascii_lowercase();
            if !allowed.iter().any(|v| v == &token) {
                allowed.push(token);
            }
        }
    }
    allowed.retain(|row| matches!(row.as_str(), "low" | "medium" | "high"));
    if allowed.is_empty() {
        allowed = vec!["low".to_string(), "medium".to_string()];
    }

    let max_risk_per_action = src
        .get("risk_policy")
        .and_then(Value::as_object)
        .and_then(|v| as_i64(v.get("max_risk_per_action")))
        .map(|v| clamp_i64(v, 0, 100));

    let execution_mode = {
        let raw_mode = src
            .get("execution_policy")
            .and_then(Value::as_object)
            .map(|v| as_str(v.get("mode")).to_ascii_lowercase())
            .unwrap_or_else(|| "score_only".to_string());
        match raw_mode.as_str() {
            "execute" => "execute".to_string(),
            "canary_execute" => "canary_execute".to_string(),
            _ => "score_only".to_string(),
        }
    };

    let generation_mode = {
        let raw_mode = src
            .get("generation_policy")
            .and_then(Value::as_object)
            .map(|v| as_str(v.get("mode")).to_ascii_lowercase())
            .unwrap_or_else(|| "hyper-creative".to_string());
        match raw_mode.as_str() {
            "normal" | "narrative" | "creative" | "hyper-creative" | "deep-thinker" => raw_mode,
            _ => "hyper-creative".to_string(),
        }
    };

    let canary_daily_exec_limit = src
        .get("execution_policy")
        .and_then(Value::as_object)
        .and_then(|v| as_i64(v.get("canary_daily_exec_limit")))
        .map(|v| clamp_i64(v, 1, 20));

    let budget_policy = {
        let obj = src
            .get("budget_policy")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        json!({
            "daily_runs_cap": as_i64(obj.get("daily_runs_cap")).map(|v| clamp_i64(v, 1, 500)),
            "daily_token_cap": as_i64(obj.get("daily_token_cap")).map(|v| clamp_i64(v, 100, 1_000_000)),
            "max_tokens_per_action": as_i64(obj.get("max_tokens_per_action")).map(|v| clamp_i64(v, 50, 1_000_000)),
            "token_cost_per_1k": as_f64(obj.get("token_cost_per_1k")),
            "daily_usd_cap": as_f64(obj.get("daily_usd_cap")),
            "per_action_avg_usd_cap": as_f64(obj.get("per_action_avg_usd_cap")),
            "monthly_usd_allocation": as_f64(obj.get("monthly_usd_allocation")),
            "monthly_credits_floor_pct": as_f64(obj.get("monthly_credits_floor_pct")).map(|v| clamp_f64(v, 0.0, 0.95)),
            "min_projected_tokens_for_burn_check": as_i64(obj.get("min_projected_tokens_for_burn_check")).map(|v| clamp_i64(v, 0, 1_000_000)),
            "per_capability_caps": obj.get("per_capability_caps").cloned().unwrap_or_else(|| json!({}))
        })
    };

    let exploration_policy = {
        let obj = src
            .get("exploration_policy")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let fraction = clamp_f64(as_f64(obj.get("fraction")).unwrap_or(0.25), 0.05, 0.8);
        let every_n = clamp_i64(as_i64(obj.get("every_n")).unwrap_or(3), 1, 20);
        let min_eligible = clamp_i64(as_i64(obj.get("min_eligible")).unwrap_or(3), 2, 20);
        json!({
            "fraction": ((fraction * 1000.0).round() / 1000.0),
            "every_n": every_n,
            "min_eligible": min_eligible
        })
    };

    let threshold_overrides = {
        let allowed = HashSet::from([
            "min_signal_quality",
            "min_sensory_signal_score",
            "min_sensory_relevance_score",
            "min_directive_fit",
            "min_actionability_score",
            "min_eye_score_ema",
            "min_composite_eligibility",
        ]);
        let mut out = Map::new();
        if let Some(Value::Object(overrides)) = src.get("threshold_overrides") {
            for (key, value) in overrides {
                if !allowed.contains(key.as_str()) {
                    continue;
                }
                if let Some(n) = as_f64(Some(value)) {
                    out.insert(key.clone(), json!(n));
                }
            }
        }
        Value::Object(out)
    };

    let admission_policy = {
        let obj = src
            .get("admission_policy")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        json!({
            "allowed_types": as_string_array(obj.get("allowed_types")).into_iter().map(|v| v.to_ascii_lowercase()).collect::<Vec<_>>(),
            "blocked_types": as_string_array(obj.get("blocked_types")).into_iter().map(|v| v.to_ascii_lowercase()).collect::<Vec<_>>(),
            "max_remediation_depth": as_i64(obj.get("max_remediation_depth")).map(|v| clamp_i64(v, 0, 12)),
            "duplicate_window_hours": clamp_i64(as_i64(obj.get("duplicate_window_hours")).unwrap_or(24), 1, 168)
        })
    };

    let objective = {
        let obj = src
            .get("objective")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let objective_metric = {
            let metric = as_str(obj.get("fitness_metric"));
            if metric.is_empty() {
                "verified_progress_rate".to_string()
            } else {
                metric
            }
        };
        json!({
            "primary": as_str(obj.get("primary")),
            "secondary": as_string_array(obj.get("secondary")),
            "fitness_metric": objective_metric,
            "target_window_days": clamp_i64(as_i64(obj.get("target_window_days")).unwrap_or(14), 1, 90)
        })
    };

    let ranking_weights = normalize_ranking_weights(src.get("ranking_weights"));

    let value_currency_policy = src
        .get("value_currency_policy")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let strategy_rel = strategy_path
        .strip_prefix(root)
        .map(|v| v.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| strategy_path.to_string_lossy().replace('\\', "/"));

    let strategy_version = {
        let v = as_str(src.get("version"));
        if v.is_empty() {
            "1.0".to_string()
        } else {
            v
        }
    };

    json!({
        "id": id,
        "name": name,
        "status": normalize_status(src.get("status")),
        "file": strategy_rel,
        "version": strategy_version,
        "objective": objective,
        "campaigns": normalize_campaigns(src.get("campaigns"), false),
        "generation_policy": { "mode": generation_mode },
        "tags": as_string_array(src.get("tags")).into_iter().map(|v| v.to_ascii_lowercase()).collect::<Vec<_>>(),
        "risk_policy": {
            "allowed_risks": allowed,
            "max_risk_per_action": max_risk_per_action,
            "invalid_risks": []
        },
        "admission_policy": admission_policy,
        "ranking_weights": ranking_weights,
        "budget_policy": budget_policy,
        "exploration_policy": exploration_policy,
        "stop_policy": src.get("stop_policy").cloned().unwrap_or_else(|| json!({})),
        "promotion_policy": normalize_promotion_policy(src.get("promotion_policy")),
        "execution_policy": {
            "mode": execution_mode,
            "canary_daily_exec_limit": canary_daily_exec_limit
        },
        "threshold_overrides": threshold_overrides,
        "value_currency_policy": value_currency_policy,
        "validation": {
            "strict_ok": true,
            "errors": [],
            "warnings": []
        }
    })
}

fn default_strategy_dir(root: &Path) -> PathBuf {
    root.join(DEFAULT_STRATEGY_DIR_REL)
}

fn list_strategies(root: &Path, options: Option<&Value>) -> Vec<Value> {
    let strategy_dir = options
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("dir"))
        .map(|v| as_str(Some(v)))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| default_strategy_dir(root));

    let Ok(entries) = fs::read_dir(&strategy_dir) else {
        return Vec::new();
    };

    let mut files = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().map(|v| v == "json").unwrap_or(false))
        .collect::<Vec<_>>();
    files.sort();

    let mut out = Vec::<Value>::new();
    for file_path in files {
        let Ok(text) = fs::read_to_string(&file_path) else {
            continue;
        };
        let Ok(raw) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if !raw.is_object() {
            continue;
        }
        out.push(normalize_strategy(root, &file_path, &raw));
    }

    out.sort_by(|a, b| as_str(a.get("id")).cmp(&as_str(b.get("id"))));
    out
}

fn apply_weaver_overlay(root: &Path, strategy: Value) -> Value {
    let overlay_path = std::env::var("WEAVER_ACTIVE_OVERLAY_PATH")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_WEAVER_OVERLAY_REL));

    let Ok(text) = fs::read_to_string(&overlay_path) else {
        return strategy;
    };
    let Ok(overlay) = serde_json::from_str::<Value>(&text) else {
        return strategy;
    };
    let Some(overlay_obj) = overlay.as_object() else {
        return strategy;
    };
    if !as_bool(overlay_obj.get("enabled"), false) {
        return strategy;
    }

    let strategy_id_overlay = as_str(overlay_obj.get("strategy_id"));
    let strategy_id_current = as_str(strategy.get("id"));
    if !strategy_id_overlay.is_empty()
        && strategy_id_overlay != "*"
        && strategy_id_overlay != strategy_id_current
    {
        return strategy;
    }

    let strategy_policy = overlay_obj
        .get("strategy_policy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let value_currency_overlay = strategy_policy
        .get("value_currency_policy_overrides")
        .cloned();

    let Some(mut strategy_obj) = strategy.as_object().cloned() else {
        return strategy;
    };

    if let Some(Value::Object(overlay_policy_obj)) = value_currency_overlay {
        let mut merged = strategy_obj
            .get("value_currency_policy")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in overlay_policy_obj {
            merged.insert(key, value);
        }
        strategy_obj.insert("value_currency_policy".to_string(), Value::Object(merged));
    }

    strategy_obj.insert(
        "weaver_overlay".to_string(),
        json!({
            "ts": as_str(overlay_obj.get("ts")),
            "source": overlay_path
                .strip_prefix(root)
                .map(|v| v.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| overlay_path.to_string_lossy().replace('\\', "/")),
            "objective_id": as_str(overlay_obj.get("objective_id")),
            "primary_metric_id": as_str(overlay_obj.get("primary_metric_id")),
            "reason_codes": as_string_array(overlay_obj.get("reason_codes"))
        }),
    );

    Value::Object(strategy_obj)
}

fn load_active_strategy(root: &Path, options: Option<&Value>) -> Result<Value, String> {
    let options_obj = options
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let allow_missing = as_bool(options_obj.get("allowMissing"), false);
    let strict = as_bool(options_obj.get("strict"), false)
        || matches!(
            std::env::var("AUTONOMY_STRATEGY_STRICT").ok().as_deref(),
            Some("1")
        );
    let requested_id = {
        let id = as_str(options_obj.get("id"));
        if id.is_empty() {
            std::env::var("AUTONOMY_STRATEGY_ID")
                .ok()
                .unwrap_or_default()
                .trim()
                .to_string()
        } else {
            id
        }
    };

    let listed = list_strategies(root, options);
    if listed.is_empty() {
        if allow_missing {
            return Ok(Value::Null);
        }
        return Err("strategy_not_found:no_profiles".to_string());
    }

    let mut pick = Value::Null;
    if !requested_id.is_empty() {
        if let Some(hit) = listed
            .iter()
            .find(|row| as_str(row.get("id")) == requested_id)
            .cloned()
        {
            pick = hit;
        } else if allow_missing {
            return Ok(Value::Null);
        } else {
            return Err(format!("strategy_not_found:{requested_id}"));
        }
    } else if let Some(active) = listed
        .iter()
        .find(|row| as_str(row.get("status")) == "active")
        .cloned()
    {
        pick = active;
    }

    if pick.is_null() {
        if allow_missing {
            return Ok(Value::Null);
        }
        return Err("strategy_not_found:no_active".to_string());
    }

    if strict {
        let strict_ok = pick
            .get("validation")
            .and_then(Value::as_object)
            .and_then(|obj| obj.get("strict_ok"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !strict_ok {
            return Err(format!("strategy_invalid:{}", as_str(pick.get("id"))));
        }
    }

    Ok(apply_weaver_overlay(root, pick))
}

fn resolve_ranking_context(strategy: Option<&Value>, context: Option<&Value>) -> Value {
    let strategy_obj = strategy
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let context_obj = context
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let base_weights = normalize_ranking_weights(strategy_obj.get("ranking_weights"));
    let mut weights_map = base_weights.as_object().cloned().unwrap_or_default();

    let policy_obj = strategy_obj
        .get("value_currency_policy")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let objective_id = as_str(context_obj.get("objective_id"));
    let mut selected_currency = as_str(context_obj.get("value_currency")).to_ascii_lowercase();
    let mut applied = Vec::<String>::new();

    if let Some(objective_overrides) = policy_obj
        .get("objective_overrides")
        .and_then(Value::as_object)
    {
        if let Some(objective_hit) = objective_overrides
            .get(&objective_id)
            .and_then(Value::as_object)
        {
            if let Some(ranking_overlay) = objective_hit.get("ranking_weights") {
                if let Some(overlay_obj) = ranking_overlay.as_object() {
                    for (key, value) in overlay_obj {
                        if let Some(n) = as_f64(Some(value)) {
                            if n >= 0.0 {
                                weights_map.insert(key.clone(), json!(n));
                            }
                        }
                    }
                    applied.push(format!("objective:{objective_id}"));
                }
            }
            if selected_currency.is_empty() {
                selected_currency =
                    as_str(objective_hit.get("primary_currency")).to_ascii_lowercase();
            }
        }
    }

    if selected_currency.is_empty() {
        selected_currency = as_str(policy_obj.get("default_currency")).to_ascii_lowercase();
    }

    if let Some(currency_overrides) = policy_obj
        .get("currency_overrides")
        .and_then(Value::as_object)
    {
        if let Some(currency_hit) = currency_overrides
            .get(&selected_currency)
            .and_then(Value::as_object)
        {
            if let Some(ranking_overlay) = currency_hit.get("ranking_weights") {
                if let Some(overlay_obj) = ranking_overlay.as_object() {
                    for (key, value) in overlay_obj {
                        if let Some(n) = as_f64(Some(value)) {
                            if n >= 0.0 {
                                weights_map.insert(key.clone(), json!(n));
                            }
                        }
                    }
                    if !selected_currency.is_empty() {
                        applied.push(format!("currency:{selected_currency}"));
                    }
                }
            }
        }
    }

    let normalized_weights = normalize_ranking_weights(Some(&Value::Object(weights_map)));

    json!({
        "objective_id": if objective_id.is_empty() { Value::Null } else { Value::String(objective_id) },
        "value_currency": if selected_currency.is_empty() { Value::Null } else { Value::String(selected_currency) },
        "weights": normalized_weights,
        "applied_overrides": applied
    })
}

fn op_dispatch(root: &Path, op: &str, args: Option<&Value>) -> Result<Value, String> {
    match op {
        "listStrategies" => Ok(Value::Array(list_strategies(root, args))),
        "loadActiveStrategy" => load_active_strategy(root, args),
        "effectiveAllowedRisks" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let defaults = as_string_array(args_obj.get("defaultSet"))
                .into_iter()
                .map(|v| v.to_ascii_lowercase())
                .collect::<Vec<_>>();
            let strategy_allowed = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("risk_policy"))
                .and_then(Value::as_object)
                .map(|obj| as_string_array(obj.get("allowed_risks")))
                .unwrap_or_default()
                .into_iter()
                .map(|v| v.to_ascii_lowercase())
                .collect::<Vec<_>>();
            let selected = if strategy_allowed.is_empty() {
                defaults
            } else {
                strategy_allowed
            };
            let mut dedupe = BTreeSet::<String>::new();
            let out = selected
                .into_iter()
                .filter(|v| !v.is_empty())
                .filter(|v| dedupe.insert(v.clone()))
                .collect::<Vec<_>>();
            Ok(json!(out))
        }
        "applyThresholdOverrides" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let mut base = args_obj
                .get("baseThresholds")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let overrides = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("threshold_overrides"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let allowed = HashSet::from([
                "min_signal_quality",
                "min_sensory_signal_score",
                "min_sensory_relevance_score",
                "min_directive_fit",
                "min_actionability_score",
                "min_eye_score_ema",
                "min_composite_eligibility",
            ]);
            for (key, value) in overrides {
                if !allowed.contains(key.as_str()) {
                    continue;
                }
                if as_f64(Some(&value)).is_some() {
                    base.insert(key, value);
                }
            }
            Ok(Value::Object(base))
        }
        "strategyExecutionMode" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let fallback = as_str(args_obj.get("fallback")).to_ascii_lowercase();
            let fallback_mode = match fallback.as_str() {
                "score_only" => "score_only",
                "canary_execute" => "canary_execute",
                "execute" => "execute",
                _ => "execute",
            };
            let mode = strategy
                .get("execution_policy")
                .and_then(Value::as_object)
                .map(|obj| as_str(obj.get("mode")).to_ascii_lowercase())
                .unwrap_or_default();
            let out = match mode.as_str() {
                "score_only" => "score_only",
                "canary_execute" => "canary_execute",
                "execute" => "execute",
                _ => fallback_mode,
            };
            Ok(Value::String(out.to_string()))
        }
        "strategyGenerationMode" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let fallback = as_str(args_obj.get("fallback")).to_ascii_lowercase();
            let mode = strategy
                .get("generation_policy")
                .and_then(Value::as_object)
                .map(|obj| as_str(obj.get("mode")).to_ascii_lowercase())
                .unwrap_or_default();
            let allowed = HashSet::from([
                "normal",
                "narrative",
                "creative",
                "hyper-creative",
                "deep-thinker",
            ]);
            if allowed.contains(mode.as_str()) {
                Ok(Value::String(mode))
            } else if allowed.contains(fallback.as_str()) {
                Ok(Value::String(fallback))
            } else {
                Ok(Value::String("hyper-creative".to_string()))
            }
        }
        "strategyCanaryDailyExecLimit" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let from_strategy = strategy
                .get("execution_policy")
                .and_then(Value::as_object)
                .and_then(|obj| as_i64(obj.get("canary_daily_exec_limit")));
            let fallback = as_i64(args_obj.get("fallback"));
            let value = from_strategy.or(fallback).map(|v| clamp_i64(v, 1, 20));
            Ok(value.map(Value::from).unwrap_or(Value::Null))
        }
        "strategyBudgetCaps" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let defaults = args_obj
                .get("defaults")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let policy = strategy
                .get("budget_policy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();

            let choose_i64 = |key: &str, lo: i64, hi: i64| -> Option<i64> {
                as_i64(policy.get(key))
                    .or_else(|| as_i64(defaults.get(key)))
                    .map(|v| clamp_i64(v, lo, hi))
            };
            let choose_f64 = |key: &str| -> Option<f64> {
                as_f64(policy.get(key)).or_else(|| as_f64(defaults.get(key)))
            };

            Ok(json!({
                "daily_runs_cap": choose_i64("daily_runs_cap", 1, 500),
                "daily_token_cap": choose_i64("daily_token_cap", 100, 1_000_000),
                "max_tokens_per_action": choose_i64("max_tokens_per_action", 50, 1_000_000),
                "token_cost_per_1k": choose_f64("token_cost_per_1k"),
                "daily_usd_cap": choose_f64("daily_usd_cap"),
                "per_action_avg_usd_cap": choose_f64("per_action_avg_usd_cap"),
                "monthly_usd_allocation": choose_f64("monthly_usd_allocation"),
                "monthly_credits_floor_pct": choose_f64("monthly_credits_floor_pct").map(|v| clamp_f64(v, 0.0, 0.95)),
                "min_projected_tokens_for_burn_check": choose_i64("min_projected_tokens_for_burn_check", 0, 1_000_000),
                "per_capability_caps": policy.get("per_capability_caps").cloned().unwrap_or_else(|| json!({}))
            }))
        }
        "strategyExplorationPolicy" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let defaults = args_obj
                .get("defaults")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let policy = strategy
                .get("exploration_policy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let fraction = as_f64(policy.get("fraction"))
                .or_else(|| as_f64(defaults.get("fraction")))
                .unwrap_or(0.25);
            let every_n = as_i64(policy.get("every_n"))
                .or_else(|| as_i64(defaults.get("every_n")))
                .unwrap_or(3);
            let min_eligible = as_i64(policy.get("min_eligible"))
                .or_else(|| as_i64(defaults.get("min_eligible")))
                .unwrap_or(3);
            Ok(json!({
                "fraction": clamp_f64(fraction, 0.05, 0.8),
                "every_n": clamp_i64(every_n, 1, 20),
                "min_eligible": clamp_i64(min_eligible, 2, 20)
            }))
        }
        "resolveStrategyRankingContext" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            Ok(resolve_ranking_context(
                args_obj.get("strategy"),
                args_obj.get("context"),
            ))
        }
        "strategyRankingWeights" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let resolved =
                resolve_ranking_context(args_obj.get("strategy"), args_obj.get("context"));
            Ok(resolved
                .get("weights")
                .cloned()
                .unwrap_or_else(|| json!({})))
        }
        "strategyCampaigns" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let active_only = as_bool(args_obj.get("activeOnly"), false);
            Ok(normalize_campaigns(strategy.get("campaigns"), active_only))
        }
        "strategyAllowsProposalType" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let proposal_type = as_str(args_obj.get("proposalType")).to_ascii_lowercase();
            let admission_policy = strategy
                .get("admission_policy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let allowed = as_string_array(admission_policy.get("allowed_types"))
                .into_iter()
                .map(|v| v.to_ascii_lowercase())
                .collect::<Vec<_>>();
            let blocked = as_string_array(admission_policy.get("blocked_types"))
                .into_iter()
                .map(|v| v.to_ascii_lowercase())
                .collect::<Vec<_>>();

            let out = if proposal_type.is_empty() {
                allowed.is_empty()
            } else if blocked.iter().any(|v| v == &proposal_type) {
                false
            } else if allowed.is_empty() {
                true
            } else {
                allowed.iter().any(|v| v == &proposal_type)
            };
            Ok(Value::Bool(out))
        }
        "strategyPromotionPolicy" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let defaults = args_obj
                .get("defaults")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let merged = {
                let mut out = defaults.as_object().cloned().unwrap_or_default();
                if let Some(obj) = strategy.get("promotion_policy").and_then(Value::as_object) {
                    for (k, v) in obj {
                        out.insert(k.clone(), v.clone());
                    }
                }
                Value::Object(out)
            };
            Ok(normalize_promotion_policy(Some(&merged)))
        }
        "strategyMaxRiskPerAction" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let raw = strategy
                .get("risk_policy")
                .and_then(Value::as_object)
                .and_then(|obj| as_i64(obj.get("max_risk_per_action")))
                .or_else(|| as_i64(args_obj.get("fallback")));
            Ok(raw
                .map(|v| Value::from(clamp_i64(v, 0, 100)))
                .unwrap_or(Value::Null))
        }
        "strategyDuplicateWindowHours" => {
            let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
            let strategy = args_obj
                .get("strategy")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let from_strategy = strategy
                .get("admission_policy")
                .and_then(Value::as_object)
                .and_then(|obj| as_i64(obj.get("duplicate_window_hours")));
            let fallback = as_i64(args_obj.get("fallback")).unwrap_or(24);
            let out = clamp_i64(from_strategy.unwrap_or(fallback), 1, 168);
            Ok(Value::from(out))
        }
        _ => Err(format!("strategy_resolver_unknown_op:{op}")),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops strategy-resolver status");
        println!("  protheus-ops strategy-resolver invoke --payload=<json>");
        return 0;
    }

    if cmd == "status" {
        let mut out = json!({
            "ok": true,
            "type": "strategy_resolver_status",
            "authority": "core/layer2/execution",
            "commands": ["status", "invoke"],
            "default_strategy_dir": DEFAULT_STRATEGY_DIR_REL,
            "default_weaver_overlay_path": DEFAULT_WEAVER_OVERLAY_REL,
            "ts": now_iso(),
            "root": clean(root.display(), 280)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_json_line(&out);
        return 0;
    }

    if cmd != "invoke" {
        let mut out = json!({
            "ok": false,
            "type": "strategy_resolver_cli_error",
            "authority": "core/layer2/execution",
            "command": cmd,
            "error": "unknown_command",
            "ts": now_iso(),
            "exit_code": 2
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_json_line(&out);
        return 2;
    }

    let payload = match load_payload(argv) {
        Ok(value) => value,
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "strategy_resolver_cli_error",
                "authority": "core/layer2/execution",
                "command": "invoke",
                "error": err,
                "ts": now_iso(),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            return 2;
        }
    };

    let op = payload
        .get("op")
        .map(|v| as_str(Some(v)))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "".to_string());

    let result = op_dispatch(root, op.as_str(), payload.get("args"));
    match result {
        Ok(result_value) => {
            let mut out = json!({
                "ok": true,
                "type": "strategy_resolver",
                "authority": "core/layer2/execution",
                "command": "invoke",
                "op": op,
                "result": result_value,
                "ts": now_iso(),
                "root": clean(root.display(), 280)
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            0
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "strategy_resolver",
                "authority": "core/layer2/execution",
                "command": "invoke",
                "op": op,
                "error": err,
                "ts": now_iso(),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            2
        }
    }
}
