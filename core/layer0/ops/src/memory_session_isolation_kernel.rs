// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "client/runtime/local/state/memory/session_isolation.json";

fn usage() {
    println!("memory-session-isolation-kernel commands:");
    println!("  protheus-ops memory-session-isolation-kernel load-state [--payload-base64=<base64_json>]");
    println!("  protheus-ops memory-session-isolation-kernel save-state [--payload-base64=<base64_json>]");
    println!(
        "  protheus-ops memory-session-isolation-kernel validate [--payload-base64=<base64_json>]"
    );
    println!("  protheus-ops memory-session-isolation-kernel failure-result [--payload-base64=<base64_json>]");
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
            .map_err(|err| format!("memory_session_isolation_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD.decode(raw_b64.as_bytes()).map_err(|err| {
            format!("memory_session_isolation_kernel_payload_base64_decode_failed:{err}")
        })?;
        let text = String::from_utf8(bytes).map_err(|err| {
            format!("memory_session_isolation_kernel_payload_utf8_decode_failed:{err}")
        })?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("memory_session_isolation_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn as_object<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn as_array<'a>(value: Option<&'a Value>) -> &'a Vec<Value> {
    value.and_then(Value::as_array).unwrap_or_else(|| {
        static EMPTY: OnceLock<Vec<Value>> = OnceLock::new();
        EMPTY.get_or_init(Vec::new)
    })
}

fn as_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string().trim_matches('"').trim().to_string(),
    }
}

fn to_bool(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64().map(|row| row != 0).unwrap_or(fallback),
        Some(Value::String(v)) => lane_utils::parse_bool(Some(v.as_str()), fallback),
        _ => fallback,
    }
}

fn workspace_root(root: &Path) -> PathBuf {
    if let Some(raw) = std::env::var_os("OPENCLAW_WORKSPACE") {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            return path;
        }
    }
    root.to_path_buf()
}

fn resolve_path(root: &Path, raw: Option<&Value>, fallback_rel: &str) -> PathBuf {
    let workspace = workspace_root(root);
    let trimmed = as_str(raw);
    if trimmed.is_empty() {
        return workspace.join(fallback_rel);
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(candidate)
    }
}

fn default_state_value() -> Value {
    json!({
        "schema_version": "1.0",
        "resources": {}
    })
}

fn load_state_value(path: &Path) -> Value {
    let parsed = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(default_state_value);
    let mut state = parsed.as_object().cloned().unwrap_or_default();
    if !state.contains_key("schema_version") {
        state.insert(
            "schema_version".to_string(),
            Value::String("1.0".to_string()),
        );
    }
    let resources_ok = state.get("resources").and_then(Value::as_object).is_some();
    if !resources_ok {
        state.insert("resources".to_string(), json!({}));
    }
    Value::Object(state)
}

fn save_state_value(path: &Path, state: &Value) -> Result<Value, String> {
    let mut normalized = state.as_object().cloned().unwrap_or_default();
    if !normalized.contains_key("schema_version") {
        normalized.insert(
            "schema_version".to_string(),
            Value::String("1.0".to_string()),
        );
    }
    let resources_ok = normalized
        .get("resources")
        .and_then(Value::as_object)
        .is_some();
    if !resources_ok {
        normalized.insert("resources".to_string(), json!({}));
    }
    let saved = Value::Object(normalized);
    lane_utils::write_json(path, &saved)?;
    Ok(saved)
}

fn parse_cli_args(raw_args: &[String]) -> (Vec<String>, HashMap<String, String>) {
    let mut positional = Vec::new();
    let mut flags = HashMap::new();
    for token in raw_args {
        if !token.starts_with("--") {
            positional.push(token.clone());
            continue;
        }
        match token.split_once('=') {
            Some((key, value)) => {
                flags.insert(key.trim_start_matches("--").to_string(), value.to_string());
            }
            None => {
                flags.insert(
                    token.trim_start_matches("--").to_string(),
                    "true".to_string(),
                );
            }
        }
    }
    (positional, flags)
}

fn session_id_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$").unwrap())
}

fn parsed_args_value(raw_args: &[String]) -> Value {
    let (positional, flags) = parse_cli_args(raw_args);
    json!({
        "positional": positional,
        "flags": flags
    })
}

fn find_session_id(flags: &HashMap<String, String>, options: &Map<String, Value>) -> String {
    let option_value = options
        .get("sessionId")
        .or_else(|| options.get("session_id"));
    let from_options = as_str(option_value);
    if !from_options.is_empty() {
        return from_options;
    }
    [
        "session-id",
        "session_id",
        "session",
        "session-key",
        "session_key",
    ]
    .iter()
    .filter_map(|key| flags.get(*key))
    .map(|value| value.trim().to_string())
    .find(|value| !value.is_empty())
    .unwrap_or_default()
}

fn collect_resource_keys(flags: &HashMap<String, String>) -> Vec<String> {
    let names = [
        "resource-id",
        "resource_id",
        "item-id",
        "item_id",
        "node-id",
        "node_id",
        "uid",
        "memory-id",
        "memory_id",
        "task-id",
        "task_id",
    ];
    let mut out = Vec::new();
    for name in names {
        let value = flags.get(name).map(|row| row.trim()).unwrap_or("");
        if value.is_empty() {
            continue;
        }
        out.push(format!("{name}:{value}"));
    }
    out.sort();
    out.dedup();
    out
}

fn validate_value(root: &Path, payload: &Map<String, Value>) -> Value {
    let args = as_array(payload.get("args"))
        .iter()
        .map(|value| as_str(Some(value)))
        .collect::<Vec<_>>();
    let options = as_object(payload.get("options"))
        .cloned()
        .unwrap_or_default();
    let (positional, flags) = parse_cli_args(&args);
    let command = {
        let explicit = as_str(options.get("command"));
        if !explicit.is_empty() {
            explicit.to_ascii_lowercase()
        } else {
            positional
                .first()
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string())
        }
    };
    let require_session = to_bool(
        options
            .get("requireSession")
            .or_else(|| options.get("require_session")),
        true,
    ) && !matches!(command.as_str(), "status" | "verify" | "health" | "help");
    let session_id = find_session_id(&flags, &options);

    if require_session && session_id.is_empty() {
        return json!({
            "ok": false,
            "type": "memory_session_isolation",
            "reason_code": "missing_session_id",
            "command": command
        });
    }
    if !session_id.is_empty() && !session_id_pattern().is_match(&session_id) {
        return json!({
            "ok": false,
            "type": "memory_session_isolation",
            "reason_code": "invalid_session_id",
            "session_id": session_id
        });
    }

    let resource_keys = collect_resource_keys(&flags);
    if resource_keys.is_empty() {
        return json!({
            "ok": true,
            "type": "memory_session_isolation",
            "reason_code": "no_resource_keys",
            "command": command,
            "session_id": if session_id.is_empty() { Value::Null } else { Value::String(session_id) }
        });
    }

    let state_path = resolve_path(
        root,
        options
            .get("statePath")
            .or_else(|| options.get("state_path")),
        DEFAULT_STATE_REL,
    );
    let mut state = load_state_value(&state_path)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut resources = state
        .get("resources")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    for key in &resource_keys {
        let existing = resources.get(key);
        let existing_session = existing
            .and_then(Value::as_object)
            .and_then(|obj| obj.get("session_id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !existing_session.is_empty() && !session_id.is_empty() && existing_session != session_id
        {
            return json!({
                "ok": false,
                "type": "memory_session_isolation",
                "reason_code": "cross_session_leak_blocked",
                "resource_key": key,
                "expected_session_id": existing_session,
                "session_id": session_id
            });
        }
    }

    let persist = to_bool(options.get("persist"), true);
    if persist && !session_id.is_empty() {
        let now = now_iso();
        for key in &resource_keys {
            resources.insert(
                key.to_string(),
                json!({
                    "session_id": session_id,
                    "last_seen_at": now
                }),
            );
        }
        state.insert("resources".to_string(), Value::Object(resources));
        let _ = save_state_value(&state_path, &Value::Object(state));
    }

    json!({
        "ok": true,
        "type": "memory_session_isolation",
        "reason_code": "session_isolation_ok",
        "session_id": if session_id.is_empty() { Value::Null } else { Value::String(session_id) },
        "resource_key_count": resource_keys.len()
    })
}

fn failure_result_value(payload: &Map<String, Value>) -> Value {
    let validation = as_object(payload.get("validation"))
        .cloned()
        .unwrap_or_default();
    let context = as_object(payload.get("context"))
        .cloned()
        .unwrap_or_default();
    let reason = as_str(validation.get("reason_code"));
    let mut envelope = Map::new();
    envelope.insert("ok".to_string(), Value::Bool(false));
    envelope.insert(
        "type".to_string(),
        Value::String("memory_session_isolation_reject".to_string()),
    );
    envelope.insert(
        "reason".to_string(),
        Value::String(if reason.is_empty() {
            "session_isolation_failed".to_string()
        } else {
            reason.clone()
        }),
    );
    envelope.insert("fail_closed".to_string(), Value::Bool(true));
    for (key, value) in context {
        envelope.insert(key, value);
    }
    let payload = Value::Object(envelope.clone());
    json!({
        "ok": false,
        "status": 2,
        "stdout": format!("{}\n", serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())),
        "stderr": format!(
            "memory_session_isolation_reject:{}\n",
            payload.get("reason").and_then(Value::as_str).unwrap_or("session_isolation_failed")
        ),
        "payload": Value::Object(envelope)
    })
}

fn run_command(root: &Path, command: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    match command {
        "load-state" => {
            let state_path = resolve_path(
                root,
                payload
                    .get("statePath")
                    .or_else(|| payload.get("state_path")),
                DEFAULT_STATE_REL,
            );
            Ok(json!({
                "ok": true,
                "state": load_state_value(&state_path)
            }))
        }
        "save-state" => {
            let state_path = resolve_path(
                root,
                payload
                    .get("statePath")
                    .or_else(|| payload.get("state_path")),
                DEFAULT_STATE_REL,
            );
            let state = payload
                .get("state")
                .cloned()
                .unwrap_or_else(default_state_value);
            Ok(json!({
                "ok": true,
                "state": save_state_value(&state_path, &state)?
            }))
        }
        "validate" => {
            let args = as_array(payload.get("args"))
                .iter()
                .map(|value| as_str(Some(value)))
                .collect::<Vec<_>>();
            Ok(json!({
                "ok": true,
                "validation": validate_value(root, payload),
                "parsed": parsed_args_value(&args)
            }))
        }
        "failure-result" => Ok(json!({
            "ok": true,
            "result": failure_result_value(payload)
        })),
        _ => Err("memory_session_isolation_kernel_unknown_command".to_string()),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|value| value.as_str()) else {
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
            print_json_line(&cli_error("memory_session_isolation_kernel", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload).clone();
    match run_command(root, command, &payload) {
        Ok(out) => {
            print_json_line(&cli_receipt("memory_session_isolation_kernel", out));
            0
        }
        Err(err) => {
            print_json_line(&cli_error("memory_session_isolation_kernel", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_blocks_cross_session_leakage() {
        let root =
            std::env::temp_dir().join(format!("memory-session-kernel-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let state_path = root.join("state/session.json");
        let allow = validate_value(
            &root,
            payload_obj(&json!({
                "args": ["query-index", "--session-id=session-a", "--resource-id=node-1"],
                "options": { "statePath": state_path.to_string_lossy().to_string() }
            })),
        );
        assert_eq!(allow.get("ok").and_then(Value::as_bool), Some(true));
        let blocked = validate_value(
            &root,
            payload_obj(&json!({
                "args": ["query-index", "--session-id=session-b", "--resource-id=node-1"],
                "options": { "statePath": state_path.to_string_lossy().to_string() }
            })),
        );
        assert_eq!(blocked.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            blocked.get("reason_code").and_then(Value::as_str),
            Some("cross_session_leak_blocked")
        );
        let _ = fs::remove_dir_all(&root);
    }
}
