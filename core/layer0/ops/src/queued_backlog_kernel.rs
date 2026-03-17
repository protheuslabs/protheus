// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

fn usage() {
    println!("queued-backlog-kernel commands:");
    println!("  protheus-ops queued-backlog-kernel ensure-dir --payload-base64=<json>");
    println!("  protheus-ops queued-backlog-kernel read-json --payload-base64=<json>");
    println!("  protheus-ops queued-backlog-kernel write-json-atomic --payload-base64=<json>");
    println!("  protheus-ops queued-backlog-kernel append-jsonl --payload-base64=<json>");
    println!("  protheus-ops queued-backlog-kernel read-jsonl --payload-base64=<json>");
    println!("  protheus-ops queued-backlog-kernel resolve-path --payload-base64=<json>");
    println!("  protheus-ops queued-backlog-kernel stable-hash --payload-base64=<json>");
    println!("  protheus-ops queued-backlog-kernel load-policy --payload-base64=<json>");
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
            .map_err(|err| format!("queued_backlog_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("queued_backlog_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("queued_backlog_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("queued_backlog_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn as_object<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn as_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string().trim_matches('"').trim().to_string(),
    }
}

fn clean_text(value: Option<&Value>, max_len: usize) -> String {
    let mut out = as_str(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn workspace_root(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("OPENCLAW_WORKSPACE") {
        let raw = raw.trim();
        if !raw.is_empty() {
            return PathBuf::from(raw);
        }
    }
    root.to_path_buf()
}

fn client_root(root: &Path) -> PathBuf {
    let workspace = workspace_root(root);
    if workspace.join("client").exists() {
        workspace.join("client")
    } else {
        workspace
    }
}

fn core_root(root: &Path) -> PathBuf {
    let workspace = workspace_root(root);
    if workspace.join("core").exists() {
        workspace.join("core")
    } else {
        workspace.join("core")
    }
}

fn normalize_relative_path_token(input: &str) -> String {
    input
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn rewrite_legacy_runtime_relative(rel_path: &str) -> String {
    let rel = normalize_relative_path_token(rel_path);
    if rel.is_empty() {
        return rel;
    }
    if rel == "local" || rel.starts_with("local/") {
        let suffix = if rel == "local" {
            String::new()
        } else {
            rel.strip_prefix("local/").unwrap_or("").to_string()
        };
        return normalize_relative_path_token(&format!("client/runtime/local/{suffix}"));
    }
    if rel == "state" || rel.starts_with("local/state/") {
        let suffix = if rel == "state" {
            String::new()
        } else if let Some(rest) = rel.strip_prefix("local/state/") {
            rest.to_string()
        } else {
            rel.strip_prefix("state/").unwrap_or("").to_string()
        };
        return normalize_relative_path_token(&format!("client/runtime/local/state/{suffix}"));
    }
    if rel == "client/runtime/state" || rel.starts_with("client/runtime/local/state/") {
        let suffix = if rel == "client/runtime/state" {
            String::new()
        } else {
            rel.strip_prefix("client/runtime/local/state/").unwrap_or("").to_string()
        };
        return normalize_relative_path_token(&format!("client/runtime/local/state/{suffix}"));
    }
    if rel == "core/state" || rel.starts_with("core/local/state/") {
        let suffix = if rel == "core/state" {
            String::new()
        } else {
            rel.strip_prefix("core/local/state/").unwrap_or("").to_string()
        };
        return normalize_relative_path_token(&format!("core/local/state/{suffix}"));
    }
    rel
}

fn rewrite_legacy_runtime_absolute(root: &Path, abs_path: &Path) -> PathBuf {
    let workspace = workspace_root(root);
    let workspace_local = workspace.join("local");
    let workspace_state = workspace.join("state");
    let client_state = client_root(root).join("state");
    let core_state = core_root(root).join("state");

    let normalized = abs_path.to_path_buf();
    if normalized == workspace_local || normalized.starts_with(&workspace_local) {
        let suffix = normalized.strip_prefix(&workspace_local).unwrap_or(Path::new(""));
        return client_root(root).join("local").join(suffix);
    }
    if normalized == workspace_state || normalized.starts_with(&workspace_state) {
        let suffix = normalized.strip_prefix(&workspace_state).unwrap_or(Path::new(""));
        return client_root(root).join("local").join("state").join(suffix);
    }
    if normalized == client_state || normalized.starts_with(&client_state) {
        let suffix = normalized.strip_prefix(&client_state).unwrap_or(Path::new(""));
        return client_root(root).join("local").join("state").join(suffix);
    }
    if normalized == core_state || normalized.starts_with(&core_state) {
        let suffix = normalized.strip_prefix(&core_state).unwrap_or(Path::new(""));
        return core_root(root).join("local").join("state").join(suffix);
    }
    normalized
}

fn resolve_path(root: &Path, raw: &str, fallback_rel: &str) -> PathBuf {
    let workspace = workspace_root(root);
    let expanded = raw
        .replace("${OPENCLAW_WORKSPACE}", &workspace.to_string_lossy())
        .replace("$OPENCLAW_WORKSPACE", &workspace.to_string_lossy());
    if expanded.trim().is_empty() {
        return workspace.join(rewrite_legacy_runtime_relative(fallback_rel));
    }
    let path = PathBuf::from(expanded.trim());
    if path.is_absolute() {
        return rewrite_legacy_runtime_absolute(root, &path);
    }
    workspace.join(rewrite_legacy_runtime_relative(expanded.trim()))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|err| format!("queued_backlog_kernel_create_dir_failed:{err}"))
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::File::create(&tmp)
        .map_err(|err| format!("queued_backlog_kernel_tmp_create_failed:{err}"))?;
    file.write_all(
        format!(
            "{}\n",
            serde_json::to_string_pretty(value)
                .map_err(|err| format!("queued_backlog_kernel_json_encode_failed:{err}"))?
        )
        .as_bytes(),
    )
    .map_err(|err| format!("queued_backlog_kernel_tmp_write_failed:{err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("queued_backlog_kernel_atomic_rename_failed:{err}"))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("queued_backlog_kernel_jsonl_open_failed:{err}"))?;
    file.write_all(
        format!(
            "{}\n",
            serde_json::to_string(row)
                .map_err(|err| format!("queued_backlog_kernel_json_encode_failed:{err}"))?
        )
        .as_bytes(),
    )
    .map_err(|err| format!("queued_backlog_kernel_jsonl_write_failed:{err}"))
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn stable_hash(value: &Value, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(value).unwrap_or_default().as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

fn shallow_merge(base: &Map<String, Value>, override_map: &Map<String, Value>) -> Value {
    let mut merged = base.clone();
    for (key, value) in override_map {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

fn run_command(root: &Path, command: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    match command {
        "ensure-dir" => {
            let path = resolve_path(root, &clean_text(payload.get("dir_path"), 520), "");
            ensure_dir(&path)?;
            Ok(json!({ "ok": true, "dir_path": path.to_string_lossy() }))
        }
        "read-json" => {
            let path = resolve_path(root, &clean_text(payload.get("file_path"), 520), "");
            let fallback = payload.get("fallback").cloned().unwrap_or(Value::Null);
            let value = read_json(&path).unwrap_or(fallback);
            Ok(json!({ "ok": true, "value": value }))
        }
        "write-json-atomic" => {
            let path = resolve_path(root, &clean_text(payload.get("file_path"), 520), "");
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            write_json_atomic(&path, &value)?;
            Ok(json!({ "ok": true, "file_path": path.to_string_lossy(), "value": value }))
        }
        "append-jsonl" => {
            let path = resolve_path(root, &clean_text(payload.get("file_path"), 520), "");
            let row = payload.get("row").cloned().unwrap_or(Value::Null);
            append_jsonl(&path, &row)?;
            Ok(json!({ "ok": true, "file_path": path.to_string_lossy(), "row": row }))
        }
        "read-jsonl" => {
            let path = resolve_path(root, &clean_text(payload.get("file_path"), 520), "");
            Ok(json!({ "ok": true, "rows": read_jsonl(&path) }))
        }
        "resolve-path" => {
            let raw = clean_text(payload.get("raw"), 520);
            let fallback_rel = clean_text(payload.get("fallback_rel"), 520);
            let path = resolve_path(root, &raw, &fallback_rel);
            Ok(json!({ "ok": true, "resolved_path": path.to_string_lossy() }))
        }
        "stable-hash" => {
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            let len = clean_text(payload.get("len"), 32)
                .parse::<usize>()
                .ok()
                .unwrap_or(16);
            Ok(json!({ "ok": true, "hash": stable_hash(&value, len) }))
        }
        "load-policy" => {
            let path = resolve_path(root, &clean_text(payload.get("policy_path"), 520), "");
            let defaults = as_object(payload.get("defaults")).cloned().unwrap_or_default();
            let raw = read_json(&path)
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            let merged = shallow_merge(&defaults, &raw);
            Ok(json!({
                "ok": true,
                "policy": merged,
                "raw": raw,
                "policy_path": path.to_string_lossy()
            }))
        }
        _ => Err("queued_backlog_kernel_unknown_command".to_string()),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|v| v.as_str()) else {
        usage();
        return 1;
    };
    if matches!(command, "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("queued_backlog_kernel", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload).clone();
    match run_command(root, command, &payload) {
        Ok(out) => {
            print_json_line(&cli_receipt("queued_backlog_kernel", out));
            0
        }
        Err(err) => {
            print_json_line(&cli_error("queued_backlog_kernel", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "queued-backlog-kernel-{}-{}-{}",
            name,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn resolve_path_rewrites_local_state_into_runtime_local() {
        let root = temp_root("resolve");
        let path = resolve_path(&root, "local/state/ops/demo.json", "local/state/ops/demo.json");
        assert!(path.to_string_lossy().contains("client/runtime/local/state/ops/demo.json"));
    }

    #[test]
    fn read_write_and_append_round_trip() {
        let root = temp_root("io");
        let file = root.join("client/runtime/local/state/demo/latest.json");
        write_json_atomic(&file, &json!({"ok": true})).unwrap();
        assert_eq!(read_json(&file).and_then(|value| value.get("ok").and_then(Value::as_bool)), Some(true));
        let jsonl = root.join("client/runtime/local/state/demo/history.jsonl");
        append_jsonl(&jsonl, &json!({"id": 1})).unwrap();
        append_jsonl(&jsonl, &json!({"id": 2})).unwrap();
        assert_eq!(read_jsonl(&jsonl).len(), 2);
    }
}
