// SPDX-License-Identifier: Apache-2.0
use serde_json::{json, Map, Number, Value};
use std::collections::HashSet;

const STRATEGY_GENERATION_MODES: &[&str] = &[
    "normal",
    "narrative",
    "creative",
    "hyper-creative",
    "deep-thinker",
];

const VALUE_CURRENCY_KEYS: &[&str] = &[
    "revenue",
    "delivery",
    "user_value",
    "quality",
    "time_savings",
    "learning",
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

fn as_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(other) => other.to_string().trim_matches('"').trim().to_string(),
        None => String::new(),
    }
}

fn parse_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(num)) => num.as_f64().filter(|v| v.is_finite()),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
        Some(Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn round_to(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    (value * factor).round() / factor
}

fn clamp_number(value: f64, lo: f64, hi: f64, fallback: f64) -> f64 {
    let mut next = if value.is_finite() { value } else { fallback };
    if next < lo {
        next = lo;
    }
    if next > hi {
        next = hi;
    }
    next
}

fn normalize_integer(
    value: Option<&Value>,
    lo: i64,
    hi: i64,
    fallback: Option<i64>,
    allow_null: bool,
) -> Option<i64> {
    if allow_null {
        let raw = as_string(value);
        if raw.is_empty() {
            return None;
        }
    }
    let Some(parsed) = parse_f64(value) else {
        return fallback;
    };
    let mut out = parsed.round() as i64;
    if out < lo {
        out = lo;
    }
    if out > hi {
        out = hi;
    }
    Some(out)
}

fn value_currency_key(value: Option<&Value>) -> String {
    let key = as_string(value).to_lowercase();
    if VALUE_CURRENCY_KEYS.contains(&key.as_str()) {
        key
    } else {
        String::new()
    }
}

fn parse_string_array_lowercase(value: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let Some(items) = value.and_then(Value::as_array) else {
        return out;
    };
    for item in items {
        let token = as_string(Some(item)).to_lowercase();
        if token.is_empty() || seen.contains(&token) {
            continue;
        }
        seen.insert(token.clone());
        out.push(token);
    }
    out
}

fn to_json_number(value: f64) -> Value {
    match Number::from_f64(value) {
        Some(n) => Value::Number(n),
        None => Value::Null,
    }
}

fn to_json_opt_i64(value: Option<i64>) -> Value {
    match value {
        Some(v) => Value::Number(Number::from(v)),
        None => Value::Null,
    }
}

fn default_ranking_weights_map() -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("composite".to_string(), to_json_number(0.35));
    out.insert("actionability".to_string(), to_json_number(0.2));
    out.insert("directive_fit".to_string(), to_json_number(0.15));
    out.insert("signal_quality".to_string(), to_json_number(0.15));
    out.insert("expected_value".to_string(), to_json_number(0.1));
    out.insert("time_to_value".to_string(), to_json_number(0.0));
    out.insert("risk_penalty".to_string(), to_json_number(0.05));
    out
}

fn normalize_ranking_weights(raw: Option<&Value>) -> Map<String, Value> {
    let mut merged = default_ranking_weights_map();
    if let Some(obj) = raw.and_then(Value::as_object) {
        for (key, value) in obj {
            if !RANKING_WEIGHT_KEYS.contains(&key.as_str()) {
                continue;
            }
            if let Some(number) = parse_f64(Some(value)) {
                if number.is_sign_negative() {
                    continue;
                }
                merged.insert(key.to_string(), to_json_number(number));
            }
        }
    }
    let total = merged
        .values()
        .filter_map(|value| parse_f64(Some(value)))
        .sum::<f64>();
    if total <= 0.0 {
        return default_ranking_weights_map();
    }
    let mut normalized = Map::new();
    for key in RANKING_WEIGHT_KEYS {
        let raw_value = merged
            .get(*key)
            .and_then(|value| parse_f64(Some(value)))
            .unwrap_or(0.0);
        let ratio = round_to(raw_value / total, 6);
        normalized.insert((*key).to_string(), to_json_number(ratio));
    }
    normalized
}

fn merge_ranking_weights(base: &Map<String, Value>, overlay: Option<&Value>) -> Map<String, Value> {
    let mut merged = base.clone();
    if let Some(obj) = overlay.and_then(Value::as_object) {
        for (key, value) in obj {
            if !RANKING_WEIGHT_KEYS.contains(&key.as_str()) {
                continue;
            }
            if let Some(number) = parse_f64(Some(value)) {
                if number.is_sign_negative() {
                    continue;
                }
                merged.insert(key.to_string(), to_json_number(number));
            }
        }
    }
    let merged_value = Value::Object(merged);
    normalize_ranking_weights(Some(&merged_value))
}

fn normalize_promotion_policy(raw: Option<&Value>) -> Map<String, Value> {
    let obj = raw.and_then(Value::as_object);
    let mut out = Map::new();
    out.insert(
        "min_days".to_string(),
        to_json_opt_i64(normalize_integer(
            obj.and_then(|src| src.get("min_days")),
            1,
            90,
            Some(7),
            false,
        )),
    );
    out.insert(
        "min_attempted".to_string(),
        to_json_opt_i64(normalize_integer(
            obj.and_then(|src| src.get("min_attempted")),
            0,
            10_000,
            Some(12),
            false,
        )),
    );
    out.insert(
        "min_verified_rate".to_string(),
        to_json_number(round_to(
            clamp_number(
                parse_f64(obj.and_then(|src| src.get("min_verified_rate"))).unwrap_or(0.5),
                0.0,
                1.0,
                0.5,
            ),
            3,
        )),
    );
    out.insert(
        "min_success_criteria_receipts".to_string(),
        to_json_opt_i64(normalize_integer(
            obj.and_then(|src| src.get("min_success_criteria_receipts")),
            0,
            10_000,
            Some(2),
            false,
        )),
    );
    out.insert(
        "min_success_criteria_pass_rate".to_string(),
        to_json_number(round_to(
            clamp_number(
                parse_f64(obj.and_then(|src| src.get("min_success_criteria_pass_rate")))
                    .unwrap_or(0.6),
                0.0,
                1.0,
                0.6,
            ),
            3,
        )),
    );
    out.insert(
        "min_objective_coverage".to_string(),
        to_json_number(round_to(
            clamp_number(
                parse_f64(obj.and_then(|src| src.get("min_objective_coverage"))).unwrap_or(0.25),
                0.0,
                1.0,
                0.25,
            ),
            3,
        )),
    );
    out.insert(
        "max_objective_no_progress_rate".to_string(),
        to_json_number(round_to(
            clamp_number(
                parse_f64(obj.and_then(|src| src.get("max_objective_no_progress_rate")))
                    .unwrap_or(0.9),
                0.0,
                1.0,
                0.9,
            ),
            3,
        )),
    );
    out.insert(
        "max_reverted_rate".to_string(),
        to_json_number(round_to(
            clamp_number(
                parse_f64(obj.and_then(|src| src.get("max_reverted_rate"))).unwrap_or(0.35),
                0.0,
                1.0,
                0.35,
            ),
            3,
        )),
    );
    out.insert(
        "max_stop_ratio".to_string(),
        to_json_number(round_to(
            clamp_number(
                parse_f64(obj.and_then(|src| src.get("max_stop_ratio"))).unwrap_or(0.75),
                0.0,
                1.0,
                0.75,
            ),
            3,
        )),
    );
    out.insert(
        "min_shipped".to_string(),
        to_json_opt_i64(normalize_integer(
            obj.and_then(|src| src.get("min_shipped")),
            0,
            10_000,
            Some(1),
            false,
        )),
    );
    out.insert(
        "disable_legacy_fallback_after_quality_receipts".to_string(),
        to_json_opt_i64(normalize_integer(
            obj.and_then(|src| src.get("disable_legacy_fallback_after_quality_receipts")),
            0,
            10_000,
            Some(10),
            false,
        )),
    );
    out.insert(
        "max_success_criteria_quality_insufficient_rate".to_string(),
        to_json_number(round_to(
            clamp_number(
                parse_f64(
                    obj.and_then(|src| src.get("max_success_criteria_quality_insufficient_rate")),
                )
                .unwrap_or(0.4),
                0.0,
                1.0,
                0.4,
            ),
            3,
        )),
    );
    out
}

fn strategy_execution_mode(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let mode_raw = as_string(
        strategy
            .get("execution_policy")
            .and_then(Value::as_object)
            .and_then(|obj| obj.get("mode")),
    )
    .to_lowercase();
    let fallback_raw = as_string(payload.get("fallback")).to_lowercase();
    let fallback_mode = match fallback_raw.as_str() {
        "score_only" => "score_only",
        "canary_execute" => "canary_execute",
        _ => "execute",
    };
    let mode = match mode_raw.as_str() {
        "score_only" => "score_only",
        "canary_execute" => "canary_execute",
        "execute" => "execute",
        _ => fallback_mode,
    };
    json!({ "mode": mode })
}

fn strategy_generation_mode(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let mode_raw = as_string(
        strategy
            .get("generation_policy")
            .and_then(Value::as_object)
            .and_then(|obj| obj.get("mode")),
    )
    .to_lowercase();
    if STRATEGY_GENERATION_MODES.contains(&mode_raw.as_str()) {
        return json!({ "mode": mode_raw });
    }
    let fallback_raw = as_string(payload.get("fallback")).to_lowercase();
    let fallback = if STRATEGY_GENERATION_MODES.contains(&fallback_raw.as_str()) {
        fallback_raw
    } else {
        "hyper-creative".to_string()
    };
    json!({ "mode": fallback })
}

fn strategy_canary_daily_exec_limit(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let raw = strategy
        .get("execution_policy")
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("canary_daily_exec_limit"));
    if !as_string(raw).is_empty() {
        if let Some(value) = parse_f64(raw) {
            let bounded = value.round().clamp(1.0, 20.0) as i64;
            return json!({ "value": bounded });
        }
    }
    let fallback = parse_f64(payload.get("fallback"));
    if let Some(value) = fallback {
        if value > 0.0 {
            let bounded = value.round().clamp(1.0, 20.0) as i64;
            return json!({ "value": bounded });
        }
    }
    json!({ "value": null })
}

fn strategy_budget_caps(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let defaults = payload.get("defaults").unwrap_or(&Value::Null);
    let budget = strategy.get("budget_policy").unwrap_or(&Value::Null);

    let default_runs = parse_f64(defaults.get("daily_runs_cap"));
    let default_tokens = parse_f64(defaults.get("daily_token_cap"));
    let default_per_action = parse_f64(defaults.get("max_tokens_per_action"));
    let default_token_cost_per_1k = parse_f64(defaults.get("token_cost_per_1k"));
    let default_daily_usd_cap = parse_f64(defaults.get("daily_usd_cap"));
    let default_per_action_avg_usd_cap = parse_f64(defaults.get("per_action_avg_usd_cap"));
    let default_monthly_usd_allocation = parse_f64(defaults.get("monthly_usd_allocation"));
    let default_monthly_credits_floor_pct = parse_f64(defaults.get("monthly_credits_floor_pct"));
    let default_min_projected_tokens_for_burn_check =
        parse_f64(defaults.get("min_projected_tokens_for_burn_check"));

    let runs = parse_f64(budget.get("daily_runs_cap")).or(default_runs);
    let tokens = parse_f64(budget.get("daily_token_cap")).or(default_tokens);

    let per_action = if !as_string(budget.get("max_tokens_per_action")).is_empty() {
        parse_f64(budget.get("max_tokens_per_action")).or(default_per_action)
    } else {
        default_per_action
    };

    let token_cost_per_1k = parse_f64(budget.get("token_cost_per_1k"))
        .filter(|value| *value > 0.0)
        .or(default_token_cost_per_1k.filter(|value| *value > 0.0));

    let daily_usd_cap = parse_f64(budget.get("daily_usd_cap"))
        .filter(|value| *value > 0.0)
        .or(default_daily_usd_cap.filter(|value| *value > 0.0));

    let per_action_avg_usd_cap = parse_f64(budget.get("per_action_avg_usd_cap"))
        .filter(|value| *value > 0.0)
        .or(default_per_action_avg_usd_cap.filter(|value| *value > 0.0));

    let monthly_usd_allocation = parse_f64(budget.get("monthly_usd_allocation"))
        .filter(|value| *value > 0.0)
        .or(default_monthly_usd_allocation.filter(|value| *value > 0.0));

    let monthly_credits_floor_pct = parse_f64(budget.get("monthly_credits_floor_pct"))
        .map(|value| round_to(clamp_number(value, 0.0, 0.95, 0.2), 4))
        .or(default_monthly_credits_floor_pct
            .map(|value| round_to(clamp_number(value, 0.0, 0.95, 0.2), 4)));

    let min_projected_tokens_for_burn_check =
        parse_f64(budget.get("min_projected_tokens_for_burn_check"))
            .filter(|value| *value >= 0.0)
            .map(|value| value.round() as i64)
            .or(default_min_projected_tokens_for_burn_check
                .filter(|value| *value >= 0.0)
                .map(|value| value.round() as i64));

    let per_capability_caps = budget
        .get("per_capability_caps")
        .and_then(Value::as_object)
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| Value::Object(Map::new()));

    json!({
        "daily_runs_cap": runs,
        "daily_token_cap": tokens,
        "max_tokens_per_action": per_action,
        "token_cost_per_1k": token_cost_per_1k,
        "daily_usd_cap": daily_usd_cap,
        "per_action_avg_usd_cap": per_action_avg_usd_cap,
        "monthly_usd_allocation": monthly_usd_allocation,
        "monthly_credits_floor_pct": monthly_credits_floor_pct,
        "min_projected_tokens_for_burn_check": min_projected_tokens_for_burn_check,
        "per_capability_caps": per_capability_caps
    })
}

fn strategy_exploration_policy(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let defaults = payload.get("defaults").unwrap_or(&Value::Null);
    let base_fraction = parse_f64(defaults.get("fraction")).unwrap_or(0.25);
    let base_every_n = parse_f64(defaults.get("every_n")).unwrap_or(3.0);
    let base_min_eligible = parse_f64(defaults.get("min_eligible")).unwrap_or(3.0);
    let Some(policy) = strategy.get("exploration_policy") else {
        return json!({
            "fraction": base_fraction,
            "every_n": base_every_n,
            "min_eligible": base_min_eligible
        });
    };
    json!({
        "fraction": parse_f64(policy.get("fraction")),
        "every_n": parse_f64(policy.get("every_n")),
        "min_eligible": parse_f64(policy.get("min_eligible"))
    })
}

fn resolve_strategy_ranking_context(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let context = payload.get("context").unwrap_or(&Value::Null);
    let mut weights = strategy
        .get("ranking_weights")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(default_ranking_weights_map);

    let objective_id = as_string(context.get("objective_id"));
    let requested_currency = value_currency_key(context.get("value_currency"));
    let mut selected_currency = if requested_currency.is_empty() {
        None
    } else {
        Some(requested_currency)
    };
    let mut applied: Vec<String> = Vec::new();

    if let Some(policy) = strategy
        .get("value_currency_policy")
        .and_then(Value::as_object)
    {
        let objective_overrides = policy
            .get("objective_overrides")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let currency_overrides = policy
            .get("currency_overrides")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        let objective_hit = if objective_id.is_empty() {
            None
        } else {
            objective_overrides.get(&objective_id).cloned()
        };

        if let Some(obj_hit) = objective_hit.as_ref().and_then(Value::as_object) {
            if obj_hit
                .get("ranking_weights")
                .and_then(Value::as_object)
                .is_some()
            {
                weights = merge_ranking_weights(&weights, obj_hit.get("ranking_weights"));
                applied.push(format!("objective:{}", objective_id));
            }
            if selected_currency.is_none() {
                let candidate = value_currency_key(obj_hit.get("primary_currency"));
                if !candidate.is_empty() {
                    selected_currency = Some(candidate);
                }
            }
        }

        if selected_currency.is_none() {
            let candidate = value_currency_key(policy.get("default_currency"));
            if !candidate.is_empty() {
                selected_currency = Some(candidate);
            }
        }

        if let Some(currency) = selected_currency.as_ref() {
            if let Some(currency_hit) = currency_overrides.get(currency).and_then(Value::as_object)
            {
                if currency_hit
                    .get("ranking_weights")
                    .and_then(Value::as_object)
                    .is_some()
                {
                    weights = merge_ranking_weights(&weights, currency_hit.get("ranking_weights"));
                    applied.push(format!("currency:{}", currency));
                }
            }
        }
    }

    json!({
        "objective_id": if objective_id.is_empty() { Value::Null } else { Value::String(objective_id) },
        "value_currency": selected_currency.map(Value::String).unwrap_or(Value::Null),
        "weights": Value::Object(weights),
        "applied_overrides": applied
    })
}

fn strategy_allows_proposal_type(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let Some(policy) = strategy.get("admission_policy").and_then(Value::as_object) else {
        return json!({ "allow": true });
    };
    let proposal_type = as_string(payload.get("proposal_type")).to_lowercase();
    let allowed = parse_string_array_lowercase(policy.get("allowed_types"));
    let blocked = parse_string_array_lowercase(policy.get("blocked_types"));

    let allow = if proposal_type.is_empty() {
        allowed.is_empty()
    } else if blocked.contains(&proposal_type) {
        false
    } else if allowed.is_empty() {
        true
    } else {
        allowed.contains(&proposal_type)
    };
    json!({ "allow": allow })
}

fn strategy_promotion_policy(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let defaults = payload.get("defaults").unwrap_or(&Value::Null);
    let base = normalize_promotion_policy(Some(defaults));
    let Some(policy) = strategy.get("promotion_policy").and_then(Value::as_object) else {
        return Value::Object(base);
    };
    let mut merged = base;
    for (key, value) in policy {
        merged.insert(key.to_string(), value.clone());
    }
    let merged_value = Value::Object(merged);
    Value::Object(normalize_promotion_policy(Some(&merged_value)))
}

fn strategy_max_risk_per_action(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let raw = strategy
        .get("risk_policy")
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("max_risk_per_action"));
    if !as_string(raw).is_empty() {
        if let Some(value) = parse_f64(raw) {
            let bounded = value.round().clamp(0.0, 100.0) as i64;
            return json!({ "value": bounded });
        }
    }
    if let Some(fallback) = parse_f64(payload.get("fallback")) {
        let bounded = fallback.round().clamp(0.0, 100.0) as i64;
        return json!({ "value": bounded });
    }
    json!({ "value": null })
}

fn strategy_duplicate_window_hours(payload: &Value) -> Value {
    let strategy = payload.get("strategy").unwrap_or(&Value::Null);
    let primary = strategy
        .get("admission_policy")
        .and_then(Value::as_object)
        .and_then(|obj| parse_f64(obj.get("duplicate_window_hours")));
    if let Some(value) = primary {
        let bounded = value.round().clamp(1.0, 168.0) as i64;
        return json!({ "value": bounded });
    }
    if let Some(fallback) = parse_f64(payload.get("fallback")) {
        let bounded = fallback.round().clamp(1.0, 168.0) as i64;
        return json!({ "value": bounded });
    }
    json!({ "value": 24 })
}

pub fn run_strategy_hotpath_json(payload: &str) -> Result<String, String> {
    let body: Value =
        serde_json::from_str(payload).map_err(|err| format!("invalid_payload:{}", err))?;
    let op = as_string(body.get("op")).to_lowercase();
    let result = match op.as_str() {
        "strategy_execution_mode" => strategy_execution_mode(&body),
        "strategy_generation_mode" => strategy_generation_mode(&body),
        "strategy_canary_daily_exec_limit" => strategy_canary_daily_exec_limit(&body),
        "strategy_budget_caps" => strategy_budget_caps(&body),
        "strategy_exploration_policy" => strategy_exploration_policy(&body),
        "resolve_strategy_ranking_context" => resolve_strategy_ranking_context(&body),
        "strategy_allows_proposal_type" => strategy_allows_proposal_type(&body),
        "strategy_promotion_policy" => strategy_promotion_policy(&body),
        "strategy_max_risk_per_action" => strategy_max_risk_per_action(&body),
        "strategy_duplicate_window_hours" => strategy_duplicate_window_hours(&body),
        _ => return Err(format!("unsupported_hotpath_op:{}", op)),
    };
    serde_json::to_string(&result).map_err(|err| format!("serialize_error:{}", err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_mode_prefers_strategy_value() {
        let payload = json!({
            "op": "strategy_execution_mode",
            "strategy": { "execution_policy": { "mode": "score_only" } },
            "fallback": "execute"
        });
        let out = run_strategy_hotpath_json(&payload.to_string()).expect("hotpath output");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(
            parsed.get("mode").and_then(Value::as_str),
            Some("score_only")
        );
    }

    #[test]
    fn budget_caps_prefers_strategy_over_defaults() {
        let payload = json!({
            "op": "strategy_budget_caps",
            "strategy": { "budget_policy": { "daily_token_cap": 3000, "token_cost_per_1k": 0.9 } },
            "defaults": { "daily_token_cap": 1000, "token_cost_per_1k": 0.2 }
        });
        let out = run_strategy_hotpath_json(&payload.to_string()).expect("hotpath output");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(
            parsed.get("daily_token_cap").and_then(Value::as_f64),
            Some(3000.0)
        );
        assert_eq!(
            parsed.get("token_cost_per_1k").and_then(Value::as_f64),
            Some(0.9)
        );
    }

    #[test]
    fn ranking_context_applies_objective_and_currency_overrides() {
        let payload = json!({
            "op": "resolve_strategy_ranking_context",
            "strategy": {
                "ranking_weights": { "composite": 1, "actionability": 1 },
                "value_currency_policy": {
                    "objective_overrides": {
                        "obj-1": {
                            "primary_currency": "delivery",
                            "ranking_weights": { "time_to_value": 2 }
                        }
                    },
                    "currency_overrides": {
                        "delivery": {
                            "ranking_weights": { "risk_penalty": 3 }
                        }
                    }
                }
            },
            "context": { "objective_id": "obj-1" }
        });
        let out = run_strategy_hotpath_json(&payload.to_string()).expect("hotpath output");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(
            parsed.get("value_currency").and_then(Value::as_str),
            Some("delivery")
        );
        let applied = parsed
            .get("applied_overrides")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(applied.len(), 2);
    }

    #[test]
    fn allows_proposal_type_respects_allow_and_block_lists() {
        let payload = json!({
            "op": "strategy_allows_proposal_type",
            "strategy": {
                "admission_policy": {
                    "allowed_types": ["deliverable", "research"],
                    "blocked_types": ["spec"]
                }
            },
            "proposal_type": "spec"
        });
        let out = run_strategy_hotpath_json(&payload.to_string()).expect("hotpath output");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed.get("allow").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn promotion_policy_normalizes_bounds() {
        let payload = json!({
            "op": "strategy_promotion_policy",
            "strategy": {
                "promotion_policy": {
                    "min_days": 999,
                    "min_verified_rate": 1.9
                }
            },
            "defaults": {}
        });
        let out = run_strategy_hotpath_json(&payload.to_string()).expect("hotpath output");
        let parsed: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(parsed.get("min_days").and_then(Value::as_i64), Some(90));
        assert_eq!(
            parsed.get("min_verified_rate").and_then(Value::as_f64),
            Some(1.0)
        );
    }

    #[test]
    fn max_risk_and_duplicate_window_fallbacks_are_clamped() {
        let max_risk_payload = json!({
            "op": "strategy_max_risk_per_action",
            "fallback": 151
        });
        let max_risk_out =
            run_strategy_hotpath_json(&max_risk_payload.to_string()).expect("hotpath output");
        let max_risk_parsed: Value = serde_json::from_str(&max_risk_out).expect("json");
        assert_eq!(
            max_risk_parsed.get("value").and_then(Value::as_i64),
            Some(100)
        );

        let window_payload = json!({
            "op": "strategy_duplicate_window_hours",
            "fallback": 0
        });
        let window_out =
            run_strategy_hotpath_json(&window_payload.to_string()).expect("hotpath output");
        let window_parsed: Value = serde_json::from_str(&window_out).expect("json");
        assert_eq!(window_parsed.get("value").and_then(Value::as_i64), Some(1));
    }
}
