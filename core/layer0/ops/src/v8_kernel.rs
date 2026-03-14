// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::{clean, deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn scoped_state_root(root: &Path, env_key: &str, scope: &str) -> PathBuf {
    if let Ok(v) = std::env::var(env_key) {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    crate::core_state_root(root).join("ops").join(scope)
}

pub fn latest_path(root: &Path, env_key: &str, scope: &str) -> PathBuf {
    scoped_state_root(root, env_key, scope).join("latest.json")
}

pub fn history_path(root: &Path, env_key: &str, scope: &str) -> PathBuf {
    scoped_state_root(root, env_key, scope).join("history.jsonl")
}

pub fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let payload = serde_json::to_string_pretty(value)
        .map_err(|err| format!("encode_json_failed:{}:{err}", path.display()))?;
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    fs::write(&tmp, format!("{payload}\n"))
        .map_err(|err| format!("write_tmp_failed:{}:{err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| {
        format!(
            "rename_tmp_failed:{}:{}:{err}",
            tmp.display(),
            path.display()
        )
    })
}

pub fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let line = serde_json::to_string(value)
        .map_err(|err| format!("encode_jsonl_failed:{}:{err}", path.display()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_jsonl_failed:{}:{err}", path.display()))?;
    writeln!(file, "{line}").map_err(|err| format!("append_jsonl_failed:{}:{err}", path.display()))
}

pub fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

pub trait ReceiptJsonExt {
    fn with_receipt_hash(self) -> Value;
    fn set_receipt_hash(&mut self);
}

impl ReceiptJsonExt for Value {
    fn with_receipt_hash(mut self) -> Value {
        self.set_receipt_hash();
        self
    }

    fn set_receipt_hash(&mut self) {
        self["receipt_hash"] = Value::String(deterministic_receipt_hash(self));
    }
}

pub fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

pub fn parse_bool_str(raw: Option<&str>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

pub fn parse_f64(raw: Option<&String>, fallback: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

pub fn parse_f64_str(raw: Option<&str>, fallback: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

pub fn parse_u64(raw: Option<&String>, fallback: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

pub fn parse_u64_str(raw: Option<&str>, fallback: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

pub fn parse_i64(raw: Option<&String>, fallback: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
}

pub fn parse_i64_str(raw: Option<&str>, fallback: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
}

pub fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let needle = format!("--{key}");
    for idx in 0..argv.len() {
        let token = &argv[idx];
        if token == &needle {
            return argv.get(idx + 1).cloned();
        }
        let prefix = format!("{needle}=");
        if let Some(value) = token.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
    }
    None
}

pub fn load_json_or(root: &Path, rel: &str, fallback: Value) -> Value {
    read_json(&root.join(rel)).unwrap_or(fallback)
}

pub fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut out = serde_json::Map::new();
            for key in keys {
                if let Some(v) = map.get(&key) {
                    out.insert(key, canonicalize_json(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

pub fn canonical_json_string(value: &Value) -> String {
    serde_json::to_string(&canonicalize_json(value)).unwrap_or_else(|_| "null".to_string())
}

pub fn conduit_bypass_requested(flags: &HashMap<String, String>) -> bool {
    parse_bool(flags.get("bypass"), false)
        || parse_bool(flags.get("direct"), false)
        || parse_bool(flags.get("unsafe-client-route"), false)
        || parse_bool(flags.get("client-bypass"), false)
}

pub fn conduit_claim_rows(
    action: &str,
    bypass_requested: bool,
    claim: &str,
    claim_ids: &[&str],
) -> Vec<Value> {
    claim_ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "claim": clean(claim, 240),
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect()
}

pub fn build_conduit_enforcement(
    root: &Path,
    env_key: &str,
    scope: &str,
    strict: bool,
    action: &str,
    receipt_type: &str,
    required_path: &str,
    bypass_requested: bool,
    claim_evidence: Vec<Value>,
) -> Value {
    let ok = !bypass_requested;
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": clean(receipt_type, 120),
        "action": clean(action, 120),
        "required_path": clean(required_path, 240),
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": claim_evidence
    });
    out.set_receipt_hash();
    let _ = append_jsonl(
        &scoped_state_root(root, env_key, scope)
            .join("conduit")
            .join("history.jsonl"),
        &out,
    );
    out
}

pub fn build_plane_conduit_enforcement(
    root: &Path,
    env_key: &str,
    scope: &str,
    strict: bool,
    action: &str,
    receipt_type: &str,
    required_path: &str,
    bypass_requested: bool,
    claim: &str,
    claim_ids: &[&str],
) -> Value {
    build_conduit_enforcement(
        root,
        env_key,
        scope,
        strict,
        action,
        receipt_type,
        required_path,
        bypass_requested,
        conduit_claim_rows(action, bypass_requested, claim, claim_ids),
    )
}

pub fn attach_conduit(mut payload: Value, conduit: Option<&Value>) -> Value {
    if let Some(gate) = conduit {
        payload["conduit_enforcement"] = gate.clone();
        let mut claims = payload
            .get("claim_evidence")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(rows) = gate.get("claim_evidence").and_then(Value::as_array) {
            claims.extend(rows.iter().cloned());
        }
        if !claims.is_empty() {
            payload["claim_evidence"] = Value::Array(claims);
        }
    }
    payload.set_receipt_hash();
    payload
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn sha256_hex_str(value: &str) -> String {
    sha256_hex_bytes(value.as_bytes())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|err| format!("read_file_failed:{}:{err}", path.display()))?;
    Ok(sha256_hex_bytes(&bytes))
}

pub fn keyed_digest_hex(secret: &str, payload: &Value) -> String {
    let rendered = serde_json::to_string(payload).unwrap_or_default();
    sha256_hex_str(&format!("{}:{}", clean(secret, 4096), rendered))
}

pub fn next_chain_hash(prev_hash: Option<&str>, payload: &Value) -> String {
    let prev = prev_hash.unwrap_or("genesis");
    let rendered = serde_json::to_string(payload).unwrap_or_default();
    sha256_hex_str(&format!("{prev}|{rendered}"))
}

pub fn deterministic_merkle_root(leaves: &[String]) -> String {
    if leaves.is_empty() {
        return sha256_hex_str("merkle:empty");
    }
    let mut level = leaves
        .iter()
        .map(|leaf| sha256_hex_str(&format!("leaf:{leaf}")))
        .collect::<Vec<_>>();
    while level.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0usize;
        while i < level.len() {
            let left = &level[i];
            let right = if i + 1 < level.len() {
                &level[i + 1]
            } else {
                &level[i]
            };
            next.push(sha256_hex_str(&format!("node:{left}:{right}")));
            i += 2;
        }
        level = next;
    }
    level[0].clone()
}

pub fn merkle_proof(leaves: &[String], index: usize) -> Vec<Value> {
    if leaves.is_empty() || index >= leaves.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut idx = index;
    let mut level = leaves
        .iter()
        .map(|leaf| sha256_hex_str(&format!("leaf:{leaf}")))
        .collect::<Vec<_>>();

    while level.len() > 1 {
        let sibling_idx = if idx % 2 == 0 {
            idx + 1
        } else {
            idx.saturating_sub(1)
        };
        let sibling = if sibling_idx < level.len() {
            level[sibling_idx].clone()
        } else {
            level[idx].clone()
        };
        out.push(json!({
            "level_size": level.len(),
            "index": idx,
            "sibling_index": sibling_idx.min(level.len().saturating_sub(1)),
            "sibling_hash": sibling
        }));

        let mut next = Vec::new();
        let mut i = 0usize;
        while i < level.len() {
            let left = &level[i];
            let right = if i + 1 < level.len() {
                &level[i + 1]
            } else {
                &level[i]
            };
            next.push(sha256_hex_str(&format!("node:{left}:{right}")));
            i += 2;
        }
        idx /= 2;
        level = next;
    }

    out
}

pub fn write_receipt(
    root: &Path,
    env_key: &str,
    scope: &str,
    mut payload: Value,
) -> Result<Value, String> {
    let latest = latest_path(root, env_key, scope);
    let history = history_path(root, env_key, scope);
    payload["ts"] = Value::String(now_iso());
    payload.set_receipt_hash();
    write_json(&latest, &payload)?;
    append_jsonl(&history, &payload)?;
    Ok(payload)
}

pub fn emit_plane_receipt(
    root: &Path,
    env_key: &str,
    scope: &str,
    error_type: &str,
    payload: Value,
) -> i32 {
    match write_receipt(root, env_key, scope, payload) {
        Ok(out) => {
            print_json(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            }
        }
        Err(err) => {
            print_json(&json!({
                "ok": false,
                "type": clean(error_type, 120),
                "error": clean(err, 240)
            }));
            1
        }
    }
}

pub fn plane_status(root: &Path, env_key: &str, scope: &str, status_type: &str) -> Value {
    json!({
        "ok": true,
        "type": clean(status_type, 120),
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root, env_key, scope).display().to_string(),
        "latest": read_json(&latest_path(root, env_key, scope))
    })
}

pub fn split_csv_clean(raw: &str, max_len: usize) -> Vec<String> {
    raw.split(',')
        .map(|row| clean(row, max_len))
        .filter(|row| !row.is_empty())
        .collect()
}

pub fn parse_csv_flag(flags: &HashMap<String, String>, key: &str, max_len: usize) -> Vec<String> {
    flags
        .get(key)
        .map(|v| split_csv_clean(v, max_len))
        .unwrap_or_default()
}

pub fn parse_csv_or_file(
    root: &Path,
    flags: &HashMap<String, String>,
    csv_key: &str,
    file_key: &str,
    max_len: usize,
) -> Vec<String> {
    let mut values = parse_csv_flag(flags, csv_key, max_len);
    let Some(rel_or_abs) = flags.get(file_key) else {
        return values;
    };
    let path = if Path::new(rel_or_abs).is_absolute() {
        PathBuf::from(rel_or_abs)
    } else {
        root.join(rel_or_abs)
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return values;
    };
    if raw.trim_start().starts_with('[') {
        if let Ok(parsed_json) = serde_json::from_str::<Value>(&raw) {
            if let Some(rows) = parsed_json.as_array() {
                for row in rows {
                    if let Some(text) = row.as_str() {
                        let cleaned = clean(text, max_len);
                        if !cleaned.is_empty() {
                            values.push(cleaned);
                        }
                    }
                }
            }
        }
        return values;
    }
    values.extend(split_csv_clean(&raw.replace('\n', ","), max_len));
    values
}
