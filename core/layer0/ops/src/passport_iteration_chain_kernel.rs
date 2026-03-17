// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_CHAIN_REL: &str = "local/state/security/passport_iteration_chain.jsonl";
const DEFAULT_LATEST_REL: &str = "local/state/security/passport_iteration_chain.latest.json";

fn usage() {
    println!("passport-iteration-chain-kernel commands:");
    println!("  protheus-ops passport-iteration-chain-kernel record --payload-base64=<json>");
    println!("  protheus-ops passport-iteration-chain-kernel status [--payload-base64=<json>]");
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
            .map_err(|err| format!("passport_iteration_chain_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("passport_iteration_chain_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("passport_iteration_chain_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("passport_iteration_chain_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
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

fn normalize_token(raw: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        let keep = matches!(lower, 'a'..='z' | '0'..='9' | '_' | '.' | ':' | '/' | '-');
        if keep {
            out.push(lower);
            prev_sep = false;
        } else if !prev_sep {
            out.push('_');
            prev_sep = true;
        }
        if out.len() >= max_len {
            break;
        }
    }
    out.trim_matches('_').to_string()
}

fn workspace_root(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("PROTHEUS_WORKSPACE_ROOT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    root.to_path_buf()
}

fn runtime_root(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    let explicit = clean_text(payload.get("root"), 520);
    if !explicit.is_empty() {
        return PathBuf::from(explicit);
    }
    if let Ok(raw) = std::env::var("PROTHEUS_RUNTIME_ROOT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let workspace = workspace_root(root);
    let candidate = workspace.join("client").join("runtime");
    if candidate.exists() {
        candidate
    } else {
        workspace
    }
}

fn resolve_path(runtime_root: &Path, raw: &str, fallback_rel: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return runtime_root.join(fallback_rel);
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        candidate
    } else {
        runtime_root.join(trimmed)
    }
}

fn relative_to_runtime(runtime_root: &Path, target: &Path) -> String {
    target
        .strip_prefix(runtime_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| target.to_string_lossy().replace('\\', "/"))
}

fn json_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn sha256_hex(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn read_rows(chain_path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(chain_path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(trimmed).ok()
            }
        })
        .collect()
}

fn write_json_atomic(file_path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("passport_iteration_chain_kernel_create_dir_failed:{err}"))?;
    }
    let tmp_path = file_path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    fs::write(
        &tmp_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value)
                .map_err(|err| format!("passport_iteration_chain_kernel_encode_failed:{err}"))?
        ),
    )
    .map_err(|err| format!("passport_iteration_chain_kernel_write_failed:{err}"))?;
    fs::rename(&tmp_path, file_path)
        .map_err(|err| format!("passport_iteration_chain_kernel_rename_failed:{err}"))?;
    Ok(())
}

fn append_jsonl(file_path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("passport_iteration_chain_kernel_create_dir_failed:{err}"))?;
    }
    let mut handle = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file_path)
        .map_err(|err| format!("passport_iteration_chain_kernel_open_failed:{err}"))?;
    use std::io::Write;
    handle
        .write_all(format!("{}\n", json_string(row)).as_bytes())
        .map_err(|err| format!("passport_iteration_chain_kernel_append_failed:{err}"))?;
    Ok(())
}

fn record(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let runtime = runtime_root(root, payload);
    let chain_path = resolve_path(
        &runtime,
        &clean_text(payload.get("chain_path"), 520),
        DEFAULT_CHAIN_REL,
    );
    let latest_path = resolve_path(
        &runtime,
        &clean_text(payload.get("latest_path"), 520),
        DEFAULT_LATEST_REL,
    );
    let lane = {
        let normalized = normalize_token(&clean_text(payload.get("lane"), 120), 120);
        if normalized.is_empty() {
            "iterative_repair".to_string()
        } else {
            normalized
        }
    };
    let step = {
        let normalized = normalize_token(&clean_text(payload.get("step"), 120), 120);
        if normalized.is_empty() {
            "step".to_string()
        } else {
            normalized
        }
    };
    let iteration = payload
        .get("iteration")
        .and_then(Value::as_i64)
        .or_else(|| as_str(payload.get("iteration")).parse::<i64>().ok())
        .unwrap_or(1)
        .max(1);
    let objective_id = {
        let raw = payload
            .get("objective_id")
            .or_else(|| payload.get("objectiveId"));
        let normalized = normalize_token(&clean_text(raw, 180), 180);
        if normalized.is_empty() { None } else { Some(normalized) }
    };
    let target_path = {
        let raw = payload
            .get("target_path")
            .or_else(|| payload.get("targetPath"));
        let value = clean_text(raw, 360);
        if value.is_empty() { None } else { Some(value) }
    };
    let metadata = payload
        .get("metadata")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    let rows = read_rows(&chain_path);
    let latest_row = rows.last();
    let seq = latest_row
        .and_then(|row| row.get("seq"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + 1;
    let prev_hash = latest_row
        .and_then(|row| row.get("hash"))
        .and_then(Value::as_str)
        .map(|value| value.to_string());

    let body = json!({
        "schema_id": "passport_iteration_chain_event",
        "schema_version": "1.0",
        "ts": now_iso(),
        "lane": lane,
        "step": step,
        "iteration": iteration,
        "objective_id": objective_id,
        "target_path": target_path,
        "metadata": metadata,
    });
    let payload_hash = sha256_hex(&json_string(&body));
    let hash = sha256_hex(&json_string(&json!({
        "seq": seq,
        "prev_hash": prev_hash,
        "payload_hash": payload_hash,
    })));
    let row = json!({
        "schema_id": "passport_iteration_chain_event",
        "schema_version": "1.0",
        "ts": body.get("ts").cloned().unwrap_or(Value::Null),
        "lane": body.get("lane").cloned().unwrap_or(Value::Null),
        "step": body.get("step").cloned().unwrap_or(Value::Null),
        "iteration": iteration,
        "objective_id": objective_id,
        "target_path": target_path,
        "metadata": metadata,
        "seq": seq,
        "prev_hash": prev_hash,
        "payload_hash": payload_hash,
        "hash": hash,
    });
    append_jsonl(&chain_path, &row)?;

    let latest = json!({
        "ok": true,
        "type": "passport_iteration_chain_record",
        "ts": now_iso(),
        "lane": lane,
        "step": step,
        "iteration": iteration,
        "seq": seq,
        "hash": hash,
        "prev_hash": row.get("prev_hash").cloned().unwrap_or(Value::Null),
        "chain_path": relative_to_runtime(&runtime, &chain_path),
        "latest_path": relative_to_runtime(&runtime, &latest_path),
        "passport": {
            "ok": false,
            "skipped": true,
        }
    });
    write_json_atomic(&latest_path, &latest)?;
    Ok(latest)
}

fn status(root: &Path, payload: &Map<String, Value>) -> Value {
    let runtime = runtime_root(root, payload);
    let chain_path = resolve_path(
        &runtime,
        &clean_text(payload.get("chain_path"), 520),
        DEFAULT_CHAIN_REL,
    );
    let latest_path = resolve_path(
        &runtime,
        &clean_text(payload.get("latest_path"), 520),
        DEFAULT_LATEST_REL,
    );
    let rows = read_rows(&chain_path);
    let latest = rows.last().cloned().unwrap_or(Value::Null);
    json!({
        "ok": true,
        "type": "passport_iteration_chain_status",
        "ts": now_iso(),
        "total_events": rows.len(),
        "latest": if latest.is_null() {
            Value::Null
        } else {
            json!({
                "seq": latest.get("seq").cloned().unwrap_or(Value::Null),
                "hash": latest.get("hash").cloned().unwrap_or(Value::Null),
                "lane": latest.get("lane").cloned().unwrap_or(Value::Null),
                "step": latest.get("step").cloned().unwrap_or(Value::Null),
                "iteration": latest.get("iteration").cloned().unwrap_or(Value::Null),
                "ts": latest.get("ts").cloned().unwrap_or(Value::Null),
            })
        },
        "chain_path": relative_to_runtime(&runtime, &chain_path),
        "latest_path": relative_to_runtime(&runtime, &latest_path),
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        usage();
        return 0;
    }

    let command = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error(
                "passport_iteration_chain_kernel_error",
                err.as_str(),
            ));
            return 1;
        }
    };
    let payload = payload_obj(&payload);

    let receipt = match command.as_str() {
        "status" => cli_receipt("passport_iteration_chain_kernel_status", status(root, payload)),
        "record" => match record(root, payload) {
            Ok(value) => cli_receipt("passport_iteration_chain_kernel_record", value),
            Err(err) => cli_error("passport_iteration_chain_kernel_error", err.as_str()),
        },
        _ => {
            usage();
            cli_error(
                "passport_iteration_chain_kernel_error",
                "passport_iteration_chain_kernel_unknown_command",
            )
        }
    };

    let exit_code = if receipt.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
    };
    print_json_line(&receipt);
    exit_code
}
