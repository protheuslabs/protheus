// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/autonomy (authoritative).

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub mod ethical_reasoning;
pub mod multi_agent_debate;
pub mod simulation;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn stable_hash(payload: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(payload).unwrap_or_default());
    hex::encode(hasher.finalize())
}

pub fn round_to(value: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places.max(0));
    ((value * scale).round()) / scale
}

pub fn clamp_num(v: f64, lo: f64, hi: f64, fallback: f64) -> f64 {
    if !v.is_finite() {
        return fallback;
    }
    if v < lo {
        return lo;
    }
    if v > hi {
        return hi;
    }
    v
}

pub fn clamp_int(v: i64, lo: i64, hi: i64, fallback: i64) -> i64 {
    let mut n = v;
    if n < lo {
        n = lo;
    }
    if n > hi {
        n = hi;
    }
    if lo > hi {
        return fallback;
    }
    n
}

pub fn clean_text(v: &str, max_len: usize) -> String {
    let trimmed = v.split_whitespace().collect::<Vec<_>>().join(" ");
    trimmed.chars().take(max_len).collect()
}

pub fn normalize_token(v: &str, max_len: usize) -> String {
    let base = clean_text(v, max_len).to_ascii_lowercase();
    let mut out = String::with_capacity(base.len());
    let mut prev_underscore = false;
    for ch in base.chars() {
        let valid = ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-');
        if valid {
            out.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    while out.starts_with('_') {
        out.remove(0);
    }
    while out.ends_with('_') {
        out.pop();
    }
    out.chars().take(max_len).collect()
}

pub fn parse_bool_str(raw: Option<&str>, fallback: bool) -> bool {
    let Some(v) = raw else {
        return fallback;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

pub fn parse_date_or_today(raw: Option<&str>) -> String {
    let text = clean_text(raw.unwrap_or_default(), 32);
    if text.len() == 10 && text.chars().nth(4) == Some('-') && text.chars().nth(7) == Some('-') {
        return text;
    }
    now_iso()[..10].to_string()
}

pub fn runtime_root(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("PROTHEUS_CLIENT_RUNTIME_ROOT") {
        let cleaned = raw.trim();
        if !cleaned.is_empty() {
            return PathBuf::from(cleaned);
        }
    }
    root.join("client").join("runtime")
}

pub fn resolve_runtime_path(root: &Path, raw: Option<&str>, fallback: &str) -> PathBuf {
    let txt = clean_text(raw.unwrap_or(fallback), 512);
    if txt.is_empty() {
        return runtime_root(root).join(fallback);
    }
    let candidate = PathBuf::from(&txt);
    if candidate.is_absolute() {
        candidate
    } else {
        runtime_root(root).join(candidate)
    }
}

pub fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_failed:{}:{e}", parent.display()))?;
    }
    Ok(())
}

pub fn read_json(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

pub fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    let payload =
        serde_json::to_string_pretty(value).map_err(|e| format!("encode_json_failed:{e}"))?;
    let mut file = fs::File::create(&tmp)
        .map_err(|e| format!("create_tmp_failed:{}:{e}", tmp.display()))?;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("write_tmp_failed:{}:{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

pub fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let text = line.trim();
            if text.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(text).ok().filter(|v| v.is_object())
        })
        .collect()
}

pub fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_jsonl_failed:{}:{e}", path.display()))?;
    let line = serde_json::to_string(value).map_err(|e| format!("encode_row_failed:{e}"))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

pub fn autonomy_receipt(command: &str, objective: Option<&str>) -> Value {
    let mut out = json!({
        "ok": true,
        "type": "autonomy_contract_receipt",
        "authority": "core/layer2/autonomy",
        "command": command,
        "objective": objective
    });
    out["receipt_hash"] = Value::String(stable_hash(&out));
    out
}

pub fn workflow_receipt(command: &str, scope: Option<&str>) -> Value {
    let mut out = json!({
        "ok": true,
        "type": "workflow_contract_receipt",
        "authority": "core/layer2/autonomy",
        "command": command,
        "scope": scope
    });
    out["receipt_hash"] = Value::String(stable_hash(&out));
    out
}

pub fn pain_signal_receipt(
    action: &str,
    source: Option<&str>,
    code: Option<&str>,
    severity: Option<&str>,
    risk: Option<&str>,
) -> Value {
    let mut out = json!({
        "ok": true,
        "type": "pain_signal_contract_receipt",
        "authority": "core/layer2/autonomy",
        "action": action,
        "source": source,
        "code": code,
        "severity": severity,
        "risk": risk
    });
    out["receipt_hash"] = Value::String(stable_hash(&out));
    out
}

pub use ethical_reasoning::{ethical_reasoning_status, run_ethical_reasoning};
pub use multi_agent_debate::{debate_status, run_multi_agent_debate};
pub use simulation::run_autonomy_simulation;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autonomy_receipt_has_hash() {
        let payload = autonomy_receipt("status", Some("default"));
        assert!(payload.get("receipt_hash").and_then(Value::as_str).is_some());
    }

    #[test]
    fn token_normalization_is_stable() {
        assert_eq!(normalize_token("A/B C:D", 120), "a/b_c:d");
        assert_eq!(normalize_token("  $$$  ", 120), "");
    }
}
