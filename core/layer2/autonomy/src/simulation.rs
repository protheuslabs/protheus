// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/autonomy (authoritative).

use crate::{
    append_jsonl, now_iso, parse_bool_str, parse_date_or_today, read_json, read_jsonl,
    resolve_runtime_path, round_to, write_json_atomic,
};
use chrono::{Duration, NaiveDate};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

fn to_int(raw: Option<&str>, fallback: i64, lo: i64, hi: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn date_window(end_date: &str, days: i64) -> Vec<String> {
    let fallback = chrono::Utc::now().date_naive();
    let end = NaiveDate::parse_from_str(end_date, "%Y-%m-%d").unwrap_or(fallback);
    (0..days)
        .map(|idx| (end - Duration::days(idx)).format("%Y-%m-%d").to_string())
        .collect()
}

fn safe_rate(num: i64, den: i64) -> f64 {
    if den <= 0 {
        0.0
    } else {
        num as f64 / den as f64
    }
}

fn parse_ts_ms(v: Option<&Value>) -> Option<i64> {
    let text = v.and_then(Value::as_str)?.trim();
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn is_policy_hold_event(row: &Value) -> bool {
    if row.get("type").and_then(Value::as_str) != Some("autonomy_run") {
        return false;
    }
    if row.get("policy_hold").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let result = row
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if result.starts_with("no_candidates_policy_") {
        return true;
    }
    if result.starts_with("stop_repeat_gate_") || result.starts_with("stop_init_gate_") {
        return true;
    }

    let block_reason = row
        .get("route_block_reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    block_reason.contains("gate_manual") || block_reason.contains("budget")
}

fn is_budget_hold_event(row: &Value) -> bool {
    if row.get("type").and_then(Value::as_str) != Some("autonomy_run") {
        return false;
    }
    let result = row
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let hold_reason = row
        .get("policy_hold_reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let block_reason = row
        .get("route_block_reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();

    result.contains("budget")
        || result.contains("burn_rate")
        || hold_reason.contains("budget")
        || hold_reason.contains("burn_rate")
        || block_reason.contains("budget")
        || block_reason.contains("burn_rate")
}

fn is_safety_stop(row: &Value) -> bool {
    let result = row
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    result.contains("safety")
}

fn is_no_progress(row: &Value) -> bool {
    let result = row
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let outcome = row
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();

    result == "executed" && outcome != "shipped"
}

fn build_checks(counters: &Map<String, Value>, autopause_active: bool) -> Value {
    let attempts = counters.get("attempts").and_then(Value::as_i64).unwrap_or(0);
    let executed = counters.get("executed").and_then(Value::as_i64).unwrap_or(0);
    let shipped = counters.get("shipped").and_then(Value::as_i64).unwrap_or(0);
    let no_progress = counters
        .get("no_progress")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let safety_stops = counters
        .get("safety_stops")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let policy_holds = counters
        .get("policy_holds")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let budget_holds = counters
        .get("budget_holds")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let drift_warn = std::env::var("AUTONOMY_SIM_DRIFT_WARN")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.65);
    let drift_fail = std::env::var("AUTONOMY_SIM_DRIFT_FAIL")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.85);
    let yield_warn = std::env::var("AUTONOMY_SIM_YIELD_WARN")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.2);
    let yield_fail = std::env::var("AUTONOMY_SIM_YIELD_FAIL")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.08);
    let safety_warn = std::env::var("AUTONOMY_SIM_SAFETY_WARN")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.25);
    let safety_fail = std::env::var("AUTONOMY_SIM_SAFETY_FAIL")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.45);
    let policy_hold_warn = std::env::var("AUTONOMY_SIM_POLICY_HOLD_WARN")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.2);
    let policy_hold_fail = std::env::var("AUTONOMY_SIM_POLICY_HOLD_FAIL")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.35);
    let budget_hold_warn = std::env::var("AUTONOMY_SIM_BUDGET_HOLD_WARN")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.12);
    let budget_hold_fail = std::env::var("AUTONOMY_SIM_BUDGET_HOLD_FAIL")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.25);
    let policy_enforce_fail = parse_bool_str(
        std::env::var("AUTONOMY_SIM_ENFORCE_POLICY_HOLD_FAIL")
            .ok()
            .as_deref(),
        false,
    );
    let budget_enforce_fail = parse_bool_str(
        std::env::var("AUTONOMY_SIM_ENFORCE_BUDGET_HOLD_FAIL")
            .ok()
            .as_deref(),
        false,
    );
    let autopause_fail = parse_bool_str(
        std::env::var("AUTONOMY_SIM_AUTOPAUSE_ACTIVE_FAIL")
            .ok()
            .as_deref(),
        true,
    );
    let min_attempts = to_int(
        std::env::var("AUTONOMY_SIM_MIN_ATTEMPTS").ok().as_deref(),
        5,
        1,
        100000,
    );

    let drift_rate = round_to(safe_rate(no_progress, attempts), 3);
    let yield_rate = round_to(safe_rate(shipped, executed), 3);
    let safety_rate = round_to(safe_rate(safety_stops, attempts), 3);
    let policy_hold_rate = round_to(safe_rate(policy_holds, attempts), 3);
    let budget_hold_rate = round_to(safe_rate(budget_holds, attempts), 3);

    let policy_status = if policy_hold_rate >= policy_hold_fail {
        if policy_enforce_fail {
            "fail"
        } else {
            "warn"
        }
    } else if policy_hold_rate >= policy_hold_warn {
        "warn"
    } else {
        "pass"
    };

    let budget_status = if budget_hold_rate >= budget_hold_fail {
        if budget_enforce_fail {
            "fail"
        } else {
            "warn"
        }
    } else if budget_hold_rate >= budget_hold_warn {
        "warn"
    } else {
        "pass"
    };

    json!({
        "drift_rate": {
            "value": drift_rate,
            "warn": drift_warn,
            "fail": drift_fail,
            "status": if drift_rate >= drift_fail { "fail" } else if drift_rate >= drift_warn { "warn" } else { "pass" }
        },
        "yield_rate": {
            "value": yield_rate,
            "warn": yield_warn,
            "fail": yield_fail,
            "status": if yield_rate <= yield_fail { "fail" } else if yield_rate <= yield_warn { "warn" } else { "pass" }
        },
        "safety_stop_rate": {
            "value": safety_rate,
            "warn": safety_warn,
            "fail": safety_fail,
            "status": if safety_rate >= safety_fail { "fail" } else if safety_rate >= safety_warn { "warn" } else { "pass" }
        },
        "attempt_volume": {
            "value": attempts,
            "min": min_attempts,
            "status": if attempts < min_attempts { "warn" } else { "pass" }
        },
        "policy_hold_rate": {
            "value": policy_hold_rate,
            "warn": policy_hold_warn,
            "fail": policy_hold_fail,
            "enforce_fail": policy_enforce_fail,
            "status": policy_status
        },
        "budget_hold_rate": {
            "value": budget_hold_rate,
            "warn": budget_hold_warn,
            "fail": budget_hold_fail,
            "enforce_fail": budget_enforce_fail,
            "status": budget_status
        },
        "budget_autopause_active": {
            "value": autopause_active,
            "fail_when_active": autopause_fail,
            "status": if autopause_active { if autopause_fail { "fail" } else { "warn" } } else { "pass" }
        }
    })
}

fn verdict_from_checks(checks: &Value) -> &'static str {
    let rows = checks.as_object().cloned().unwrap_or_default();
    if rows.values().any(|row| row.get("status").and_then(Value::as_str) == Some("fail")) {
        return "fail";
    }
    if rows.values().any(|row| row.get("status").and_then(Value::as_str) == Some("warn")) {
        return "warn";
    }
    "pass"
}

fn reason_counts(rows: &[Value], reason_fn: fn(&Value) -> String) -> Value {
    let mut map = BTreeMap::<String, i64>::new();
    for row in rows {
        let key = reason_fn(row);
        *map.entry(key).or_insert(0) += 1;
    }
    let obj: Map<String, Value> = map.into_iter().map(|(k, v)| (k, json!(v))).collect();
    Value::Object(obj)
}

fn hold_reason(row: &Value) -> String {
    row.get("policy_hold_reason")
        .or_else(|| row.get("route_block_reason"))
        .or_else(|| row.get("result"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase()
}

fn read_budget_snapshot(path: &Path, end_date: &str, run_rows: &[Value]) -> Value {
    let snapshot = read_json(path);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let active = snapshot
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let until_ms = snapshot.get("until_ms").and_then(Value::as_i64).unwrap_or(0);
    let currently_active = active && (until_ms <= 0 || until_ms > now_ms);

    let end_of_day_ms = chrono::DateTime::parse_from_rfc3339(
        &format!("{}T23:59:59.999Z", parse_date_or_today(Some(end_date))),
    )
    .ok()
    .map(|v| v.timestamp_millis())
    .unwrap_or(now_ms);

    let mut explicit_last: Option<(i64, bool, Option<i64>)> = None;
    let mut implicit_last: Option<i64> = None;

    for row in run_rows {
        if row.get("type").and_then(Value::as_str) != Some("autonomy_run") {
            continue;
        }
        let ts_ms = parse_ts_ms(row.get("ts"));
        let Some(ts_ms) = ts_ms else {
            continue;
        };
        if ts_ms > end_of_day_ms {
            continue;
        }

        let autopause = row
            .get("route_summary")
            .and_then(Value::as_object)
            .and_then(|m| m.get("budget_global_guard"))
            .and_then(Value::as_object)
            .and_then(|m| m.get("autopause"))
            .and_then(Value::as_object)
            .cloned();

        if let Some(ap) = autopause {
            if let Some(ap_active) = ap.get("active").and_then(Value::as_bool) {
                let ap_until = ap
                    .get("until")
                    .and_then(Value::as_str)
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.timestamp_millis());
                if explicit_last.map(|(ms, _, _)| ts_ms >= ms).unwrap_or(true) {
                    explicit_last = Some((ts_ms, ap_active, ap_until));
                }
            }
        }

        let result = row
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let block_reason = row
            .get("route_block_reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if result.contains("budget_autopause") || block_reason.contains("budget_autopause") {
            if implicit_last.map(|ms| ts_ms >= ms).unwrap_or(true) {
                implicit_last = Some(ts_ms);
            }
        }
    }

    let observed_in_window = explicit_last.is_some() || implicit_last.is_some();
    let active_at_window_end = if let Some((_, active_flag, until_opt)) = explicit_last {
        if !active_flag {
            false
        } else {
            until_opt.map(|until| until > end_of_day_ms).unwrap_or(true)
        }
    } else {
        implicit_last.is_some()
    };

    let external_override = std::env::var("AUTONOMY_SIM_RUNS_DIR").is_ok()
        || std::env::var("AUTONOMY_SIM_PROPOSALS_DIR").is_ok();
    let snapshot_suggests_active =
        currently_active && parse_date_or_today(Some(end_date)) == parse_date_or_today(None);

    let active_relevant = if external_override {
        active_at_window_end
    } else {
        active_at_window_end || (!observed_in_window && snapshot_suggests_active)
    };

    let signal_source = if explicit_last.is_some() {
        Value::String("route_summary.autopause".to_string())
    } else if implicit_last.is_some() {
        Value::String("budget_autopause_signal".to_string())
    } else {
        Value::Null
    };

    json!({
        "path": path,
        "active": active,
        "currently_active": currently_active,
        "active_relevant": active_relevant,
        "source": snapshot.get("source").cloned().unwrap_or(Value::Null),
        "reason": snapshot.get("reason").cloned().unwrap_or(Value::Null),
        "pressure": snapshot.get("pressure").cloned().unwrap_or(Value::Null),
        "until": snapshot.get("until").cloned().unwrap_or(Value::Null),
        "updated_at": snapshot.get("updated_at").cloned().unwrap_or(Value::Null),
        "observed_in_window": observed_in_window,
        "active_at_window_end": active_at_window_end,
        "signal_source": signal_source,
        "explicit_last_ts": explicit_last.map(|(ms, _, _)| chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339()).unwrap_or_default()),
        "implicit_last_ts": implicit_last.map(|ms| chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339()).unwrap_or_default()),
        "source_mode": if external_override { "derived_from_runs" } else { "live_state_plus_runs" },
        "snapshot_fallback_used": if external_override { false } else { !observed_in_window && snapshot_suggests_active }
    })
}

fn queue_snapshot(dates: &[String], proposals_dir: &Path) -> Value {
    let mut total = 0i64;
    let mut pending = 0i64;
    let mut stale = 0i64;
    let now_ms = chrono::Utc::now().timestamp_millis();

    for day in dates {
        let fp = proposals_dir.join(format!("{day}.json"));
        let raw = read_json(&fp);
        let rows = if let Some(arr) = raw.as_array() {
            arr.clone()
        } else {
            raw.get("proposals")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };

        for row in rows {
            if !row.is_object() {
                continue;
            }
            total += 1;
            let status = row
                .get("status")
                .or_else(|| row.get("state"))
                .and_then(Value::as_str)
                .unwrap_or("pending")
                .to_ascii_lowercase();
            if status == "pending" || status == "open" {
                pending += 1;
                let created_ms = chrono::DateTime::parse_from_rfc3339(&format!("{day}T00:00:00.000Z"))
                    .ok()
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or(now_ms);
                if now_ms - created_ms >= 72 * 3600 * 1000 {
                    stale += 1;
                }
            }
        }
    }

    json!({
        "total": total,
        "pending": pending,
        "stale_pending_72h": stale
    })
}

pub fn run_autonomy_simulation(
    root: &Path,
    end_date: Option<&str>,
    days: i64,
    write_output: bool,
) -> Value {
    let end_date = parse_date_or_today(end_date);
    let days = days.clamp(1, to_int(std::env::var("AUTONOMY_SIM_MAX_DAYS").ok().as_deref(), 180, 1, 365));

    let runs_dir = std::env::var("AUTONOMY_SIM_RUNS_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            resolve_runtime_path(
                root,
                Some("local/state/autonomy/runs"),
                "local/state/autonomy/runs",
            )
        });
    let proposals_dir = std::env::var("AUTONOMY_SIM_PROPOSALS_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            resolve_runtime_path(
                root,
                Some("local/state/sensory/proposals"),
                "local/state/sensory/proposals",
            )
        });
    let output_dir = std::env::var("AUTONOMY_SIM_OUTPUT_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            resolve_runtime_path(
                root,
                Some("local/state/autonomy/simulations"),
                "local/state/autonomy/simulations",
            )
        });
    let budget_path = std::env::var("AUTONOMY_SIM_BUDGET_AUTOPAUSE_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            resolve_runtime_path(
                root,
                Some("local/state/autonomy/budget_autopause.json"),
                "local/state/autonomy/budget_autopause.json",
            )
        });

    let dates = date_window(&end_date, days);
    let mut run_rows = Vec::<Value>::new();
    for day in &dates {
        let fp = runs_dir.join(format!("{day}.jsonl"));
        run_rows.extend(read_jsonl(&fp));
    }
    run_rows.retain(|row| row.get("type").and_then(Value::as_str) == Some("autonomy_run"));

    let baseline_attempts_raw = run_rows.clone();
    let baseline_policy_holds: Vec<Value> = baseline_attempts_raw
        .iter()
        .filter(|row| is_policy_hold_event(row))
        .cloned()
        .collect();
    let baseline_budget_holds: Vec<Value> = baseline_policy_holds
        .iter()
        .filter(|row| is_budget_hold_event(row))
        .cloned()
        .collect();
    let baseline_attempts: Vec<Value> = baseline_attempts_raw
        .iter()
        .filter(|row| !is_policy_hold_event(row))
        .cloned()
        .collect();
    let baseline_executed: Vec<Value> = baseline_attempts
        .iter()
        .filter(|row| row.get("result").and_then(Value::as_str) == Some("executed"))
        .cloned()
        .collect();
    let baseline_shipped: Vec<Value> = baseline_executed
        .iter()
        .filter(|row| row.get("outcome").and_then(Value::as_str) == Some("shipped"))
        .cloned()
        .collect();
    let baseline_no_progress: Vec<Value> = baseline_attempts
        .iter()
        .filter(|row| is_no_progress(row))
        .cloned()
        .collect();
    let baseline_safety_stops: Vec<Value> = baseline_attempts
        .iter()
        .filter(|row| is_safety_stop(row))
        .cloned()
        .collect();

    let identity_enabled = parse_bool_str(
        std::env::var("AUTONOMY_SIM_IDENTITY_PROJECTION_ENABLED")
            .ok()
            .as_deref(),
        parse_bool_str(
            std::env::var("SPINE_IDENTITY_ANCHOR_ENABLED").ok().as_deref(),
            false,
        ),
    );
    let block_unknown = parse_bool_str(
        std::env::var("AUTONOMY_SIM_IDENTITY_BLOCK_UNKNOWN_OBJECTIVE")
            .ok()
            .as_deref(),
        parse_bool_str(
            std::env::var("SPINE_IDENTITY_BLOCK_UNKNOWN_OBJECTIVE")
                .ok()
                .as_deref(),
            true,
        ),
    );
    let active_objective_ids: HashSet<String> = std::env::var("AUTONOMY_SIM_ACTIVE_OBJECTIVE_IDS")
        .ok()
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_else(|| {
            ["T1_make_jay_billionaire_v1".to_string()]
                .iter()
                .cloned()
                .collect()
        });

    let mut identity_blocked = Vec::<Value>::new();
    let mut identity_accepted = Vec::<Value>::new();
    if identity_enabled {
        for row in &baseline_attempts_raw {
            let objective_id = row
                .get("objective_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let unknown = !objective_id.is_empty() && !active_objective_ids.contains(&objective_id);
            if block_unknown && (objective_id.is_empty() || unknown) {
                identity_blocked.push(json!({
                    "evt": row,
                    "context": {
                        "objective_id": if objective_id.is_empty() { Value::Null } else { json!(objective_id) }
                    },
                    "verdict": {
                        "blocking_codes": ["unknown_active_objective"]
                    }
                }));
                continue;
            }
            identity_accepted.push(row.clone());
        }
    } else {
        identity_accepted = baseline_attempts_raw.clone();
    }

    let effective_policy_holds: Vec<Value> = identity_accepted
        .iter()
        .filter(|row| is_policy_hold_event(row))
        .cloned()
        .collect();
    let effective_budget_holds: Vec<Value> = effective_policy_holds
        .iter()
        .filter(|row| is_budget_hold_event(row))
        .cloned()
        .collect();
    let effective_attempts: Vec<Value> = identity_accepted
        .iter()
        .filter(|row| !is_policy_hold_event(row))
        .cloned()
        .collect();
    let effective_executed: Vec<Value> = effective_attempts
        .iter()
        .filter(|row| row.get("result").and_then(Value::as_str) == Some("executed"))
        .cloned()
        .collect();
    let effective_shipped: Vec<Value> = effective_executed
        .iter()
        .filter(|row| row.get("outcome").and_then(Value::as_str) == Some("shipped"))
        .cloned()
        .collect();
    let effective_no_progress: Vec<Value> = effective_attempts
        .iter()
        .filter(|row| is_no_progress(row))
        .cloned()
        .collect();
    let effective_safety_stops: Vec<Value> = effective_attempts
        .iter()
        .filter(|row| is_safety_stop(row))
        .cloned()
        .collect();

    let baseline_counters = json!({
        "attempts": baseline_attempts_raw.len(),
        "executed": baseline_executed.len(),
        "shipped": baseline_shipped.len(),
        "no_progress": baseline_no_progress.len(),
        "safety_stops": baseline_safety_stops.len(),
        "policy_holds": baseline_policy_holds.len(),
        "budget_holds": baseline_budget_holds.len()
    });
    let effective_counters = json!({
        "attempts": effective_attempts.len(),
        "executed": effective_executed.len(),
        "shipped": effective_shipped.len(),
        "no_progress": effective_no_progress.len(),
        "safety_stops": effective_safety_stops.len(),
        "policy_holds": effective_policy_holds.len(),
        "budget_holds": effective_budget_holds.len()
    });

    let budget_autopause = read_budget_snapshot(&budget_path, &end_date, &run_rows);
    let checks = build_checks(
        baseline_counters
            .as_object()
            .expect("baseline counters object"),
        budget_autopause
            .get("active_relevant")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    let checks_effective = build_checks(
        effective_counters
            .as_object()
            .expect("effective counters object"),
        budget_autopause
            .get("active_relevant")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );

    let verdict_raw = verdict_from_checks(&checks);
    let verdict_effective = verdict_from_checks(&checks_effective);
    let verdict = if verdict_raw == "fail" || verdict_effective == "fail" {
        "fail"
    } else if verdict_raw == "warn" || verdict_effective == "warn" {
        "warn"
    } else {
        "pass"
    };

    let hold_reasons = json!({
        "baseline": {
            "policy": reason_counts(&baseline_policy_holds, hold_reason),
            "budget": reason_counts(&baseline_budget_holds, hold_reason)
        },
        "effective": {
            "policy": reason_counts(&effective_policy_holds, hold_reason),
            "budget": reason_counts(&effective_budget_holds, hold_reason)
        }
    });

    let mut objective_mix_counts = BTreeMap::<String, i64>::new();
    for row in &effective_executed {
        let objective_id = row
            .get("objective_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if objective_id.is_empty() {
            continue;
        }
        *objective_mix_counts.entry(objective_id).or_insert(0) += 1;
    }
    let objective_mix_map: Map<String, Value> = objective_mix_counts
        .iter()
        .map(|(k, v)| (k.clone(), json!(*v)))
        .collect();

    let queue = queue_snapshot(&dates, &proposals_dir);

    let compiler_projection_enabled = parse_bool_str(
        std::env::var("AUTONOMY_SIM_LINEAGE_REQUIRED").ok().as_deref(),
        true,
    );

    let identity_summary = json!({
        "checked": baseline_attempts_raw.len(),
        "blocked": identity_blocked.len(),
        "allowed": identity_accepted.len(),
        "identity_drift_score": 0,
        "max_identity_drift_score": 0.58,
        "max_candidate_drift_score": 0,
        "blocking_code_counts": {
            "unknown_active_objective": identity_blocked.len()
        }
    });

    let mut insufficient_reasons = Vec::<Value>::new();
    if run_rows.is_empty() {
        insufficient_reasons.push(json!("no_run_rows_in_window"));
    }
    if baseline_attempts_raw.len() < to_int(std::env::var("AUTONOMY_SIM_MIN_ATTEMPTS").ok().as_deref(), 5, 1, 100000) as usize {
        insufficient_reasons.push(json!("attempt_volume_below_min"));
    }
    if baseline_executed.is_empty() {
        insufficient_reasons.push(json!("no_executed_attempts"));
    }
    if baseline_shipped.is_empty() {
        insufficient_reasons.push(json!("no_shipped_outcomes"));
    }

    let mut recommendations = Vec::<Value>::new();
    if checks
        .get("policy_hold_rate")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        != Some("pass")
    {
        recommendations.push(json!(
            "Reduce policy-hold churn by tightening admission and queue hygiene."
        ));
    }
    if checks
        .get("budget_hold_rate")
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str)
        != Some("pass")
    {
        recommendations.push(json!(
            "Budget holds are elevated; apply pacing/defer strategy before full cadence."
        ));
    }
    if recommendations.is_empty() {
        recommendations.push(json!(
            "Simulation is stable; continue collecting telemetry and tighten targeted bottlenecks."
        ));
    }

    let mut payload = json!({
        "ok": true,
        "type": "autonomy_simulation_harness",
        "ts": now_iso(),
        "end_date": end_date,
        "days": days,
        "verdict": verdict,
        "verdict_raw": verdict_raw,
        "verdict_effective": verdict_effective,
        "checks": checks,
        "checks_effective": checks_effective,
        "metric_integrity": {
            "mode": "dual_track",
            "baseline_preserved": true,
            "effective_projection_present": true,
            "denominator_reduction_only": effective_attempts.len() < baseline_attempts_raw.len(),
            "denominator_delta": baseline_attempts_raw.len() as i64 - effective_attempts.len() as i64,
            "identity_projection_enabled": identity_enabled,
            "identity_projection_blocked_attempts": identity_blocked.len()
        },
        "counters": baseline_counters,
        "baseline_counters": baseline_counters,
        "effective_counters": effective_counters,
        "hold_reasons": hold_reasons,
        "budget_autopause": budget_autopause,
        "compiler_projection": {
            "enabled": compiler_projection_enabled,
            "lineage_require_t1_root": parse_bool_str(std::env::var("AUTONOMY_SIM_LINEAGE_REQUIRE_T1_ROOT").ok().as_deref(), true),
            "lineage_block_missing_objective": parse_bool_str(std::env::var("AUTONOMY_SIM_LINEAGE_BLOCK_MISSING_OBJECTIVE").ok().as_deref(), true),
            "filter_contextless_attempts": parse_bool_str(std::env::var("AUTONOMY_SIM_LINEAGE_FILTER_CONTEXTLESS").ok().as_deref(), true),
            "rolling_context_enabled": parse_bool_str(std::env::var("AUTONOMY_SIM_LINEAGE_ROLLING_CONTEXT").ok().as_deref(), false),
            "compiler_hash": Value::Null,
            "compiler_active_count": 0,
            "accepted_attempts": identity_accepted.len(),
            "rejected_attempts": 0,
            "skipped_attempts": 0,
            "rejected_by_reason": {},
            "skipped_by_reason": {},
            "sample_rejected": [],
            "sample_skipped": []
        },
        "identity_projection": {
            "enabled": identity_enabled,
            "unavailable": false,
            "unavailable_reason": Value::Null,
            "policy_path": Value::Null,
            "active_objective_ids": active_objective_ids.into_iter().collect::<Vec<_>>(),
            "attempted": baseline_attempts_raw.len(),
            "blocked_attempts": identity_blocked.len(),
            "blocked_by_reason": {
                "unknown_active_objective": identity_blocked.len()
            },
            "summary": identity_summary,
            "sample_blocked": identity_blocked.into_iter().take(8).collect::<Vec<_>>()
        },
        "queue": queue,
        "objective_mix": {
            "executed_total": effective_executed.len(),
            "objective_count": objective_mix_counts.len(),
            "counts": objective_mix_map
        },
        "insufficient_data": {
            "active": !insufficient_reasons.is_empty(),
            "reasons": insufficient_reasons
        },
        "recommendations": recommendations.into_iter().take(5).collect::<Vec<_>>()
    });

    if write_output {
        let report_path = output_dir.join(format!("{}.json", parse_date_or_today(Some(&end_date))));
        let _ = write_json_atomic(&report_path, &payload);
        payload["report_path"] = json!(report_path);
    }

    let _ = append_jsonl(
        &resolve_runtime_path(
            root,
            Some("local/state/autonomy/simulations/history.jsonl"),
            "local/state/autonomy/simulations/history.jsonl",
        ),
        &json!({
            "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
            "type": "autonomy_simulation_harness",
            "date": payload.get("end_date").cloned().unwrap_or(Value::Null),
            "verdict": payload.get("verdict").cloned().unwrap_or(Value::Null)
        }),
    );

    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn simulation_identity_projection_filters_unknown_objective() {
        let dir = tempdir().expect("tmp");
        let root = dir.path();
        let runs_dir = dir.path().join("runs");
        let proposals_dir = dir.path().join("proposals");
        let day = "2026-02-25";

        std::fs::create_dir_all(&runs_dir).expect("runs dir");
        std::fs::create_dir_all(&proposals_dir).expect("proposals dir");

        append_jsonl(
            &runs_dir.join(format!("{day}.jsonl")),
            &json!({
                "ts": "2026-02-25T01:00:00.000Z",
                "type": "autonomy_run",
                "result": "executed",
                "outcome": "shipped",
                "objective_id": "T1_make_jay_billionaire_v1"
            }),
        )
        .expect("append row1");
        append_jsonl(
            &runs_dir.join(format!("{day}.jsonl")),
            &json!({
                "ts": "2026-02-25T01:05:00.000Z",
                "type": "autonomy_run",
                "result": "executed",
                "outcome": "no_change",
                "objective_id": "UNKNOWN_OBJECTIVE_SHOULD_BLOCK"
            }),
        )
        .expect("append row2");
        write_json_atomic(&proposals_dir.join(format!("{day}.json")), &json!([])).expect("proposal");

        std::env::set_var("AUTONOMY_SIM_RUNS_DIR", &runs_dir);
        std::env::set_var("AUTONOMY_SIM_PROPOSALS_DIR", &proposals_dir);
        std::env::set_var("AUTONOMY_SIM_LINEAGE_REQUIRED", "0");
        std::env::set_var("AUTONOMY_SIM_IDENTITY_PROJECTION_ENABLED", "1");
        std::env::set_var("AUTONOMY_SIM_IDENTITY_BLOCK_UNKNOWN_OBJECTIVE", "1");

        let out = run_autonomy_simulation(root, Some(day), 1, false);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("identity_projection")
                .and_then(Value::as_object)
                .and_then(|m| m.get("enabled"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            out.get("effective_counters")
                .and_then(Value::as_object)
                .and_then(|m| m.get("attempts"))
                .and_then(Value::as_i64),
            Some(1)
        );

        std::env::remove_var("AUTONOMY_SIM_RUNS_DIR");
        std::env::remove_var("AUTONOMY_SIM_PROPOSALS_DIR");
        std::env::remove_var("AUTONOMY_SIM_LINEAGE_REQUIRED");
        std::env::remove_var("AUTONOMY_SIM_IDENTITY_PROJECTION_ENABLED");
        std::env::remove_var("AUTONOMY_SIM_IDENTITY_BLOCK_UNKNOWN_OBJECTIVE");
    }
}
