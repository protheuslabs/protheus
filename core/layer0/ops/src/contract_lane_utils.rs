// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::contract_lane_utils (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::{deterministic_receipt_hash, now_iso};

pub fn parse_flag(argv: &[String], key: &str, allow_switch_true: bool) -> Option<String> {
    let with_eq = format!("--{key}=");
    let plain = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(v) = token.strip_prefix(&with_eq) {
            return Some(v.trim().to_string());
        }
        if token == plain {
            if let Some(next) = argv.get(i + 1) {
                if !next.trim_start().starts_with("--") {
                    return Some(next.trim().to_string());
                }
            }
            if allow_switch_true {
                return Some("true".to_string());
            }
            return None;
        }
        i += 1;
    }
    None
}

pub fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(v) = raw else {
        return fallback;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

pub fn parse_bool_extended(raw: Option<&str>, fallback: bool) -> bool {
    let Some(v) = raw else {
        return fallback;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "allow" | "enabled" => true,
        "0" | "false" | "no" | "off" | "deny" | "disabled" => false,
        _ => fallback,
    }
}

pub fn parse_u64(raw: Option<&str>, fallback: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

pub fn parse_u64_clamped(raw: Option<&str>, fallback: u64, lo: u64, hi: u64) -> u64 {
    parse_u64(raw, fallback).clamp(lo, hi)
}

pub fn parse_f64_clamped(raw: Option<&str>, fallback: f64, lo: f64, hi: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

pub fn parse_opt_bool(raw: Option<&str>) -> Option<bool> {
    let v = raw?.trim().to_ascii_lowercase();
    match v.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn parse_i64_clamped(raw: Option<&str>, fallback: i64, lo: i64, hi: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

pub fn clean_token(raw: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.trim().chars() {
            if out.len() >= 160 {
                break;
            }
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                out.push(ch);
            } else {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn clean_text(raw: Option<&str>, max_len: usize) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.split_whitespace().collect::<Vec<_>>().join(" ").chars() {
            if out.len() >= max_len {
                break;
            }
            out.push(ch);
        }
    }
    out.trim().to_string()
}

pub fn cli_receipt(kind: &str, payload: Value) -> Value {
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

pub fn cli_error(kind: &str, error: &str) -> Value {
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

pub fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

pub fn payload_json(argv: &[String], lane: &str) -> Result<Value, String> {
    if let Some(raw) = parse_flag(argv, "payload", false) {
        return serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("{lane}_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("{lane}_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("{lane}_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("{lane}_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

pub fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

pub fn repo_path(root: &Path, rel: &str) -> PathBuf {
    let candidate = PathBuf::from(rel.trim());
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

pub fn path_flag(
    root: &Path,
    argv: &[String],
    payload: &Map<String, Value>,
    flag: &str,
    payload_key: &str,
    default_rel: &str,
) -> PathBuf {
    parse_flag(argv, flag, false)
        .or_else(|| {
            payload
                .get(payload_key)
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(default_rel))
}

pub fn json_u64(raw: Option<&Value>, fallback: u64, min: u64, max: u64) -> u64 {
    raw.and_then(Value::as_u64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

pub fn json_bool(raw: Option<&Value>, fallback: bool) -> bool {
    raw.and_then(Value::as_bool).unwrap_or(fallback)
}

pub fn string_set(raw: Option<&Value>) -> Vec<String> {
    let mut out = BTreeSet::new();
    if let Some(items) = raw.and_then(Value::as_array) {
        for item in items {
            let value = clean_token(item.as_str(), "");
            if !value.is_empty() {
                out.insert(value);
            }
        }
    }
    out.into_iter().collect()
}

pub fn bridge_surface_prefix_allowed(path: &str) -> bool {
    ["adapters/", "client/runtime/", "client/lib/", "tests/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

pub fn normalize_bridge_path(root: &Path, raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("bridge_path_required".to_string());
    }
    if candidate.contains("..") {
        return Err("unsafe_bridge_path_parent_reference".to_string());
    }
    let abs = repo_path(root, candidate);
    let rel_path = rel_path(root, &abs);
    if !bridge_surface_prefix_allowed(&rel_path) {
        return Err("unsupported_bridge_path".to_string());
    }
    Ok(rel_path)
}

pub fn normalize_bridge_path_clean(root: &Path, raw: &str, unsupported_error: &str) -> Result<String, String> {
    let clean = clean_text(Some(raw), 260);
    if !bridge_surface_prefix_allowed(&clean) {
        return Err(unsupported_error.to_string());
    }
    Ok(rel_path(root, &repo_path(root, &clean)))
}

pub fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{}:{err}", parent.display()))
}

pub fn write_json(path: &Path, payload: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut encoded =
        serde_json::to_string_pretty(payload).map_err(|err| format!("encode_failed:{err}"))?;
    encoded.push('\n');
    fs::write(path, encoded).map_err(|err| format!("write_failed:{}:{err}", path.display()))
}

pub fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    use std::io::Write;
    let line = serde_json::to_string(row).map_err(|err| format!("encode_failed:{err}"))? + "\n";
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    let mut file = opts
        .open(path)
        .map_err(|err| format!("open_failed:{}:{err}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("append_failed:{}:{err}", path.display()))
}

pub fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

pub fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| path.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_flag_supports_switch_true_mode() {
        let argv = vec!["--strict".to_string()];
        assert_eq!(parse_flag(&argv, "strict", true).as_deref(), Some("true"));
        assert_eq!(parse_flag(&argv, "strict", false), None);
    }

    #[test]
    fn normalize_bridge_path_rejects_parent_references() {
        let root = Path::new("/tmp/workspace");
        assert_eq!(
            normalize_bridge_path(root, "../bad").unwrap_err(),
            "unsafe_bridge_path_parent_reference"
        );
    }

    #[test]
    fn string_set_dedupes_and_sanitizes() {
        let payload = json!(["Alpha", "Alpha", "beta!", ""]);
        assert_eq!(string_set(Some(&payload)), vec!["Alpha", "beta-"]);
    }
}
