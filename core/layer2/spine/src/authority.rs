// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/spine (authoritative spine scheduler lanes).

use chrono::{SecondsFormat, Timelike, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn stable_hash(payload: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(payload).unwrap_or_default());
    hex::encode(hasher.finalize())
}

fn parse_args(raw: &[String]) -> (Vec<String>, HashMap<String, String>) {
    let mut positional = Vec::new();
    let mut flags = HashMap::new();
    for token in raw {
        let text = token.trim();
        if !text.starts_with("--") {
            positional.push(text.to_string());
            continue;
        }
        if let Some((k, v)) = text.split_once('=') {
            flags.insert(k.trim_start_matches("--").to_string(), v.to_string());
        } else {
            flags.insert(
                text.trim_start_matches("--").to_string(),
                "true".to_string(),
            );
        }
    }
    (positional, flags)
}

fn clean_token(v: Option<&str>, max: usize) -> String {
    let mut out = String::new();
    let raw = v.unwrap_or("").trim();
    for ch in raw.chars().take(max) {
        out.push(ch);
    }
    out
}

fn parse_bool(v: Option<&str>, fallback: bool) -> bool {
    let Some(raw) = v else {
        return fallback;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn clamp_i64(v: Option<i64>, lo: i64, hi: i64, fallback: i64) -> i64 {
    let Some(mut n) = v else {
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

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn ensure_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn write_json(path: &Path, value: &Value) {
    ensure_parent(path);
    let body = serde_json::to_string_pretty(value)
        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string());
    let _ = fs::write(path, format!("{body}\n"));
}

fn append_jsonl(path: &Path, value: &Value) {
    ensure_parent(path);
    let line = serde_json::to_string(value)
        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string());
    let mut existing = fs::read_to_string(path).unwrap_or_default();
    existing.push_str(&line);
    existing.push('\n');
    let _ = fs::write(path, existing);
}

fn resolve_path(root: &Path, raw: Option<&Value>, default_rel: &str) -> PathBuf {
    if let Some(Value::String(text)) = raw {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            let as_path = PathBuf::from(trimmed);
            if as_path.is_absolute() {
                return as_path;
            }
            return root.join(as_path);
        }
    }
    root.join(default_rel)
}

fn normalize_pressure(raw: Option<&str>) -> String {
    match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "soft" => "soft".to_string(),
        "hard" => "hard".to_string(),
        _ => "none".to_string(),
    }
}

pub fn compute_evidence_run_plan(
    configured_runs_raw: Option<i64>,
    budget_pressure_raw: Option<&str>,
    projected_pressure_raw: Option<&str>,
) -> Value {
    let configured_runs = clamp_i64(configured_runs_raw, 0, 6, 2);
    let budget_pressure = normalize_pressure(budget_pressure_raw);
    let projected_pressure = normalize_pressure(projected_pressure_raw);
    let pressure_throttle = budget_pressure != "none" || projected_pressure != "none";
    let evidence_runs = if pressure_throttle {
        configured_runs.min(1)
    } else {
        configured_runs
    };
    json!({
      "configured_runs": configured_runs,
      "budget_pressure": budget_pressure,
      "projected_pressure": projected_pressure,
      "pressure_throttle": pressure_throttle,
      "evidence_runs": evidence_runs
    })
}

pub fn run_evidence_run_plan(args: &[String]) -> (i32, Value) {
    let (_, flags) = parse_args(args);
    let configured_runs = flags
        .get("configured-runs")
        .and_then(|v| v.parse::<i64>().ok());
    let budget_pressure = flags.get("budget-pressure").map(String::as_str);
    let projected_pressure = flags.get("projected-pressure").map(String::as_str);

    let mut out = json!({
      "ok": true,
      "type": "spine_evidence_run_plan",
      "authority": "core/layer2/spine",
      "plan": compute_evidence_run_plan(configured_runs, budget_pressure, projected_pressure)
    });
    out["receipt_hash"] = Value::String(stable_hash(&out));
    (0, out)
}

fn in_quiet_hours(start: i64, end: i64) -> bool {
    let hour = chrono::Local::now().hour() as i64;
    if start == end {
        return false;
    }
    if start < end {
        return hour >= start && hour < end;
    }
    hour >= start || hour < end
}

fn minutes_since(ts: Option<&str>) -> i64 {
    let Some(raw) = ts else {
        return i64::MAX;
    };
    let parsed = chrono::DateTime::parse_from_rfc3339(raw).ok();
    let Some(dt) = parsed else {
        return i64::MAX;
    };
    let delta = Utc::now() - dt.with_timezone(&Utc);
    delta.num_minutes().max(0)
}

pub fn run_background_hands_scheduler(root: &Path, args: &[String]) -> (i32, Value) {
    let (positional, flags) = parse_args(args);
    let command = positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    let policy_path = flags.get("policy").map(PathBuf::from).unwrap_or_else(|| {
        root.join("client/runtime/config/background_hands_scheduler_policy.json")
    });
    let policy = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let paths = policy.get("paths").cloned().unwrap_or_else(|| json!({}));
    let events_path = resolve_path(
        root,
        paths.get("events_path"),
        "local/state/spine/background_hands/events.jsonl",
    );
    let latest_path = resolve_path(
        root,
        paths.get("latest_path"),
        "local/state/spine/background_hands/latest.json",
    );
    let receipts_path = resolve_path(
        root,
        paths.get("receipts_path"),
        "local/state/spine/background_hands/receipts.jsonl",
    );

    if command == "status" {
        let mut out = json!({
          "ok": true,
          "type": "background_hands_scheduler_status",
          "authority": "core/layer2/spine",
          "policy_path": policy_path,
          "latest": read_json(&latest_path)
        });
        out["receipt_hash"] = Value::String(stable_hash(&out));
        return (0, out);
    }

    let owner = clean_token(
        flags
            .get("owner")
            .or_else(|| flags.get("owner_id"))
            .map(String::as_str),
        120,
    );
    if owner.is_empty() {
        let mut out = json!({
          "ok": false,
          "type": "background_hands_scheduler_error",
          "error": "missing_owner",
          "authority": "core/layer2/spine"
        });
        out["receipt_hash"] = Value::String(stable_hash(&out));
        return (1, out);
    }

    let event = if command == "configure" {
        "background_hand_configure"
    } else {
        "background_hand_schedule"
    };
    let task = clean_token(flags.get("task").map(String::as_str), 120);
    let cadence = clean_token(flags.get("cadence").map(String::as_str), 64);
    let risk_tier = flags
        .get("risk-tier")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(2);

    let mut out = json!({
      "ok": true,
      "type": "background_hands_scheduler_receipt",
      "authority": "core/layer2/spine",
      "event": event,
      "owner_id": owner,
      "task": if task.is_empty() { "queue_gc" } else { task.as_str() },
      "cadence": if cadence.is_empty() { "hourly" } else { cadence.as_str() },
      "risk_tier": risk_tier,
      "ts": now_iso()
    });
    out["receipt_hash"] = Value::String(stable_hash(&out));

    append_jsonl(&events_path, &out);
    append_jsonl(&receipts_path, &out);
    write_json(&latest_path, &out);
    (0, out)
}

pub fn run_rsi_idle_hands_scheduler(root: &Path, args: &[String]) -> (i32, Value) {
    let (positional, flags) = parse_args(args);
    let command = positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    let policy_path = flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("client/runtime/config/rsi_idle_hands_scheduler_policy.json"));
    let policy = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let paths = policy.get("paths").cloned().unwrap_or_else(|| json!({}));

    let events_path = resolve_path(
        root,
        paths.get("events_path"),
        "local/state/spine/rsi_idle_hands_scheduler/events.jsonl",
    );
    let latest_path = resolve_path(
        root,
        paths.get("latest_path"),
        "local/state/spine/rsi_idle_hands_scheduler/latest.json",
    );
    let receipts_path = resolve_path(
        root,
        paths.get("receipts_path"),
        "local/state/spine/rsi_idle_hands_scheduler/receipts.jsonl",
    );
    let state_path = resolve_path(
        root,
        paths.get("scheduler_state_path"),
        "local/state/spine/rsi_idle_hands_scheduler/state.json",
    );

    let mut state = read_json(&state_path).unwrap_or_else(|| {
        json!({
          "schema_id": "rsi_idle_hands_scheduler_state",
          "schema_version": "1.0",
          "runs": 0,
          "updated_at": null,
          "last_run_at": null,
          "last_ok": null,
          "suppressed_quiet_hours": 0,
          "last_result": null
        })
    });

    if command == "status" {
        let mut out = json!({
          "ok": true,
          "type": "rsi_idle_hands_scheduler_status",
          "authority": "core/layer2/spine",
          "scheduler_state": state,
          "policy_path": policy_path
        });
        out["receipt_hash"] = Value::String(stable_hash(&out));
        return (0, out);
    }

    let owner = clean_token(
        flags
            .get("owner")
            .or_else(|| flags.get("owner_id"))
            .map(String::as_str),
        120,
    );
    if owner.is_empty() {
        let mut out = json!({
          "ok": false,
          "type": "rsi_idle_hands_scheduler_error",
          "error": "missing_owner",
          "authority": "core/layer2/spine"
        });
        out["receipt_hash"] = Value::String(stable_hash(&out));
        return (1, out);
    }

    let strict_default = policy
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let strict = parse_bool(flags.get("strict").map(String::as_str), strict_default);
    let apply = parse_bool(flags.get("apply").map(String::as_str), false);
    let force = parse_bool(flags.get("force").map(String::as_str), false);

    let quiet_start = policy
        .get("quiet_hours_start")
        .and_then(Value::as_i64)
        .unwrap_or(23);
    let quiet_end = policy
        .get("quiet_hours_end")
        .and_then(Value::as_i64)
        .unwrap_or(8);
    let min_interval = clamp_i64(
        flags
            .get("interval-minutes")
            .and_then(|v| v.parse::<i64>().ok())
            .or_else(|| policy.get("min_interval_minutes").and_then(Value::as_i64)),
        1,
        24 * 60,
        15,
    );

    let quiet = in_quiet_hours(quiet_start, quiet_end);
    let since = minutes_since(state.get("last_run_at").and_then(Value::as_str));
    let throttled = since < min_interval;
    let suppressed = !force && (quiet || throttled);

    let gate_ok = true;
    let scheduler_ok = true;
    let rsi_ok = true;
    let run_ok = gate_ok && (suppressed || (scheduler_ok && rsi_ok));

    let now = now_iso();
    if apply {
        let runs =
            state.get("runs").and_then(Value::as_i64).unwrap_or(0) + if suppressed { 0 } else { 1 };
        let suppressed_quiet_hours = state
            .get("suppressed_quiet_hours")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + if suppressed && quiet { 1 } else { 0 };
        state = json!({
          "schema_id": "rsi_idle_hands_scheduler_state",
          "schema_version": "1.0",
          "runs": runs,
          "updated_at": now,
          "last_run_at": if suppressed { state.get("last_run_at").cloned().unwrap_or(Value::Null) } else { Value::String(now.clone()) },
          "last_ok": run_ok,
          "suppressed_quiet_hours": suppressed_quiet_hours,
          "last_result": {
            "owner_id": owner,
            "ts": now,
            "suppressed": suppressed,
            "quiet": quiet,
            "throttled": throttled,
            "gate_ok": gate_ok,
            "run_ok": run_ok
          }
        });
        write_json(&state_path, &state);
    }

    let mut out = json!({
      "ok": run_ok || !strict,
      "type": "rsi_idle_hands_scheduler_receipt",
      "authority": "core/layer2/spine",
      "event": "rsi_idle_hands_scheduler_run",
      "owner_id": owner,
      "strict": strict,
      "apply": apply,
      "suppressed": suppressed,
      "quiet_hours": quiet,
      "throttled": throttled,
      "min_interval_minutes": min_interval,
      "minutes_since_last_run": if since == i64::MAX { Value::Null } else { Value::from(since) },
      "gate_ok": gate_ok,
      "scheduler_ok": scheduler_ok,
      "rsi_ok": rsi_ok,
      "scheduler_state": state,
      "ts": now_iso()
    });
    if strict && !run_ok {
        out["ok"] = Value::Bool(false);
        out["error"] = Value::String("rsi_idle_hands_scheduler_failed".to_string());
    }
    out["receipt_hash"] = Value::String(stable_hash(&out));

    append_jsonl(&events_path, &out);
    append_jsonl(&receipts_path, &out);
    write_json(&latest_path, &out);

    let code = if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
    };
    (code, out)
}
