// Layer ownership: core/layer2/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::deterministic_receipt_hash;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_POLICY_REL: &str =
    "client/runtime/config/release_gate_canary_rollback_enforcer_policy.json";
const DEFAULT_LATEST_REL: &str = "local/state/ops/release_gate_canary_rollback_enforcer/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/release_gate_canary_rollback_enforcer/history.jsonl";

fn print_json(value: &Value) {
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
        if let Some(value) = token.strip_prefix(&pref) {
            return Some(value.to_string());
        }
        if token == long && idx + 1 < argv.len() {
            return Some(argv[idx + 1].clone());
        }
        idx += 1;
    }
    None
}
fn to_bool(raw: Option<String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(value) if ["1", "true", "yes", "on"].contains(&value.as_str()) => true,
        Some(value) if ["0", "false", "no", "off"].contains(&value.as_str()) => false,
        _ => fallback,
    }
}
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn clean_text(value: &str, max_len: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect()
}
fn resolve_root(cli_root: &Path) -> PathBuf {
    env::var("RELEASE_GATE_CANARY_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| cli_root.to_path_buf())
}
fn resolve_path(root: &Path, raw: Option<String>, fallback_rel: &str) -> PathBuf {
    match raw {
        Some(value) if !value.trim().is_empty() => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        }
        _ => root.join(fallback_rel),
    }
}
fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}
fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(
        &tmp,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(|err| err.to_string())?
        ),
    )
    .map_err(|err| err.to_string())?;
    fs::rename(&tmp, path).map_err(|err| err.to_string())?;
    Ok(())
}
fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    let mut line = serde_json::to_string(value).map_err(|err| err.to_string())?;
    line.push('\n');
    file.write_all(line.as_bytes())
        .map_err(|err| err.to_string())
}
fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
fn load_policy(root: &Path, argv: &[String]) -> Value {
    let policy_path = resolve_path(
        root,
        parse_flag(argv, "policy").or_else(|| env::var("RELEASE_GATE_CANARY_POLICY_PATH").ok()),
        DEFAULT_POLICY_REL,
    );
    let raw = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let latest = raw
        .pointer("/outputs/latest_path")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| DEFAULT_LATEST_REL.to_string());
    let history = raw
        .pointer("/outputs/history_path")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| DEFAULT_HISTORY_REL.to_string());
    let min = raw
        .pointer("/thresholds/canary_pass_rate_min")
        .and_then(Value::as_f64)
        .unwrap_or(0.6)
        .clamp(0.0, 1.0);
    json!({"version":raw.get("version").and_then(Value::as_str).unwrap_or("1.0"),"enabled":raw.get("enabled").and_then(Value::as_bool).unwrap_or(true),"thresholds":{"canary_pass_rate_min":min},"outputs":{"latest_path":resolve_path(root,Some(latest),DEFAULT_LATEST_REL),"history_path":resolve_path(root,Some(history),DEFAULT_HISTORY_REL)},"policy_path":policy_path})
}
fn cmd_gate(root: &Path, argv: &[String]) -> Result<Value, String> {
    let policy = load_policy(root, argv);
    if !policy
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        let mut out = json!({"ok":true,"result":"disabled_by_policy","type":"release_gate_canary_rollback_enforcer","authority":"core/layer2/ops"});
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        return Ok(out);
    }
    let canary_pass_rate = parse_flag(argv, "canary_pass_rate")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    let rollback_ready = to_bool(parse_flag(argv, "rollback_ready"), false);
    let min = policy
        .pointer("/thresholds/canary_pass_rate_min")
        .and_then(Value::as_f64)
        .unwrap_or(0.6);
    let mut blockers = Vec::new();
    if canary_pass_rate < min {
        blockers.push(
            json!({"gate":"canary_pass_rate","reason":"below_threshold","value":canary_pass_rate}),
        );
    }
    if !rollback_ready {
        blockers.push(json!({"gate":"rollback_readiness","reason":"rollback_not_ready"}));
    }
    let ts = now_iso();
    let mut out = json!({"ok":blockers.is_empty(),"ts":ts,"type":"release_gate_canary_rollback_enforcer","authority":"core/layer2/ops","canary_pass_rate":canary_pass_rate,"rollback_ready":rollback_ready,"blockers":blockers,"policy_path":rel(root, Path::new(policy.get("policy_path").and_then(Value::as_str).unwrap_or_default()))});
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    let latest_path = PathBuf::from(
        policy
            .pointer("/outputs/latest_path")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_LATEST_REL),
    );
    let history_path = PathBuf::from(
        policy
            .pointer("/outputs/history_path")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_HISTORY_REL),
    );
    write_json_atomic(&latest_path, &out)?;
    append_jsonl(
        &history_path,
        &json!({"ts":out["ts"],"type":out["type"],"canary_pass_rate":out["canary_pass_rate"],"rollback_ready":out["rollback_ready"],"blocker_count":out["blockers"].as_array().map(|rows| rows.len()).unwrap_or(0),"ok":out["ok"]}),
    )?;
    Ok(out)
}
fn cmd_status(root: &Path, argv: &[String]) -> Value {
    let policy = load_policy(root, argv);
    let latest_path = PathBuf::from(
        policy
            .pointer("/outputs/latest_path")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_LATEST_REL),
    );
    let mut out = json!({"ok":true,"ts":now_iso(),"type":"release_gate_canary_rollback_enforcer_status","authority":"core/layer2/ops","latest":read_json(&latest_path),"policy_path":rel(root, Path::new(policy.get("policy_path").and_then(Value::as_str).unwrap_or_default()))});
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}
pub fn run(cli_root: &Path, argv: &[String]) -> i32 {
    let root = resolve_root(cli_root);
    let cmd = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let result = match cmd.as_str() {
        "gate" => cmd_gate(&root, argv),
        "status" => Ok(cmd_status(&root, argv)),
        "help" | "--help" | "-h" => {
            println!("Usage:\n  protheus-ops release-gate-canary-rollback-enforcer gate|status [--policy=<path>] [--canary_pass_rate=<n>] [--rollback_ready=1|0]");
            return 0;
        }
        _ => Ok(json!({"ok":false,"error":format!("unknown_command:{cmd}")})),
    };
    match result {
        Ok(payload) => {
            let exit = if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            };
            print_json(&payload);
            exit
        }
        Err(err) => {
            print_json(&json!({"ok":false,"error":clean_text(&err,260)}));
            1
        }
    }
}
