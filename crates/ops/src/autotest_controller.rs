use crate::legacy_bridge::{run_legacy_script, split_legacy_fallback_flag};
use crate::now_iso;
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::System;
use walkdir::WalkDir;

const LEGACY_SCRIPT_REL: &str = "systems/ops/autotest_controller_legacy.js";
const DEFAULT_POLICY_REL: &str = "config/autotest_policy.json";

#[derive(Debug, Clone)]
struct CliArgs {
    positional: Vec<String>,
    flags: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct RuntimePaths {
    policy_path: PathBuf,
    state_dir: PathBuf,
    registry_path: PathBuf,
    status_path: PathBuf,
    events_path: PathBuf,
    latest_path: PathBuf,
    reports_dir: PathBuf,
    runs_dir: PathBuf,
    module_root: PathBuf,
    test_root: PathBuf,
    spine_runs_dir: PathBuf,
    pain_signals_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExecPolicy {
    default_scope: String,
    strict: bool,
    max_tests_per_run: usize,
    run_timeout_ms: i64,
    timeout_ms_per_test: i64,
    retry_flaky_once: bool,
    flaky_quarantine_after: u32,
    flaky_quarantine_sec: i64,
    midrun_resource_guard: bool,
    resource_recheck_every_tests: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AlertsPolicy {
    emit_untested: bool,
    emit_changed_without_tests: bool,
    max_untested_in_report: usize,
    max_failed_in_report: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeGuardPolicy {
    spine_hot_window_sec: i64,
    max_rss_mb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Policy {
    version: String,
    enabled: bool,
    strict_default: bool,
    module_include_ext: Vec<String>,
    module_ignore_prefixes: Vec<String>,
    test_include_suffix: String,
    test_ignore_prefixes: Vec<String>,
    min_match_score: i64,
    min_token_len: usize,
    shared_token_score: i64,
    basename_contains_score: i64,
    layer_hint_score: i64,
    explicit_prefix_maps: BTreeMap<String, Vec<String>>,
    critical_commands: Vec<String>,
    execution: ExecPolicy,
    alerts: AlertsPolicy,
    runtime_guard: RuntimeGuardPolicy,
    sleep_window_start_hour: u32,
    sleep_window_end_hour: u32,
    external_health_paths: Vec<String>,
    external_health_window_hours: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SeedFields {
    owner: Option<String>,
    priority: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct GuardMeta {
    ok: bool,
    reason: Option<String>,
    files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ModuleRow {
    id: String,
    path: String,
    fingerprint: String,
    checked: bool,
    changed: bool,
    is_new: bool,
    untested: bool,
    mapped_test_ids: Vec<String>,
    mapped_test_count: usize,
    last_change_ts: Option<String>,
    last_test_ts: Option<String>,
    last_pass_ts: Option<String>,
    last_fail_ts: Option<String>,
    seed_fields: SeedFields,
    health_state: Option<String>,
    health_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TestRow {
    id: String,
    kind: String,
    path: Option<String>,
    command: String,
    critical: bool,
    last_status: String,
    last_exit_code: Option<i32>,
    last_run_ts: Option<String>,
    last_duration_ms: Option<u128>,
    last_stdout_excerpt: Option<String>,
    last_stderr_excerpt: Option<String>,
    last_guard: Option<GuardMeta>,
    last_retry_count: Option<u32>,
    last_flaky: Option<bool>,
    consecutive_flaky: Option<u32>,
    quarantined_until_ts: Option<String>,
    last_pass_ts: Option<String>,
    last_fail_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AlertState {
    emitted_signatures: HashMap<String, String>,
    latest: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StatusState {
    version: String,
    updated_at: Option<String>,
    modules: HashMap<String, ModuleRow>,
    tests: HashMap<String, TestRow>,
    alerts: AlertState,
    last_sync: Option<String>,
    last_run: Option<String>,
    last_report: Option<String>,
}

#[derive(Debug, Clone)]
struct ModuleCandidate {
    id: String,
    path: String,
    abs_path: PathBuf,
    basename: String,
}

#[derive(Debug, Clone)]
struct TestCandidate {
    id: String,
    kind: String,
    path: String,
    command: String,
    stem: String,
}

#[derive(Debug, Clone, Default)]
struct GuardResult {
    ok: bool,
    reason: Option<String>,
    files: Vec<String>,
    stderr_excerpt: Option<String>,
    stdout_excerpt: Option<String>,
    duration_ms: u128,
}

#[derive(Debug, Clone)]
struct CommandResult {
    ok: bool,
    exit_code: i32,
    signal: Option<String>,
    timed_out: bool,
    duration_ms: u128,
    stdout_excerpt: String,
    stderr_excerpt: String,
}

#[derive(Debug, Clone)]
struct PrioritizedTest {
    id: String,
    score: i64,
    priority: String,
    test: TestRow,
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

fn short_text(v: &str, max: usize) -> String {
    let compact = v
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    if compact.len() <= max {
        compact
    } else {
        format!("{}...", &compact[..max])
    }
}

fn stable_hash(seed: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

fn stable_id(seed: &str, prefix: &str) -> String {
    format!("{}_{}", prefix, stable_hash(seed, 14))
}

fn rel_path(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
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

fn default_policy() -> Policy {
    Policy {
        version: "1.0".to_string(),
        enabled: true,
        strict_default: true,
        module_include_ext: vec![".ts".to_string()],
        module_ignore_prefixes: vec!["systems/ops/visualizer/".to_string()],
        test_include_suffix: ".test.js".to_string(),
        test_ignore_prefixes: Vec::new(),
        min_match_score: 4,
        min_token_len: 4,
        shared_token_score: 2,
        basename_contains_score: 4,
        layer_hint_score: 2,
        explicit_prefix_maps: BTreeMap::from([
            (
                "systems/security/".to_string(),
                vec![
                    "memory/tools/tests/security_integrity.test.js".to_string(),
                    "memory/tools/tests/guard_remote_gate.test.js".to_string(),
                    "memory/tools/tests/directive_gate.test.js".to_string(),
                ],
            ),
            (
                "systems/spine/".to_string(),
                vec!["memory/tools/tests/spine_evidence_run_plan.test.js".to_string()],
            ),
        ]),
        critical_commands: vec![
            "node systems/ops/typecheck_systems.js".to_string(),
            "node systems/ops/ts_clone_drift_guard.js --baseline=config/ts_clone_drift_baseline.json"
                .to_string(),
            "node systems/spine/contract_check.js".to_string(),
        ],
        execution: ExecPolicy {
            default_scope: "changed".to_string(),
            strict: false,
            max_tests_per_run: 25,
            run_timeout_ms: 300_000,
            timeout_ms_per_test: 180_000,
            retry_flaky_once: true,
            flaky_quarantine_after: 3,
            flaky_quarantine_sec: 3_600,
            midrun_resource_guard: true,
            resource_recheck_every_tests: 1,
        },
        alerts: AlertsPolicy {
            emit_untested: true,
            emit_changed_without_tests: true,
            max_untested_in_report: 40,
            max_failed_in_report: 40,
        },
        runtime_guard: RuntimeGuardPolicy {
            spine_hot_window_sec: 1_200,
            max_rss_mb: 8_192.0,
        },
        sleep_window_start_hour: 0,
        sleep_window_end_hour: 7,
        external_health_paths: Vec::new(),
        external_health_window_hours: 24,
    }
}

fn runtime_paths(root: &Path) -> RuntimePaths {
    let state_dir = std::env::var("AUTOTEST_STATE_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| root.join("state/ops/autotest"));

    let default_pain_signals_path = root.join("state/autonomy/pain_signals.jsonl");

    RuntimePaths {
        policy_path: std::env::var("AUTOTEST_POLICY_PATH")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL)),
        state_dir: state_dir.clone(),
        registry_path: state_dir.join("registry.json"),
        status_path: state_dir.join("status.json"),
        events_path: state_dir.join("events.jsonl"),
        latest_path: state_dir.join("latest.json"),
        reports_dir: state_dir.join("reports"),
        runs_dir: state_dir.join("runs"),
        module_root: std::env::var("AUTOTEST_MODULE_ROOT")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| root.join("systems")),
        test_root: std::env::var("AUTOTEST_TEST_ROOT")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| root.join("memory/tools/tests")),
        spine_runs_dir: std::env::var("AUTOTEST_SPINE_RUNS_DIR")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| root.join("state/spine/runs")),
        pain_signals_path: std::env::var("AUTOTEST_PAIN_SIGNALS_PATH")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or(default_pain_signals_path),
    }
}

fn load_policy(root: &Path, policy_path: &Path) -> Policy {
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
    out.strict_default = raw
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(out.strict_default);

    if let Some(module_discovery) = raw.get("module_discovery") {
        out.module_include_ext = module_discovery
            .get("include_ext")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|rows| !rows.is_empty())
            .unwrap_or_else(|| out.module_include_ext.clone());
        out.module_ignore_prefixes = module_discovery
            .get("ignore_prefixes")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| out.module_ignore_prefixes.clone());
    }

    if let Some(test_discovery) = raw.get("test_discovery") {
        if let Some(sfx) = test_discovery.get("include_suffix").and_then(Value::as_str) {
            let sfx = sfx.trim();
            if !sfx.is_empty() {
                out.test_include_suffix = sfx.to_string();
            }
        }
        out.test_ignore_prefixes = test_discovery
            .get("ignore_prefixes")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| out.test_ignore_prefixes.clone());
    }

    if let Some(heuristics) = raw.get("heuristics") {
        out.min_match_score = heuristics
            .get("min_match_score")
            .and_then(Value::as_i64)
            .unwrap_or(out.min_match_score);
        out.min_token_len = heuristics
            .get("min_token_len")
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(out.min_token_len);
        out.shared_token_score = heuristics
            .get("shared_token_score")
            .and_then(Value::as_i64)
            .unwrap_or(out.shared_token_score);
        out.basename_contains_score = heuristics
            .get("basename_contains_score")
            .and_then(Value::as_i64)
            .unwrap_or(out.basename_contains_score);
        out.layer_hint_score = heuristics
            .get("layer_hint_score")
            .and_then(Value::as_i64)
            .unwrap_or(out.layer_hint_score);
    }

    if let Some(explicit_maps) = raw
        .get("explicit_maps")
        .and_then(|v| v.get("by_prefix"))
        .and_then(Value::as_object)
    {
        let mut maps = BTreeMap::new();
        for (k, v) in explicit_maps {
            let rows = v
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            maps.insert(k.to_string(), rows);
        }
        out.explicit_prefix_maps = maps;
    }

    if let Some(commands) = raw.get("critical_commands").and_then(Value::as_array) {
        let rows = commands
            .iter()
            .filter_map(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if !rows.is_empty() {
            out.critical_commands = rows;
        }
    }

    if let Some(execution) = raw.get("execution") {
        out.execution.default_scope = execution
            .get("default_scope")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .filter(|s| ["critical", "changed", "all"].contains(&s.as_str()))
            .unwrap_or_else(|| out.execution.default_scope.clone());
        out.execution.strict = execution
            .get("strict")
            .and_then(Value::as_bool)
            .unwrap_or(out.execution.strict);
        out.execution.max_tests_per_run = execution
            .get("max_tests_per_run")
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(out.execution.max_tests_per_run)
            .clamp(1, 500);
        out.execution.run_timeout_ms = execution
            .get("run_timeout_ms")
            .and_then(Value::as_i64)
            .unwrap_or(out.execution.run_timeout_ms)
            .clamp(1_000, 2 * 60 * 60 * 1_000);
        out.execution.timeout_ms_per_test = execution
            .get("timeout_ms_per_test")
            .and_then(Value::as_i64)
            .unwrap_or(out.execution.timeout_ms_per_test)
            .clamp(1_000, 2 * 60 * 60 * 1_000);
        out.execution.retry_flaky_once = execution
            .get("retry_flaky_once")
            .and_then(Value::as_bool)
            .unwrap_or(out.execution.retry_flaky_once);
        out.execution.flaky_quarantine_after = execution
            .get("flaky_quarantine_after")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.execution.flaky_quarantine_after);
        out.execution.flaky_quarantine_sec = execution
            .get("flaky_quarantine_sec")
            .and_then(Value::as_i64)
            .unwrap_or(out.execution.flaky_quarantine_sec)
            .clamp(0, 7 * 24 * 60 * 60);
        out.execution.midrun_resource_guard = execution
            .get("midrun_resource_guard")
            .and_then(Value::as_bool)
            .unwrap_or(out.execution.midrun_resource_guard);
        out.execution.resource_recheck_every_tests = execution
            .get("resource_recheck_every_tests")
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(out.execution.resource_recheck_every_tests)
            .clamp(1, 256);
    }

    if let Some(alerts) = raw.get("alerts") {
        out.alerts.emit_untested = alerts
            .get("emit_untested")
            .and_then(Value::as_bool)
            .unwrap_or(out.alerts.emit_untested);
        out.alerts.emit_changed_without_tests = alerts
            .get("emit_changed_without_tests")
            .and_then(Value::as_bool)
            .unwrap_or(out.alerts.emit_changed_without_tests);
        out.alerts.max_untested_in_report = alerts
            .get("max_untested_in_report")
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(out.alerts.max_untested_in_report)
            .clamp(1, 400);
        out.alerts.max_failed_in_report = alerts
            .get("max_failed_in_report")
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(out.alerts.max_failed_in_report)
            .clamp(1, 400);
    }

    if let Some(runtime_guard) = raw.get("runtime_guard") {
        out.runtime_guard.spine_hot_window_sec = runtime_guard
            .get("spine_hot_window_sec")
            .and_then(Value::as_i64)
            .unwrap_or(out.runtime_guard.spine_hot_window_sec)
            .clamp(5, 24 * 60 * 60);
        out.runtime_guard.max_rss_mb = runtime_guard
            .get("max_rss_mb")
            .and_then(Value::as_f64)
            .unwrap_or(out.runtime_guard.max_rss_mb)
            .clamp(256.0, 256_000.0);
    }

    if let Some(sleep_cfg) = raw.get("sleep_window_local") {
        out.sleep_window_start_hour = sleep_cfg
            .get("start_hour")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.sleep_window_start_hour)
            .clamp(0, 23);
        out.sleep_window_end_hour = sleep_cfg
            .get("end_hour")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(out.sleep_window_end_hour)
            .clamp(0, 23);
    }

    if let Some(ext) = raw.get("external_health") {
        out.external_health_paths = ext
            .get("sources")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|v| {
                        if let Some(p) = v.get("path").and_then(Value::as_str) {
                            return Some(p.trim().to_string());
                        }
                        v.as_str().map(|s| s.trim().to_string())
                    })
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| out.external_health_paths.clone());
        out.external_health_window_hours = ext
            .get("window_hours")
            .and_then(Value::as_i64)
            .unwrap_or(out.external_health_window_hours)
            .clamp(1, 24 * 30);
    }

    let _ = root;
    out
}

fn ensure_state_dirs(paths: &RuntimePaths) -> Result<(), String> {
    ensure_dir(&paths.state_dir)?;
    ensure_dir(&paths.reports_dir)?;
    ensure_dir(&paths.runs_dir)?;
    if let Some(parent) = paths.events_path.parent() {
        ensure_dir(parent)?;
    }
    if let Some(parent) = paths.latest_path.parent() {
        ensure_dir(parent)?;
    }
    if let Some(parent) = paths.registry_path.parent() {
        ensure_dir(parent)?;
    }
    if let Some(parent) = paths.status_path.parent() {
        ensure_dir(parent)?;
    }
    Ok(())
}

fn load_status(paths: &RuntimePaths) -> StatusState {
    let raw = read_json(&paths.status_path);
    serde_json::from_value::<StatusState>(raw).unwrap_or_else(|_| StatusState {
        version: "1.0".to_string(),
        updated_at: None,
        modules: HashMap::new(),
        tests: HashMap::new(),
        alerts: AlertState::default(),
        last_sync: None,
        last_run: None,
        last_report: None,
    })
}

fn list_files_recursively(root_dir: &Path) -> Vec<PathBuf> {
    if !root_dir.exists() {
        return Vec::new();
    }
    WalkDir::new(root_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .collect()
}

fn should_ignore_rel(rel: &str, ignore_prefixes: &[String]) -> bool {
    ignore_prefixes.iter().any(|prefix| rel.starts_with(prefix))
}

fn sha256_file(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => stable_hash(&String::from_utf8_lossy(&bytes), 64),
        Err(_) => stable_hash("missing", 64),
    }
}

fn module_candidates(root: &Path, paths: &RuntimePaths, policy: &Policy) -> Vec<ModuleCandidate> {
    let mut out = Vec::new();
    for abs in list_files_recursively(&paths.module_root) {
        let rel = rel_path(root, &abs);
        if should_ignore_rel(&rel, &policy.module_ignore_prefixes) {
            continue;
        }
        if !policy
            .module_include_ext
            .iter()
            .any(|ext| rel.ends_with(ext.as_str()))
        {
            continue;
        }
        let path_name = rel.clone();
        let base = abs
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(ModuleCandidate {
            id: stable_id(&format!("mod|{path_name}"), "mod"),
            path: path_name,
            abs_path: abs,
            basename: base,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn test_candidates(root: &Path, paths: &RuntimePaths, policy: &Policy) -> Vec<TestCandidate> {
    let mut out = Vec::new();
    for abs in list_files_recursively(&paths.test_root) {
        let rel = rel_path(root, &abs);
        if should_ignore_rel(&rel, &policy.test_ignore_prefixes) {
            continue;
        }
        if !rel.ends_with(&policy.test_include_suffix) {
            continue;
        }
        let stem = abs
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(TestCandidate {
            id: stable_id(&format!("tst|{rel}"), "tst"),
            kind: "node_test".to_string(),
            path: rel.clone(),
            command: format!("node {rel}"),
            stem,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn tokenize_name(v: &str, min_len: usize) -> Vec<String> {
    v.split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(|s| normalize_token(s, 120))
        .filter(|s| !s.is_empty() && s.len() >= min_len)
        .collect()
}

fn layer_hint(rel: &str) -> String {
    let parts = rel.split('/').collect::<Vec<_>>();
    if parts.len() >= 3 && parts[0] == "systems" {
        normalize_token(parts[1], 64)
    } else if parts.len() >= 2 {
        normalize_token(parts[0], 64)
    } else {
        String::new()
    }
}

fn score_module_test_pair(module: &ModuleCandidate, test: &TestCandidate, policy: &Policy) -> i64 {
    let module_base = normalize_token(&module.basename, 120);
    let test_stem = normalize_token(&test.stem, 180);
    let mut score = 0i64;

    if test_stem.contains(&module_base) || module_base.contains(&test_stem) {
        score += policy.basename_contains_score;
    }

    let module_tokens = tokenize_name(&module_base, policy.min_token_len);
    let test_tokens = tokenize_name(&test_stem, policy.min_token_len)
        .into_iter()
        .collect::<HashSet<_>>();
    for tok in module_tokens {
        if test_tokens.contains(&tok) {
            score += policy.shared_token_score;
        }
    }

    let mod_layer = layer_hint(&module.path);
    if !mod_layer.is_empty() && test_stem.contains(&mod_layer) {
        score += policy.layer_hint_score;
    }

    score
}

fn map_module_tests(
    modules: &[ModuleCandidate],
    tests: &[TestCandidate],
    policy: &Policy,
) -> HashMap<String, Vec<String>> {
    let by_path = tests
        .iter()
        .map(|t| (t.path.clone(), t.id.clone()))
        .collect::<HashMap<_, _>>();

    let mut mapping = HashMap::new();
    for module in modules {
        let mut test_ids = HashSet::new();

        for (prefix, test_paths) in &policy.explicit_prefix_maps {
            if !module.path.starts_with(prefix) {
                continue;
            }
            for test_path in test_paths {
                if let Some(id) = by_path.get(test_path) {
                    test_ids.insert(id.clone());
                }
            }
        }

        for test in tests {
            let score = score_module_test_pair(module, test, policy);
            if score >= policy.min_match_score {
                test_ids.insert(test.id.clone());
            }
        }

        let mut ids = test_ids.into_iter().collect::<Vec<_>>();
        ids.sort();
        mapping.insert(module.path.clone(), ids);
    }

    mapping
}

fn emit_alerts(paths: &RuntimePaths, status: &mut StatusState, alerts: Vec<Value>) -> Vec<Value> {
    let mut emitted = Vec::new();
    for alert in alerts {
        let signature = alert
            .get("signature")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if signature.is_empty() {
            continue;
        }
        if status.alerts.emitted_signatures.contains_key(&signature) {
            continue;
        }
        status
            .alerts
            .emitted_signatures
            .insert(signature, now_iso());
        let _ = append_jsonl(&paths.events_path, &alert);
        emitted.push(alert);
    }
    status.alerts.latest = emitted.iter().take(200).cloned().collect();
    emitted
}

fn update_module_check_states(status: &mut StatusState) {
    let test_map = status.tests.clone();
    for module in status.modules.values_mut() {
        let ids = module.mapped_test_ids.clone();
        let all_pass = !ids.is_empty()
            && ids.iter().all(|id| {
                test_map
                    .get(id)
                    .map(|t| t.last_status == "pass")
                    .unwrap_or(false)
            });
        let has_fail = ids.iter().any(|id| {
            test_map.get(id).is_some_and(|t| {
                t.last_status == "fail" || t.last_guard.as_ref().map(|g| !g.ok).unwrap_or(false)
            })
        });

        module.checked = all_pass && !module.changed;
        module.untested = ids.is_empty();
        if module.checked && module.last_pass_ts.is_none() {
            module.last_pass_ts = Some(now_iso());
        }

        if module.untested {
            module.health_state = Some("untested".to_string());
            module.health_reason = Some("no_mapped_tests".to_string());
        } else if has_fail {
            module.health_state = Some("red".to_string());
            module.health_reason = Some("failing_or_guard_blocked_test".to_string());
        } else if module.changed {
            module.health_state = Some("pending".to_string());
            module.health_reason = Some("changed_waiting_for_fresh_pass".to_string());
        } else if module.checked {
            module.health_state = Some("green".to_string());
            module.health_reason = Some("all_mapped_tests_passing".to_string());
        } else {
            module.health_state = Some("yellow".to_string());
            module.health_reason = Some("partial_or_stale_coverage".to_string());
        }
    }
}

fn sync_state(root: &Path, paths: &RuntimePaths, policy: &Policy) -> Value {
    let prev = load_status(paths);
    let modules = module_candidates(root, paths, policy);
    let tests = test_candidates(root, paths, policy);
    let mapping = map_module_tests(&modules, &tests, policy);
    let now = now_iso();

    let mut next_modules = HashMap::<String, ModuleRow>::new();
    let mut alerts = Vec::<Value>::new();

    let mut changed_count = 0usize;
    let mut new_count = 0usize;
    let mut untested_count = 0usize;

    for module in &modules {
        let fp = sha256_file(&module.abs_path);
        let prev_row = prev.modules.get(&module.path);
        let mapped_tests = mapping.get(&module.path).cloned().unwrap_or_default();
        let has_tests = !mapped_tests.is_empty();
        let is_new = prev_row.is_none();
        let fingerprint_changed = prev_row.map(|r| r.fingerprint != fp).unwrap_or(true);
        let pending_prior = prev_row.map(|r| r.changed && !r.checked).unwrap_or(false);
        let changed = fingerprint_changed || pending_prior;

        if is_new {
            new_count += 1;
        }
        if changed {
            changed_count += 1;
        }
        if !has_tests {
            untested_count += 1;
        }

        let checked = if changed {
            false
        } else {
            prev_row
                .map(|r| r.checked && r.mapped_test_count == mapped_tests.len())
                .unwrap_or(false)
        };

        let row = ModuleRow {
            id: prev_row
                .map(|r| r.id.clone())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| module.id.clone()),
            path: module.path.clone(),
            fingerprint: fp.clone(),
            checked,
            changed,
            is_new,
            untested: !has_tests,
            mapped_test_ids: mapped_tests.clone(),
            mapped_test_count: mapped_tests.len(),
            last_change_ts: if fingerprint_changed {
                Some(now.clone())
            } else {
                prev_row.and_then(|r| r.last_change_ts.clone())
            },
            last_test_ts: prev_row.and_then(|r| r.last_test_ts.clone()),
            last_pass_ts: prev_row.and_then(|r| r.last_pass_ts.clone()),
            last_fail_ts: prev_row.and_then(|r| r.last_fail_ts.clone()),
            seed_fields: SeedFields {
                owner: prev_row.and_then(|r| r.seed_fields.owner.clone()),
                priority: prev_row
                    .and_then(|r| r.seed_fields.priority.clone())
                    .or_else(|| Some("normal".to_string())),
                notes: prev_row.and_then(|r| r.seed_fields.notes.clone()),
            },
            health_state: prev_row.and_then(|r| r.health_state.clone()),
            health_reason: prev_row.and_then(|r| r.health_reason.clone()),
        };

        if policy.alerts.emit_untested && !has_tests {
            let should_emit = is_new
                || (policy.alerts.emit_changed_without_tests && changed)
                || prev_row.map(|r| !r.untested).unwrap_or(true);
            if should_emit {
                alerts.push(json!({
                    "ts": now,
                    "type": "autotest_alert",
                    "severity": "warn",
                    "alert_kind": "untested_module",
                    "module_path": module.path,
                    "reason": if changed { "changed_module_without_tests" } else { "module_without_tests" },
                    "signature": stable_id(&format!("untested|{}|{}", module.path, fp), "alert")
                }));
            }
        }

        next_modules.insert(module.path.clone(), row);
    }

    let mut next_tests = HashMap::<String, TestRow>::new();
    for test in &tests {
        let prev_row = prev.tests.get(&test.id);
        next_tests.insert(
            test.id.clone(),
            TestRow {
                id: test.id.clone(),
                kind: test.kind.clone(),
                path: Some(test.path.clone()),
                command: test.command.clone(),
                critical: false,
                last_status: prev_row
                    .map(|r| r.last_status.clone())
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| "untested".to_string()),
                last_exit_code: prev_row.and_then(|r| r.last_exit_code),
                last_run_ts: prev_row.and_then(|r| r.last_run_ts.clone()),
                last_duration_ms: prev_row.and_then(|r| r.last_duration_ms),
                last_stdout_excerpt: prev_row.and_then(|r| r.last_stdout_excerpt.clone()),
                last_stderr_excerpt: prev_row.and_then(|r| r.last_stderr_excerpt.clone()),
                last_guard: prev_row.and_then(|r| r.last_guard.clone()),
                last_retry_count: prev_row.and_then(|r| r.last_retry_count),
                last_flaky: prev_row.and_then(|r| r.last_flaky),
                consecutive_flaky: prev_row.and_then(|r| r.consecutive_flaky),
                quarantined_until_ts: prev_row.and_then(|r| r.quarantined_until_ts.clone()),
                last_pass_ts: prev_row.and_then(|r| r.last_pass_ts.clone()),
                last_fail_ts: prev_row.and_then(|r| r.last_fail_ts.clone()),
            },
        );
    }

    for command in &policy.critical_commands {
        let id = stable_id(&format!("critical|{command}"), "tst");
        let prev_row = prev.tests.get(&id);
        next_tests.insert(
            id.clone(),
            TestRow {
                id,
                kind: "shell_command".to_string(),
                path: None,
                command: command.clone(),
                critical: true,
                last_status: prev_row
                    .map(|r| r.last_status.clone())
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| "untested".to_string()),
                last_exit_code: prev_row.and_then(|r| r.last_exit_code),
                last_run_ts: prev_row.and_then(|r| r.last_run_ts.clone()),
                last_duration_ms: prev_row.and_then(|r| r.last_duration_ms),
                last_stdout_excerpt: prev_row.and_then(|r| r.last_stdout_excerpt.clone()),
                last_stderr_excerpt: prev_row.and_then(|r| r.last_stderr_excerpt.clone()),
                last_guard: prev_row.and_then(|r| r.last_guard.clone()),
                last_retry_count: prev_row.and_then(|r| r.last_retry_count),
                last_flaky: prev_row.and_then(|r| r.last_flaky),
                consecutive_flaky: prev_row.and_then(|r| r.consecutive_flaky),
                quarantined_until_ts: prev_row.and_then(|r| r.quarantined_until_ts.clone()),
                last_pass_ts: prev_row.and_then(|r| r.last_pass_ts.clone()),
                last_fail_ts: prev_row.and_then(|r| r.last_fail_ts.clone()),
            },
        );
    }

    let registry = json!({
        "ok": true,
        "type": "autotest_registry",
        "ts": now,
        "policy_version": policy.version,
        "module_root": rel_path(root, &paths.module_root),
        "test_root": rel_path(root, &paths.test_root),
        "modules": modules.iter().map(|m| json!({
            "id": m.id,
            "path": m.path,
            "mapped_test_ids": mapping.get(&m.path).cloned().unwrap_or_default()
        })).collect::<Vec<_>>(),
        "tests": next_tests.values().map(|t| json!({
            "id": t.id,
            "kind": t.kind,
            "path": t.path,
            "command": t.command,
            "critical": t.critical
        })).collect::<Vec<_>>()
    });

    let mut next_status = StatusState {
        version: "1.0".to_string(),
        updated_at: Some(now.clone()),
        modules: next_modules,
        tests: next_tests,
        alerts: prev.alerts,
        last_sync: Some(now.clone()),
        last_run: prev.last_run,
        last_report: prev.last_report,
    };
    update_module_check_states(&mut next_status);

    let emitted_alerts = emit_alerts(paths, &mut next_status, alerts);

    let _ = write_json_atomic(&paths.registry_path, &registry);
    let _ = write_json_atomic(
        &paths.status_path,
        &serde_json::to_value(&next_status).unwrap_or(Value::Null),
    );

    let claims = vec![
        json!({
            "id": "modules_scanned",
            "claim": "module_registry_is_current",
            "evidence": {
                "modules": modules.len(),
                "changed_modules": changed_count,
                "new_modules": new_count
            }
        }),
        json!({
            "id": "mapping_computed",
            "claim": "module_to_test_mapping_available",
            "evidence": {
                "tests_discovered": next_status.tests.len(),
                "untested_modules": untested_count
            }
        }),
    ];

    let persona_lenses = json!({
        "operator": {
            "focus": if untested_count > 0 { "coverage_gap" } else { "execution" },
            "risk_level": if untested_count > 0 { "medium" } else { "low" }
        },
        "auditor": {
            "alerts_emitted": emitted_alerts.len(),
            "deterministic_registry": true
        }
    });

    let mut out = json!({
        "ok": true,
        "type": "autotest_sync",
        "ts": now,
        "changed_modules": changed_count,
        "new_modules": new_count,
        "untested_modules": untested_count,
        "tests_discovered": next_status.tests.len(),
        "emitted_alerts": emitted_alerts.len(),
        "registry_path": rel_path(root, &paths.registry_path),
        "status_path": rel_path(root, &paths.status_path),
        "claim_evidence": claims,
        "persona_lenses": persona_lenses
    });
    let hash = receipt_hash(&out);
    out["receipt_hash"] = Value::String(hash);

    let _ = write_json_atomic(&paths.latest_path, &out);
    let _ = append_jsonl(
        &paths.runs_dir.join(format!("{}.jsonl", &now[..10])),
        &json!({
            "ts": now,
            "type": "autotest_sync",
            "changed_modules": changed_count,
            "new_modules": new_count,
            "untested_modules": untested_count,
            "emitted_alerts": emitted_alerts.len(),
            "receipt_hash": out.get("receipt_hash").cloned().unwrap_or(Value::Null)
        }),
    );

    out
}

fn in_sleep_window(policy: &Policy) -> bool {
    let hour = chrono::Local::now().hour();
    let start = policy.sleep_window_start_hour;
    let end = policy.sleep_window_end_hour;
    if start == end {
        return true;
    }
    if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

fn runtime_resource_within(policy: &Policy) -> Value {
    let mut system = System::new_all();
    system.refresh_memory();
    let rss_mb = (system.used_memory() as f64) / 1024.0;
    let ok = rss_mb <= policy.runtime_guard.max_rss_mb;
    json!({
        "ok": ok,
        "rss_mb": ((rss_mb * 100.0).round() / 100.0),
        "max_rss_mb": policy.runtime_guard.max_rss_mb,
        "reason": if ok { Value::Null } else { Value::String("rss_limit_exceeded".to_string()) }
    })
}

fn is_spine_hot(paths: &RuntimePaths, window_sec: i64) -> Value {
    let today = &now_iso()[..10];
    let file = paths.spine_runs_dir.join(format!("{today}.jsonl"));
    if !file.exists() {
        return json!({ "hot": false, "reason": "spine_ledger_missing" });
    }
    let mut latest_started_ms = None::<i64>;
    let mut latest_terminal_ms = None::<i64>;
    for row in read_jsonl(&file) {
        let typ = row.get("type").and_then(Value::as_str).unwrap_or_default();
        let ts_ms = row
            .get("ts")
            .and_then(Value::as_str)
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.timestamp_millis());
        if typ == "spine_run_started" {
            latest_started_ms = ts_ms.or(latest_started_ms);
        }
        if typ == "spine_run_complete" || typ == "spine_run_failed" {
            latest_terminal_ms = ts_ms.or(latest_terminal_ms);
        }
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let hot = latest_started_ms
        .map(|started| {
            let age_sec = (now_ms - started) / 1000;
            if age_sec > window_sec {
                return false;
            }
            latest_terminal_ms.map(|end| end < started).unwrap_or(true)
        })
        .unwrap_or(false);
    json!({
        "hot": hot,
        "window_sec": window_sec,
        "last_started_ms": latest_started_ms,
        "last_terminal_ms": latest_terminal_ms
    })
}

fn run_shell_command(root: &Path, command: &str, timeout_ms: i64) -> CommandResult {
    let start = Instant::now();
    let mut child = match Command::new("sh")
        .arg("-lc")
        .arg(command)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(err) => {
            return CommandResult {
                ok: false,
                exit_code: 1,
                signal: None,
                timed_out: false,
                duration_ms: start.elapsed().as_millis(),
                stdout_excerpt: String::new(),
                stderr_excerpt: short_text(&format!("spawn_failed:{err}"), 800),
            }
        }
    };

    let timeout = Duration::from_millis(timeout_ms.max(1000) as u64);
    let mut timed_out = false;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(15));
            }
            Err(err) => {
                return CommandResult {
                    ok: false,
                    exit_code: 1,
                    signal: None,
                    timed_out: false,
                    duration_ms: start.elapsed().as_millis(),
                    stdout_excerpt: String::new(),
                    stderr_excerpt: short_text(&format!("wait_failed:{err}"), 800),
                }
            }
        }
    }

    let output = child.wait_with_output();
    match output {
        Ok(out) => {
            let code = out.status.code().unwrap_or(1);
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            CommandResult {
                ok: !timed_out && code == 0,
                exit_code: code,
                signal: None,
                timed_out,
                duration_ms: start.elapsed().as_millis(),
                stdout_excerpt: short_text(&stdout, 800),
                stderr_excerpt: short_text(&stderr, 800),
            }
        }
        Err(err) => CommandResult {
            ok: false,
            exit_code: 1,
            signal: None,
            timed_out,
            duration_ms: start.elapsed().as_millis(),
            stdout_excerpt: String::new(),
            stderr_excerpt: short_text(&format!("output_failed:{err}"), 800),
        },
    }
}

fn command_path_hints(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(|tok| tok.trim_matches('"').trim_matches('\''))
        .filter(|tok| {
            (tok.starts_with("systems/") || tok.starts_with("memory/tools/tests/"))
                && (tok.ends_with(".js") || tok.ends_with(".ts"))
        })
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
}

fn normalize_guard_file_list(files: &[String]) -> Vec<String> {
    let mut uniq = HashSet::new();
    let mut out = Vec::new();
    for file in files {
        let clean = file.trim().replace('\\', "/");
        if clean.is_empty() || clean.contains("..") {
            continue;
        }
        if uniq.insert(clean.clone()) {
            out.push(clean);
        }
    }
    out.sort();
    out
}

fn run_guard_for_files(root: &Path, files: &[String]) -> GuardResult {
    if files.is_empty() {
        return GuardResult {
            ok: true,
            reason: None,
            files: Vec::new(),
            stderr_excerpt: None,
            stdout_excerpt: None,
            duration_ms: 0,
        };
    }
    let guard_path = root.join("systems/security/guard.js");
    if !guard_path.exists() {
        return GuardResult {
            ok: true,
            reason: Some("guard_missing_fail_open".to_string()),
            files: files.to_vec(),
            stderr_excerpt: None,
            stdout_excerpt: None,
            duration_ms: 0,
        };
    }

    let start = Instant::now();
    let run = Command::new("node")
        .arg(guard_path)
        .arg(format!("--files={}", files.join(",")))
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    match run {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            GuardResult {
                ok: out.status.success(),
                reason: if out.status.success() {
                    None
                } else {
                    Some("guard_blocked".to_string())
                },
                files: files.to_vec(),
                stderr_excerpt: Some(short_text(&stderr, 400)),
                stdout_excerpt: Some(short_text(&stdout, 400)),
                duration_ms: start.elapsed().as_millis(),
            }
        }
        Err(err) => GuardResult {
            ok: false,
            reason: Some(format!("guard_exec_failed:{err}")),
            files: files.to_vec(),
            stderr_excerpt: None,
            stdout_excerpt: None,
            duration_ms: start.elapsed().as_millis(),
        },
    }
}

fn reverse_module_mapping(status: &StatusState) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::<String, Vec<String>>::new();
    for module in status.modules.values() {
        for test_id in &module.mapped_test_ids {
            out.entry(test_id.clone())
                .or_default()
                .push(module.path.clone());
        }
    }
    out
}

fn test_set_for_scope(status: &StatusState, scope: &str) -> HashSet<String> {
    let mut selected = HashSet::new();
    match scope {
        "all" => {
            selected.extend(status.tests.keys().cloned());
        }
        "critical" => {
            for test in status.tests.values() {
                if test.critical {
                    selected.insert(test.id.clone());
                }
            }
        }
        _ => {
            for module in status.modules.values() {
                if module.changed {
                    for id in &module.mapped_test_ids {
                        selected.insert(id.clone());
                    }
                }
            }
            for test in status.tests.values() {
                if test.critical {
                    selected.insert(test.id.clone());
                }
            }
        }
    }
    selected
}

fn module_stale_ms(module: &ModuleRow, now_ms: i64) -> i64 {
    let last_test_ms = module
        .last_test_ts
        .as_deref()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.timestamp_millis())
        .unwrap_or(0);
    (now_ms - last_test_ms).max(0)
}

fn prioritize_tests(status: &StatusState, test_ids: &HashSet<String>) -> Vec<PrioritizedTest> {
    let reverse = reverse_module_mapping(status);
    let now_ms = chrono::Utc::now().timestamp_millis();

    let mut out = Vec::new();
    for id in test_ids {
        let Some(test) = status.tests.get(id).cloned() else {
            continue;
        };
        let mapped_modules = reverse.get(id).cloned().unwrap_or_default();
        let mut score = 0i64;
        let mut priority = "normal".to_string();

        if test.critical {
            score += 100;
            priority = "critical".to_string();
        }
        if test.last_status == "fail" {
            score += 40;
            priority = "high".to_string();
        }
        if test.last_status == "untested" {
            score += 30;
        }

        let mut changed_count = 0i64;
        let mut stale_score = 0i64;
        for module_path in mapped_modules {
            if let Some(module) = status.modules.get(&module_path) {
                if module.changed {
                    changed_count += 1;
                }
                stale_score += (module_stale_ms(module, now_ms) / 1000).min(300);
            }
        }
        score += changed_count * 20;
        score += stale_score.min(120);

        out.push(PrioritizedTest {
            id: id.clone(),
            score,
            priority,
            test,
        });
    }

    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.id.cmp(&b.id))
            .then_with(|| a.test.command.cmp(&b.test.command))
    });
    out
}

fn summarize_external_health(paths: &RuntimePaths, policy: &Policy) -> Value {
    let mut sources = Vec::<PathBuf>::new();
    if !policy.external_health_paths.is_empty() {
        for raw in &policy.external_health_paths {
            let p = PathBuf::from(raw);
            sources.push(if p.is_absolute() {
                p
            } else {
                paths
                    .state_dir
                    .parent()
                    .unwrap_or(paths.state_dir.as_path())
                    .join(p)
            });
        }
    } else {
        sources.push(paths.pain_signals_path.clone());
    }

    let since_ms = chrono::Utc::now().timestamp_millis()
        - (policy.external_health_window_hours * 60 * 60 * 1000);

    let mut total = 0usize;
    let mut high_or_critical = 0usize;
    let mut latest_ts = None::<String>;

    for src in &sources {
        for row in read_jsonl(src) {
            let ts = row
                .get("ts")
                .or_else(|| row.get("timestamp"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let ts_ms = chrono::DateTime::parse_from_rfc3339(ts)
                .ok()
                .map(|v| v.timestamp_millis())
                .unwrap_or(0);
            if ts_ms < since_ms {
                continue;
            }
            total += 1;
            let sev = row
                .get("severity")
                .and_then(Value::as_str)
                .unwrap_or("medium")
                .to_ascii_lowercase();
            if sev == "high" || sev == "critical" {
                high_or_critical += 1;
            }
            latest_ts = Some(ts.to_string());
        }
    }

    let available = total > 0;
    json!({
        "enabled": true,
        "available": available,
        "window_hours": policy.external_health_window_hours,
        "total": total,
        "high_or_critical": high_or_critical,
        "latest_ts": latest_ts,
        "path": sources
            .first()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| paths.pain_signals_path.to_string_lossy().to_string())
    })
}

fn cmd_run(root: &Path, cli: &CliArgs, policy: &Policy, paths: &RuntimePaths) -> Value {
    let run_start = Instant::now();
    let strict = to_bool(
        cli.flags.get("strict").map(String::as_str),
        policy.execution.strict,
    );
    let sleep_only = to_bool(cli.flags.get("sleep-only").map(String::as_str), false);
    let force = to_bool(cli.flags.get("force").map(String::as_str), false);
    let scope = cli
        .flags
        .get("scope")
        .map(String::as_str)
        .filter(|s| ["critical", "changed", "all"].contains(s))
        .unwrap_or(policy.execution.default_scope.as_str())
        .to_string();
    let max_tests = clamp_i64(
        cli.flags.get("max-tests").map(String::as_str),
        1,
        500,
        policy.execution.max_tests_per_run as i64,
    ) as usize;
    let run_timeout_ms = clamp_i64(
        cli.flags.get("run-timeout-ms").map(String::as_str),
        1_000,
        2 * 60 * 60 * 1_000,
        policy.execution.run_timeout_ms,
    );

    let run_deadline = Instant::now() + Duration::from_millis(run_timeout_ms as u64);
    let mut phase_ms = json!({
        "sync_ms": 0,
        "select_ms": 0,
        "execute_ms": 0,
        "total_ms": 0
    });

    let sync_started = Instant::now();
    let sync_out = sync_state(root, paths, policy);
    phase_ms["sync_ms"] = json!(sync_started.elapsed().as_millis());

    let mut status = load_status(paths);
    let external_health = summarize_external_health(paths, policy);
    let sleep_gate = in_sleep_window(policy);
    let resources = runtime_resource_within(policy);
    let spine_hot = is_spine_hot(paths, policy.runtime_guard.spine_hot_window_sec);

    let mut skip_reasons = Vec::<String>::new();
    if sleep_only && !sleep_gate {
        skip_reasons.push("outside_sleep_window".to_string());
    }
    if !resources.get("ok").and_then(Value::as_bool).unwrap_or(true) {
        skip_reasons.push("resource_guard".to_string());
    }
    if spine_hot
        .get("hot")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        skip_reasons.push("spine_hot".to_string());
    }

    if !skip_reasons.is_empty() && !force {
        let now = now_iso();
        phase_ms["total_ms"] = json!(run_start.elapsed().as_millis());
        let mut out = json!({
            "ok": true,
            "type": "autotest_run",
            "ts": now,
            "scope": scope,
            "strict": strict,
            "skipped": true,
            "skip_reasons": skip_reasons,
            "synced": sync_out,
            "external_health": external_health,
            "sleep_window_ok": sleep_gate,
            "resource_guard": resources,
            "spine_hot": spine_hot,
            "run_timeout_ms": run_timeout_ms,
            "phase_ms": phase_ms,
            "claim_evidence": [
                {
                    "id": "execution_gate",
                    "claim": "autotest_run_was_safely_skipped",
                    "evidence": {
                        "skip_reasons": skip_reasons
                    }
                }
            ],
            "persona_lenses": {
                "operator": {
                    "mode": "defensive",
                    "reason": "runtime_guard"
                }
            }
        });
        out["receipt_hash"] = Value::String(receipt_hash(&out));
        let _ = write_json_atomic(&paths.latest_path, &out);
        let _ = append_jsonl(&paths.runs_dir.join(format!("{}.jsonl", &now[..10])), &out);
        return out;
    }

    let select_started = Instant::now();
    let test_ids = test_set_for_scope(&status, &scope);
    let prioritized = prioritize_tests(&status, &test_ids);
    let selected = prioritized
        .iter()
        .take(max_tests)
        .map(|row| row.test.clone())
        .collect::<Vec<_>>();
    let selection_preview = prioritized
        .iter()
        .take(24)
        .map(|row| {
            json!({
                "id": row.id,
                "score": row.score,
                "priority": row.priority
            })
        })
        .collect::<Vec<_>>();
    let test_to_modules = reverse_module_mapping(&status);
    phase_ms["select_ms"] = json!(select_started.elapsed().as_millis());

    let execute_started = Instant::now();
    let mut results = Vec::<Value>::new();
    let mut guard_blocked = 0usize;
    let mut flaky_count = 0usize;
    let mut quarantined_count = 0usize;
    let mut executed_status = HashMap::<String, String>::new();

    for (idx, test) in selected.iter().enumerate() {
        if policy.execution.midrun_resource_guard
            && idx % policy.execution.resource_recheck_every_tests == 0
        {
            let loop_resources = runtime_resource_within(policy);
            if !loop_resources
                .get("ok")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && !force
            {
                phase_ms["execute_ms"] = json!(execute_started.elapsed().as_millis());
                phase_ms["total_ms"] = json!(run_start.elapsed().as_millis());
                let mut out = json!({
                    "ok": false,
                    "type": "autotest_run",
                    "ts": now_iso(),
                    "scope": scope,
                    "strict": strict,
                    "aborted": true,
                    "abort_reason": "resource_guard_during_execution",
                    "selected_tests": results.len(),
                    "passed": results.iter().filter(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false)).count(),
                    "failed": results.iter().filter(|row| !row.get("ok").and_then(Value::as_bool).unwrap_or(false)).count(),
                    "resource_guard_runtime": loop_resources,
                    "partial_results": results,
                    "phase_ms": phase_ms
                });
                out["receipt_hash"] = Value::String(receipt_hash(&out));
                let _ = write_json_atomic(&paths.latest_path, &out);
                return out;
            }
        }

        if Instant::now() > run_deadline {
            phase_ms["execute_ms"] = json!(execute_started.elapsed().as_millis());
            phase_ms["total_ms"] = json!(run_start.elapsed().as_millis());
            let mut out = json!({
                "ok": false,
                "type": "autotest_run",
                "ts": now_iso(),
                "scope": scope,
                "strict": strict,
                "timeout": true,
                "timeout_reason": "execution_budget_exhausted",
                "selected_tests": results.len(),
                "passed": results.iter().filter(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false)).count(),
                "failed": results.iter().filter(|row| !row.get("ok").and_then(Value::as_bool).unwrap_or(false)).count(),
                "partial_results": results,
                "phase_ms": phase_ms
            });
            out["receipt_hash"] = Value::String(receipt_hash(&out));
            let _ = write_json_atomic(&paths.latest_path, &out);
            return out;
        }

        let mut guard_files = Vec::<String>::new();
        if let Some(path) = &test.path {
            guard_files.push(path.clone());
        }
        if let Some(modules) = test_to_modules.get(&test.id) {
            guard_files.extend(modules.iter().cloned());
        }
        guard_files.extend(command_path_hints(&test.command));
        let guard_files = normalize_guard_file_list(&guard_files);
        let guard = run_guard_for_files(root, &guard_files);

        let remaining_ms = run_deadline
            .checked_duration_since(Instant::now())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(1_000)
            .max(1_000);
        let per_test_timeout = policy
            .execution
            .timeout_ms_per_test
            .min(remaining_ms)
            .max(1_000);

        let mut res = if guard.ok {
            run_shell_command(root, &test.command, per_test_timeout)
        } else {
            guard_blocked += 1;
            CommandResult {
                ok: false,
                exit_code: 1,
                signal: None,
                timed_out: false,
                duration_ms: guard.duration_ms,
                stdout_excerpt: short_text(
                    &format!("guard_blocked:{}", guard.reason.clone().unwrap_or_default()),
                    800,
                ),
                stderr_excerpt: short_text(
                    &format!(
                        "{} {}",
                        guard.stderr_excerpt.clone().unwrap_or_default(),
                        guard.stdout_excerpt.clone().unwrap_or_default()
                    ),
                    800,
                ),
            }
        };

        let mut retried = false;
        let mut flaky = false;
        if guard.ok
            && !res.ok
            && policy.execution.retry_flaky_once
            && !test.critical
            && !res.timed_out
            && Instant::now() < run_deadline
        {
            retried = true;
            let remaining_ms = run_deadline
                .checked_duration_since(Instant::now())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(1_000)
                .max(1_000);
            let retry_timeout = policy
                .execution
                .timeout_ms_per_test
                .min(remaining_ms)
                .max(1_000);
            let retry = run_shell_command(root, &test.command, retry_timeout);
            if retry.ok {
                flaky = true;
                flaky_count += 1;
                res = retry;
            } else {
                res = retry;
            }
        }

        if let Some(row) = status.tests.get_mut(&test.id) {
            row.last_status = if res.ok {
                "pass".to_string()
            } else {
                "fail".to_string()
            };
            row.last_exit_code = Some(res.exit_code);
            row.last_run_ts = Some(now_iso());
            row.last_duration_ms = Some(res.duration_ms);
            row.last_stdout_excerpt = Some(res.stdout_excerpt.clone());
            row.last_stderr_excerpt = Some(res.stderr_excerpt.clone());
            row.last_guard = Some(GuardMeta {
                ok: guard.ok,
                reason: guard.reason.clone(),
                files: guard.files.clone(),
            });
            row.last_retry_count = Some(if retried { 1 } else { 0 });
            row.last_flaky = Some(flaky);
            let current_flaky = row.consecutive_flaky.unwrap_or(0);
            row.consecutive_flaky = Some(if flaky { current_flaky + 1 } else { 0 });
            if flaky
                && row.consecutive_flaky.unwrap_or(0) >= policy.execution.flaky_quarantine_after
            {
                let ts = chrono::Utc::now()
                    + chrono::Duration::seconds(policy.execution.flaky_quarantine_sec);
                row.quarantined_until_ts = Some(ts.to_rfc3339());
                quarantined_count += 1;
            } else if res.ok {
                row.quarantined_until_ts = None;
            }
            if res.ok {
                row.last_pass_ts = row.last_run_ts.clone();
            } else {
                row.last_fail_ts = row.last_run_ts.clone();
            }
        }

        executed_status.insert(
            test.id.clone(),
            if res.ok {
                "pass".to_string()
            } else {
                "fail".to_string()
            },
        );

        results.push(json!({
            "id": test.id,
            "command": test.command,
            "critical": test.critical,
            "guard_ok": guard.ok,
            "guard_reason": guard.reason,
            "guard_files": guard.files,
            "ok": res.ok,
            "exit_code": res.exit_code,
            "duration_ms": res.duration_ms,
            "signal": res.signal,
            "timed_out": res.timed_out,
            "retried": retried,
            "flaky": flaky,
            "quarantined_until_ts": status.tests.get(&test.id).and_then(|row| row.quarantined_until_ts.clone()),
            "stdout_excerpt": res.stdout_excerpt,
            "stderr_excerpt": res.stderr_excerpt
        }));
    }
    phase_ms["execute_ms"] = json!(execute_started.elapsed().as_millis());

    let run_ts = now_iso();
    for module in status.modules.values_mut() {
        let ids = module.mapped_test_ids.clone();
        if ids.is_empty() {
            continue;
        }
        let has_executed = ids.iter().any(|id| executed_status.contains_key(id));
        if !has_executed {
            continue;
        }
        module.last_test_ts = Some(run_ts.clone());
        let fail = ids.iter().any(|id| {
            executed_status
                .get(id)
                .map(|v| v == "fail")
                .unwrap_or(false)
        });
        let fresh_pass = !ids.is_empty()
            && ids.iter().all(|id| {
                executed_status
                    .get(id)
                    .map(|v| v == "pass")
                    .unwrap_or(false)
            });
        if fail {
            module.last_fail_ts = Some(run_ts.clone());
        }
        if fresh_pass {
            module.last_pass_ts = Some(run_ts.clone());
            if module.changed {
                module.changed = false;
            }
        }
    }

    update_module_check_states(&mut status);
    status.updated_at = Some(run_ts.clone());
    status.last_run = Some(run_ts.clone());
    let _ = write_json_atomic(
        &paths.status_path,
        &serde_json::to_value(&status).unwrap_or(Value::Null),
    );

    let passed = results
        .iter()
        .filter(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let failed = results.len().saturating_sub(passed);
    let untested = status.modules.values().filter(|m| m.untested).count();

    phase_ms["total_ms"] = json!(run_start.elapsed().as_millis());

    let claim_evidence = vec![
        json!({
            "id": "selection_scope",
            "claim": "test_selection_respects_scope",
            "evidence": {
                "scope": scope,
                "selected_tests": results.len(),
                "queued_candidates": prioritized.len()
            }
        }),
        json!({
            "id": "execution_outcome",
            "claim": "run_outcome_matches_observed_test_results",
            "evidence": {
                "passed": passed,
                "failed": failed,
                "guard_blocked": guard_blocked,
                "untested_modules": untested
            }
        }),
    ];

    let persona_lenses = json!({
        "operator": {
            "attention": if failed > 0 { "incident" } else { "maintenance" },
            "guard_blocked": guard_blocked
        },
        "skeptic": {
            "confidence": if failed == 0 { 0.92 } else { 0.58 },
            "flaky_tests": flaky_count,
            "newly_quarantined_tests": quarantined_count
        }
    });

    let mut out = json!({
        "ok": if strict { failed == 0 && untested == 0 } else { failed == 0 },
        "type": "autotest_run",
        "ts": run_ts,
        "scope": scope,
        "strict": strict,
        "synced": sync_out,
        "selected_tests": results.len(),
        "queued_candidates": prioritized.len(),
        "selection_preview": selection_preview,
        "passed": passed,
        "failed": failed,
        "guard_blocked": guard_blocked,
        "flaky_tests": flaky_count,
        "newly_quarantined_tests": quarantined_count,
        "untested_modules": untested,
        "external_health": external_health,
        "sleep_window_ok": sleep_gate,
        "resource_guard": resources,
        "spine_hot": spine_hot,
        "run_timeout_ms": run_timeout_ms,
        "phase_ms": phase_ms,
        "results": results.iter().take(300).cloned().collect::<Vec<_>>(),
        "claim_evidence": claim_evidence,
        "persona_lenses": persona_lenses,
        "pain_signal": Value::Null
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));

    let _ = write_json_atomic(&paths.latest_path, &out);
    let _ = append_jsonl(
        &paths.runs_dir.join(format!("{}.jsonl", &run_ts[..10])),
        &out,
    );

    if failed > 0 || untested > 0 || guard_blocked > 0 || flaky_count > 0 {
        let _ = append_jsonl(
            &paths.events_path,
            &json!({
                "ts": run_ts,
                "type": "autotest_alert",
                "severity": if failed > 0 || guard_blocked > 0 { "error" } else { "warn" },
                "alert_kind": if guard_blocked > 0 {
                    "guard_blocked"
                } else if failed > 0 {
                    "test_failures"
                } else if flaky_count > 0 {
                    "flaky_tests"
                } else {
                    "untested_modules"
                },
                "failed": failed,
                "guard_blocked": guard_blocked,
                "flaky_tests": flaky_count,
                "untested_modules": untested,
                "scope": scope
            }),
        );
    }

    out
}

fn cmd_report(root: &Path, cli: &CliArgs, policy: &Policy, paths: &RuntimePaths) -> Value {
    let token = cli
        .positional
        .get(1)
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "latest".to_string());
    let write = to_bool(cli.flags.get("write").map(String::as_str), true);
    let mut status = load_status(paths);

    let latest_run = read_json(&paths.latest_path);
    let ts = now_iso();
    let date = if token == "latest" {
        ts[..10].to_string()
    } else {
        token
    };

    let modules = status.modules.values().cloned().collect::<Vec<_>>();
    let tests = status.tests.values().cloned().collect::<Vec<_>>();
    let external_health = summarize_external_health(paths, policy);

    let mut untested = modules
        .iter()
        .filter(|m| m.untested)
        .cloned()
        .collect::<Vec<_>>();
    untested.sort_by(|a, b| a.path.cmp(&b.path));
    untested.truncate(policy.alerts.max_untested_in_report);

    let mut red_modules = modules
        .iter()
        .filter(|m| m.health_state.as_deref() == Some("red"))
        .cloned()
        .collect::<Vec<_>>();
    red_modules.sort_by(|a, b| a.path.cmp(&b.path));
    red_modules.truncate(policy.alerts.max_untested_in_report);

    let mut failed_tests = tests
        .iter()
        .filter(|t| t.last_status == "fail")
        .cloned()
        .collect::<Vec<_>>();
    failed_tests.sort_by(|a, b| a.command.cmp(&b.command));
    failed_tests.truncate(policy.alerts.max_failed_in_report);

    let checked_modules = modules.iter().filter(|m| m.checked).count();
    let green_modules = modules
        .iter()
        .filter(|m| m.health_state.as_deref() == Some("green"))
        .count();
    let changed_modules = modules.iter().filter(|m| m.changed).count();

    let mut lines = vec![
        "# Autotest Report".to_string(),
        "".to_string(),
        format!("- Generated: {ts}"),
        format!("- Date: {date}"),
        format!("- Modules: {}", modules.len()),
        format!("- Checked: {checked_modules}"),
        format!("- Green Modules: {green_modules}"),
        format!("- Red Modules: {}", red_modules.len()),
        format!("- Changed/Pending: {changed_modules}"),
        format!("- Untested Modules: {}", untested.len()),
        format!("- Failed Tests: {}", failed_tests.len()),
    ];

    if latest_run.is_object() {
        lines.push(format!(
            "- Last Run Scope: {}",
            latest_run
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("n/a")
        ));
        lines.push(format!(
            "- Last Run Passed/Failed: {}/{}",
            latest_run
                .get("passed")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            latest_run
                .get("failed")
                .and_then(Value::as_i64)
                .unwrap_or(0)
        ));
    }

    lines.extend(["".to_string(), "## Red Modules (Need Help)".to_string()]);
    if red_modules.is_empty() {
        lines.push("- None".to_string());
    } else {
        for module in &red_modules {
            lines.push(format!("- {}", module.path));
            lines.push(format!(
                "  - reason: {}",
                module
                    .health_reason
                    .clone()
                    .unwrap_or_else(|| "failing_or_guard_blocked_test".to_string())
            ));
        }
    }

    lines.extend(["".to_string(), "## Failed Tests".to_string()]);
    if failed_tests.is_empty() {
        lines.push("- None".to_string());
    } else {
        for test in &failed_tests {
            let label = test.path.clone().unwrap_or_else(|| test.command.clone());
            lines.push(format!("- {label}"));
            if let Some(stderr) = &test.last_stderr_excerpt {
                lines.push(format!("  - stderr: {stderr}"));
            }
        }
    }

    lines.extend([
        "".to_string(),
        "## External Health Signals".to_string(),
        format!(
            "- Total Signals: {}",
            external_health
                .get("total")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ),
        format!(
            "- High/Critical: {}",
            external_health
                .get("high_or_critical")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ),
    ]);

    lines.extend(["".to_string(), "## Untested Modules".to_string()]);
    if untested.is_empty() {
        lines.push("- None".to_string());
    } else {
        for module in &untested {
            lines.push(format!("- {}", module.path));
            if module.changed {
                lines.push("  - reason: changed module with no mapped tests".to_string());
            } else if module.is_new {
                lines.push("  - reason: new module with no mapped tests".to_string());
            } else {
                lines.push("  - reason: no mapped tests".to_string());
            }
        }
    }

    let markdown = format!("{}\n", lines.join("\n"));
    let out_path = paths.reports_dir.join(format!("{date}.md"));
    if write {
        let _ = ensure_dir(&paths.reports_dir);
        let _ = fs::write(&out_path, markdown);
    }

    let mut out = json!({
        "ok": true,
        "type": "autotest_report",
        "ts": ts,
        "date": date,
        "modules_total": modules.len(),
        "modules_checked": checked_modules,
        "modules_green": green_modules,
        "modules_red": red_modules.len(),
        "modules_changed": changed_modules,
        "untested_modules": untested.len(),
        "failed_tests": failed_tests.len(),
        "external_health": external_health,
        "output_path": if write { Value::String(rel_path(root, &out_path)) } else { Value::Null },
        "write": write,
        "claim_evidence": [
            {
                "id": "report_composition",
                "claim": "report_counts_match_status_snapshot",
                "evidence": {
                    "modules_total": modules.len(),
                    "tests_total": tests.len(),
                    "failed_tests": failed_tests.len()
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "risk_focus": if failed_tests.is_empty() { "coverage" } else { "stability" }
            }
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));

    status.last_report = Some(now_iso());
    let _ = write_json_atomic(
        &paths.status_path,
        &serde_json::to_value(status).unwrap_or(Value::Null),
    );
    let _ = write_json_atomic(&paths.latest_path, &out);
    let _ = append_jsonl(
        &paths.runs_dir.join(format!("{}.jsonl", &now_iso()[..10])),
        &out,
    );

    out
}

fn cmd_status(root: &Path, policy: &Policy, paths: &RuntimePaths) -> Value {
    let status = load_status(paths);
    let modules = status.modules.values().collect::<Vec<_>>();
    let tests = status.tests.values().collect::<Vec<_>>();
    let external_health = summarize_external_health(paths, policy);

    let mut out = json!({
        "ok": true,
        "type": "autotest_status",
        "ts": now_iso(),
        "policy_version": policy.version,
        "modules_total": modules.len(),
        "modules_checked": modules.iter().filter(|m| m.checked).count(),
        "modules_green": modules.iter().filter(|m| m.health_state.as_deref() == Some("green")).count(),
        "modules_red": modules.iter().filter(|m| m.health_state.as_deref() == Some("red")).count(),
        "modules_pending": modules.iter().filter(|m| m.health_state.as_deref() == Some("pending")).count(),
        "modules_changed": modules.iter().filter(|m| m.changed).count(),
        "untested_modules": modules.iter().filter(|m| m.untested).count(),
        "tests_total": tests.len(),
        "tests_failed": tests.iter().filter(|t| t.last_status == "fail").count(),
        "tests_flaky": tests.iter().filter(|t| t.last_flaky.unwrap_or(false)).count(),
        "tests_quarantined": tests.iter().filter(|t| {
            t.quarantined_until_ts
                .as_deref()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp_millis() > chrono::Utc::now().timestamp_millis())
                .unwrap_or(false)
        }).count(),
        "tests_passed": tests.iter().filter(|t| t.last_status == "pass").count(),
        "tests_untested": tests.iter().filter(|t| t.last_status == "untested").count(),
        "external_health": external_health,
        "last_sync": status.last_sync,
        "last_run": status.last_run,
        "last_report": status.last_report,
        "status_path": rel_path(root, &paths.status_path),
        "registry_path": rel_path(root, &paths.registry_path),
        "claim_evidence": [
            {
                "id": "status_snapshot",
                "claim": "status_is_derived_from_current_registry",
                "evidence": {
                    "modules_total": modules.len(),
                    "tests_total": tests.len()
                }
            }
        ],
        "persona_lenses": {
            "auditor": {
                "coverage_gap": modules.iter().filter(|m| m.untested).count()
            }
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cmd_daemon(root: &Path, cli: &CliArgs, policy: &Policy, paths: &RuntimePaths) -> Value {
    let interval_sec = clamp_i64(
        cli.flags.get("interval-sec").map(String::as_str),
        20,
        24 * 60 * 60,
        300,
    );
    let max_cycles = clamp_i64(
        cli.flags.get("max-cycles").map(String::as_str),
        0,
        1_000_000,
        0,
    );
    let jitter_sec = clamp_i64(cli.flags.get("jitter-sec").map(String::as_str), 0, 600, 0);
    let scope = cli
        .flags
        .get("scope")
        .map(String::as_str)
        .filter(|s| ["critical", "changed", "all"].contains(s))
        .unwrap_or(policy.execution.default_scope.as_str())
        .to_string();
    let strict = to_bool(
        cli.flags.get("strict").map(String::as_str),
        policy.execution.strict,
    );
    let max_tests = clamp_i64(
        cli.flags.get("max-tests").map(String::as_str),
        1,
        500,
        policy.execution.max_tests_per_run as i64,
    );

    let mut cycles = 0i64;
    let mut last: Option<Value>;

    loop {
        cycles += 1;
        let run_cli = CliArgs {
            positional: vec!["run".to_string()],
            flags: HashMap::from([
                ("scope".to_string(), scope.clone()),
                (
                    "strict".to_string(),
                    if strict { "1" } else { "0" }.to_string(),
                ),
                ("max-tests".to_string(), max_tests.to_string()),
                ("sleep-only".to_string(), "1".to_string()),
            ]),
        };
        let run_out = cmd_run(root, &run_cli, policy, paths);

        let report_cli = CliArgs {
            positional: vec!["report".to_string(), "latest".to_string()],
            flags: HashMap::from([("write".to_string(), "1".to_string())]),
        };
        let report_out = cmd_report(root, &report_cli, policy, paths);

        last = Some(json!({
            "run": run_out,
            "report": report_out
        }));

        if max_cycles > 0 && cycles >= max_cycles {
            break;
        }

        let jitter = if jitter_sec > 0 {
            (chrono::Utc::now().timestamp() % (jitter_sec + 1)).abs()
        } else {
            0
        };
        thread::sleep(Duration::from_secs((interval_sec + jitter) as u64));
    }

    let mut out = json!({
        "ok": true,
        "type": "autotest_daemon",
        "ts": now_iso(),
        "cycles": cycles,
        "interval_sec": interval_sec,
        "jitter_sec": jitter_sec,
        "scope": scope,
        "strict": strict,
        "max_tests": max_tests,
        "last": last.unwrap_or(Value::Null),
        "claim_evidence": [
            {
                "id": "daemon_cycles",
                "claim": "daemon_executed_expected_cycle_pattern",
                "evidence": {
                    "cycles": cycles,
                    "interval_sec": interval_sec
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "mode": "background"
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
    println!("  protheus-ops autotest-controller sync [--policy=path] [--strict=1|0]");
    println!("  protheus-ops autotest-controller run [--policy=path] [--scope=critical|changed|all] [--max-tests=N] [--strict=1|0] [--sleep-only=1|0] [--force=1|0] [--run-timeout-ms=N]");
    println!("  protheus-ops autotest-controller report [YYYY-MM-DD|latest] [--policy=path] [--write=1|0]");
    println!("  protheus-ops autotest-controller status [--policy=path]");
    println!("  protheus-ops autotest-controller pulse [--policy=path] [--scope=changed|critical|all] [--max-tests=N] [--strict=1|0] [--force=1|0] [--run-timeout-ms=N]");
    println!("  protheus-ops autotest-controller daemon [--policy=path] [--interval-sec=N] [--max-cycles=N] [--scope=changed|critical|all] [--max-tests=N] [--strict=1|0] [--run-timeout-ms=N]");
    println!("  add --legacy-fallback=1 to execute systems/ops/autotest_controller_legacy.js");
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let (use_legacy, cleaned_argv) =
        split_legacy_fallback_flag(argv, "PROTHEUS_OPS_AUTOTEST_CONTROLLER_LEGACY");
    if use_legacy {
        return run_legacy_script(
            root,
            LEGACY_SCRIPT_REL,
            &cleaned_argv,
            "autotest_controller",
        );
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

    let mut paths = runtime_paths(root);
    if let Some(p) = cli.flags.get("policy") {
        let pb = PathBuf::from(p);
        paths.policy_path = if pb.is_absolute() { pb } else { root.join(pb) };
    }
    let policy = load_policy(root, &paths.policy_path);

    if let Err(err) = ensure_state_dirs(&paths) {
        print_json_line(&json!({
            "ok": false,
            "type": "autotest",
            "error": err
        }));
        return 1;
    }

    if !policy.enabled && cmd != "status" {
        print_json_line(&json!({
            "ok": true,
            "type": "autotest",
            "ts": now_iso(),
            "disabled": true,
            "reason": "policy_disabled"
        }));
        return 0;
    }

    let out = match cmd.as_str() {
        "sync" => sync_state(root, &paths, &policy),
        "run" => cmd_run(root, &cli, &policy, &paths),
        "report" => cmd_report(root, &cli, &policy, &paths),
        "status" => cmd_status(root, &policy, &paths),
        "pulse" => {
            let run_cli = CliArgs {
                positional: vec!["run".to_string()],
                flags: {
                    let mut flags = cli.flags.clone();
                    flags.insert("sleep-only".to_string(), "1".to_string());
                    flags
                },
            };
            let run_out = cmd_run(root, &run_cli, &policy, &paths);
            let report_cli = CliArgs {
                positional: vec!["report".to_string(), "latest".to_string()],
                flags: HashMap::from([("write".to_string(), "1".to_string())]),
            };
            let report_out = cmd_report(root, &report_cli, &policy, &paths);
            let mut payload = json!({
                "ok": run_out.get("ok").and_then(Value::as_bool).unwrap_or(false)
                    && report_out.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "type": "autotest_pulse",
                "ts": now_iso(),
                "run": run_out,
                "report": report_out,
                "claim_evidence": [
                    {
                        "id": "pulse_pair",
                        "claim": "pulse_runs_and_reports_in_sequence",
                        "evidence": {
                            "run_ok": run_out.get("ok").and_then(Value::as_bool).unwrap_or(false),
                            "report_ok": report_out.get("ok").and_then(Value::as_bool).unwrap_or(false)
                        }
                    }
                ],
                "persona_lenses": {
                    "operator": {
                        "mode": "pulse"
                    }
                }
            });
            payload["receipt_hash"] = Value::String(receipt_hash(&payload));
            payload
        }
        "daemon" => cmd_daemon(root, &cli, &policy, &paths),
        _ => {
            usage();
            return 2;
        }
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
    fn parity_fixture_score_prefers_layer_and_tokens() {
        let policy = default_policy();
        let module = ModuleCandidate {
            id: "mod_1".to_string(),
            path: "systems/ops/autotest_controller.ts".to_string(),
            abs_path: PathBuf::from("systems/ops/autotest_controller.ts"),
            basename: "autotest_controller".to_string(),
        };
        let test = TestCandidate {
            id: "tst_1".to_string(),
            kind: "node_test".to_string(),
            path: "memory/tools/tests/autotest_controller.test.js".to_string(),
            command: "node memory/tools/tests/autotest_controller.test.js".to_string(),
            stem: "autotest_controller.test".to_string(),
        };
        let score = score_module_test_pair(&module, &test, &policy);
        assert!(score >= policy.min_match_score);
    }

    #[test]
    fn deterministic_receipt_hash_for_fixture() {
        let payload = json!({
            "ok": true,
            "type": "autotest_status",
            "modules_total": 2,
            "tests_total": 4,
            "claim_evidence": [{"id":"c1","claim":"x","evidence":{"a":1}}]
        });
        let h1 = receipt_hash(&payload);
        let h2 = receipt_hash(&payload);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn split_fallback_is_opt_in() {
        let (fallback, cleaned) =
            split_legacy_fallback_flag(&["run".to_string()], "NO_SUCH_ENV_KEY");
        assert!(!fallback);
        assert_eq!(cleaned, vec!["run".to_string()]);
    }
}
