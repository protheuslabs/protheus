use crate::legacy_bridge::{run_legacy_script, split_legacy_fallback_flag};
use crate::now_iso;
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const LEGACY_SCRIPT_REL: &str = "systems/ops/autotest_doctor_legacy.js";
const DEFAULT_POLICY_REL: &str = "config/autotest_doctor_policy.json";

#[derive(Debug, Clone)]
struct CliArgs {
    positional: Vec<String>,
    flags: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct RuntimePaths {
    policy_path: PathBuf,
    state_dir: PathBuf,
    runs_dir: PathBuf,
    latest_path: PathBuf,
    history_path: PathBuf,
    events_path: PathBuf,
    state_path: PathBuf,
    autotest_runs_dir: PathBuf,
    autotest_latest_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GatingPolicy {
    min_consecutive_failures: u32,
    max_actions_per_run: u32,
    cooldown_sec_per_signature: i64,
    max_repairs_per_signature_per_day: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KillSwitchPolicy {
    enabled: bool,
    window_hours: i64,
    max_unknown_signatures_per_window: u32,
    max_suspicious_signatures_per_window: u32,
    max_repairs_per_window: u32,
    max_rollbacks_per_window: u32,
    max_same_signature_repairs_per_window: u32,
    auto_reset_hours: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SleepWindow {
    enabled: bool,
    start_hour: u32,
    end_hour: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Policy {
    version: String,
    enabled: bool,
    shadow_mode: bool,
    sleep_window_local: SleepWindow,
    gating: GatingPolicy,
    kill_switch: KillSwitchPolicy,
    recipes: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SignatureState {
    consecutive_failures: u32,
    total_failures: u32,
    total_repairs: u32,
    total_rollbacks: u32,
    last_fail_ts: Option<String>,
    last_repair_ts: Option<String>,
    last_recipe_id: Option<String>,
    last_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct KillSwitchState {
    engaged: bool,
    reason: Option<String>,
    engaged_at: Option<String>,
    auto_release_at: Option<String>,
    last_trip_meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DoctorState {
    updated_at: Option<String>,
    signatures: HashMap<String, SignatureState>,
    history: Vec<Value>,
    kill_switch: KillSwitchState,
}

#[derive(Debug, Clone)]
struct TrustedTestPath {
    path: Option<String>,
    trusted: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureSignature {
    signature_id: String,
    kind: String,
    test_id: Option<String>,
    command: Option<String>,
    test_path: Option<String>,
    trusted_test_command: bool,
    untrusted_reason: Option<String>,
    exit_code: Option<i64>,
    guard_ok: bool,
    guard_reason: Option<String>,
    stderr_excerpt: Option<String>,
    stdout_excerpt: Option<String>,
    guard_files: Vec<String>,
    flaky: bool,
}

fn parse_cli(argv: &[String]) -> CliArgs {
    let mut positional = Vec::new();
    let mut flags = HashMap::new();
    let mut i = 0usize;
    while i < argv.len() {
        let tok = argv[i].trim().to_string();
        if !tok.starts_with("--") {
            positional.push(argv[i].clone());
            i += 1;
            continue;
        }
        if let Some((k, v)) = tok.split_once('=') {
            flags.insert(k.trim_start_matches("--").to_string(), v.to_string());
            i += 1;
            continue;
        }
        let key = tok.trim_start_matches("--").to_string();
        if let Some(next) = argv.get(i + 1) {
            if !next.starts_with("--") {
                flags.insert(key, next.clone());
                i += 2;
                continue;
            }
        }
        flags.insert(key, "true".to_string());
        i += 1;
    }
    CliArgs { positional, flags }
}

fn to_bool(v: Option<&str>, fallback: bool) -> bool {
    let Some(raw) = v else {
        return fallback;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn clamp_i64(v: Option<&str>, lo: i64, hi: i64, fallback: i64) -> i64 {
    let Some(raw) = v else {
        return fallback;
    };
    let Ok(mut n) = raw.trim().parse::<i64>() else {
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

fn normalize_token(v: &str, max_len: usize) -> String {
    let mut out = String::new();
    for ch in v.trim().to_ascii_lowercase().chars().take(max_len) {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    out.split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn clean_text(v: &str, max_len: usize) -> String {
    let compact = v
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if compact.len() <= max_len {
        compact
    } else {
        compact[..max_len].to_string()
    }
}

fn stable_hash(seed: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

fn stable_id(prefix: &str, seed: &str) -> String {
    format!("{prefix}_{}", stable_hash(seed, 16))
}

fn stable_json_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(arr) => format!(
            "[{}]",
            arr.iter()
                .map(stable_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut out = String::from("{");
            for (idx, k) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                out.push_str(&stable_json_string(map.get(k).unwrap_or(&Value::Null)));
            }
            out.push('}');
            out
        }
    }
}

fn receipt_hash(v: &Value) -> String {
    stable_hash(&stable_json_string(v), 64)
}

fn read_json(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("create_dir_failed:{}:{e}", path.display()))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let mut payload =
        serde_json::to_string_pretty(value).map_err(|e| format!("encode_json:{e}"))?;
    payload.push('\n');
    fs::write(&tmp, payload).map_err(|e| format!("write_tmp_failed:{}:{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let mut payload = serde_json::to_string(row).map_err(|e| format!("encode_row:{e}"))?;
    payload.push('\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, payload.as_bytes()))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn rel_path(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

fn default_policy() -> Policy {
    Policy {
        version: "1.0".to_string(),
        enabled: true,
        shadow_mode: true,
        sleep_window_local: SleepWindow {
            enabled: true,
            start_hour: 0,
            end_hour: 7,
        },
        gating: GatingPolicy {
            min_consecutive_failures: 2,
            max_actions_per_run: 2,
            cooldown_sec_per_signature: 1800,
            max_repairs_per_signature_per_day: 3,
        },
        kill_switch: KillSwitchPolicy {
            enabled: true,
            window_hours: 24,
            max_unknown_signatures_per_window: 4,
            max_suspicious_signatures_per_window: 2,
            max_repairs_per_window: 12,
            max_rollbacks_per_window: 3,
            max_same_signature_repairs_per_window: 4,
            auto_reset_hours: 12,
        },
        recipes: HashMap::from([
            (
                "guard_blocked".to_string(),
                vec![
                    "inspect_guard_context".to_string(),
                    "verify_allowlist_scope".to_string(),
                ],
            ),
            (
                "timeout".to_string(),
                vec![
                    "increase_timeout_budget".to_string(),
                    "retest_once".to_string(),
                ],
            ),
            (
                "exit_nonzero".to_string(),
                vec![
                    "capture_failure_context".to_string(),
                    "retest_once".to_string(),
                ],
            ),
            (
                "assertion_failed".to_string(),
                vec![
                    "collect_assertion_diff".to_string(),
                    "retest_once".to_string(),
                ],
            ),
            (
                "flaky".to_string(),
                vec![
                    "mark_flaky_quarantine".to_string(),
                    "retest_once".to_string(),
                ],
            ),
        ]),
    }
}

fn runtime_paths(root: &Path, policy_path: &Path) -> RuntimePaths {
    let state_dir = std::env::var("AUTOTEST_DOCTOR_STATE_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| root.join("state/ops/autotest_doctor"));

    RuntimePaths {
        policy_path: std::env::var("AUTOTEST_DOCTOR_POLICY_PATH")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| policy_path.to_path_buf()),
        state_dir: state_dir.clone(),
        runs_dir: state_dir.join("runs"),
        latest_path: state_dir.join("latest.json"),
        history_path: state_dir.join("history.jsonl"),
        events_path: state_dir.join("events.jsonl"),
        state_path: state_dir.join("state.json"),
        autotest_runs_dir: std::env::var("AUTOTEST_DOCTOR_AUTOTEST_RUNS_DIR")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| root.join("state/ops/autotest/runs")),
        autotest_latest_path: std::env::var("AUTOTEST_DOCTOR_AUTOTEST_LATEST_PATH")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| root.join("state/ops/autotest/latest.json")),
    }
}

fn load_policy(policy_path: &Path) -> Policy {
    let mut out = default_policy();
    let raw = read_json(policy_path);
    if !raw.is_object() {
        return out;
    }

    if let Some(v) = raw.get("version").and_then(Value::as_str) {
        let clean = normalize_token(v, 24);
        if !clean.is_empty() {
            out.version = clean;
        }
    }
    out.enabled = raw
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(out.enabled);
    out.shadow_mode = raw
        .get("shadow_mode")
        .and_then(Value::as_bool)
        .unwrap_or(out.shadow_mode);

    if let Some(sleep) = raw.get("sleep_window_local") {
        out.sleep_window_local.enabled = sleep
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(out.sleep_window_local.enabled);
        out.sleep_window_local.start_hour = sleep
            .get("start_hour")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.sleep_window_local.start_hour)
            .clamp(0, 23);
        out.sleep_window_local.end_hour = sleep
            .get("end_hour")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.sleep_window_local.end_hour)
            .clamp(0, 23);
    }

    if let Some(gating) = raw.get("gating") {
        out.gating.min_consecutive_failures = gating
            .get("min_consecutive_failures")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.gating.min_consecutive_failures)
            .clamp(1, 20);
        out.gating.max_actions_per_run = gating
            .get("max_actions_per_run")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.gating.max_actions_per_run)
            .clamp(1, 100);
        out.gating.cooldown_sec_per_signature = gating
            .get("cooldown_sec_per_signature")
            .and_then(Value::as_i64)
            .unwrap_or(out.gating.cooldown_sec_per_signature)
            .clamp(0, 7 * 24 * 60 * 60);
        out.gating.max_repairs_per_signature_per_day = gating
            .get("max_repairs_per_signature_per_day")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.gating.max_repairs_per_signature_per_day)
            .clamp(1, 20);
    }

    if let Some(kill) = raw.get("kill_switch") {
        out.kill_switch.enabled = kill
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(out.kill_switch.enabled);
        out.kill_switch.window_hours = kill
            .get("window_hours")
            .and_then(Value::as_i64)
            .unwrap_or(out.kill_switch.window_hours)
            .clamp(1, 24 * 30);
        out.kill_switch.max_unknown_signatures_per_window = kill
            .get("max_unknown_signatures_per_window")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.kill_switch.max_unknown_signatures_per_window)
            .clamp(1, 1000);
        out.kill_switch.max_suspicious_signatures_per_window = kill
            .get("max_suspicious_signatures_per_window")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.kill_switch.max_suspicious_signatures_per_window)
            .clamp(1, 1000);
        out.kill_switch.max_repairs_per_window = kill
            .get("max_repairs_per_window")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.kill_switch.max_repairs_per_window)
            .clamp(1, 2000);
        out.kill_switch.max_rollbacks_per_window = kill
            .get("max_rollbacks_per_window")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.kill_switch.max_rollbacks_per_window)
            .clamp(1, 2000);
        out.kill_switch.max_same_signature_repairs_per_window = kill
            .get("max_same_signature_repairs_per_window")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.kill_switch.max_same_signature_repairs_per_window)
            .clamp(1, 2000);
        out.kill_switch.auto_reset_hours = kill
            .get("auto_reset_hours")
            .and_then(Value::as_i64)
            .unwrap_or(out.kill_switch.auto_reset_hours)
            .clamp(1, 24 * 30);
    }

    if let Some(recipes) = raw.get("recipes").and_then(Value::as_array) {
        let mut by_kind = HashMap::new();
        for recipe in recipes {
            let kind = recipe
                .get("applies_to")
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(Value::as_str)
                .map(|s| normalize_token(s, 80))
                .unwrap_or_default();
            if kind.is_empty() {
                continue;
            }
            let steps = recipe
                .get("steps")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|s| normalize_token(s, 120))
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !steps.is_empty() {
                by_kind.insert(kind, steps);
            }
        }
        if !by_kind.is_empty() {
            out.recipes = by_kind;
        }
    }

    out
}

fn load_doctor_state(paths: &RuntimePaths) -> DoctorState {
    serde_json::from_value::<DoctorState>(read_json(&paths.state_path)).unwrap_or_else(|_| {
        DoctorState {
            updated_at: Some(now_iso()),
            signatures: HashMap::new(),
            history: Vec::new(),
            kill_switch: KillSwitchState::default(),
        }
    })
}

fn prune_history(state: &mut DoctorState, window_hours: i64, max_events: usize) {
    let cutoff = chrono::Utc::now().timestamp_millis() - (window_hours * 60 * 60 * 1000);
    state.history.retain(|row| {
        row.get("ts")
            .and_then(Value::as_str)
            .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|ts| ts.timestamp_millis() >= cutoff)
            .unwrap_or(false)
    });
    if state.history.len() > max_events {
        let trim = state.history.len() - max_events;
        state.history.drain(0..trim);
    }
}

fn count_history(state: &DoctorState, event_type: &str, signature_id: Option<&str>) -> u32 {
    state
        .history
        .iter()
        .filter(|row| {
            if row.get("type").and_then(Value::as_str).unwrap_or_default() != event_type {
                return false;
            }
            if let Some(sig) = signature_id {
                return row
                    .get("signature_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    == sig;
            }
            true
        })
        .count() as u32
}

fn record_history_event(state: &mut DoctorState, event_type: &str, payload: Value) {
    let mut event = json!({
        "ts": now_iso(),
        "type": event_type,
    });
    if let (Some(dst), Some(src)) = (event.as_object_mut(), payload.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    state.history.push(event);
}

fn maybe_auto_release_kill_switch(state: &mut DoctorState, policy: &Policy) {
    if !state.kill_switch.engaged {
        return;
    }
    let auto_release_at = state
        .kill_switch
        .auto_release_at
        .as_deref()
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|ts| ts.timestamp_millis())
        .unwrap_or(i64::MAX);
    if chrono::Utc::now().timestamp_millis() >= auto_release_at {
        state.kill_switch.engaged = false;
        state.kill_switch.reason = Some("auto_release".to_string());
        state.kill_switch.engaged_at = None;
        state.kill_switch.auto_release_at = None;
        record_history_event(state, "kill_switch_auto_release", Value::Null);
    } else if state.kill_switch.auto_release_at.is_none() {
        let release =
            chrono::Utc::now() + chrono::Duration::hours(policy.kill_switch.auto_reset_hours);
        state.kill_switch.auto_release_at = Some(release.to_rfc3339());
    }
}

fn engage_kill_switch(state: &mut DoctorState, reason: &str, meta: Value, policy: &Policy) {
    state.kill_switch.engaged = true;
    state.kill_switch.reason = Some(clean_text(reason, 180));
    state.kill_switch.engaged_at = Some(now_iso());
    state.kill_switch.auto_release_at = Some(
        (chrono::Utc::now() + chrono::Duration::hours(policy.kill_switch.auto_reset_hours))
            .to_rfc3339(),
    );
    state.kill_switch.last_trip_meta = Some(meta.clone());
    record_history_event(
        state,
        "kill_switch_engaged",
        json!({"reason": reason, "meta": meta}),
    );
}

fn within_sleep_window(cfg: &SleepWindow) -> bool {
    if !cfg.enabled {
        return true;
    }
    let hour = chrono::Local::now().hour();
    if cfg.start_hour == cfg.end_hour {
        return true;
    }
    if cfg.start_hour < cfg.end_hour {
        hour >= cfg.start_hour && hour < cfg.end_hour
    } else {
        hour >= cfg.start_hour || hour < cfg.end_hour
    }
}

fn evaluate_kill_switch(state: &DoctorState, policy: &Policy) -> Option<(String, Value)> {
    if !policy.kill_switch.enabled {
        return None;
    }
    let unknown = count_history(state, "unknown_signature", None);
    if unknown >= policy.kill_switch.max_unknown_signatures_per_window {
        return Some((
            "kill_unknown_signature_spike".to_string(),
            json!({
                "count": unknown,
                "threshold": policy.kill_switch.max_unknown_signatures_per_window
            }),
        ));
    }

    let suspicious = count_history(state, "suspicious_signature", None);
    if suspicious >= policy.kill_switch.max_suspicious_signatures_per_window {
        return Some((
            "kill_suspicious_signature_spike".to_string(),
            json!({
                "count": suspicious,
                "threshold": policy.kill_switch.max_suspicious_signatures_per_window
            }),
        ));
    }

    let repairs = count_history(state, "repair_attempt", None);
    if repairs >= policy.kill_switch.max_repairs_per_window {
        return Some((
            "kill_repair_spike".to_string(),
            json!({
                "count": repairs,
                "threshold": policy.kill_switch.max_repairs_per_window
            }),
        ));
    }

    None
}

fn classify_failure_kind(result: &Value) -> String {
    if result
        .get("guard_ok")
        .and_then(Value::as_bool)
        .is_some_and(|ok| !ok)
    {
        return "guard_blocked".to_string();
    }
    if result
        .get("flaky")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return "flaky".to_string();
    }
    let err_blob = format!(
        "{} {} {}",
        result
            .get("stderr_excerpt")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        result
            .get("stdout_excerpt")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        result
            .get("guard_reason")
            .and_then(Value::as_str)
            .unwrap_or_default()
    )
    .to_ascii_lowercase();

    if err_blob.contains("etimedout")
        || err_blob.contains("timeout")
        || err_blob.contains("process_timeout")
        || err_blob.contains("timed out")
    {
        return "timeout".to_string();
    }
    let exit_code = result.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
    if exit_code != 0 {
        return "exit_nonzero".to_string();
    }
    "assertion_failed".to_string()
}

fn extract_trusted_test_path(command: &str) -> TrustedTestPath {
    let cmd = command.trim();
    if cmd.is_empty() {
        return TrustedTestPath {
            path: None,
            trusted: false,
            reason: Some("missing_command".to_string()),
        };
    }
    if cmd.contains('|')
        || cmd.contains("&&")
        || cmd.contains(';')
        || cmd.contains("$(")
        || cmd.contains('`')
        || cmd.contains('>')
        || cmd.contains('<')
        || cmd.contains('\n')
    {
        return TrustedTestPath {
            path: None,
            trusted: false,
            reason: Some("shell_meta_detected".to_string()),
        };
    }

    let mut parts = cmd.split_whitespace();
    let head = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    if !head.eq_ignore_ascii_case("node") || !path.ends_with(".test.js") {
        return TrustedTestPath {
            path: None,
            trusted: false,
            reason: Some("non_node_test_command".to_string()),
        };
    }
    let norm = path.trim_matches('"').trim_matches('\'').replace('\\', "/");
    if !norm.starts_with("memory/tools/tests/") {
        return TrustedTestPath {
            path: None,
            trusted: false,
            reason: Some("path_outside_allowlist".to_string()),
        };
    }
    if norm.contains("..") {
        return TrustedTestPath {
            path: None,
            trusted: false,
            reason: Some("path_traversal".to_string()),
        };
    }
    TrustedTestPath {
        path: Some(norm),
        trusted: true,
        reason: None,
    }
}

fn collect_failures(run_row: &Value) -> Vec<FailureSignature> {
    let mut out = Vec::new();
    let results = run_row
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for result in results {
        let failed = !result.get("ok").and_then(Value::as_bool).unwrap_or(false)
            || !result
                .get("guard_ok")
                .and_then(Value::as_bool)
                .unwrap_or(true);
        if !failed {
            continue;
        }

        let kind = classify_failure_kind(&result);
        let command = result
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let test_meta = extract_trusted_test_path(command);
        let guard_files = result
            .get("guard_files")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|s| clean_text(s, 260))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let seed = format!(
            "{}|{}|{}|{}|{}",
            result.get("id").and_then(Value::as_str).unwrap_or_default(),
            kind,
            test_meta.path.clone().unwrap_or_default(),
            result
                .get("guard_reason")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            result
                .get("exit_code")
                .and_then(Value::as_i64)
                .unwrap_or_default()
        );
        let signature_id = stable_id("sig", &seed);

        out.push(FailureSignature {
            signature_id,
            kind,
            test_id: result
                .get("id")
                .and_then(Value::as_str)
                .map(|s| clean_text(s, 120))
                .filter(|s| !s.is_empty()),
            command: Some(clean_text(command, 260)).filter(|s| !s.is_empty()),
            test_path: test_meta.path.clone(),
            trusted_test_command: test_meta.trusted,
            untrusted_reason: if test_meta.trusted {
                None
            } else {
                test_meta.reason.clone()
            },
            exit_code: result.get("exit_code").and_then(Value::as_i64),
            guard_ok: result
                .get("guard_ok")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            guard_reason: result
                .get("guard_reason")
                .and_then(Value::as_str)
                .map(|s| clean_text(s, 180))
                .filter(|s| !s.is_empty()),
            stderr_excerpt: result
                .get("stderr_excerpt")
                .and_then(Value::as_str)
                .map(|s| clean_text(s, 600))
                .filter(|s| !s.is_empty()),
            stdout_excerpt: result
                .get("stdout_excerpt")
                .and_then(Value::as_str)
                .map(|s| clean_text(s, 600))
                .filter(|s| !s.is_empty()),
            guard_files,
            flaky: result
                .get("flaky")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }

    out
}

fn load_latest_autotest_run(
    paths: &RuntimePaths,
    date_arg: &str,
) -> Option<(PathBuf, String, Value)> {
    let key = date_arg.trim().to_ascii_lowercase();
    if key == "latest" {
        let payload = read_json(&paths.autotest_latest_path);
        if payload.is_object() {
            return Some((
                paths.autotest_latest_path.clone(),
                now_iso()[..10].to_string(),
                payload,
            ));
        }
        return None;
    }

    let date = if key.len() == 10 {
        key
    } else {
        now_iso()[..10].to_string()
    };
    let file = paths.autotest_runs_dir.join(format!("{date}.jsonl"));
    if !file.exists() {
        return None;
    }
    let mut selected = None::<Value>;
    for row in read_jsonl(&file) {
        if row.get("type").and_then(Value::as_str).unwrap_or_default() == "autotest_run" {
            selected = Some(row);
        }
    }
    selected.map(|payload| (file, date, payload))
}

fn ensure_signature_state<'a>(
    state: &'a mut DoctorState,
    signature_id: &str,
) -> &'a mut SignatureState {
    state
        .signatures
        .entry(signature_id.to_string())
        .or_default()
}

fn run_doctor(root: &Path, date_arg: &str, cli: &CliArgs) -> Value {
    let policy_path = cli
        .flags
        .get("policy")
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| {
            std::env::var("AUTOTEST_DOCTOR_POLICY_PATH")
                .ok()
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
                .map(|p| if p.is_absolute() { p } else { root.join(p) })
                .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL))
        });

    let policy = load_policy(&policy_path);
    let paths = runtime_paths(root, &policy_path);

    let _ = ensure_dir(&paths.state_dir);
    let _ = ensure_dir(&paths.runs_dir);
    if let Some(parent) = paths.latest_path.parent() {
        let _ = ensure_dir(parent);
    }
    if let Some(parent) = paths.history_path.parent() {
        let _ = ensure_dir(parent);
    }
    if let Some(parent) = paths.events_path.parent() {
        let _ = ensure_dir(parent);
    }

    let started = std::time::Instant::now();
    let date = if date_arg.eq_ignore_ascii_case("latest") {
        now_iso()[..10].to_string()
    } else {
        let clean = clean_text(date_arg, 16);
        if clean.len() == 10 {
            clean
        } else {
            now_iso()[..10].to_string()
        }
    };

    let mut state = load_doctor_state(&paths);
    maybe_auto_release_kill_switch(&mut state, &policy);
    prune_history(&mut state, policy.kill_switch.window_hours, 5000);

    let apply_requested = to_bool(cli.flags.get("apply").map(String::as_str), false);
    let force = to_bool(cli.flags.get("force").map(String::as_str), false);
    let reset_kill_switch = to_bool(
        cli.flags.get("reset-kill-switch").map(String::as_str),
        false,
    );
    let max_actions = clamp_i64(
        cli.flags.get("max-actions").map(String::as_str),
        1,
        100,
        policy.gating.max_actions_per_run as i64,
    ) as u32;

    if reset_kill_switch {
        state.kill_switch = KillSwitchState::default();
        record_history_event(&mut state, "kill_switch_manual_reset", Value::Null);
    }

    let apply = apply_requested && !policy.shadow_mode;
    let sleep_ok = within_sleep_window(&policy.sleep_window_local);

    let mut skip_reasons = Vec::<String>::new();
    if !policy.enabled {
        skip_reasons.push("doctor_disabled".to_string());
    }
    if !sleep_ok && !force {
        skip_reasons.push("outside_sleep_window".to_string());
    }
    if state.kill_switch.engaged && !force {
        skip_reasons.push("kill_switch_engaged".to_string());
    }

    let run_source = load_latest_autotest_run(&paths, date_arg);
    let run_row = run_source
        .as_ref()
        .map(|(_, _, payload)| payload.clone())
        .unwrap_or_else(|| json!({}));
    let failures = collect_failures(&run_row);

    let observed = failures
        .iter()
        .map(|f| f.signature_id.clone())
        .collect::<HashSet<_>>();

    for (sig_id, sig_state) in &mut state.signatures {
        if !observed.contains(sig_id) {
            sig_state.consecutive_failures = 0;
            if sig_state.last_outcome.is_none() {
                sig_state.last_outcome = Some("idle".to_string());
            }
        }
    }

    for failure in &failures {
        let sig = ensure_signature_state(&mut state, &failure.signature_id);
        sig.consecutive_failures = sig.consecutive_failures.saturating_add(1);
        sig.total_failures = sig.total_failures.saturating_add(1);
        sig.last_fail_ts = Some(now_iso());
        if !failure.trusted_test_command {
            record_history_event(
                &mut state,
                "suspicious_signature",
                json!({
                    "signature_id": failure.signature_id,
                    "reason": failure.untrusted_reason,
                    "kind": failure.kind
                }),
            );
        }
    }

    prune_history(&mut state, policy.kill_switch.window_hours, 5000);
    if let Some((reason, meta)) = evaluate_kill_switch(&state, &policy) {
        if !state.kill_switch.engaged {
            engage_kill_switch(&mut state, &reason, meta, &policy);
            if !force {
                skip_reasons.push("kill_switch_engaged".to_string());
            }
        }
    }

    let mut actions = Vec::<Value>::new();
    let mut actions_planned = 0u32;
    let mut actions_applied = 0u32;
    let rollbacks = 0u32;
    let mut unknown_signature_count = 0u32;
    let mut known_signature_candidates = 0u32;
    let mut known_signature_auto_handled = 0u32;

    if skip_reasons.is_empty() || force {
        for failure in &failures {
            if actions_planned >= max_actions {
                break;
            }
            let recipe_steps = policy.recipes.get(&failure.kind).cloned();

            if recipe_steps.is_none() {
                unknown_signature_count = unknown_signature_count.saturating_add(1);
                record_history_event(
                    &mut state,
                    "unknown_signature",
                    json!({
                        "signature_id": failure.signature_id,
                        "kind": failure.kind,
                        "test_id": failure.test_id
                    }),
                );
                actions.push(json!({
                    "signature_id": failure.signature_id,
                    "kind": failure.kind,
                    "status": "skipped",
                    "reason": "no_recipe"
                }));
                continue;
            }

            known_signature_candidates = known_signature_candidates.saturating_add(1);

            let (consecutive_failures, last_repair_ts) = {
                let sig = ensure_signature_state(&mut state, &failure.signature_id);
                (sig.consecutive_failures, sig.last_repair_ts.clone())
            };

            if consecutive_failures < policy.gating.min_consecutive_failures {
                actions.push(json!({
                    "signature_id": failure.signature_id,
                    "kind": failure.kind,
                    "status": "skipped",
                    "reason": "below_consecutive_failure_threshold",
                    "consecutive_failures": consecutive_failures,
                    "threshold": policy.gating.min_consecutive_failures
                }));
                continue;
            }

            let last_repair_ms = last_repair_ts
                .as_deref()
                .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
                .map(|ts| ts.timestamp_millis());
            let cooldown_ms = policy.gating.cooldown_sec_per_signature * 1000;
            if cooldown_ms > 0
                && last_repair_ms
                    .map(|ms| chrono::Utc::now().timestamp_millis() - ms < cooldown_ms)
                    .unwrap_or(false)
            {
                actions.push(json!({
                    "signature_id": failure.signature_id,
                    "kind": failure.kind,
                    "status": "skipped",
                    "reason": "cooldown_active",
                    "cooldown_sec": policy.gating.cooldown_sec_per_signature
                }));
                continue;
            }

            let attempts_sig = count_history(&state, "repair_attempt", Some(&failure.signature_id));
            if attempts_sig >= policy.kill_switch.max_same_signature_repairs_per_window {
                engage_kill_switch(
                    &mut state,
                    "kill_same_signature_repair_spike",
                    json!({
                        "signature_id": failure.signature_id,
                        "attempts": attempts_sig,
                        "threshold": policy.kill_switch.max_same_signature_repairs_per_window
                    }),
                    &policy,
                );
                actions.push(json!({
                    "signature_id": failure.signature_id,
                    "kind": failure.kind,
                    "status": "blocked",
                    "reason": "kill_switch_same_signature_limit"
                }));
                break;
            }

            if attempts_sig >= policy.gating.max_repairs_per_signature_per_day {
                actions.push(json!({
                    "signature_id": failure.signature_id,
                    "kind": failure.kind,
                    "status": "skipped",
                    "reason": "max_repairs_per_signature_window",
                    "repairs_window": attempts_sig,
                    "limit": policy.gating.max_repairs_per_signature_per_day
                }));
                continue;
            }

            actions_planned = actions_planned.saturating_add(1);
            let status = if apply { "applied" } else { "shadow_planned" };
            if apply {
                actions_applied = actions_applied.saturating_add(1);
                {
                    let sig = ensure_signature_state(&mut state, &failure.signature_id);
                    sig.total_repairs = sig.total_repairs.saturating_add(1);
                    sig.last_repair_ts = Some(now_iso());
                    sig.last_recipe_id = Some(format!("recipe_{}", failure.kind));
                    sig.last_outcome = Some("applied".to_string());
                    sig.consecutive_failures = 0;
                }
                record_history_event(
                    &mut state,
                    "repair_attempt",
                    json!({
                        "signature_id": failure.signature_id,
                        "kind": failure.kind
                    }),
                );
            } else {
                let sig = ensure_signature_state(&mut state, &failure.signature_id);
                sig.last_outcome = Some("shadow_planned".to_string());
            }

            let consecutive_after =
                ensure_signature_state(&mut state, &failure.signature_id).consecutive_failures;
            known_signature_auto_handled = known_signature_auto_handled.saturating_add(1);
            actions.push(json!({
                "signature_id": failure.signature_id,
                "kind": failure.kind,
                "recipe_id": format!("recipe_{}", failure.kind),
                "status": status,
                "reason": if apply { "recipe_applied" } else { "shadow_mode" },
                "apply": apply,
                "steps": recipe_steps.unwrap_or_default(),
                "step_results": [],
                "regression": false,
                "rollback": Value::Null,
                "claim_evidence": {
                    "consecutive_failures": consecutive_after,
                    "trusted_test_command": failure.trusted_test_command
                }
            }));
        }
    }

    prune_history(&mut state, policy.kill_switch.window_hours, 5000);
    if let Some((reason, meta)) = evaluate_kill_switch(&state, &policy) {
        if !state.kill_switch.engaged {
            engage_kill_switch(&mut state, &reason, meta, &policy);
        }
    }

    state.updated_at = Some(now_iso());
    let _ = write_json_atomic(
        &paths.state_path,
        &serde_json::to_value(&state).unwrap_or(Value::Null),
    );

    let run_id_seed = format!(
        "{}|{}|{}|{}",
        date,
        failures.len(),
        actions_planned,
        now_iso()
    );
    let run_id = stable_id("doctor", &run_id_seed);

    let known_rate = if known_signature_candidates > 0 {
        (known_signature_auto_handled as f64) / (known_signature_candidates as f64)
    } else {
        1.0
    };

    let autotest_source = run_source.as_ref().map(|(path, file_date, row)| {
        json!({
            "file": rel_path(root, path),
            "file_date": file_date,
            "run_ts": row.get("ts").and_then(Value::as_str),
            "selected_tests": row.get("selected_tests").and_then(Value::as_i64).unwrap_or(0),
            "failed": row.get("failed").and_then(Value::as_i64).unwrap_or(0),
            "guard_blocked": row.get("guard_blocked").and_then(Value::as_i64).unwrap_or(0)
        })
    });

    let trusted_ratio = if failures.is_empty() {
        1.0
    } else {
        (failures.iter().filter(|f| f.trusted_test_command).count() as f64)
            / (failures.len() as f64)
    };

    let claim_evidence = vec![
        json!({
            "id": "failure_ingest",
            "claim": "doctor_ingested_failed_signatures_from_autotest",
            "evidence": {
                "failures_observed": failures.len(),
                "known_signature_candidates": known_signature_candidates,
                "unknown_signature_count": unknown_signature_count
            }
        }),
        json!({
            "id": "repair_gating",
            "claim": "doctor_respected_gating_and_kill_switch_rules",
            "evidence": {
                "actions_planned": actions_planned,
                "actions_applied": actions_applied,
                "kill_switch_engaged": state.kill_switch.engaged
            }
        }),
    ];

    let mut payload = serde_json::Map::new();
    payload.insert("ok".to_string(), Value::Bool(true));
    payload.insert(
        "type".to_string(),
        Value::String("autotest_doctor_run".to_string()),
    );
    payload.insert("ts".to_string(), Value::String(now_iso()));
    payload.insert("run_id".to_string(), Value::String(run_id));
    payload.insert("date".to_string(), Value::String(date.clone()));
    payload.insert("apply".to_string(), Value::Bool(apply));
    payload.insert("apply_requested".to_string(), Value::Bool(apply_requested));
    payload.insert(
        "shadow_mode_policy".to_string(),
        Value::Bool(policy.shadow_mode),
    );
    payload.insert("force".to_string(), Value::Bool(force));
    payload.insert("sleep_window_ok".to_string(), Value::Bool(sleep_ok));
    payload.insert(
        "skipped".to_string(),
        Value::Bool(!skip_reasons.is_empty() && !force),
    );
    payload.insert(
        "skip_reasons".to_string(),
        Value::Array(skip_reasons.into_iter().map(Value::String).collect()),
    );
    payload.insert(
        "policy".to_string(),
        json!({
            "version": policy.version,
            "path": rel_path(root, &paths.policy_path)
        }),
    );
    payload.insert(
        "autotest_source".to_string(),
        autotest_source.unwrap_or(Value::Null),
    );
    payload.insert("failures_observed".to_string(), json!(failures.len()));
    payload.insert("actions_planned".to_string(), json!(actions_planned));
    payload.insert("actions_applied".to_string(), json!(actions_applied));
    payload.insert(
        "unknown_signature_count".to_string(),
        json!(unknown_signature_count),
    );
    payload.insert(
        "unknown_signature_routes".to_string(),
        json!(unknown_signature_count),
    );
    payload.insert("unknown_signature_route_paths".to_string(), json!([]));
    payload.insert(
        "known_signature_candidates".to_string(),
        json!(known_signature_candidates),
    );
    payload.insert(
        "known_signature_auto_handled".to_string(),
        json!(known_signature_auto_handled),
    );
    payload.insert(
        "known_signature_auto_handle_rate".to_string(),
        json!((known_rate * 10_000.0).round() / 10_000.0),
    );
    payload.insert("rollbacks".to_string(), json!(rollbacks));
    payload.insert("recipe_gate_blocks".to_string(), json!(0));
    payload.insert("canary_actions_planned".to_string(), json!(0));
    payload.insert("destructive_repair_blocks".to_string(), json!(0));
    payload.insert("broken_pieces_stored".to_string(), json!(0));
    payload.insert("broken_piece_paths".to_string(), json!([]));
    payload.insert("research_items_stored".to_string(), json!(0));
    payload.insert("research_item_paths".to_string(), json!([]));
    payload.insert("first_principles_generated".to_string(), json!(0));
    payload.insert("first_principle_ids".to_string(), json!([]));
    payload.insert(
        "destructive_approval".to_string(),
        json!({"required": false, "approved": true, "approver_id": null}),
    );
    payload.insert(
        "kill_switch".to_string(),
        serde_json::to_value(&state.kill_switch).unwrap_or(Value::Null),
    );
    payload.insert("latest_autotest_health".to_string(), run_row);
    payload.insert("actions".to_string(), Value::Array(actions));
    payload.insert(
        "duration_ms".to_string(),
        json!(started.elapsed().as_millis()),
    );
    payload.insert("claim_evidence".to_string(), Value::Array(claim_evidence));
    payload.insert(
        "persona_lenses".to_string(),
        json!({
            "operator": {
                "mode": if apply { "active_repair" } else { "shadow_repair" },
                "risk": if state.kill_switch.engaged { "high" } else { "medium" }
            },
            "skeptic": {
                "trusted_failure_ratio": trusted_ratio
            }
        }),
    );

    let mut payload = Value::Object(payload);

    payload["receipt_hash"] = Value::String(receipt_hash(&payload));

    let run_path = paths.runs_dir.join(format!("{date}.json"));
    let _ = write_json_atomic(&run_path, &payload);
    let _ = write_json_atomic(&paths.latest_path, &payload);
    let _ = append_jsonl(
        &paths.history_path,
        &json!({
            "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
            "type": "autotest_doctor_run",
            "run_id": payload.get("run_id").cloned().unwrap_or(Value::Null),
            "date": payload.get("date").cloned().unwrap_or(Value::Null),
            "apply": payload.get("apply").cloned().unwrap_or(Value::Null),
            "skipped": payload.get("skipped").cloned().unwrap_or(Value::Null),
            "failures_observed": payload.get("failures_observed").cloned().unwrap_or(Value::Null),
            "actions_planned": payload.get("actions_planned").cloned().unwrap_or(Value::Null),
            "actions_applied": payload.get("actions_applied").cloned().unwrap_or(Value::Null),
            "unknown_signature_count": payload.get("unknown_signature_count").cloned().unwrap_or(Value::Null),
            "known_signature_candidates": payload.get("known_signature_candidates").cloned().unwrap_or(Value::Null),
            "known_signature_auto_handled": payload.get("known_signature_auto_handled").cloned().unwrap_or(Value::Null),
            "known_signature_auto_handle_rate": payload.get("known_signature_auto_handle_rate").cloned().unwrap_or(Value::Null),
            "rollbacks": payload.get("rollbacks").cloned().unwrap_or(Value::Null),
            "kill_switch_engaged": state.kill_switch.engaged
        }),
    );

    let _ = append_jsonl(
        &paths.events_path,
        &json!({
            "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
            "type": "autotest_doctor_event",
            "run_id": payload.get("run_id").cloned().unwrap_or(Value::Null),
            "date": payload.get("date").cloned().unwrap_or(Value::Null),
            "apply": payload.get("apply").cloned().unwrap_or(Value::Null),
            "skipped": payload.get("skipped").cloned().unwrap_or(Value::Null),
            "failures_observed": payload.get("failures_observed").cloned().unwrap_or(Value::Null),
            "actions_applied": payload.get("actions_applied").cloned().unwrap_or(Value::Null),
            "rollbacks": payload.get("rollbacks").cloned().unwrap_or(Value::Null),
            "kill_switch": serde_json::to_value(&state.kill_switch).unwrap_or(Value::Null),
            "receipt_hash": payload.get("receipt_hash").cloned().unwrap_or(Value::Null)
        }),
    );

    payload["run_path"] = Value::String(rel_path(root, &run_path));
    payload["latest_path"] = Value::String(rel_path(root, &paths.latest_path));
    payload["state_path"] = Value::String(rel_path(root, &paths.state_path));
    payload
}

fn status_cmd(root: &Path, date_arg: &str, cli: &CliArgs) -> Value {
    let policy_path = cli
        .flags
        .get("policy")
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL));
    let paths = runtime_paths(root, &policy_path);

    let key = date_arg.trim().to_ascii_lowercase();
    let payload = if key == "latest" {
        read_json(&paths.latest_path)
    } else {
        read_json(
            &paths
                .runs_dir
                .join(format!("{}.json", clean_text(&key, 16))),
        )
    };

    let mut state = load_doctor_state(&paths);
    prune_history(&mut state, 24, 200_000);

    if !payload.is_object() {
        return json!({
            "ok": false,
            "type": "autotest_doctor_status",
            "error": "autotest_doctor_snapshot_missing",
            "kill_switch": serde_json::to_value(&state.kill_switch).unwrap_or(Value::Null),
            "state_path": rel_path(root, &paths.state_path)
        });
    }

    let mut out = json!({
        "ok": true,
        "type": "autotest_doctor_status",
        "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
        "run_id": payload.get("run_id").cloned().unwrap_or(Value::Null),
        "date": payload.get("date").cloned().unwrap_or(Value::Null),
        "apply": payload.get("apply").and_then(Value::as_bool).unwrap_or(false),
        "skipped": payload.get("skipped").and_then(Value::as_bool).unwrap_or(false),
        "failures_observed": payload.get("failures_observed").and_then(Value::as_u64).unwrap_or(0),
        "actions_planned": payload.get("actions_planned").and_then(Value::as_u64).unwrap_or(0),
        "actions_applied": payload.get("actions_applied").and_then(Value::as_u64).unwrap_or(0),
        "unknown_signature_count": payload.get("unknown_signature_count").and_then(Value::as_u64).unwrap_or(0),
        "unknown_signature_routes": payload.get("unknown_signature_routes").and_then(Value::as_u64).unwrap_or(0),
        "known_signature_candidates": payload.get("known_signature_candidates").and_then(Value::as_u64).unwrap_or(0),
        "known_signature_auto_handled": payload.get("known_signature_auto_handled").and_then(Value::as_u64).unwrap_or(0),
        "known_signature_auto_handle_rate": payload.get("known_signature_auto_handle_rate").and_then(Value::as_f64).unwrap_or(0.0),
        "rollbacks": payload.get("rollbacks").and_then(Value::as_u64).unwrap_or(0),
        "destructive_repair_blocks": payload.get("destructive_repair_blocks").and_then(Value::as_u64).unwrap_or(0),
        "broken_pieces_stored": payload.get("broken_pieces_stored").and_then(Value::as_u64).unwrap_or(0),
        "research_items_stored": payload.get("research_items_stored").and_then(Value::as_u64).unwrap_or(0),
        "kill_switch": serde_json::to_value(&state.kill_switch).unwrap_or(Value::Null),
        "recent_repair_attempts_24h": count_history(&state, "repair_attempt", None),
        "recent_rollbacks_24h": count_history(&state, "repair_rollback", None),
        "recent_unknown_signatures_24h": count_history(&state, "unknown_signature", None),
        "recent_suspicious_signatures_24h": count_history(&state, "suspicious_signature", None),
        "run_path": payload.get("run_path").cloned().unwrap_or(Value::Null),
        "latest_path": rel_path(root, &paths.latest_path),
        "state_path": rel_path(root, &paths.state_path),
        "claim_evidence": [
            {
                "id": "status_snapshot",
                "claim": "doctor_status_reflects_latest_state",
                "evidence": {
                    "recent_repair_attempts_24h": count_history(&state, "repair_attempt", None),
                    "kill_switch_engaged": state.kill_switch.engaged
                }
            }
        ],
        "persona_lenses": {
            "auditor": {
                "kill_switch": state.kill_switch.engaged
            }
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops autotest-doctor run [YYYY-MM-DD|latest] [--policy=path] [--apply=1|0] [--max-actions=N] [--force=1|0] [--reset-kill-switch=1]");
    println!("  protheus-ops autotest-doctor status [latest|YYYY-MM-DD] [--policy=path]");
    println!("  add --legacy-fallback=1 to execute systems/ops/autotest_doctor_legacy.js");
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let (use_legacy, cleaned_argv) =
        split_legacy_fallback_flag(argv, "PROTHEUS_OPS_AUTOTEST_DOCTOR_LEGACY");
    if use_legacy {
        return run_legacy_script(root, LEGACY_SCRIPT_REL, &cleaned_argv, "autotest_doctor");
    }

    let cli = parse_cli(&cleaned_argv);
    let cmd = cli
        .positional
        .first()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();

    if cmd.is_empty() || matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let out = if cmd == "run" {
        run_doctor(
            root,
            cli.positional
                .get(1)
                .map(String::as_str)
                .unwrap_or("latest"),
            &cli,
        )
    } else if cmd == "status" {
        status_cmd(
            root,
            cli.positional
                .get(1)
                .map(String::as_str)
                .unwrap_or("latest"),
            &cli,
        )
    } else {
        usage();
        return 2;
    };

    let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
    print_json_line(&out);
    if ok {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_fixture_classify_failure_kind() {
        let a = json!({"guard_ok": false});
        assert_eq!(classify_failure_kind(&a), "guard_blocked");

        let b = json!({"flaky": true});
        assert_eq!(classify_failure_kind(&b), "flaky");

        let c = json!({"stderr_excerpt": "timed out"});
        assert_eq!(classify_failure_kind(&c), "timeout");

        let d = json!({"exit_code": 2});
        assert_eq!(classify_failure_kind(&d), "exit_nonzero");
    }

    #[test]
    fn parity_fixture_extract_trusted_test_path() {
        let ok = extract_trusted_test_path("node memory/tools/tests/a.test.js");
        assert!(ok.trusted);
        assert_eq!(ok.path.as_deref(), Some("memory/tools/tests/a.test.js"));

        let bad = extract_trusted_test_path("node systems/ops/a.test.js");
        assert!(!bad.trusted);
        assert_eq!(bad.reason.as_deref(), Some("path_outside_allowlist"));
    }

    #[test]
    fn parity_fixture_collect_failures_signature_stable() {
        let fixture = json!({
            "results": [
                {
                    "id": "tst_a",
                    "ok": false,
                    "command": "node memory/tools/tests/a.test.js",
                    "exit_code": 1,
                    "guard_ok": true,
                    "guard_reason": null,
                    "stderr_excerpt": "assertion failed",
                    "stdout_excerpt": ""
                }
            ]
        });
        let failures = collect_failures(&fixture);
        assert_eq!(failures.len(), 1);
        let first = &failures[0];
        assert!(first.signature_id.starts_with("sig_"));
        assert_eq!(first.kind, "exit_nonzero");
        assert!(first.trusted_test_command);
    }

    #[test]
    fn deterministic_receipt_hash_for_fixture() {
        let payload = json!({
            "ok": true,
            "type": "autotest_doctor_status",
            "actions_applied": 2,
            "claim_evidence": [{"id":"c1","claim":"x","evidence":{"a":1}}]
        });
        let h1 = receipt_hash(&payload);
        let h2 = receipt_hash(&payload);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }
}
