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

const DEFAULT_POLICY_REL: &str = "client/runtime/config/mech_suit_mode_policy.json";
const DEFAULT_STATUS_REL: &str = "client/runtime/local/state/ops/mech_suit_mode/latest.json";
const DEFAULT_HISTORY_REL: &str = "client/runtime/local/state/ops/mech_suit_mode/history.jsonl";
const DEFAULT_ATTENTION_QUEUE_REL: &str = "client/runtime/local/state/attention/queue.jsonl";
const DEFAULT_ATTENTION_RECEIPTS_REL: &str = "client/runtime/local/state/attention/receipts.jsonl";
const DEFAULT_ATTENTION_LATEST_REL: &str = "client/runtime/local/state/attention/latest.json";

fn usage() {
    println!("mech-suit-mode-kernel commands:");
    println!("  protheus-ops mech-suit-mode-kernel load-policy [--payload-base64=<json>]");
    println!("  protheus-ops mech-suit-mode-kernel approx-token-count [--payload-base64=<json>]");
    println!("  protheus-ops mech-suit-mode-kernel classify-severity [--payload-base64=<json>]");
    println!("  protheus-ops mech-suit-mode-kernel should-emit-console [--payload-base64=<json>]");
    println!("  protheus-ops mech-suit-mode-kernel update-status --payload-base64=<json>");
    println!("  protheus-ops mech-suit-mode-kernel append-attention-event --payload-base64=<json>");
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
            .map_err(|err| format!("mech_suit_mode_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("mech_suit_mode_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("mech_suit_mode_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("mech_suit_mode_kernel_payload_decode_failed:{err}"));
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

fn as_array<'a>(value: Option<&'a Value>) -> &'a Vec<Value> {
    value.and_then(Value::as_array).unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
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

fn as_bool(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64().map(|v| v != 0).unwrap_or(fallback),
        Some(Value::String(v)) => lane_utils::parse_bool(Some(v.as_str()), fallback),
        _ => fallback,
    }
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(v)) => v.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn clamp_i64(value: Option<&Value>, lo: i64, hi: i64, fallback: i64) -> i64 {
    let raw = as_f64(value).unwrap_or(fallback as f64);
    if !raw.is_finite() {
        return fallback;
    }
    raw.floor().clamp(lo as f64, hi as f64) as i64
}

fn round_to(value: f64, digits: u32) -> f64 {
    let factor = 10_f64.powi(i32::try_from(digits).unwrap_or(3));
    (value * factor).round() / factor
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("mech_suit_mode_kernel_create_dir_failed:{err}"))?;
    }
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::File::create(&tmp)
        .map_err(|err| format!("mech_suit_mode_kernel_tmp_create_failed:{err}"))?;
    file.write_all(
        format!(
            "{}\n",
            serde_json::to_string_pretty(value)
                .map_err(|err| format!("mech_suit_mode_kernel_json_encode_failed:{err}"))?
        )
        .as_bytes(),
    )
    .map_err(|err| format!("mech_suit_mode_kernel_tmp_write_failed:{err}"))?;
    fs::rename(&tmp, path).map_err(|err| format!("mech_suit_mode_kernel_atomic_rename_failed:{err}"))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("mech_suit_mode_kernel_jsonl_open_failed:{err}"))?;
    file.write_all(
        format!(
            "{}\n",
            serde_json::to_string(row)
                .map_err(|err| format!("mech_suit_mode_kernel_json_encode_failed:{err}"))?
        )
        .as_bytes(),
    )
    .map_err(|err| format!("mech_suit_mode_kernel_jsonl_write_failed:{err}"))
}

fn workspace_root(root: &Path) -> PathBuf {
    if let Some(raw) = std::env::var_os("OPENCLAW_WORKSPACE") {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            return p;
        }
    }
    root.to_path_buf()
}

fn normalize_relative_token(input: &str) -> String {
    input
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn rewrite_runtime_relative(rel: &str) -> String {
    let rel = normalize_relative_token(rel);
    if rel.is_empty() {
        return rel;
    }
    if rel == "state" || rel.starts_with("state/") || rel.starts_with("local/state/") {
        let suffix = if rel == "state" {
            String::new()
        } else if let Some(rest) = rel.strip_prefix("state/") {
            rest.to_string()
        } else {
            rel.strip_prefix("local/state/").unwrap_or("").to_string()
        };
        return normalize_relative_token(&format!("client/runtime/local/state/{suffix}"));
    }
    if rel == "local" || rel.starts_with("local/") {
        let suffix = if rel == "local" {
            String::new()
        } else {
            rel.strip_prefix("local/").unwrap_or("").to_string()
        };
        return normalize_relative_token(&format!("client/runtime/local/{suffix}"));
    }
    rel
}

fn resolve_path(root: &Path, raw: &str, fallback_rel: &str) -> PathBuf {
    let expanded = raw
        .replace("${OPENCLAW_WORKSPACE}", &root.to_string_lossy())
        .replace("$OPENCLAW_WORKSPACE", &root.to_string_lossy());
    let candidate = if expanded.trim().is_empty() {
        rewrite_runtime_relative(fallback_rel)
    } else if Path::new(expanded.trim()).is_absolute() {
        return PathBuf::from(expanded.trim());
    } else {
        rewrite_runtime_relative(expanded.trim())
    };
    root.join(candidate)
}

fn text_token(value: Option<&Value>, max_len: usize) -> String {
    clean_text(value, max_len)
}

fn default_policy_value(root: &Path) -> Value {
    json!({
        "version": "1.0",
        "enabled": true,
        "state": {
            "status_path": path_to_rel(root, &root.join(DEFAULT_STATUS_REL)),
            "history_path": path_to_rel(root, &root.join(DEFAULT_HISTORY_REL))
        },
        "spine": {
            "heartbeat_hours": 4,
            "manual_triggers_allowed": false,
            "quiet_non_critical": true,
            "silent_subprocess_output": true,
            "critical_patterns": ["critical", "fail", "failed", "emergency", "blocked", "halt", "violation", "integrity", "outage"]
        },
        "eyes": {
            "push_attention_queue": true,
            "quiet_non_critical": true,
            "attention_queue_path": path_to_rel(root, &root.join(DEFAULT_ATTENTION_QUEUE_REL)),
            "receipts_path": path_to_rel(root, &root.join(DEFAULT_ATTENTION_RECEIPTS_REL)),
            "latest_path": path_to_rel(root, &root.join(DEFAULT_ATTENTION_LATEST_REL)),
            "attention_contract": {
                "max_queue_depth": 2048,
                "ttl_hours": 48,
                "dedupe_window_hours": 24,
                "backpressure_drop_below": "critical",
                "escalate_levels": ["critical"],
                "priority_map": {
                    "critical": 100,
                    "warn": 60,
                    "info": 20
                }
            },
            "push_event_types": ["external_item", "eye_run_failed", "infra_outage_state", "eye_health_quarantine_set", "eye_auto_dormant", "collector_proposal_added"],
            "focus_warn_score": 0.7,
            "critical_error_codes": ["env_blocked", "auth_denied", "integrity_blocked", "transport_blocked"]
        },
        "personas": {
            "ambient_stance": true,
            "auto_apply": true,
            "full_reload": false,
            "cache_path": "client/runtime/local/state/personas/ambient_stance/cache.json",
            "latest_path": "client/runtime/local/state/personas/ambient_stance/latest.json",
            "receipts_path": "client/runtime/local/state/personas/ambient_stance/receipts.jsonl",
            "max_personas": 256,
            "max_patch_bytes": 65536
        },
        "dopamine": {
            "threshold_breach_only": true,
            "surface_levels": ["warn", "critical"]
        },
        "receipts": {
            "silent_unless_critical": true
        }
    })
}

fn path_to_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

fn normalize_string_array(value: Option<&Value>, max_len: usize, lowercase: bool, fallback: &[&str]) -> Value {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let rows = as_array(value);
    if rows.is_empty() {
        for row in fallback {
            let token = if lowercase { row.to_ascii_lowercase() } else { row.to_string() };
            if seen.insert(token.clone()) {
                out.push(Value::String(token));
            }
        }
        return Value::Array(out);
    }
    for row in rows {
        let mut token = text_token(Some(row), max_len);
        if lowercase {
            token = token.to_ascii_lowercase();
        }
        if token.is_empty() {
            continue;
        }
        if seen.insert(token.clone()) {
            out.push(Value::String(token));
        }
    }
    Value::Array(out)
}

fn normalize_policy(raw: Option<&Map<String, Value>>, root: &Path, policy_path: &Path) -> Value {
    let base = default_policy_value(root);
    let base_obj = payload_obj(&base);
    let src = raw.cloned().unwrap_or_default();

    let state_src = as_object(src.get("state"));
    let spine_src = as_object(src.get("spine"));
    let eyes_src = as_object(src.get("eyes"));
    let contract_src = eyes_src.and_then(|v| as_object(v.get("attention_contract")));
    let personas_src = as_object(src.get("personas"));
    let dopamine_src = as_object(src.get("dopamine"));
    let receipts_src = as_object(src.get("receipts"));
    let base_state = as_object(base_obj.get("state")).unwrap();
    let base_spine = as_object(base_obj.get("spine")).unwrap();
    let base_eyes = as_object(base_obj.get("eyes")).unwrap();
    let base_contract = as_object(base_eyes.get("attention_contract")).unwrap();
    let base_personas = as_object(base_obj.get("personas")).unwrap();
    let base_dopamine = as_object(base_obj.get("dopamine")).unwrap();
    let base_receipts = as_object(base_obj.get("receipts")).unwrap();
    let version = text_token(src.get("version"), 40);
    let normalized_version = if version.is_empty() {
        base_obj.get("version").cloned().unwrap_or(Value::String("mech-suit-mode/v1".to_string()))
    } else {
        Value::String(version)
    };

    json!({
        "version": normalized_version,
        "enabled": std::env::var("MECH_SUIT_MODE_FORCE")
            .ok()
            .map(|raw| lane_utils::parse_bool(Some(raw.as_str()), as_bool(src.get("enabled"), true)))
            .unwrap_or_else(|| as_bool(src.get("enabled"), true)),
        "state": {
            "status_path": text_token(state_src.and_then(|v| v.get("status_path")), 400)
                .if_empty_then(as_str(base_state.get("status_path"))),
            "history_path": text_token(state_src.and_then(|v| v.get("history_path")), 400)
                .if_empty_then(as_str(base_state.get("history_path")))
        },
        "spine": {
            "heartbeat_hours": clamp_i64(spine_src.and_then(|v| v.get("heartbeat_hours")), 1, 8760, 4),
            "manual_triggers_allowed": as_bool(spine_src.and_then(|v| v.get("manual_triggers_allowed")), false),
            "quiet_non_critical": as_bool(spine_src.and_then(|v| v.get("quiet_non_critical")), as_bool(base_spine.get("quiet_non_critical"), true)),
            "silent_subprocess_output": as_bool(spine_src.and_then(|v| v.get("silent_subprocess_output")), as_bool(base_spine.get("silent_subprocess_output"), true)),
            "critical_patterns": normalize_string_array(spine_src.and_then(|v| v.get("critical_patterns")), 80, true, &["critical", "fail", "failed", "emergency", "blocked", "halt", "violation", "integrity", "outage"])
        },
        "eyes": {
            "push_attention_queue": as_bool(eyes_src.and_then(|v| v.get("push_attention_queue")), as_bool(base_eyes.get("push_attention_queue"), true)),
            "quiet_non_critical": as_bool(eyes_src.and_then(|v| v.get("quiet_non_critical")), as_bool(base_eyes.get("quiet_non_critical"), true)),
            "attention_queue_path": text_token(eyes_src.and_then(|v| v.get("attention_queue_path")), 400).if_empty_then(as_str(base_eyes.get("attention_queue_path"))),
            "receipts_path": text_token(eyes_src.and_then(|v| v.get("receipts_path")), 400).if_empty_then(as_str(base_eyes.get("receipts_path"))),
            "latest_path": text_token(eyes_src.and_then(|v| v.get("latest_path")), 400).if_empty_then(as_str(base_eyes.get("latest_path"))),
            "attention_contract": {
                "max_queue_depth": clamp_i64(contract_src.and_then(|v| v.get("max_queue_depth")), 1, 1_000_000, base_contract.get("max_queue_depth").and_then(Value::as_i64).unwrap_or(2048)),
                "ttl_hours": clamp_i64(contract_src.and_then(|v| v.get("ttl_hours")), 1, 24*365, base_contract.get("ttl_hours").and_then(Value::as_i64).unwrap_or(48)),
                "dedupe_window_hours": clamp_i64(contract_src.and_then(|v| v.get("dedupe_window_hours")), 1, 24*365, base_contract.get("dedupe_window_hours").and_then(Value::as_i64).unwrap_or(24)),
                "backpressure_drop_below": text_token(contract_src.and_then(|v| v.get("backpressure_drop_below")), 24).to_ascii_lowercase().if_empty_then(as_str(base_contract.get("backpressure_drop_below"))),
                "escalate_levels": normalize_string_array(contract_src.and_then(|v| v.get("escalate_levels")), 24, true, &["critical"]),
                "priority_map": {
                    "critical": clamp_i64(contract_src.and_then(|v| v.get("priority_map")).and_then(|v| as_object(Some(v))).and_then(|v| v.get("critical")), 0, 1000, 100),
                    "warn": clamp_i64(contract_src.and_then(|v| v.get("priority_map")).and_then(|v| as_object(Some(v))).and_then(|v| v.get("warn")), 0, 1000, 60),
                    "info": clamp_i64(contract_src.and_then(|v| v.get("priority_map")).and_then(|v| as_object(Some(v))).and_then(|v| v.get("info")), 0, 1000, 20)
                }
            },
            "push_event_types": normalize_string_array(eyes_src.and_then(|v| v.get("push_event_types")), 80, false, &["external_item", "eye_run_failed", "infra_outage_state", "eye_health_quarantine_set", "eye_auto_dormant", "collector_proposal_added"]),
            "focus_warn_score": round_to(as_f64(eyes_src.and_then(|v| v.get("focus_warn_score"))).unwrap_or(0.7).clamp(0.0, 1.0), 3),
            "critical_error_codes": normalize_string_array(eyes_src.and_then(|v| v.get("critical_error_codes")), 80, true, &["env_blocked", "auth_denied", "integrity_blocked", "transport_blocked"])
        },
        "personas": {
            "ambient_stance": as_bool(personas_src.and_then(|v| v.get("ambient_stance")), as_bool(base_personas.get("ambient_stance"), true)),
            "auto_apply": as_bool(personas_src.and_then(|v| v.get("auto_apply")), as_bool(base_personas.get("auto_apply"), true)),
            "full_reload": as_bool(personas_src.and_then(|v| v.get("full_reload")), as_bool(base_personas.get("full_reload"), false)),
            "cache_path": text_token(personas_src.and_then(|v| v.get("cache_path")), 400).if_empty_then(as_str(base_personas.get("cache_path"))),
            "latest_path": text_token(personas_src.and_then(|v| v.get("latest_path")), 400).if_empty_then(as_str(base_personas.get("latest_path"))),
            "receipts_path": text_token(personas_src.and_then(|v| v.get("receipts_path")), 400).if_empty_then(as_str(base_personas.get("receipts_path"))),
            "max_personas": clamp_i64(personas_src.and_then(|v| v.get("max_personas")), 1, 100000, 256),
            "max_patch_bytes": clamp_i64(personas_src.and_then(|v| v.get("max_patch_bytes")), 256, 10_000_000, 65536)
        },
        "dopamine": {
            "threshold_breach_only": as_bool(dopamine_src.and_then(|v| v.get("threshold_breach_only")), as_bool(base_dopamine.get("threshold_breach_only"), true)),
            "surface_levels": normalize_string_array(dopamine_src.and_then(|v| v.get("surface_levels")), 40, true, &["warn", "critical"])
        },
        "receipts": {
            "silent_unless_critical": as_bool(receipts_src.and_then(|v| v.get("silent_unless_critical")), as_bool(base_receipts.get("silent_unless_critical"), true))
        },
        "_policy_path": path_to_rel(root, policy_path),
        "_root": root.to_string_lossy().to_string()
    })
}

trait StringExt {
    fn if_empty_then(self, fallback: String) -> String;
}

impl StringExt for String {
    fn if_empty_then(self, fallback: String) -> String {
        if self.is_empty() { fallback } else { self }
    }
}

fn resolve_policy_path(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    if let Some(raw) = payload.get("policy_path") {
        let s = as_str(Some(raw));
        if !s.is_empty() {
            return resolve_path(root, &s, DEFAULT_POLICY_REL);
        }
    }
    if let Ok(raw) = std::env::var("MECH_SUIT_MODE_POLICY_PATH") {
        if !raw.trim().is_empty() {
            return resolve_path(root, &raw, DEFAULT_POLICY_REL);
        }
    }
    root.join(DEFAULT_POLICY_REL)
}

fn load_policy(root: &Path, payload: &Map<String, Value>) -> Value {
    let policy_path = resolve_policy_path(root, payload);
    let raw = read_json(&policy_path)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    normalize_policy(Some(&raw), root, &policy_path)
}

fn approx_token_count_value(value: &Value) -> i64 {
    let text = as_str(Some(value));
    if text.trim().is_empty() {
        0
    } else {
        ((text.len() + 3) / 4) as i64
    }
}

fn classify_severity_value(message: &str, patterns: &[String]) -> String {
    let line = message.to_ascii_lowercase();
    if line.trim().is_empty() {
        return "info".to_string();
    }
    let critical_terms = [
        "critical", "fail", "failed", "emergency", "blocked", "halt", "panic", "violation", "integrity", "outage", "fatal"
    ];
    if critical_terms.iter().any(|needle| line.contains(needle)) {
        return "critical".to_string();
    }
    if patterns.iter().any(|needle| !needle.is_empty() && line.contains(&needle.to_ascii_lowercase())) {
        return "critical".to_string();
    }
    let warn_terms = ["warn", "warning", "degraded", "retry", "quarantine", "dormant", "slow", "parked"];
    if warn_terms.iter().any(|needle| line.contains(needle)) {
        return "warn".to_string();
    }
    "info".to_string()
}

fn should_emit_console_value(message: &str, method: &str, policy: &Value) -> bool {
    if policy.get("enabled").and_then(Value::as_bool) != Some(true) {
        return true;
    }
    let patterns = as_array(policy.pointer("/spine/critical_patterns"))
        .iter()
        .map(|row| as_str(Some(row)).to_ascii_lowercase())
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    let severity = classify_severity_value(message, &patterns);
    if severity == "critical" {
        return true;
    }
    if method == "error" && severity == "warn" {
        return false;
    }
    false
}

fn update_status_value(root: &Path, policy: &Value, component: &str, patch: &Value) -> Result<Value, String> {
    let latest_path = resolve_path(root, &as_str(policy.pointer("/state/status_path")), DEFAULT_STATUS_REL);
    let history_path = resolve_path(root, &as_str(policy.pointer("/state/history_path")), DEFAULT_HISTORY_REL);
    let mut latest = read_json(&latest_path).unwrap_or_else(|| json!({
        "ts": Value::Null,
        "active": policy.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "components": {}
    }));
    if latest.get("components").and_then(Value::as_object).is_none() {
        latest["components"] = json!({});
    }
    let ts = now_iso();
    latest["ts"] = Value::String(ts.clone());
    latest["active"] = Value::Bool(policy.get("enabled").and_then(Value::as_bool).unwrap_or(true));
    latest["policy_path"] = Value::String(as_str(policy.get("_policy_path")));
    let components = latest.get_mut("components").and_then(Value::as_object_mut).ok_or_else(|| "mech_suit_mode_kernel_components_invalid".to_string())?;
    let merged = if let Some(existing) = components.get(component).and_then(Value::as_object) {
        let mut map = existing.clone();
        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                map.insert(k.clone(), v.clone());
            }
        }
        Value::Object(map)
    } else {
        patch.clone()
    };
    components.insert(component.to_string(), merged);
    write_json(&latest_path, &latest)?;
    append_jsonl(&history_path, &json!({
        "ts": ts,
        "type": "mech_suit_status",
        "component": component,
        "active": latest.get("active").and_then(Value::as_bool).unwrap_or(true),
        "patch": patch
    }))?;
    Ok(latest)
}

fn priority_for(policy: &Value, severity: &str) -> i64 {
    policy
        .pointer(&format!("/eyes/attention_contract/priority_map/{severity}"))
        .and_then(Value::as_i64)
        .unwrap_or(match severity {
            "critical" => 100,
            "warn" => 60,
            _ => 20,
        })
}

fn build_attention_event_value(event: &Value, policy: &Value) -> Option<Value> {
    let row = event.as_object()?;
    let event_type = text_token(row.get("type"), 80);
    let allowed = as_array(policy.pointer("/eyes/push_event_types"))
        .iter()
        .map(|row| as_str(Some(row)))
        .collect::<std::collections::BTreeSet<_>>();
    let explicit_source = text_token(row.get("source"), 80);
    let explicit_source_type = text_token(row.get("source_type"), 80);
    let allow_generic = !explicit_source.is_empty() || !explicit_source_type.is_empty();
    if !allowed.contains(&event_type) && !allow_generic {
        return None;
    }

    let eye_id = text_token(row.get("eye_id"), 80).if_empty_then("unknown_eye".to_string());
    let parser_type = text_token(row.get("parser_type"), 60);
    let focus_score = as_f64(row.get("focus_score"));
    let fallback = row.get("fallback").and_then(Value::as_bool).unwrap_or(false);
    let mut severity = text_token(row.get("severity"), 24).to_ascii_lowercase();
    if severity.is_empty() {
        severity = "info".to_string();
    }
    let mut summary = text_token(row.get("summary"), 140).if_empty_then(format!("{event_type}:{eye_id}"));

    match event_type.as_str() {
        "external_item" => {
            let focus_mode = text_token(row.get("focus_mode"), 24);
            let threshold = as_f64(policy.pointer("/eyes/focus_warn_score")).unwrap_or(0.7);
            severity = if fallback {
                "info".to_string()
            } else if focus_score.unwrap_or(0.0) >= threshold || focus_mode == "focus" {
                "warn".to_string()
            } else {
                "info".to_string()
            };
            summary = text_token(row.get("title"), 140).if_empty_then(format!("{eye_id} external item"));
        }
        "eye_run_failed" => {
            let code = text_token(row.get("error_code"), 80).to_ascii_lowercase();
            let critical_codes = as_array(policy.pointer("/eyes/critical_error_codes"))
                .iter()
                .map(|row| as_str(Some(row)).to_ascii_lowercase())
                .collect::<std::collections::BTreeSet<_>>();
            severity = if critical_codes.contains(&code) {
                "critical".to_string()
            } else {
                "warn".to_string()
            };
            summary = text_token(row.get("error"), 140).if_empty_then(format!("{eye_id} collector failed"));
        }
        "infra_outage_state" => {
            let active = row.get("active").and_then(Value::as_bool).unwrap_or(false);
            severity = if active { "critical".to_string() } else { "warn".to_string() };
            summary = if active {
                format!("eyes outage active ({} failed)", row.get("failed_transport_eyes").and_then(Value::as_i64).unwrap_or(0))
            } else {
                "eyes outage recovered".to_string()
            };
        }
        "eye_health_quarantine_set" => {
            severity = "warn".to_string();
            summary = format!("{eye_id} quarantined: {}", text_token(row.get("reason"), 120).if_empty_then("health_quarantine".to_string()));
        }
        "eye_auto_dormant" => {
            severity = "warn".to_string();
            summary = format!("{eye_id} dormant: {}", text_token(row.get("reason"), 120).if_empty_then("auto_dormant".to_string()));
        }
        "collector_proposal_added" => {
            severity = "warn".to_string();
            summary = format!("{eye_id} remediation proposal added");
        }
        _ => {}
    }

    let ts = text_token(row.get("ts"), 40).if_empty_then(now_iso());
    let attention_key = text_token(row.get("attention_key"), 160).if_empty_then(format!(
        "{}:{}:{}",
        event_type,
        eye_id,
        text_token(row.get("item_hash").or_else(|| row.get("error_code")).or_else(|| row.get("reason")).or_else(|| row.get("title")), 120)
    ));
    let parser_type_value = if parser_type.is_empty() {
        Value::Null
    } else {
        Value::String(parser_type)
    };
    let focus_mode = text_token(row.get("focus_mode"), 24);
    let focus_mode_value = if focus_mode.is_empty() {
        Value::Null
    } else {
        Value::String(focus_mode)
    };
    let error_code = text_token(row.get("error_code"), 80);
    let error_code_value = if error_code.is_empty() {
        Value::Null
    } else {
        Value::String(error_code)
    };
    let mut payload = json!({
        "ts": ts,
        "type": "attention_event",
        "source": explicit_source.if_empty_then("external_eyes".to_string()),
        "source_type": explicit_source_type.if_empty_then(event_type.clone()),
        "eye_id": eye_id,
        "parser_type": parser_type_value,
        "severity": severity,
        "priority": priority_for(policy, &severity),
        "summary": summary,
        "focus_mode": focus_mode_value,
        "focus_score": focus_score.map(Value::from).unwrap_or(Value::Null),
        "error_code": error_code_value,
        "attention_key": attention_key,
        "raw_event": event
    });
    payload["receipt_hash"] = Value::String(hex_sha256(&payload));
    Some(payload)
}

fn hex_sha256(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(value).unwrap_or_default().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn append_attention_event_value(root: &Path, policy: &Value, event: &Value, run_context: &str) -> Result<Value, String> {
    if policy.get("enabled").and_then(Value::as_bool) != Some(true)
        || policy.pointer("/eyes/push_attention_queue").and_then(Value::as_bool) != Some(true)
    {
        return Ok(json!({"ok": true, "queued": false, "reason": "disabled"}));
    }
    let Some(attention) = build_attention_event_value(event, policy) else {
        return Ok(json!({"ok": true, "queued": false, "reason": "event_not_tracked"}));
    };

    let queue_path = resolve_path(root, &as_str(policy.pointer("/eyes/attention_queue_path")), DEFAULT_ATTENTION_QUEUE_REL);
    let receipts_path = resolve_path(root, &as_str(policy.pointer("/eyes/receipts_path")), DEFAULT_ATTENTION_RECEIPTS_REL);
    let latest_path = resolve_path(root, &as_str(policy.pointer("/eyes/latest_path")), DEFAULT_ATTENTION_LATEST_REL);
    append_jsonl(&queue_path, &attention)?;
    append_jsonl(&receipts_path, &json!({
        "ts": attention.get("ts").cloned().unwrap_or(Value::String(now_iso())),
        "type": "attention_receipt",
        "queued": true,
        "severity": attention.get("severity").cloned().unwrap_or(Value::String("info".to_string())),
        "eye_id": attention.get("eye_id").cloned().unwrap_or(Value::String("unknown_eye".to_string())),
        "source_type": attention.get("source_type").cloned().unwrap_or(Value::String("unknown".to_string())),
        "receipt_hash": attention.get("receipt_hash").cloned().unwrap_or(Value::Null)
    }))?;
    let mut latest = read_json(&latest_path).unwrap_or_else(|| json!({"queued_total": 0}));
    latest["ts"] = attention.get("ts").cloned().unwrap_or(Value::String(now_iso()));
    latest["active"] = Value::Bool(true);
    latest["queued_total"] = Value::from(latest.get("queued_total").and_then(Value::as_i64).unwrap_or(0) + 1);
    latest["last_event"] = json!({
        "eye_id": attention.get("eye_id").cloned().unwrap_or(Value::Null),
        "source_type": attention.get("source_type").cloned().unwrap_or(Value::Null),
        "severity": attention.get("severity").cloned().unwrap_or(Value::Null),
        "summary": attention.get("summary").cloned().unwrap_or(Value::Null),
    });
    write_json(&latest_path, &latest)?;
    let status = update_status_value(root, policy, "eyes", &json!({
        "ambient": true,
        "push_attention_queue": true,
        "quiet_non_critical": policy.pointer("/eyes/quiet_non_critical").and_then(Value::as_bool).unwrap_or(true),
        "last_attention_ts": attention.get("ts").cloned().unwrap_or(Value::Null),
        "last_attention_summary": attention.get("summary").cloned().unwrap_or(Value::Null),
        "attention_queue_path": as_str(policy.pointer("/eyes/attention_queue_path")),
        "attention_receipts_path": as_str(policy.pointer("/eyes/receipts_path")),
        "attention_last_decision": "admitted",
        "attention_routed_via": "rust_kernel",
        "run_context": run_context
    }))?;
    Ok(json!({
        "ok": true,
        "queued": true,
        "event": attention,
        "decision": "admitted",
        "routed_via": "rust_kernel",
        "status": status
    }))
}

fn run_command(root: &Path, command: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    let workspace = workspace_root(root);
    match command {
        "load-policy" => {
            let policy = load_policy(&workspace, payload);
            Ok(json!({ "ok": true, "policy": policy }))
        }
        "approx-token-count" => {
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            Ok(json!({ "ok": true, "token_count": approx_token_count_value(&value) }))
        }
        "classify-severity" => {
            let message = text_token(payload.get("message"), 600);
            let patterns = as_array(payload.get("patterns"))
                .iter()
                .map(|row| text_token(Some(row), 80).to_ascii_lowercase())
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>();
            Ok(json!({ "ok": true, "severity": classify_severity_value(&message, &patterns) }))
        }
        "should-emit-console" => {
            let message = text_token(payload.get("message"), 600);
            let method = text_token(payload.get("method"), 24).to_ascii_lowercase();
            let policy = if let Some(obj) = as_object(payload.get("policy")) {
                normalize_policy(Some(obj), &workspace, &resolve_policy_path(&workspace, payload))
            } else {
                load_policy(&workspace, payload)
            };
            Ok(json!({ "ok": true, "emit": should_emit_console_value(&message, &method, &policy), "policy": policy }))
        }
        "update-status" => {
            let component = text_token(payload.get("component"), 80);
            if component.is_empty() {
                return Err("mech_suit_mode_kernel_missing_component".to_string());
            }
            let patch = payload.get("patch").cloned().unwrap_or_else(|| json!({}));
            let policy = if let Some(obj) = as_object(payload.get("policy")) {
                normalize_policy(Some(obj), &workspace, &resolve_policy_path(&workspace, payload))
            } else {
                load_policy(&workspace, payload)
            };
            let status = update_status_value(&workspace, &policy, &component, &patch)?;
            Ok(json!({ "ok": true, "status": status }))
        }
        "append-attention-event" => {
            let event = payload.get("event").cloned().unwrap_or_else(|| json!({}));
            let run_context = text_token(payload.get("run_context"), 40).if_empty_then("eyes".to_string());
            let policy = if let Some(obj) = as_object(payload.get("policy")) {
                normalize_policy(Some(obj), &workspace, &resolve_policy_path(&workspace, payload))
            } else {
                load_policy(&workspace, payload)
            };
            append_attention_event_value(&workspace, &policy, &event, &run_context)
        }
        _ => Err("mech_suit_mode_kernel_unknown_command".to_string()),
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
            print_json_line(&cli_error("mech_suit_mode_kernel", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload).clone();
    match run_command(root, command, &payload) {
        Ok(out) => {
            print_json_line(&cli_receipt("mech_suit_mode_kernel", out));
            0
        }
        Err(err) => {
            print_json_line(&cli_error("mech_suit_mode_kernel", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mech-suit-mode-kernel-{}-{}-{}",
            name,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(root.join("client/runtime/config")).unwrap();
        root
    }

    #[test]
    fn classify_and_emit_gate_match_policy() {
        let policy = default_policy_value(Path::new("/tmp"));
        assert_eq!(classify_severity_value("integrity fail in spine", &[]), "critical");
        assert!(!should_emit_console_value("warning: retry queued", "error", &policy));
        assert!(should_emit_console_value("critical integrity failure", "log", &policy));
    }

    #[test]
    fn append_attention_event_writes_queue_and_status() {
        let root = temp_root("attention");
        let policy_path = root.join(DEFAULT_POLICY_REL);
        write_json(&policy_path, &json!({
            "enabled": true,
            "eyes": {
                "push_attention_queue": true,
                "push_event_types": ["eye_run_failed"]
            }
        })).unwrap();
        let payload = json!({
            "event": {
                "type": "eye_run_failed",
                "eye_id": "hn_frontpage",
                "error": "transport denied",
                "error_code": "auth_denied"
            }
        });
        let out = run_command(&root, "append-attention-event", payload_obj(&payload)).unwrap();
        assert_eq!(out.get("queued").and_then(Value::as_bool), Some(true));
        assert!(root.join(DEFAULT_ATTENTION_QUEUE_REL).exists());
        assert!(root.join(DEFAULT_STATUS_REL).exists());
    }
}
