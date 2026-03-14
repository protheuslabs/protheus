// Layer ownership: core/layer1/storage via core/layer2/ops CLI (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::deterministic_receipt_hash;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_MAX_AGE_HOURS: f64 = 12.0;
const DEFAULT_CACHE_REL: &str = "local/state/sensory/eyes/cache";

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
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn clean_id(value: &str) -> String {
    let raw = value.trim().to_ascii_lowercase();
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "collector".to_string()
    } else {
        out
    }
}
fn cache_dir(root: &Path) -> PathBuf {
    std::env::var("EYES_COLLECTOR_CACHE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_CACHE_REL))
}
fn cache_path(root: &Path, id: &str) -> PathBuf {
    cache_dir(root).join(format!("{}.json", clean_id(id)))
}
fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}
fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(|err| err.to_string())?
        ),
    )
    .map_err(|err| err.to_string())
}
fn max_age_hours(argv: &[String]) -> f64 {
    parse_flag(argv, "max-age-hours")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(DEFAULT_MAX_AGE_HOURS)
}
fn cmd_status(root: &Path) -> Value {
    let mut out = json!({"ok":true,"type":"collector_cache_status","authority":"core/layer1/storage","cache_dir":cache_dir(root),"default_max_age_hours":DEFAULT_MAX_AGE_HOURS});
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}
fn cmd_load(root: &Path, argv: &[String]) -> Value {
    let id = clean_id(&parse_flag(argv, "collector-id").unwrap_or_else(|| "collector".to_string()));
    let path = cache_path(root, &id);
    let max_age = max_age_hours(argv);
    let payload = read_json(&path);
    let mut cache = Value::Null;
    if let Some(raw) = payload {
        let items_ok = raw.get("items").and_then(Value::as_array).is_some();
        let ts_ms = raw
            .get("ts")
            .and_then(Value::as_str)
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        let age_ms = chrono::Utc::now().timestamp_millis().saturating_sub(ts_ms);
        let max_age_ms = (max_age * 60.0 * 60.0 * 1000.0) as i64;
        if items_ok && ts_ms > 0 && age_ms <= max_age_ms {
            cache = json!({"ts": raw.get("ts").cloned().unwrap_or(Value::Null), "age_ms": age_ms, "items": raw.get("items").cloned().unwrap_or_else(|| json!([]))});
        }
    }
    let mut out = json!({"ok":true,"type":"collector_cache_load","authority":"core/layer1/storage","collector_id":id,"cache":cache});
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}
fn cmd_save(root: &Path, argv: &[String]) -> Result<Value, String> {
    let id = clean_id(&parse_flag(argv, "collector-id").unwrap_or_else(|| "collector".to_string()));
    let items = parse_flag(argv, "items-json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!([]));
    let items_arr = items.as_array().cloned().unwrap_or_default();
    if items_arr.is_empty() {
        let mut out = json!({"ok":true,"type":"collector_cache_save","authority":"core/layer1/storage","collector_id":id,"saved":false,"reason":"empty_items"});
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        return Ok(out);
    }
    let payload = json!({"ts":now_iso(),"count":items_arr.len(),"items":items_arr});
    let path = cache_path(root, &id);
    write_json_pretty(&path, &payload)?;
    let mut out = json!({"ok":true,"type":"collector_cache_save","authority":"core/layer1/storage","collector_id":id,"saved":true,"path":path,"count":payload["count"]});
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    Ok(out)
}
pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let result = match cmd.as_str() {
        "status" => Ok(cmd_status(root)),
        "load" => Ok(cmd_load(root, argv)),
        "save" => cmd_save(root, argv),
        "help" | "--help" | "-h" => {
            println!("Usage:\n  protheus-ops collector-cache load|save|status [--collector-id=<id>] [--max-age-hours=<n>] [--items-json=<json>]");
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
            print_json(&json!({"ok":false,"error":err}));
            1
        }
    }
}
